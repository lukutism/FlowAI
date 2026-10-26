import { describe, expect, test } from 'bun:test'
import { fill, fillSh, livePids, sh, shLogged } from '../src/sh.ts'

// A project's commands get values that come from tickets and forms (a base, a customer): in a shell command they
// are one word each, whatever they hold.
describe('placeholders in shell commands', () => {
  test('a value is one word: spaces, quotes and $(…) stay data', async () => {
    const cmd = fillSh('printf "%s|" {a} {b} flow-{run}', { a: 'x y', b: `$(echo hi)'; echo pwned`, run: 'fso-1' })
    expect((await sh(cmd, '/tmp')).out).toBe(`x y|$(echo hi)'; echo pwned|flow-fso-1|`)
  })
  test('plain values are left as they are; an empty one is no word at all', () => {
    expect(fillSh('apply {customer} {base} {dryRun}', { customer: 'acme', base: 'origin/patch/3.18', dryRun: '' })).toBe('apply acme origin/patch/3.18 ')
  })
  test('unknown names stay as written; fill (no shell) never quotes', () => {
    expect(fillSh('{nope} {port}', { port: 5300 })).toBe('{nope} 5300')
    expect(fill('https://localhost:{port}/{a}', { port: 1, a: 'x y' })).toBe('https://localhost:1/x y')
  })
})

describe('process ids read back from a run\'s files', () => {
  test('only real ones: never 0, 1 or negative (kill(-1) is every process of the user)', () => {
    expect(livePids([0, -1, 1, 4242, 'x', 3.5, null])).toEqual([4242])
    expect(livePids(undefined)).toEqual([])
  })
})

describe('a command logged as it runs', () => {
  test('its own output comes back whole, even after non-ASCII lines in the log (an id from create)', async () => {
    const { mkdtempSync, writeFileSync } = require('node:fs') as typeof import('node:fs')
    const log = require('node:path').join(mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'flow-log-')), 'setup.log')
    writeFileSync(log, '✓ done — … 🎉 earlier output\n'.repeat(20))
    const r = await shLogged('echo A1B2-UDID', '/tmp', log)
    expect(r.out.trim().split('\n').pop()).toBe('A1B2-UDID')
  })
})
