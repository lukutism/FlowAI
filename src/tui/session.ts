/**
 * The Agent pane's lines: the session the way Claude Code shows it. ⏺ marks what the agent said and each tool it ran,
 * as Name(args), with what the tool returned under ⎿; what flow and you sent is shown whole (a long prompt folds to
 * its first lines until o shows all); refusals and turn ends stand out.
 */
import type { Entry } from '../transcript.ts'
import { hhmm, tokens } from './model.ts'

export type Seg = [text: string, color: string]
export type Line = Seg[]

export const C = { text: '#DDE2E8', secondary: '#A3ABB5', muted: '#6D7681', faint: '#434A54', accent: '#78A6EC', success: '#72C08A', warning: '#E2B35F', danger: '#EC7A70', selected: '#1B2533', panel: '#161A20' }

/** words wrapped to a width (long words are cut) */
export function wrap(text: string, width: number): string[] {
  const out: string[] = []
  for (const para of text.split('\n')) {
    let cur = ''
    for (const w of para.split(/\s+/).filter(Boolean)) {
      if (!cur) cur = w
      else if (cur.length + 1 + w.length <= width) cur += ` ${w}`
      else { out.push(cur); cur = w }
      while (cur.length > width) { out.push(cur.slice(0, width)); cur = cur.slice(width) }
    }
    out.push(cur)
  }
  while (out.length && !out[out.length - 1]) out.pop()
  return out
}

/** coloured pieces wrapped to a width, word by word (a piece may break across lines) */
export function wrapSegs(segs: Seg[], width: number): Line[] {
  const lines: Line[] = []
  let cur: Line = [], len = 0
  const put = (t: string, c: string) => { const last = cur[cur.length - 1]; if (last && last[1] === c) last[0] += t; else cur.push([t, c]); len += t.length }
  for (const [text, color] of segs) {
    for (const word of text.split(/(\s+)/).filter(Boolean)) {
      if (/^\s+$/.test(word)) { if (len && len < width) put(' ', color); continue }
      if (len && len + word.length > width) { lines.push(cur); cur = []; len = 0 }
      let w = word
      while (w.length > width) { put(w.slice(0, width - len), color); lines.push(cur); cur = []; len = 0; w = w.slice(width) }
      put(w, color)
    }
  }
  if (cur.length) lines.push(cur)
  for (const l of lines) { const last = l[l.length - 1]; if (last) last[0] = last[0].replace(/\s+$/, '') }
  return lines.length ? lines : [[]]
}

/** one line of the agent's Markdown as coloured pieces: `code` and links stand out, emphasis marks dropped */
export function inline(text: string, color: string): Seg[] {
  const out: Seg[] = []
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\[([^\]]+)\]\([^)]*\)/g
  let at = 0
  for (const m of text.matchAll(re)) {
    if (m.index > at) out.push([text.slice(at, m.index), color])
    if (m[1] !== undefined) out.push([m[1], C.accent])
    else if (m[4] !== undefined) out.push([m[4], C.accent])
    else out.push([m[2] ?? m[3] ?? '', C.text])
    at = m.index + m[0].length
  }
  if (at < text.length) out.push([text.slice(at), color])
  return out
}

