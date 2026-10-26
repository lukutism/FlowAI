import { describe, expect, test } from 'bun:test'
import { lstatSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseLogins, renderEnv, writeAppEnv } from '../src/appenv.ts'

// A run's app environment: the repo's env file written into the worktree with the run's own values (the license
// from the login step, the project's fixed values), so the app on the run's device signs in.
describe('the login step\'s text', () => {
  test('email, password and license by name; other lines and empty values are left out', () => {
    expect(parseLogins('email: qa@example.com\npassword: p: w\nlicense: ABC-123\nnote\nother:  \n')).toEqual({ email: 'qa@example.com', password: 'p: w', license: 'ABC-123' })
    expect(parseLogins('')).toEqual({})
  })
})

describe('renderEnv', () => {
  test('the named keys replaced in place, the rest (comments, order) kept, missing keys appended', () => {
    expect(renderEnv('# app\nA=1\nOPS_LICENSE_KEY=\nB=2\n', { OPS_LICENSE_KEY: 'XYZ', NEW: 'n' })).toBe('# app\nA=1\nOPS_LICENSE_KEY=XYZ\nB=2\nNEW=n\n')
  })
})

describe('writeAppEnv', () => {
  const spec = { file: '.env', from: '.env.container.develop', set: { OPS_CLOUD_HOST: 'qa' }, login: { license: 'OPS_LICENSE_KEY' } }
  test('from the base file, with the license and the fixed values; it names the keys it set, never their values', () => {
    const wt = mkdtempSync(join(tmpdir(), 'flow-env-'))
    writeFileSync(join(wt, '.env.container.develop'), 'OPS_CLOUD_HOST=develop\nOPS_LICENSE_KEY=\nOPS_X=1\n')
    const r = writeAppEnv(wt, spec, { license: 'LIC-9' })
    expect(readFileSync(join(wt, '.env'), 'utf8')).toBe('OPS_CLOUD_HOST=qa\nOPS_LICENSE_KEY=LIC-9\nOPS_X=1\n')
    expect(r).toBe('.env: OPS_CLOUD_HOST, OPS_LICENSE_KEY set for this run')
    expect(r).not.toContain('LIC-9')
  })
  test("a link to the main checkout's file is replaced by the run's own file: the main checkout's stays as it was", () => {
    const wt = mkdtempSync(join(tmpdir(), 'flow-env-')), main = mkdtempSync(join(tmpdir(), 'flow-env-main-'))
    writeFileSync(join(main, '.env'), 'OPS_LICENSE_KEY=\nMINE=1\n')
    symlinkSync(join(main, '.env'), join(wt, '.env'))
    writeAppEnv(wt, { file: '.env', set: {}, login: { license: 'OPS_LICENSE_KEY' } }, { license: 'LIC-9' })
    expect(lstatSync(join(wt, '.env')).isSymbolicLink()).toBe(false)
    expect(readFileSync(join(wt, '.env'), 'utf8')).toBe('OPS_LICENSE_KEY=LIC-9\nMINE=1\n')
    expect(readFileSync(join(main, '.env'), 'utf8')).toBe('OPS_LICENSE_KEY=\nMINE=1\n')
  })
  test('nothing to set (no license given, no fixed values): no file is written', () => {
    const wt = mkdtempSync(join(tmpdir(), 'flow-env-'))
    writeFileSync(join(wt, '.env.container.develop'), 'A=1\n')
    expect(writeAppEnv(wt, { ...spec, set: {} }, {})).toBeUndefined()
    expect(() => lstatSync(join(wt, '.env'))).toThrow()
  })
  test('a base file that is missing is named', () => {
    const wt = mkdtempSync(join(tmpdir(), 'flow-env-'))
    expect(() => writeAppEnv(wt, spec, { license: 'L' })).toThrow(/\.env\.container\.develop not found/)
  })
})
