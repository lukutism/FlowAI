#!/usr/bin/env bun
/**
 * The `flow` MCP server of a run's agent session (stdio, one JSON-RPC message a line). It lists and calls the run's
 * tools through flow's service: FLOW_RUN names the run, FLOW_DATA flow's data folder. It reads flow's token itself,
 * so the agent never sees it; every call is for this run only.
 */
import { connect } from './daemon.ts'
import type { FlowClient } from './client.ts'

type Msg = { jsonrpc: '2.0'; id?: number | string; method?: string; params?: Record<string, unknown> }

export async function serveMcp(o: { run: string; client: () => Promise<FlowClient | null>; input: AsyncIterable<Uint8Array>; write: (line: string) => void }) {
  let c: FlowClient | null = null
  const service = async () => (c?.connected ? c : (c = await o.client()))
  const answer = (id: Msg['id'], result: unknown) => o.write(JSON.stringify({ jsonrpc: '2.0', id, result }))
  const fail = (id: Msg['id'], code: number, message: string) => o.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }))
  const handle = async (m: Msg) => {
    if (m.id === undefined) return // a notification (initialized, cancelled)
    if (m.method === 'initialize') return answer(m.id, { protocolVersion: (m.params?.protocolVersion as string) ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'flow', version: '1' } })
    if (m.method === 'ping') return answer(m.id, {})
    const s = await service()
    if (m.method === 'tools/list') {
      if (!s) return answer(m.id, { tools: [] })
      return answer(m.id, { tools: await s.tools(o.run).catch(() => []) })
    }
    if (m.method === 'tools/call') {
      if (!s) return answer(m.id, { content: [{ type: 'text', text: "flow's service is not running: the tool can't be called now" }], isError: true })
      const r = await s.tool(o.run, String(m.params?.name ?? ''), (m.params?.arguments as Record<string, unknown>) ?? {})
      return answer(m.id, { content: [{ type: 'text', text: r.text }], isError: !r.ok })
    }
    fail(m.id, -32601, `no method ${m.method}`)
  }
  let buf = ''
  const dec = new TextDecoder()
  for await (const chunk of o.input) {
    buf += dec.decode(chunk, { stream: true })
    let i: number
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
      if (!line) continue
      let m: Msg
      try { m = JSON.parse(line) } catch { fail(null as never, -32700, 'not JSON'); continue }
      void handle(m).catch(e => fail(m.id, -32603, (e as Error).message))
    }
  }
  ;(c as FlowClient | null)?.close()
}

/** the run's MCP server on stdio: FLOW_RUN names the run, FLOW_DATA flow's data folder */
export async function runMcp() {
  const run = process.env.FLOW_RUN ?? '', data = process.env.FLOW_DATA ?? ''
  await serveMcp({ run, client: () => connect(data).catch(() => null), input: Bun.stdin.stream(), write: l => { process.stdout.write(l + '\n') } })
  process.exit(0)
}

if (import.meta.main) await runMcp()