/** the agent's Markdown as lines: headings, bullets, numbered items, code blocks; first line after ⏺, the rest indented */
function markdown(text: string, width: number, color: string): Line[] {
  const out: Line[] = []
  let code = false
  for (const raw of text.replace(/\s+$/, '').split('\n')) {
    if (/^\s*```/.test(raw)) { code = !code; continue }
    if (code) { out.push([['│ ', C.faint], [raw.slice(0, width - 2), C.secondary]]); continue }
    if (!raw.trim()) { if (out.length) out.push([]); continue }
    const h = /^#{1,6}\s+(.*)$/.exec(raw)
    const b = /^(\s*)[-*+]\s+(.*)$/.exec(raw)
    const n = /^(\s*)(\d+[.)])\s+(.*)$/.exec(raw)
    if (h) out.push(...wrapSegs(inline(h[1]!, C.text), width))
    else if (b || n) {
      const lead = b ? `${b[1]}• ` : `${n![1]}${n![2]} `
      wrapSegs(inline(b ? b[2]! : n![3]!, color), width - lead.length).forEach((l, i) => out.push([[i ? ' '.repeat(lead.length) : lead, C.muted], ...l]))
    } else out.push(...wrapSegs(inline(raw, color), width))
  }
  while (out.length && !out[out.length - 1]!.length) out.pop()
  return out
}

/** a path as the agent's worktree sees it */
const short = (p: string) => p.replace(/^.*\/\.flow\/worktrees\/[^/]+\/[^/]+\//, '').replace(/^.*\/worktrees\/[^/]+\/[^/]+\//, '')

/** what a tool call was about, in one line */
export function toolSummary(input: Record<string, unknown>): string {
  const v = input.command ?? input.file_path ?? input.notebook_path ?? input.pattern ?? input.path ?? input.url ?? input.description ?? input.query ?? input.prompt
  return typeof v === 'string' ? short(v.replace(/\s+/g, ' ')) : JSON.stringify(input).slice(0, 80)
}

/** a tool call as Claude Code names it: Bash(yarn lint), Update(src/a.ts), Grep("x"), server · tool(args) */
export function toolTitle(name: string, input: Record<string, unknown>): string {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name)
  if (mcp) return `${mcp[1]} · ${mcp[2]}(${toolSummary(input)})`
  const shown = name === 'Edit' || name === 'MultiEdit' ? 'Update' : name === 'TodoWrite' ? 'Update Todos' : name
  if (name === 'TodoWrite') return shown
  if (name === 'Grep') return `Grep("${String(input.pattern ?? '')}"${input.path ? `, ${short(String(input.path))}` : ''})`
  return `${shown}(${toolSummary(input)})`
}

/** what a tool returned, in a line or a few: counts for reads and searches, the first lines of anything else */
function resultLines(name: string, text: string, error: boolean, full: boolean): { lines: string[]; more: number } {
  const all = text.replace(/\s+$/, '').split('\n').filter((l, i, a) => l.trim() || (i > 0 && i < a.length - 1))
  if (error) return { lines: all.slice(0, full ? undefined : 2), more: full ? 0 : Math.max(0, all.length - 2) }
  if (!full) {
    if (name === 'Read') return { lines: [`Read ${all.length} line${all.length === 1 ? '' : 's'}`], more: 0 }
    if (name === 'Edit' || name === 'MultiEdit' || name === 'NotebookEdit') return { lines: ['Updated'], more: 0 }
    if (name === 'Write') return { lines: ['Written'], more: 0 }
    if (name === 'Grep' || name === 'Glob') return { lines: [all.length ? `Found ${all.length} line${all.length === 1 ? '' : 's'}` : 'Found nothing'], more: 0 }
    if (name === 'TodoWrite') return { lines: [], more: 0 }
  }
  if (!all.length) return { lines: ['(no output)'], more: 0 }
  return full ? { lines: all, more: 0 } : { lines: all.slice(0, 3), more: Math.max(0, all.length - 3) }
}

/** the session as lines for a pane of the given width; full: every prompt and tool output whole (o) */
export function sessionLines(entries: Entry[], width: number, full = false): Line[] {
  const out: Line[] = []
  const w = Math.max(16, width - 1)
  const results = new Map<string, { text: string; error: boolean }>()
  const tools: string[] = []
  for (const e of entries) {
    if (e.kind === 'toolResult') results.set(e.id, { text: e.text, error: e.error })
    if (e.kind === 'tool') tools.push(`${e.name} ${toolSummary(e.input)}`)
  }
  const under = (lines: Line[], more: number, hint: string) => {
    lines.forEach((l, i) => out.push([[i ? '    ' : '  ⎿ ', C.faint], ...l]))
    if (more) out.push([[`    … +${more} line${more === 1 ? '' : 's'}${hint}`, C.faint]])
  }
  const gap = () => { if (out.length && out[out.length - 1]!.length) out.push([]) }
  for (const e of entries) {
    const reviewer = !e.own
    if (e.kind === 'prompt') {
      gap()
      if (e.from === 'you') {
        wrapSegs([[e.text, C.text]], w - 2).forEach((l, i) => out.push(i ? [['  ', ''], ...l] : [['› ', C.accent], ...l, [`  ${hhmm(e.at)}`, C.faint]]))
      } else {
        out.push([['⏺ ', C.warning], ['flow', C.warning], [reviewer ? ' → reviewer' : '', C.muted], [`  ${hhmm(e.at)}`, C.faint]])
        const lines = e.text.replace(/\s+$/, '').split('\n').flatMap(l => wrap(l, w - 4).map(x => x || ' '))
        const shown = full ? lines : lines.slice(0, 3)
        shown.forEach((l, i) => out.push([[i ? '    ' : '  ⎿ ', C.faint], [l, C.secondary]]))
        if (lines.length > shown.length) out.push([[`    … ${lines.length - shown.length} more lines · `, C.faint], ['o', C.muted], [' shows all', C.faint]])
      }
      gap()
    } else if (e.kind === 'session') out.push([[`${reviewer ? 'reviewer' : 'claude'} · ${e.model} · session ${e.session.slice(0, 6)}`, C.faint]])
    else if (e.kind === 'text') {
      const md = markdown(e.text, w - 2, reviewer ? C.secondary : C.text)
      md.forEach((l, i) => out.push([[i ? '  ' : '⏺ ', reviewer ? C.muted : C.text], ...l]))
    } else if (e.kind === 'tool') {
      const r = results.get(e.id)
      out.push([['⏺ ', r ? (r.error ? C.danger : C.success) : C.muted], ...wrapSegs([[toolTitle(e.name, e.input), C.secondary]], w - 2)[0]!])
      if (r) {
        const { lines, more } = resultLines(e.name, r.text, r.error, full)
        under(lines.map(l => [[l.slice(0, w - 4), r.error ? C.danger : C.muted]]), more, full ? '' : ' · o shows all')
      }
    } else if (e.kind === 'denied') {
      // a refusal the tool's own result already showed is not repeated
      const seen = tools.includes(`${e.tool} ${toolSummary(e.input)}`)
      if (!seen) { out.push([['✕ ', C.danger], [toolTitle(e.tool, e.input), C.secondary]]); out.push([['  ⎿ ', C.faint], ['refused by flow', C.danger]]) }
    } else if (e.kind === 'compaction') out.push([[`── context compacted ${tokens(e.before)} → ${tokens(e.after)} ──`, C.faint]])
    else if (e.kind === 'result') {
      const n = e.tokens.input + e.tokens.output + e.tokens.cacheWrite
      out.push(e.ok
        ? [[`── turn ended · ${tokens(n)} new · ${tokens(e.tokens.cacheRead)} from cache · ${e.turns} call${e.turns === 1 ? '' : 's'} ──`, C.faint]]
        : [['── turn failed: ', C.danger], [(e.text || e.reason).split('\n')[0]!.slice(0, w - 20), C.danger], [' ──', C.danger]])
      gap()
    }
  }
  while (out.length && !out[out.length - 1]!.length) out.pop()
  return out
}

/** the agent at work: the tool it is running now, if any */
export function workingLine(entries: Entry[], since: number, now: number): Line {
  const last = [...entries].reverse().find(e => e.kind === 'tool' || e.kind === 'toolResult' || e.kind === 'text')
  const secs = Math.max(0, Math.round((now - since) / 1000))
  return [['✻ ', C.accent], ['Working… ', C.accent], [`${secs}s`, C.muted], ...(last?.kind === 'tool' ? [[` · ${toolTitle(last.name, last.input)}`, C.muted] as Seg] : [])]
}
