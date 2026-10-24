/**
 * The `claude -p --output-format stream-json --verbose` stream, reduced to what the engine acts on.
 * Shapes come from real subscription sessions (spike/FINDINGS.md, test/fixtures/).
 */

export interface Window { utilization: number; resetsAt: number; status: string }
export interface Tokens { input: number; output: number; cacheRead: number; cacheWrite: number }

export type AgentEvent =
  | { kind: 'session'; session: string; model: string; subscription: boolean }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; id: string; name: string; input: Record<string, unknown> }
  | { kind: 'denied'; tool: string; input: Record<string, unknown> }
  | { kind: 'compaction'; trigger: string; before: number; after: number }
  | { kind: 'usage'; windows: { fiveHour?: Window; week?: Window } }
  | { kind: 'result'; ok: boolean; text: string; turns: number; reason: string; session: string; tokens: Tokens }

type Json = Record<string, any>

const window = (w: Json | undefined): Window | undefined =>
  w ? { utilization: Number(w.utilization ?? 0), resetsAt: Number(w.resetsAt ?? 0), status: String(w.status ?? '') } : undefined

/** one stream line → the engine's events (none for lines it doesn't act on) */
export function parseLine(line: string): AgentEvent[] {
  if (!line.startsWith('{')) return []
  let e: Json
  try { e = JSON.parse(line) } catch { return [] }
  if (e.type === 'system' && e.subtype === 'init')
    return [{ kind: 'session', session: String(e.session_id), model: String(e.model), subscription: e.apiKeySource === 'none' }]
  if (e.type === 'system' && e.subtype === 'compact_boundary') {
    const m: Json = e.compact_metadata ?? {}
    return [{ kind: 'compaction', trigger: String(m.trigger ?? ''), before: Number(m.pre_tokens ?? 0), after: Number(m.post_tokens ?? 0) }]
  }
  if (e.type === 'rate_limit_event') {
    const w: Json = e.rate_limit_info?.unifiedWindows ?? {}
    return [{ kind: 'usage', windows: { fiveHour: window(w.five_hour), week: window(w.seven_day) } }]
  }
  if (e.type === 'assistant') {
    const out: AgentEvent[] = []
    for (const b of (e.message?.content ?? []) as Json[]) {
      if (b.type === 'tool_use') out.push({ kind: 'tool', id: String(b.id), name: String(b.name), input: b.input ?? {} })
      else if (b.type === 'text' && b.text) out.push({ kind: 'text', text: String(b.text) })
    }
    return out
  }
  if (e.type === 'result') {
    const u: Json = e.usage ?? {}
    const denied: AgentEvent[] = ((e.permission_denials ?? []) as Json[]).map(d => ({ kind: 'denied', tool: String(d.tool_name), input: d.tool_input ?? {} }))
    return [...denied, {
      kind: 'result', ok: !e.is_error, text: String(e.result ?? ''), turns: Number(e.num_turns ?? 0),
      reason: String(e.terminal_reason ?? e.subtype ?? ''), session: String(e.session_id ?? ''),
      tokens: { input: Number(u.input_tokens ?? 0), output: Number(u.output_tokens ?? 0), cacheRead: Number(u.cache_read_input_tokens ?? 0), cacheWrite: Number(u.cache_creation_input_tokens ?? 0) },
    }]
  }
  return []
}

export const parseStream = (text: string): AgentEvent[] => text.split('\n').flatMap(parseLine)
