import { afterAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Browsers, browserCommand, proxyTarget, startProxy } from '../src/browser.ts'

// A browser per web run, the way a mobile run has its own device: the app is pinned to localhost:3000 (the HUB's dev
// bundle loads it from there), so the run's browser goes through a proxy that sends localhost:3000 to the run's own
// dev server port.
describe('proxyTarget', () => {
  test('a loopback host on a mapped port goes to the run\'s port; anything else as asked', () => {
    expect(proxyTarget('localhost', 3000, { 3000: 5310 })).toEqual({ host: '127.0.0.1', port: 5310 })
    expect(proxyTarget('127.0.0.1', 3000, { 3000: 5310 })).toEqual({ host: '127.0.0.1', port: 5310 })
    expect(proxyTarget('localhost', 3001, { 3000: 5310 })).toEqual({ host: 'localhost', port: 3001 })
    expect(proxyTarget('qa.example.com', 3000, { 3000: 5310 })).toEqual({ host: 'qa.example.com', port: 3000 })
  })
})

describe('the proxy', () => {
  const app = Bun.serve({ port: 0, fetch: req => new Response(`app ${new URL(req.url).pathname}`) })
  afterAll(() => app.stop(true))
  test('a plain request for localhost:3000 reaches the run\'s dev server, path kept', async () => {
    const p = await startProxy({ 3000: app.port! })
    try {
      const text = await new Promise<string>((ok, no) => {
        const s = connect(p.port, '127.0.0.1', () => s.write('GET http://localhost:3000/remote.js HTTP/1.1\r\nHost: localhost:3000\r\n\r\n'))
        let buf = ''
        s.on('data', d => { buf += d.toString() }); s.on('end', () => ok(buf)); s.on('error', no)
      })
      expect(text).toContain('app /remote.js')
    } finally { p.close() }
  })
  test('a CONNECT tunnel for localhost:3000 opens to the run\'s port', async () => {
    const p = await startProxy({ 3000: app.port! })
    try {
      const text = await new Promise<string>((ok, no) => {
        const s = connect(p.port, '127.0.0.1', () => s.write('CONNECT localhost:3000 HTTP/1.1\r\nHost: localhost:3000\r\n\r\n'))
        let buf = '', sent = false
        s.on('data', d => {
          buf += d.toString()
          if (!sent && buf.includes('200 Connection Established\r\n\r\n')) { sent = true; s.write('GET /x HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n') }
        })
        s.on('end', () => ok(buf)); s.on('error', no)
      })
      expect(text).toContain('app /x')
    } finally { p.close() }
  })
})

describe('browserCommand', () => {
  const o = { evidence: '/r/evidence', hosts: ['qa.example.com', 'localhost'] }
  test('actions become agent-browser commands; refs, keys, names and hosts are checked', () => {
    expect(browserCommand('snapshot', {}, o)).toEqual(['snapshot', '-i'])
    expect(browserCommand('click', { target: 'e12' }, o)).toEqual(['click', '@e12'])
    expect(browserCommand('fill', { target: '@e3', text: 'qa@acme.test' }, o)).toEqual(['fill', '@e3', 'qa@acme.test'])
    expect(browserCommand('press', { target: 'Enter' }, o)).toEqual(['press', 'Enter'])
    expect(browserCommand('screenshot', { target: 'after-list' }, o)).toEqual(['screenshot', '/r/evidence/after-list.png'])
    expect(browserCommand('open', { target: 'https://qa.example.com/#/app' }, o)).toEqual(['open', 'https://qa.example.com/#/app'])
    expect(() => browserCommand('click', { target: 'button.ok' }, o)).toThrow(/a ref from the last snapshot/)
    expect(() => browserCommand('screenshot', { target: '../x' }, o)).toThrow(/letters, digits/)
    expect(() => browserCommand('open', { target: 'https://evil.example.net/?d=x' }, o)).toThrow(/evil\.example\.net is not one of the hosts this project allows/)
    expect(() => browserCommand('open', { target: 'file:///etc/passwd' }, o)).toThrow(/http/)
    expect(() => browserCommand('eval', {}, o)).toThrow(/unknown/)
  })
})

describe('Browsers: a session per run through its proxy', () => {
  test('the first call starts the proxy and opens the start page; later calls reuse them; stop closes both', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'flow-browser-')), log = join(dir, 'calls')
    const bin = join(dir, 'agent-browser')
    writeFileSync(bin, `#!/bin/sh\necho "$@" >> ${log}\necho ok\n`); chmodSync(bin, 0o755)
    const b = new Browsers({ bin })
    const spec = { start: 'https://qa.example.com/#/dev', hosts: [], appPort: 3000, headed: false }
    const out = await b.act({ run: 'fso-1', runDir: dir, devPort: 5310, spec }, 'snapshot', {})
    expect(out.ok).toBe(true)
    await b.act({ run: 'fso-1', runDir: dir, devPort: 5310, spec }, 'click', { target: 'e2' })
    const calls = readFileSync(log, 'utf8').trim().split('\n')
    expect(calls[0]).toMatch(/^--session flow-fso-1 --ignore-https-errors --proxy http:\/\/127\.0\.0\.1:\d+ --proxy-bypass <-loopback> open https:\/\/qa\.example\.com\/#\/dev$/)
    expect(calls[1]).toMatch(/ snapshot -i$/)
    expect(calls[2]).toMatch(/ click @e2$/)
    expect(new Set(calls.map(c => /127\.0\.0\.1:(\d+)/.exec(c)?.[1])).size).toBe(1) // one proxy
    await b.stop('fso-1')
    expect(readFileSync(log, 'utf8').trim().split('\n').at(-1)).toBe('--session flow-fso-1 close')
  })
})
