import { describe, expect, test } from 'bun:test'
import { serveMcp } from '../src/mcp.ts'
import type { FlowClient } from '../src/client.ts'

// The run's flow MCP server speaks MCP on stdio (a JSON-RPC message a line) and asks flow's service for the run's tools.
async function talk(lines: object[], client: Partial<FlowClient> | null) {
  const out: Record<string, unknown>[] = []
  const input = (async function* () { for (const l of lines) yield new TextEncoder().encode(JSON.stringify(l) + '\n') })()
  await serveMcp({ run: 'fso-1', client: async () => (client ? ({ connected: true, close() {}, ...client } as unknown as FlowClient) : null), input, write: l => out.push(JSON.parse(l)) })
  await Bun.sleep(10)
  return out
}
describe('the flow MCP server', () => {
  test('initialize, list the run\'s tools, call one: the call goes to the service for this run only', async () => {
    const calls: unknown[] = []
    const out = await talk([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'verify', arguments: {} } },
    ], {
      tools: async run => { calls.push(['tools', run]); return [{ name: 'verify', description: 'd', inputSchema: { type: 'object', properties: {} } }] },
      tool: async (run, name, args) => { calls.push(['tool', run, name, args]); return { ok: false, text: 'verify: 1 new finding' } },
    })
    expect(out.find(m => m.id === 1)).toMatchObject({ result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'flow' } } })
    expect(out.find(m => m.id === 2)).toMatchObject({ result: { tools: [{ name: 'verify' }] } })
    expect(out.find(m => m.id === 3)).toMatchObject({ result: { content: [{ type: 'text', text: 'verify: 1 new finding' }], isError: true } })
    expect(calls).toEqual([['tools', 'fso-1'], ['tool', 'fso-1', 'verify', {}]])
    expect(out).toHaveLength(3) // no answer to a notification
  })
  test('with the service down a call says so instead of hanging', async () => {
    const out = await talk([{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'verify' } }], null)
    expect(out[0]).toMatchObject({ result: { isError: true, content: [{ text: expect.stringMatching(/not running/) }] } })
  })
})
