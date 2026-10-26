import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { maskLogins, redactLogins } from '../src/redact.ts'
import { appendTranscript } from '../src/transcript.ts'

// Logins written in a ticket: their values go to the run's logins.md (only you read it); the ticket the agent quotes
// from keeps a pointer, and what the screen shows has them masked.
describe('redactLogins', () => {
  test('labelled values (password, license key, token, pin) are taken out; the label and the email stay', () => {
    const r = redactLogins('Login: qa@acme.test\nPassword: Hunter2!\nlicense key = ABCD-1234-XY.\napi token is t0k3n_abc\nSee the order.')
    expect(r.text).toBe('Login: qa@acme.test\nPassword: [in the run\'s logins.md]\nlicense key = [in the run\'s logins.md].\napi token is [in the run\'s logins.md]\nSee the order.')
    expect(r.found).toEqual([{ label: 'Password', value: 'Hunter2!' }, { label: 'license key', value: 'ABCD-1234-XY' }, { label: 'token', value: 't0k3n_abc' }])
  })
  test('a password alone on the line under an email', () => {
    const r = redactLogins('try this user\nqa@acme.test\nW1nter#2026\nthanks')
    expect(r.text).toBe("try this user\nqa@acme.test\n[in the run's logins.md]\nthanks")
    expect(r.found).toEqual([{ label: 'password', value: 'W1nter#2026' }])
  })
  test('words that only look like labels, and short values, stay', () => {
    const t = 'The password field is shown twice.\nPIN: 12\nThe token list'
    expect(redactLogins(t)).toEqual({ text: t, found: [] })
  })
})

describe('maskLogins', () => {
  test('every known value masked wherever it appears', () => {
    expect(maskLogins('adb shell input text Hunter2! && echo Hunter2!', ['Hunter2!'])).toBe('adb shell input text •••••• && echo ••••••')
    expect(maskLogins('nothing here', [])).toBe('nothing here')
  })
})

describe('the transcript', () => {
  test("the run's login values are masked before the entry is kept or shown", () => {
    const data = mkdtempSync(join(tmpdir(), 'flow-mask-'))
    mkdirSync(join(data, 'runs', 'r'), { recursive: true })
    writeFileSync(join(data, 'runs', 'r', 'logins.md'), 'email: qa@acme.test\npassword: Hunter2!x\n')
    const kept = appendTranscript(data, 'r', { kind: 'tool', id: 't1', name: 'Bash', input: { command: 'adb shell input text Hunter2!x' }, at: 1, own: true } as never)
    expect(JSON.stringify(kept)).not.toContain('Hunter2!x')
    expect(readFileSync(join(data, 'runs', 'r', 'transcript.jsonl'), 'utf8')).toContain('adb shell input text ••••••')
  })
})
