import type { Question } from './run.ts'

/**
 * The agent's plan (plan.md in the run folder): a first paragraph that says what will change, then sections.
 * "## Open questions" lists `- Q1: <question> — default: <answer>`; `(held)` after the id marks a question that
 * decides whether behaviour changes, which only the human answers. "none" means no questions.
 */
export function parsePlan(md: string): { summary: string; questions: Question[] } {
  const body = md.replace(/^#\s.*\n/, '')
  const summary = (body.split(/\n\s*\n/).map(p => p.trim()).find(p => p && !p.startsWith('#')) ?? '').replace(/\s+/g, ' ')
  const section = /^##\s+Open questions\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/im.exec(md)?.[1] ?? ''
  const questions: Question[] = []
  for (const line of section.split('\n')) {
    const m = /^\s*[-*]\s+(?:(Q\d+)\s*(\(held\))?\s*:\s*)?(.+)$/i.exec(line)
    if (!m || (!m[1] && /^none\b/i.test(m[3]!))) continue
    const id = m[1]?.toUpperCase() ?? `Q${questions.length + 1}`
    const d = /^(.*?)\s*[—–-]+\s*default:\s*(.+)$/i.exec(m[3]!.trim())
    if (!d) throw new Error(`${id} has no default ("— default: <answer>"): flow needs one to proceed when you don't answer`)
    questions.push({ id, text: d[1]!.trim(), default: d[2]!.trim(), held: !!m[2] })
  }
  return { summary, questions }
}

const field = (md: string, name: string) => new RegExp(`^${name}:[ \\t]*(.*)$`, 'mi').exec(md)?.[1]?.trim()
function sections(md: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  let cur: string[] | undefined
  for (const line of md.split('\n')) {
    const h = /^##\s+(.+?)\s*$/.exec(line)
    if (h) out.set(h[1]!.toLowerCase(), (cur = []))
    else cur?.push(line)
  }
  return out
}

/**
 * What the plan still lacks, each in the form it takes: the definition of done hwt asked for. A bug says how it was
 * reproduced (a mocked test passed on a wrong fix once); a project with release lines says which lines the fix is
 * for; tests or comments in the PR say who asked (reviewers took them out of most PRs); the design choice, the
 * acceptance criteria with their checks, what must not change; "none" open questions says why.
 */
export function planGaps(md: string, o: { bug: boolean; releaseLines: boolean }): string[] {
  const s = sections(md), gaps: string[] = []
  const filled = (v?: string) => !!v && !/^<.*>$/.test(v)
  const repro = field(md, 'Repro')
  if (o.bug) {
    const [word, why] = (repro ?? '').split(/\s+[—–-]+\s+/)
    const kind = /^(live|test|mocked|not-reproduced)$/i.exec(word?.trim() ?? '')?.[1]?.toLowerCase()
    if (!kind) gaps.push('Repro: live | test | mocked | not-reproduced — <what you did>')
    else if ((kind === 'mocked' || kind === 'not-reproduced') && !why?.trim()) gaps.push(`Repro: why (${kind} — <why live is not possible>)`)
  }
  if (o.releaseLines && !filled(field(md, 'Target lines'))) gaps.push('Target lines: this base only | also <lines> — <why>')
  const extras = field(md, 'PR extras')
  if (!extras) gaps.push('PR extras: none | tests | comments — <who asked>')
  else {
    const [what, who] = extras.split(/\s+[—–]+\s+/)
    const asked = [/\btests?\b/i.test(what ?? '') && 'tests', /\bcomments?\b/i.test(what ?? '') && 'comments'].filter(Boolean)
    if (asked.length && !who?.trim()) gaps.push(`PR extras: who asked (${asked.join(', ')} — <the human's or the ticket's ask>)`)
  }
  if (!(s.get('problem') ?? []).some(l => filled(l.trim()))) gaps.push('Problem')
  const design = s.get('design choice')
  if (!design) gaps.push('Design choice (Smallest option, Reuses, Rejected)')
  else for (const part of ['Smallest option', 'Reuses', 'Rejected']) {
    const v = design.map(l => new RegExp(`^\\s*-?\\s*${part}:\\s*(.*)$`, 'i').exec(l)?.[1]?.trim()).find(x => x !== undefined)
    if (!filled(v)) gaps.push(`Design choice: ${part}`)
  }
  const criteria = (s.get('acceptance criteria') ?? []).map(l => /^\s*-\s*(AC\d+):\s*(.+)$/.exec(l)).filter(m => m !== null)
  if (!criteria.length) gaps.push('Acceptance criteria (- AC1: WHEN … THEN … — check: …)')
  for (const m of criteria) if (!filled(/check:\s*(.+)$/i.exec(m[2]!)?.[1]?.trim())) gaps.push(`${m[1]}: check`)
  if (!(s.get('unchanged behavior') ?? []).some(l => /^\s*-\s*U\d+:/.test(l))) gaps.push('Unchanged behavior (- U1: WHEN … THEN still … — check: …)')
  const open = s.get('open questions')
  if (!open) gaps.push('Open questions')
  else if (open.some(l => /^\s*(?:-\s*)?none\s*$/i.test(l))) gaps.push('Open questions: none — say why nothing is open')
  return gaps
}

const HEADER_MAX = 100

/** `fix(cmms): #186278 Fix asset list memory crash`: conventional (commitlint), the ticket in the subject */
export function commitMessage(ticket: { id: number | string; title: string; kind: 'bug' | 'feature' }, files: string[], repoKey: string): string {
  const areas = new Set(files.map(f => /^(?:apps|packages)\/([^/]+)\//.exec(f)?.[1]).filter(Boolean))
  const head = `${ticket.kind === 'bug' ? 'fix' : 'feat'}(${areas.size === 1 ? [...areas][0] : repoKey}): `
  // a colon would end commitlint's header parse early; a trailing full stop is refused
  let subject = `${ticket.id === '' ? '' : `#${ticket.id} `}${ticket.title}`.trim().replace(/\s*:\s+/g, ' - ').replace(/[.\s]+$/, '')
  if (head.length + subject.length > HEADER_MAX) subject = subject.slice(0, HEADER_MAX - head.length - 1).replace(/\s+\S*$/, '').replace(/[.,;:\s]+$/, '') + '…'
  return head + subject
}

/** the PR title's text: pr.md's first heading, without a conventional-commit prefix (the ticket key goes in front) */
export function prSummary(pr: string, fallback: string): string {
  const h = /^#\s+(.+)$/m.exec(pr)?.[1]?.trim()
  return h ? h.replace(/^[a-z]+(\([^)]*\))?!?:\s*/i, '') : fallback
}
