import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const GUARD = join(import.meta.dir, 'guard.ts')
const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/**
 * The run's settings file, passed with --settings. The CLI merges it with the user's own settings, so their
 * plugins, skills, MCP servers and hooks all stay; flow adds only its guard.
 */
export function writeRunSettings(o: { dir: string; worktree: string; allow?: string[] }): string {
  const command = `FLOW_WORKTREE=${sh(o.worktree)} FLOW_ALLOW=${sh((o.allow ?? []).join(':'))} ${sh(process.execPath)} ${sh(GUARD)}`
  const settings = { hooks: { PreToolUse: [{ matcher: 'Bash|Edit|Write|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command }] }] } }
  mkdirSync(o.dir, { recursive: true })
  const file = join(o.dir, 'settings.json')
  writeFileSync(file, JSON.stringify(settings, null, 2) + '\n')
  return file
}
