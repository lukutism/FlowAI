/**
 * A browser per web run, the way a mobile run has its own device (hwt's). A web app may be pinned to one address
 * (the HUB's dev web bundle loads the portal from https://localhost:3000, a port its CSP fixes), while each run's
 * dev server has a port of its own. So the run's agent-browser session goes through a small proxy in flow's
 * service that sends localhost:<appPort> to the run's port: the page still sees its address, and runs never share
 * a dev server. The agent drives it through its browser tool; it may open only the hosts the project allows (the
 * browser runs in flow, outside the agent's sandbox).
 */
import { mkdirSync } from 'node:fs'
import { connect, createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

export function proxyTarget(host: string, port: number, map: Record<number, number>): { host: string; port: number } {
  return LOOPBACK.has(host) && map[port] ? { host: '127.0.0.1', port: map[port]! } : { host, port }
}

/** CONNECT tunnels (https, wss) and plain absolute-URI http requests, loopback ports in map sent on to their run's */
export function startProxy(map: Record<number, number>): Promise<{ port: number; close: () => void }> {
  const server: Server = createServer(client => {
    client.once('data', head => {
      const text = head.toString('latin1')
      const line = text.slice(0, text.indexOf('\r\n'))
      const tunnel = /^CONNECT\s+(\[[^\]]+\]|[^:\s]+):(\d+)\s/i.exec(line)
      const plain = /^[A-Z]+\s+http:\/\/(\[[^\]]+\]|[^:/\s]+)(?::(\d+))?(\/\S*)?\s/i.exec(line)
      if (!tunnel && !plain) return void client.end('HTTP/1.1 400 Bad Request\r\n\r\n')
      const t = proxyTarget(tunnel ? tunnel[1]! : plain![1]!, Number(tunnel ? tunnel[2] : plain![2] ?? 80), map)
      const upstream: Socket = connect(t.port, t.host, () => {
        if (tunnel) client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        // plain http: the request goes on with an origin-form path, one per connection (a kept-alive one would
        // carry the next absolute URI on unchanged)
        else upstream.write(Buffer.from(text.replace(line, line.replace(/http:\/\/[^/\s]+/i, '') || line)
          .replace(/^(?:proxy-)?connection:[^\r\n]*\r\n/gim, '').replace('\r\n', '\r\nConnection: close\r\n'), 'latin1'))
        upstream.pipe(client); client.pipe(upstream)
      })
      upstream.on('error', () => { if (!client.destroyed) client.end(tunnel ? 'HTTP/1.1 502 Bad Gateway\r\n\r\n' : '') })
      client.on('error', () => upstream.destroy())
    })
  })
  return new Promise((ok, no) => {
    server.once('error', no)
    server.listen(0, '127.0.0.1', () => ok({ port: (server.address() as { port: number }).port, close: () => server.close() }))
  })
}

export interface BrowserSpec { start?: string; hosts: string[]; appPort: number; headed: boolean }

/** an action of the agent's browser tool as an agent-browser command: refs, keys, names and hosts checked */
export function browserCommand(action: string, a: { target?: string; text?: string }, o: { evidence: string; hosts: string[] }): string[] {
  const ref = (r?: string) => {
    const m = /^@?(e\d{1,6})$/.exec(r ?? '')
    if (!m) throw new Error(`a ref from the last snapshot, like e12; got "${r ?? ''}"`)
    return `@${m[1]}`
  }
  switch (action) {
    case 'snapshot': return ['snapshot', '-i']
    case 'click': return ['click', ref(a.target)]
    case 'fill': return ['fill', ref(a.target), a.text ?? '']
    case 'press':
      if (!/^[A-Za-z0-9+]{1,30}$/.test(a.target ?? '')) throw new Error(`press takes a key (Enter, Tab, Escape, Control+a); got "${a.target ?? ''}"`)
      return ['press', a.target!]
    case 'screenshot':
      if (!/^[\w-][\w.-]{0,59}$/.test(a.target ?? '')) throw new Error('screenshot takes a name: letters, digits, . _ - (60 at most)')
      return ['screenshot', join(o.evidence, `${a.target!.replace(/\.png$/, '')}.png`)]
    case 'url': return ['get', 'url']
    case 'open': {
      let u: URL
      try { u = new URL(a.target ?? '') } catch { throw new Error('open takes an http or https URL') }
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('open takes an http or https URL')
      if (!o.hosts.includes(u.hostname)) throw new Error(`${u.hostname} is not one of the hosts this project allows (${o.hosts.join(', ')})`)
      return ['open', u.href]
    }
    default: throw new Error(`unknown browser action "${action}": snapshot, click, fill, press, screenshot, url or open`)
  }
}

interface Open { proxy: { port: number; close: () => void }; devPort: number }

/** the runs' browser sessions: started at a run's first call, each with its proxy; stopped with the dev server */
export class Browsers {
  private open = new Map<string, Open>()
  constructor(private o: { bin?: string } = {}) {}

  private async ab(runDir: string, args: string[]) {
    const p = Bun.spawn([this.o.bin ?? 'agent-browser', ...args], { cwd: runDir, stdout: 'pipe', stderr: 'pipe', env: process.env })
    const timer = setTimeout(() => p.kill(), 120_000)
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
    clearTimeout(timer)
    return { code: await p.exited, out: out.trim(), err: err.trim() }
  }

  private args(run: string, o: Open, spec: BrowserSpec, cmd: string[]) {
    // <-loopback>: Chrome sends localhost straight to the port unless told to use the proxy for it too
    return ['--session', `flow-${run}`, ...(spec.headed ? ['--headed'] : []), '--ignore-https-errors', '--proxy', `http://127.0.0.1:${o.proxy.port}`, '--proxy-bypass', '<-loopback>', ...cmd]
  }

  async act(r: { run: string; runDir: string; devPort: number; spec: BrowserSpec }, action: string, a: { target?: string; text?: string }): Promise<{ ok: boolean; text: string }> {
    const hosts = [...new Set(['localhost', ...r.spec.hosts, ...(r.spec.start ? [new URL(r.spec.start).hostname] : [])])]
    const cmd = browserCommand(action, a, { evidence: join(r.runDir, 'evidence'), hosts })
    let o = this.open.get(r.run)
    if (o && o.devPort !== r.devPort) { await this.stop(r.run); o = undefined } // the dev server was restarted elsewhere
    if (!o) {
      o = { proxy: await startProxy({ [r.spec.appPort]: r.devPort }), devPort: r.devPort }
      this.open.set(r.run, o)
      if (r.spec.start) {
        const s = await this.ab(r.runDir, this.args(r.run, o, r.spec, ['open', r.spec.start]))
        if (s.code !== 0) return { ok: false, text: `agent-browser open ${r.spec.start} failed: ${(s.err || s.out).split('\n').slice(-3).join(' ')}` }
      }
    }
    if (action === 'screenshot') mkdirSync(join(r.runDir, 'evidence'), { recursive: true })
    const res = await this.ab(r.runDir, this.args(r.run, o, r.spec, cmd))
    if (res.code !== 0) return { ok: false, text: `agent-browser ${cmd[0]} failed: ${(res.err || res.out).split('\n').slice(-3).join(' ')}` }
    return { ok: true, text: action === 'screenshot' ? `saved ${cmd[1]}` : res.out || '(done)' }
  }

  async stop(run: string, runDir?: string) {
    const o = this.open.get(run)
    if (!o) return
    this.open.delete(run)
    await this.ab(runDir ?? process.cwd(), ['--session', `flow-${run}`, 'close']).catch(() => {})
    o.proxy.close()
  }
}
