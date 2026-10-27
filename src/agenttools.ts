import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * What a project's agents get beside flow's own tools: your plugins, skills and MCP servers, and the repo's, as in
 * your own sessions. A project can turn some off for its agents (their settings file; yours stay as they are).
 */
export interface AgentTools { plugins: { id: string; name: string }[]; skills: string[]; mcp: string[] }
export interface Off { plugins: string[]; skills: string[]; mcp: string[] }

/**
 * From a session's first message: its plugins (by id, from `claude plugin list`), the skills that aren't a plugin's
 * (those go with their plugin, named plugin:skill), the MCP servers that aren't a plugin's or flow's own.
 */
export function toolsFromInit(init: { plugins?: { name: string }[]; skills?: string[]; mcp_servers?: { name: string }[] }, installed: { id: string }[]): AgentTools {
  const idOf = (name: string) => installed.find(p => p.id.split('@')[0] === name)?.id
  const plugins = (init.plugins ?? []).flatMap(p => { const id = idOf(p.name); return id ? [{ id, name: p.name }] : [] })
  const skills = [...new Set((init.skills ?? []).filter(s => !s.includes(':')))].sort()
  const mcp = (init.mcp_servers ?? []).map(s => s.name).filter(n => !n.startsWith('plugin:') && n !== 'flow').sort()
  return { plugins, skills, mcp }
}

/** what is off, as the agents' settings: plugins disabled, skills off, servers not started (and their tools denied) */
export function offSettings(off: Off): { enabledPlugins?: Record<string, false>; skillOverrides?: Record<string, 'off'>; deniedMcpServers?: { serverName: string }[]; deny?: string[] } {
  return {
    ...(off.plugins.length ? { enabledPlugins: Object.fromEntries(off.plugins.map(id => [id, false as const])) } : {}),
    ...(off.skills.length ? { skillOverrides: Object.fromEntries(off.skills.map(s => [s, 'off' as const])) } : {}),
    // a server's tools are mcp__<its name, other characters as _>__…
    ...(off.mcp.length ? { deniedMcpServers: off.mcp.map(serverName => ({ serverName })), deny: off.mcp.map(n => `mcp__${n.replace(/[^A-Za-z0-9_-]/g, '_')}`) } : {}),
  }
}

/**
 * What an agent in this folder would get, read from a session's first message. The session is stopped as soon as
 * that comes, and it can't reach the model at all (its API address goes nowhere), so this costs no usage.
 */
export async function discoverAgentTools(cwd: string, timeoutMs = 60_000): Promise<AgentTools> {
  const dir = mkdtempSync(join(tmpdir(), 'flow-tools-'))
  try {
    writeFileSync(join(dir, 'settings.json'), '{}')
    const p = Bun.spawn(['claude', '-p', '--output-format', 'stream-json', '--verbose', '--settings', join(dir, 'settings.json'), 'x'],
      { cwd, stdout: 'pipe', stderr: 'ignore', stdin: 'ignore', env: { ...process.env, ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' } })
    const timer = setTimeout(() => p.kill(), timeoutMs)
    let init: Parameters<typeof toolsFromInit>[0] | undefined, buf = ''
    try {
      for await (const chunk of p.stdout) {
        buf += new TextDecoder().decode(chunk)
        for (let i = buf.indexOf('\n'); i >= 0 && !init; i = buf.indexOf('\n')) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1)
          try { const m = JSON.parse(line); if (m.type === 'system' && m.subtype === 'init') init = m } catch {}
        }
        if (init) break
      }
    } finally { clearTimeout(timer); p.kill() }
    if (!init) throw new Error("claude didn't start a session in time")
    const list = Bun.spawnSync(['claude', 'plugin', 'list', '--json'], { stdout: 'pipe', stderr: 'ignore' })
    let installed: { id: string }[] = []
    try { installed = JSON.parse(new TextDecoder().decode(list.stdout)) } catch {}
    return toolsFromInit(init, installed)
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
