/**
 * Turns a raw `claude -p --output-format stream-json` recording into a fixture that is safe for a public repo.
 * Raw recordings carry the user's setup: plugin hook output (work notes), MCP server and plugin names, local paths.
 *
 *   bun scripts/sanitize-recording.ts <raw.jsonl> <fixture.jsonl>
 */
import { readFileSync, writeFileSync } from 'node:fs'

/** words that must never reach a fixture; extend when a new private name shows up */
export const PRIVATE = [/osapiens/i, /\bbkw\b/i, /nordex/i, /lukas/i, /malinauskas/i, /\/Users\/[^/"]+/, /field-service/i]

/** the user's setup as init and commands_changed describe it: names and descriptions of their plugins, skills, MCP servers */
const SETUP_LISTS = ['tools', 'mcp_servers', 'plugins', 'agents', 'skills', 'slash_commands', 'commands', 'memory_paths', 'output_style']

export function sanitizeLine(line: string): string | null {
  if (!line.startsWith('{')) return null
  const e = JSON.parse(line) as Record<string, unknown>
  // hook events come from the user's own plugins: their output is private and not part of the CLI protocol we test
  if (e.type === 'system' && (e.subtype === 'hook_started' || e.subtype === 'hook_response')) return null
  if (e.type === 'system') {
    for (const k of SETUP_LISTS) {
      const v = e[k]
      if (Array.isArray(v)) e[k] = { count: v.length }
      else if (v && typeof v === 'object') e[k] = { count: Object.keys(v).length }
    }
  }
  const text = JSON.stringify(e)
    .replace(/\/Users\/[^/"\\]+/g, '/home/user')
    .replace(/-Users-[^-/"\\]+/g, '-home-user')
    .replace(/\/private\/tmp\/[^"\\]*/g, '/tmp/x')
    .replace(/\/tmp\/cc-socks\/\d+\.sock/g, '/tmp/cc.sock')
  return text
}

export function sanitize(raw: string): string {
  const out = raw.split('\n').map(sanitizeLine).filter((l): l is string => l !== null)
  const joined = out.join('\n') + '\n'
  const leak = PRIVATE.find(p => p.test(joined))
  if (leak) throw new Error(`fixture still matches ${leak}: extend sanitizeLine before publishing`)
  return joined
}

if (import.meta.main) {
  const [from, to] = process.argv.slice(2)
  if (!from || !to) { console.error('usage: bun scripts/sanitize-recording.ts <raw.jsonl> <fixture.jsonl>'); process.exit(1) }
  writeFileSync(to, sanitize(readFileSync(from, 'utf8')))
  console.log(`${to}: ${readFileSync(to, 'utf8').split('\n').filter(Boolean).length} events`)
}
