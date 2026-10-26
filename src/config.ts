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
  /** a pattern (case-insensitive) on a ticket's target platform and tags: the new-run form picks the repos that match */
  match: z.string().optional(),
  /**
   * the app's env file, the run's own: file (relative to the worktree) from the template `from`, with `set` and the
   * login step's values (login: which variable gets the email, password, license); git-excluded, never shipped
   */
  appEnv: z.object({ file: z.string(), from: z.string().optional(), set: z.record(z.string(), z.string()).default({}), login: z.object({ email: z.string().optional(), password: z.string().optional(), license: z.string().optional() }).default({}) }).optional(),
  /** a web app's dev server, started for a run that asks for one: cmd with {port}; url where it answers */
  devServer: z.object({ cmd: z.string(), portStart: z.number().int().default(5300), url: z.string().default('http://localhost:{port}'),
    /**
     * the run's own browser (agent-browser), through a proxy that sends localhost:<appPort> to the run's port: start
     * is opened first, hosts the other hosts the agent may open (with localhost); headed shows its window
     */
    browser: z.object({ start: z.string().optional(), hosts: z.array(z.string()).default([]), appPort: z.number().int().default(3000), headed: z.boolean().default(false) }).optional(),
  }).optional(),
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
  /** the built app kept and installed again ({artifact}) while its native inputs are the same: minutes saved a run */
  cache: z.object({ inputs: z.array(z.string()).min(1), artifact: z.string(), installFrom: z.string() }).optional(),
  stop: z.string().optional(),
  remove: z.string().optional(),
  /** the app on the device (android package, iOS bundle id): the agent's device tool relaunches it */
  app: z.string().optional(),
})
const devices = z.object({
  metro: z.string(),
  consolePortStart: z.number().int().default(5700),
  metroPortStart: z.number().int().default(8300),
  /** the emulator without its window ({headless} in its boot command): less memory and CPU, seen in the browser; a run may choose otherwise */
  headless: z.boolean().default(true),
  android: deviceCommands.optional(),
  ios: deviceCommands.optional(),
})

