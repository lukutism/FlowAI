import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { azureDraftPr, type Az } from './azure.ts'
import type { Project } from './config.ts'

/** Where pull requests go. repository: the repo's name on the host (from its origin URL). */
export interface Forge {
  draftPr(o: { repository: string; head: string; base: string; title: string; body: string; workItem?: number }): { number: number; url: string }
}

export type Gh = (args: string[]) => { code: number; out: string; err: string }
export const realGh: Gh = args => {
  const r = Bun.spawnSync(['gh', ...args])
  return { code: r.exitCode, out: new TextDecoder().decode(r.stdout), err: new TextDecoder().decode(r.stderr) }
}

export const azureForge = (az: Az, f: { org: string; project: string }): Forge => ({
  draftPr: o => azureDraftPr(az, f, o.repository, { ...o, workItem: o.workItem ?? 0 }),
})

/** GitHub through gh; the body goes through a temp file (no argv length or quoting limits) */
export function githubForge(f: { kind: 'github'; owner: string }, gh: Gh = realGh): Forge {
  return {
    draftPr(o) {
      const dir = mkdtempSync(join(tmpdir(), 'flow-pr-'))
      try {
        writeFileSync(join(dir, 'body.md'), o.body)
        const r = gh(['pr', 'create', '-R', `${f.owner}/${o.repository}`, '--draft', '--base', o.base, '--head', o.head, '--title', o.title, '--body-file', join(dir, 'body.md')])
        if (r.code !== 0) {
          if (/gh auth login|not logged in|authentication required/i.test(r.err)) throw new Error('gh is not logged in: run gh auth login')
          throw new Error(`gh pr create failed: ${(r.err || r.out).trim().split('\n')[0]}`)
        }
        const url = /https:\/\/\S+\/pull\/(\d+)/.exec(r.out)
        if (!url) throw new Error(`gh pr create printed no PR link: ${r.out.trim().split('\n')[0]}`)
        return { number: Number(url[1]), url: url[0] }
      } finally { rmSync(dir, { recursive: true, force: true }) }
    },
  }
}

export function forgeFor(p: Project, deps: { az: Az; gh?: Gh }): Forge {
  if (p.forge.kind === 'azure') return azureForge(deps.az, p.forge)
  return githubForge(p.forge, deps.gh)
}
