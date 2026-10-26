import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const GUARD = join(import.meta.dir, 'guard.ts')
const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
const expand = (p: string) => resolve(p.replace(/^~(?=\/|$)/, homedir()))

/**
 * The run's settings file, passed with --settings. The CLI merges it with the user's own settings, so their
 * plugins, skills, MCP servers and hooks all stay; flow adds only its guard.
 * deny: files the agent must not read (flow's token).
 */
export function writeRunSettings(o: { dir: string; worktree: string; allow?: string[]; deny?: string[]; sandbox?: Record<string, unknown>; claudeMdExcludes?: string[]; denyTools?: string[]; allowTools?: string[] }): string {
  const deny = o.deny ?? []
  // a guard that fails to start would otherwise let the tool through (a hook's error is not a refusal); exit 2 blocks
  const command = `FLOW_WORKTREE=${sh(o.worktree)} FLOW_ALLOW=${sh((o.allow ?? []).join(':'))} FLOW_DENY=${sh(deny.join(':'))} ${sh(process.execPath)} ${sh(GUARD)} || { echo 'flow guard failed to run' >&2; exit 2; }`
  const settings: Record<string, unknown> = { hooks: { PreToolUse: [{ matcher: 'Bash|Edit|Write|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command }] }] } }
  const denied = [...deny.map(f => `Read(/${f})`), ...(o.denyTools ?? [])]
  if (denied.length || o.allowTools?.length) settings.permissions = { ...(denied.length ? { deny: denied } : {}), ...(o.allowTools?.length ? { allow: o.allowTools } : {}) }
  // CLAUDE.md files above the worktree meant for something else (another tool's agents): not loaded
  if (o.claudeMdExcludes?.length) settings.claudeMdExcludes = o.claudeMdExcludes.map(p => (p.startsWith('~/') ? expand(p) : p))
  // the project's OS sandbox (Claude Code's): shell commands can then write only where it allows, the run's own
  // folders first; this closes what the guard can't see (a redirect such as echo > ../x)
  if (o.sandbox) {
    const sb = structuredClone(o.sandbox) as { filesystem?: { allowWrite?: string[]; denyWrite?: string[]; denyRead?: string[] } }
    const allowWrite = [o.worktree, ...(o.allow ?? []), ...(sb.filesystem?.allowWrite ?? [])]
    // folders on PATH inside a writable one (~/.bun/bin in ~/.bun): a binary planted there runs later, unsandboxed
    const writable = allowWrite.map(expand)
    const onPath = (process.env.PATH ?? '').split(':').filter(Boolean).map(expand)
      .filter((d, i, all) => all.indexOf(d) === i && writable.some(w => d === w || d.startsWith(w + '/')))
    sb.filesystem = { ...sb.filesystem, allowWrite }
    if (onPath.length) sb.filesystem.denyWrite = [...(sb.filesystem.denyWrite ?? []), ...onPath]
    if (deny.length) sb.filesystem.denyRead = [...(sb.filesystem.denyRead ?? []), ...deny]
    settings.sandbox = sb
  }
  mkdirSync(o.dir, { recursive: true })
  const file = join(o.dir, 'settings.json')
  writeFileSync(file, JSON.stringify(settings, null, 2) + '\n')
  return file
}