/** whether a {placeholder} sits inside '…' or "…" in a shell command */
export function placeholderInQuotes(cmd: string): boolean {
  let q = ''
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!
    if (q) { if (c === q) q = ''; else if (c === '\\' && q === '"') i++; else if (c === '{' && /^\{\w+\}/.test(cmd.slice(i))) return true; continue }
    if (c === '\\') i++
    else if (c === "'" || c === '"') q = c
  }
  return false
}

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
  /** CLAUDE.md files (paths or globs) the agents don't load: another tool's instructions in a folder above the worktrees */
  claudeMdExcludes: z.array(z.string()).optional(),
  /** the main checkout's git-ignored files linked into each worktree (project skills, .mcp.json, .npmrc, a code index) */
  localFiles: z.array(z.string()).default([]),
  /** who flow's commits are by in this project's repos (a client's repo may need another identity than your global git one) */
  commitAs: z.preprocess(v => (v && typeof v === 'object' && !Object.keys(v).length ? undefined : v), z.object({ name: z.string().min(1), email: z.string().email() }).optional()),
  /**
   * indexes each worktree gets its own copy of (a code graph): cloned copy-on-write from the main checkout when it
   * has one (none is made), git-excluded, then sync run in the background to bring it to the run's branch
   */
  indexes: z.array(z.object({ dir: z.string(), sync: z.string().optional() })).default([]),
  /**
   * a run's environment, asked in the new-run form (or --var NAME=value) and suggested from the ticket: which cloud,
   * which application. {NAME} in an app env's values and a browser's start page; empty keeps the template's value.
   * from: follow another variable unless given; detect: a ticket field (environment, customer, application, tags),
   * mapped by pattern (case-insensitive) to a value, or taken as it is; repos: the repos it is asked for
   */
  vars: z.array(z.object({
    name: z.string().regex(/^[A-Z][A-Z0-9_]*$/), label: z.string().optional(), choices: z.array(z.string()).optional(), default: z.string().optional(),
    from: z.string().optional(), repos: z.array(z.string()).optional(),
    detect: z.object({ field: z.enum(['environment', 'customer', 'application', 'tags']), map: z.record(z.string(), z.string()).optional() }).optional(),
  })).default([]),
  /** what tools write into a worktree and must not ship: added to git's local exclude list (.git/info/exclude), which the repo's main checkout and all its worktrees share, so it applies there too */
  ignore: z.array(z.string()).default(['.argent/']),
  /** the new run's Login step: email and password always; a license field for projects whose app needs one */
  login: z.object({ license: z.boolean().default(false) }).default({}),
  /** the project's own commands, as tools the agents call by name ({worktree} {runDir} {run} {base} {id} {metroPort} and each argument; arguments are quoted) */
  tools: z.array(z.object({
    name: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/).refine(n => !['verify', 'device', 'logs', 'ticket', 'ask', 'resolve', 'block'].includes(n), "that name is one of flow's own tools"),
    description: z.string().min(1),
    cmd: z.string().min(1),
    cwd: z.enum(['worktree', 'run']).default('worktree'),
    args: z.array(z.object({ name: z.string().regex(/^[a-z][a-zA-Z0-9_]*$/).refine(n => !['run', 'worktree', 'runDir', 'base', 'id', 'metroPort', 'platform'].includes(n), "an argument can't take a built-in placeholder's name"), description: z.string() })).default([]),
  // flow quotes each value as one word; a placeholder inside quotes of the command's own would undo that
  }).refine(t => !placeholderInQuotes(t.cmd), { message: 'a {placeholder} inside quotes: leave it bare (flow quotes each value itself)', path: ['cmd'] })).default([]),
  /** tools the agents may not call (an MCP server's write tools); permission rules, as in Claude Code's settings */
  denyTools: z.array(z.string()).default([]),
  /** an independent reviewer (a fresh, read-only claude session) before ship */
  /**
   * the independent review before ship: lenses run as fresh read-only sessions in parallel (correctness: bugs and
   * the repo's rules; skeptic: root cause, criteria, the plan's and the PR's claims; simplicity: what could be cut),
   * each with at most maxTurns turns
   */
  review: z.object({ enabled: z.boolean().default(true), lenses: z.array(z.enum(['correctness', 'skeptic', 'simplicity'])).min(1).default(['correctness', 'skeptic', 'simplicity']), maxTurns: z.number().int().positive().default(30) }).default({}),
  /** what the agent should know about this project, from you (tools to check data with, where things are): a line each */
  brief: z.array(z.string()).default([]),
  /** customer patch apps by pattern on a ticket's area and title (picking → product): the form picks the patch's app */
  patchApps: z.record(z.string()).default({}),
  /** a run started with a device gets its own, booted in the first repo's worktree */
  devices: devices.optional(),
})

export type Project = z.infer<typeof project>
export type Repo = Project['repos'][number]
export type VerifyStep = Repo['verify'][number]

export function parseProject(json: unknown, source: string): Project {
  const r = project.safeParse(json)
  if (r.success) {
    // a variable follows only one named before it
    for (const [i, v] of r.data.vars.entries()) if (v.from && !r.data.vars.slice(0, i).some(x => x.name === v.from)) throw new Error(`${source}: vars: ${v.name} follows ${v.from}, which is not one of the vars before it`)
    return r.data
  }
  throw new Error(r.error.issues.map(i => `${source}: ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n'))
}

export const loadProject = (file: string): Project => parseProject(JSON.parse(readFileSync(file, 'utf8')), file)

/** ~/.config/flow/flow.json: what holds for the whole machine (all projects share its slots) */
const settings = z.object({
  limits: z.object({ agents: z.number().int().min(1).default(2), builds: z.number().int().min(1).default(2), devices: z.number().int().min(1).default(4) }).default({}),
  /** a desktop notification when a run starts needing you */
  notify: z.boolean().default(true),
})
export type Settings = z.infer<typeof settings>

export function loadSettings(file: string): Settings {
  const r = settings.safeParse(existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {})
  if (r.success) return r.data
  throw new Error(r.error.issues.map(i => `${file}: ${i.path.join('.')}: ${i.message}`).join('\n'))
}
