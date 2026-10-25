import { describe, expect, test } from 'bun:test'
import { sanitize, sanitizeLine } from '../scripts/sanitize-recording.ts'

// Raw recordings carry the user's plugin output and setup; fixtures go to a public repo.
describe('sanitize-recording', () => {
  test('hook output from the user\'s plugins is dropped entirely', () => {
    expect(sanitizeLine(JSON.stringify({ type: 'system', subtype: 'hook_response', stdout: 'notes about a customer' }))).toBeNull()
  })
  test('the setup lists become counts; paths lose the user name', () => {
    const out = JSON.parse(sanitizeLine(JSON.stringify({ type: 'system', subtype: 'init', tools: ['a', 'b'], mcp_servers: [{ name: 'internal' }], memory_paths: { auto: '/x' }, cwd: '/Users/someone/projects/x' }))!)
    expect(out).toMatchObject({ tools: { count: 2 }, mcp_servers: { count: 1 }, memory_paths: { count: 1 }, cwd: '/home/user/projects/x' })
  })
  test('a fixture that would still name something private is refused, not written', () => {
    // the private names come from a local file; here a stand-in
    expect(() => sanitize(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'the Globex patch' }] } }), [/globex/i])).toThrow(/globex/i)
  })
})
