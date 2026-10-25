import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

/** A project: where its tickets and code live and how its changes are checked. One JSON file per project. */

const path = z.string().transform(p => (p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(2)) : p))

const azure = z.object({ kind: z.literal('azure'), org: z.string().url(), project: z.string() })
/** keychain: the macOS keychain item holding the API token (never in a file) */
const jira = z.object({ kind: z.literal('jira'), site: z.string().url(), key: z.string(), email: z.string(), keychain: z.string().default('flow-jira') })
/** owner: the organisation or user; each repo's name comes from its origin URL */
const github = z.object({ kind: z.literal('github'), owner: z.string() })

const verifyStep = z.object({
  name: z.string(),
  /** vitest: its JSON report reads like jest's */
  kind: z.enum(['tsc', 'eslint', 'jest', 'vitest', 'command']),
  /** {files}: the changed files; {json}: a file the step writes its findings to */
  cmd: z.string(),
  changedOnly: z.boolean().default(false),
  ext: z.array(z.string()).optional(),
  /** run inside each package ("packages/*"), with paths relative to it */
  perPackage: z.string().optional(),
})

const repo = z.object({
  key: z.string(),
  path,
  defaultBase: z.string(),
  /** branch patterns a ticket may name as its base (release lines) */
  releaseBases: z.array(z.string()).default([]),
  install: z.string().optional(),
  verify: z.array(verifyStep),
  /** taken when a run names no repos (if none is marked, the first) */
  default: z.boolean().default(false),
  /** a web app's dev server, started for a run that asks for one: cmd with {port}; url where it answers */
  devServer: z.object({ cmd: z.string(), portStart: z.number().int().default(5300), url: z.string().default('http://localhost:{port}') }).optional(),
  /**
   * customer patches: apply puts the customer's patch in the new worktree, staged ({customer} {app} {base} {main});
   * writeBack writes the worktree's whole change back as that patch ({customer} {app} {base} {dryRun}: --dry-run or nothing)
   */
  patches: z.object({
    apply: z.string(), writeBack: z.string(),
    /** for the new-run form: prints the customer/app pairs, one a line; and says whether {customer}/{app} has a patch for {base} (exit 0) */
    choices: z.string().optional(), check: z.string().optional(),
  }).optional(),
})

/** a run's own device (emulator or simulator) and Metro; the commands and placeholders are in device.ts */
const deviceCommands = z.object({
  template: z.string().optional(),
  prepare: z.string().optional(),
  create: z.string().optional(),
  id: z.string().optional(),
  boot: z.string(),
  bootStays: z.boolean().default(false),
  ready: z.string(),
  install: z.string().optional(),
  stop: z.string().optional(),
  remove: z.string().optional(),
})
const devices = z.object({
  metro: z.string(),
  consolePortStart: z.number().int().default(5700),
  metroPortStart: z.number().int().default(8300),
  android: deviceCommands.optional(),
  ios: deviceCommands.optional(),
})

const project = z.object({
  key: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string(),
  tracker: z.discriminatedUnion('kind', [azure, jira]),
  forge: z.discriminatedUnion('kind', [azure, github]),
  worktrees: path,
  repos: z.array(repo).min(1),
  agent: z.object({ cli: z.literal('claude').default('claude'), maxParallel: z.number().int().min(1).default(2) }).default({}),
  /** start agent turns only while the plan windows are under these shares */
  usage: z.object({ fiveHour: z.number().min(0).max(1).default(0.9), week: z.number().min(0).max(1).default(0.95) }).default({}),
  plan: z.object({ deadlineMinutes: z.number().int().positive().default(30) }).default({}),
  /** naming: branch ({type} fix|feat, {id}, {key}); commit (conventional, or "<key> <summary>"); PR title and body */
  naming: z.object({
    branch: z.string().default('{type}/{id}'),
    commit: z.enum(['conventional', 'key-summary']).default('conventional'),
    prTitle: z.enum(['key-summary', 'key']).default('key-summary'),
    prBody: z.enum(['full', 'ticket-link']).default('full'),
  }).default({}),
  /** Claude Code's OS sandbox for the agents' shell commands (its settings block); flow adds the run's folders */
  sandbox: z.record(z.unknown()).optional(),
  /** an independent reviewer (a fresh, read-only claude session) before ship */
  review: z.object({ enabled: z.boolean().default(true) }).default({}),
  /** a run started with a device gets its own, booted in the first repo's worktree */
  devices: devices.optional(),
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

/** ~/.config/flow/flow.json: what holds for the whole machine (all projects share its slots) */
const settings = z.object({
  limits: z.object({ agents: z.number().int().min(1).default(2), builds: z.number().int().min(1).default(2), devices: z.number().int().min(1).default(4) }).default({}),
})
export type Settings = z.infer<typeof settings>

export function loadSettings(file: string): Settings {
  const r = settings.safeParse(existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {})
  if (r.success) return r.data
  throw new Error(r.error.issues.map(i => `${file}: ${i.path.join('.')}: ${i.message}`).join('\n'))
}
