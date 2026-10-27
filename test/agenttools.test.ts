import { describe, expect, test } from 'bun:test'
import { offSettings, toolsFromInit } from '../src/agenttools.ts'

// What a project's agents get (as you do: your plugins, skills, MCP servers, the repo's), read from a session's
// first message; and what the project turns off, as the agents' own settings (yours stay as they are).
describe('the agents\' plugins, skills and MCP servers', () => {
  const init = { type: 'system', subtype: 'init', plugins: [{ name: 'crit' }, { name: 'figma' }], skills: ['crit', 'crit:crit', 'figma:figma-use', 'agent-browser'],
    mcp_servers: [{ name: 'codegraph' }, { name: 'plugin:figma:figma' }, { name: 'claude.ai Gmail' }, { name: 'flow' }] }
  test("read from the session's first message: plugins by id, skills that aren't a plugin's, servers that aren't a plugin's or flow's", () => {
    expect(toolsFromInit(init, [{ id: 'crit@crit' }, { id: 'figma@claude-plugins-official' }])).toEqual({
      plugins: [{ id: 'crit@crit', name: 'crit' }, { id: 'figma@claude-plugins-official', name: 'figma' }],
      skills: ['agent-browser', 'crit'], mcp: ['claude.ai Gmail', 'codegraph'],
    })
  })
  test("turned off in the agents' settings: the plugin, the skill, the server (not started, and its tools denied)", () => {
    expect(offSettings({ plugins: ['crit@crit'], skills: ['agent-browser'], mcp: ['claude.ai Gmail'] })).toEqual({
      enabledPlugins: { 'crit@crit': false }, skillOverrides: { 'agent-browser': 'off' },
      deniedMcpServers: [{ serverName: 'claude.ai Gmail' }], deny: ['mcp__claude_ai_Gmail'],
    })
    expect(offSettings({ plugins: [], skills: [], mcp: [] })).toEqual({})
  })
})
