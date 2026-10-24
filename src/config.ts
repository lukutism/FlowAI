import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

/** A project: where its tickets and code live and how its changes are checked. One JSON file per project. */

const path = z.string().transform(p => (p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(2)) : p))

const azure = z.object({ kind: z.literal('azure'), org: z.string().url(), project: z.string() })
const jira = z.object({ kind: z.literal('jira'), site: z.string().url(), key: z.string() })
const github = z.object({ kind: z.literal('github'), repo: z.string().regex(/^[^/]+\/[^/]+$/) })

const verifyStep = z.object({
  name: z.string(),
  kind: z.enum(['tsc', 'eslint', 'jest', 'command']),
  /** {files}: the changed files; {json}: a file the step writes its findings to */
  cmd: z.string(),
  changedOnly: z.boolean().default(false),
  ext: z.array(z.string()).optional(),
})

const repo = z.object({
  key: z.string(),
  path,
  defaultBase: z.string(),
  /** branch patterns a ticket may name as its base (release lines) */
  releaseBases: z.array(z.string()).default([]),
  install: z.string().optional(),
  verify: z.array(verifyStep),
})

const project = z.object({
  key: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string(),
  tracker: z.discriminatedUnion('kind', [azure, jira, github]),
  forge: z.discriminatedUnion('kind', [azure, github]),
  worktrees: path,
  repos: z.array(repo).min(1),
  agent: z.object({ cli: z.literal('claude').default('claude'), maxParallel: z.number().int().min(1).default(2) }).default({}),
  /** start agent turns only while the plan windows are under these shares */
  usage: z.object({ fiveHour: z.number().min(0).max(1).default(0.9), week: z.number().min(0).max(1).default(0.95) }).default({}),
  plan: z.object({ deadlineMinutes: z.number().int().positive().default(30) }).default({}),
  /** an independent reviewer (a fresh, read-only claude session) before ship */
  review: z.object({ enabled: z.boolean().default(true) }).default({}),
})

export type Project = z.infer<typeof project>
export type Repo = Project['repos'][number]
export type VerifyStep = Repo['verify'][number]

export function parseProject(json: unknown, source: string): Project {
  const r = project.safeParse(json)
  if (r.success) return r.data
  throw new Error(r.error.issues.map(i => `${source}: ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n'))
}

export const loadProject = (file: string): Project => parseProject(JSON.parse(readFileSync(file, 'utf8')), file)
