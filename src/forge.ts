import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { azureDraftPr, azurePrState, type Az } from './azure.ts'
import type { Project } from './config.ts'

/** Where pull requests go. repository: the repo's name on the host (from its origin URL). */
export interface Forge {
  draftPr(o: { repository: string; head: string; base: string; title: string; body: string; workItem?: number }): Promise<{ number: number; url: string }>
  /** whether a PR flow opened is still open, merged or closed (unknown: the host could not be asked) */
  prState(pr: { number: number; url: string }): Promise<'open' | 'merged' | 'closed' | 'unknown'>
  /** a comment on a PR flow opened (the agent's description, where the project's PR body is just the ticket link) */
  comment?(pr: { number: number; url: string }, body: string): Promise<void>
}

export type GhResult = { code: number; out: string; err: string }
export type Gh = (args: string[]) => GhResult | Promise<GhResult>
export const realGh: Gh = async args => {
  const p = Bun.spawn(['gh', ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  return { code: await p.exited, out, err }
}

export const azureForge = (az: Az, f: { org: string; project: string }): Forge => ({
  draftPr: o => azureDraftPr(az, f, o.repository, { ...o, workItem: o.workItem ?? 0 }),
  prState: pr => azurePrState(az, f, pr.number),
})

/** GitHub through gh; the body goes through a temp file (no argv length or quoting limits) */
export function githubForge(f: { kind: 'github'; owner: string }, gh: Gh = realGh): Forge {
  return {
    async draftPr(o) {
      const dir = mkdtempSync(join(tmpdir(), 'flow-pr-'))
      try {
        writeFileSync(join(dir, 'body.md'), o.body)
        const r = await gh(['pr', 'create', '-R', `${f.owner}/${o.repository}`, '--draft', '--base', o.base, '--head', o.head, '--title', o.title, '--body-file', join(dir, 'body.md')])
        if (r.code !== 0) {
          if (/gh auth login|not logged in|authentication required/i.test(r.err)) throw new Error('gh is not logged in: run gh auth login')
          throw new Error(`gh pr create failed: ${(r.err || r.out).trim().split('\n')[0]}`)
        }
        const url = /https:\/\/\S+\/pull\/(\d+)/.exec(r.out)
        if (!url) throw new Error(`gh pr create printed no PR link: ${r.out.trim().split('\n')[0]}`)
        return { number: Number(url[1]), url: url[0] }
      } finally { rmSync(dir, { recursive: true, force: true }) }
    },
    async comment(pr, body) {
      const repo = /github\.com\/([^/]+\/[^/]+)\/pull\//.exec(pr.url)?.[1]
      if (!repo) throw new Error(`not a GitHub PR: ${pr.url}`)
      const dir = mkdtempSync(join(tmpdir(), 'flow-pr-'))
      try {
        writeFileSync(join(dir, 'comment.md'), body)
        const r = await gh(['pr', 'comment', String(pr.number), '-R', repo, '--body-file', join(dir, 'comment.md')])
        if (r.code !== 0) throw new Error(`gh pr comment failed: ${(r.err || r.out).trim().split('\n')[0]}`)
      } finally { rmSync(dir, { recursive: true, force: true }) }
    },
    async prState(pr) {
      const repo = /github\.com\/([^/]+\/[^/]+)\/pull\//.exec(pr.url)?.[1]
      if (!repo) return 'unknown'
      const r = await gh(['pr', 'view', String(pr.number), '-R', repo, '--json', 'state'])
      if (r.code !== 0) return 'unknown'
      try {
        const state = (JSON.parse(r.out) as { state?: string }).state
        return state === 'OPEN' ? 'open' : state === 'MERGED' ? 'merged' : state === 'CLOSED' ? 'closed' : 'unknown'
      } catch { return 'unknown' }
    },
  }
}

export function forgeFor(p: Project, deps: { az: Az; gh?: Gh }): Forge {
  if (p.forge.kind === 'azure') return azureForge(deps.az, p.forge)
  return githubForge(p.forge, deps.gh)
}
