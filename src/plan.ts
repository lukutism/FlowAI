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
    if (!m) continue
    const id = m[1]?.toUpperCase() ?? `Q${questions.length + 1}`
    const d = /^(.*?)\s*[—–-]+\s*default:\s*(.+)$/i.exec(m[3]!.trim())
    if (!d) throw new Error(`${id} has no default ("— default: <answer>"): flow needs one to proceed when you don't answer`)
    questions.push({ id, text: d[1]!.trim(), default: d[2]!.trim(), held: !!m[2] })
  }
  return { summary, questions }
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
