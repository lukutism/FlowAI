/**
 * Turns a raw `claude -p --output-format stream-json` recording into a fixture that is safe for a public repo.
 * Raw recordings carry the user's setup: plugin hook output (work notes), MCP server and plugin names, local paths.
 *
 *   bun scripts/sanitize-recording.ts <raw.jsonl> <fixture.jsonl>
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Words that must never reach a fixture: local paths here, and the names private to the user (customers, the
 * employer, their own) from a file outside the repo, one pattern a line (~/.config/flow/private-patterns.txt), so
 * the list itself is never published.
 */
const LOCAL = join(homedir(), '.config', 'flow', 'private-patterns.txt')
export const PRIVATE: RegExp[] = [/\/Users\/[^/"]+/, ...(existsSync(LOCAL) ? readFileSync(LOCAL, 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')).map(l => new RegExp(l, 'i')) : [])]

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

export function sanitize(raw: string, patterns: RegExp[] = PRIVATE): string {
  const out = raw.split('\n').map(sanitizeLine).filter((l): l is string => l !== null)
  const joined = out.join('\n') + '\n'
  const leak = patterns.find(p => p.test(joined))
  if (leak) throw new Error(`fixture still matches ${leak}: extend sanitizeLine before publishing`)
  return joined
}

if (import.meta.main) {
  const [from, to] = process.argv.slice(2)
  if (!from || !to) { console.error('usage: bun scripts/sanitize-recording.ts <raw.jsonl> <fixture.jsonl>'); process.exit(1) }
  writeFileSync(to, sanitize(readFileSync(from, 'utf8')))
  console.log(`${to}: ${readFileSync(to, 'utf8').split('\n').filter(Boolean).length} events`)
}
