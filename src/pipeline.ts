import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AgentEvent } from './agent/stream.ts'
import type { Az } from './azure.ts'
import { forgeFor, type Forge, type Gh } from './forge.ts'
import type { JiraDeps } from './jira.ts'
import { trackerFor, type Tracker } from './tracker.ts'
import type { Project, Repo } from './config.ts'
import { startDevice, stopDevice, type DeviceState } from './device.ts'
import { startDevServer, stopDevServer, type DevServerState } from './devserver.ts'
import { contentHash, createWorktree, pending, plainOutput, pushed, shipChange } from './git.ts'
import { fillSh, logLine, sh, tail } from './sh.ts'
import { parseLogins, writeAppEnv } from './appenv.ts'
import { loginValues, redactLogins } from './redact.ts'
import { slug } from './slug.ts'
import { commitMessage, parsePlan, planFacts, planGaps, prSummary } from './plan.ts'
import { drift, prProblems } from './drift.ts'
import { advisorPrompt, lookupPrompt, parseAdvice, type Advice } from './advisor.ts'
import { Browsers } from './browser.ts'
import { detectVars, fillVars, resolveVars } from './vars.ts'
import { buildPrompt, contextPrompt, fenced, finishBuildPrompt, fixPrompt, fromHuman, planPrompt, planRetryPrompt, runBrief, type Brief } from './prompts.ts'
import { callTool, toolList, type ToolDef } from './runtools.ts'
import { memoryDir, saveLearnings } from './learnings.ts'
import { changeText, parseFindings, reviewFixPrompt, reviewPrompt, type Finding, type Lens } from './review.ts'
import type { RunState } from './run.ts'
import type { Resources } from './resources.ts'
import { Runner, type RunAgent } from './runner.ts'
import { writeRunSettings } from './settings.ts'
import type { EventStore } from './store.ts'
import type { Windows } from './usage.ts'
import { changedFiles, verify } from './verify.ts'

/** the run's flow MCP server (its tools) */
import { self } from './self.ts'

/** a repo of a run: its worktree and the base it started from */
interface RunRepo { key: string; worktree: string; base: string }

/** what a run needs beyond its events: kept as run.json in the run folder */
interface Meta extends Brief { id: number | string; kind: 'bug' | 'feature'; repos: RunRepo[]; platform?: 'android' | 'ios'; web?: string; model?: string
  /** a run without a ticket: a task described instead */
  task?: boolean
  /** the run's environment (the project's vars: given, suggested by the ticket, followed or default) */
  vars?: Record<string, string>
  /** the run's emulator and browser without their windows (unset: the project's default) */
  headless?: boolean }

export { slug } from './slug.ts'

/** a project's git in a worktree (its env), for flow's own local steps */
const gitIn = (cwd: string, env?: Record<string, string | undefined>) => (...a: string[]) => {
  const x = Bun.spawnSync(['git', ...a], { cwd, env: env ?? process.env })
  return { code: x.exitCode, out: new TextDecoder().decode(x.stdout).trim(), err: new TextDecoder().decode(x.stderr).trim() }
}

export interface PipelineDeps {
  store: EventStore
  project: Project
  az: Az
  /** flow's own data: the event log and one folder per run */
  dataDir: string
  makeAgent: (o: { cwd: string; settings: string; resume?: string; model?: string; env?: Record<string, string>; appendSystemPrompt?: string; mcpConfig?: string }) => RunAgent
  /** a fresh, read-only reviewer session per review; without it the review is skipped */
  makeReviewer?: (o: { cwd: string; settings: string; model?: string; maxTurns?: number }) => RunAgent
  gitEnv?: Record<string, string | undefined>
  now?: () => number
  /** sees each agent event as it arrives (live output); own: the run's agent, not the reviewer */
  tap?: (run: string, e: AgentEvent, own: boolean) => void
  /** each prompt as it is sent to an agent */
  onPrompt?: (run: string, text: string, own: boolean, from: 'flow' | 'you') => void
  /** the plan windows changed (after they are saved) */
  onWindows?: (w: Windows) => void
  /** where tickets come from and PRs go; by default from the project (az, gh, the Jira token in the keychain) */
  tracker?: Tracker
  forge?: Forge
  /** agent-browser (tests pass a stand-in) */
  browserBin?: string
  gh?: Gh
  jira?: JiraDeps
  /** machine-wide slots shared with other runs (the service's): agent turns, builds */
  resources?: Resources
  /** how long a run's device may take to boot (default 3 minutes) */
  deviceReadyTimeoutMs?: number
  /** how long a run's dev server may take to listen (default 5 minutes) */
  devServerReadyTimeoutMs?: number
}

/**
 * A ticket from intake to draft PRs: a worktree per repo, plan turn, the plan gate, build, verify against the base
 * (new findings go back to the agent), an independent review, then a stop for the human to ship. Each step runs
 * until the run needs the human, then returns; the next command (approve, message, ship) carries on from the log.
 */
export class Pipeline {
  readonly runner: Runner
  private agents = new Map<string, RunAgent>()
  /** the device slot each run with a device holds */
  private deviceSlots = new Map<string, () => void>()
  /** how the agent ended its turn through its tools (ask, resolve, block), taken when the turn is over */
  private ends = new Map<string, { kind: 'ask' | 'resolve' | 'block'; text: string }>()
  /** repos the agent added during the turn going on: its session restarts with them when the turn ends */
  private addedDuringTurn = new Map<string, string[]>()
  /** the web runs' browsers, each through its proxy */
  private browsers: Browsers
  private tracker: Tracker
  private forge: Forge

  constructor(private d: PipelineDeps) {
    this.tracker = d.tracker ?? trackerFor(d.project, { az: d.az, ...d.jira })
    this.forge = d.forge ?? forgeFor(d.project, { az: d.az, gh: d.gh })
    this.browsers = new Browsers(d.browserBin ? { bin: d.browserBin } : {})
    const usage = join(d.dataDir, 'usage.json')
    this.runner = new Runner({
      store: d.store, maxParallel: d.project.agent.maxParallel, limits: d.project.usage, agentFor: run => this.agentFor(run), now: d.now, tap: d.tap, onPrompt: d.onPrompt, queued: run => this.takeQueued(run),
      // an ending (ask, resolve, block) belongs to the turn that called it: a failed turn's never ends a later one
      turnStarts: run => { this.ends.delete(run) },
      // a repo the agent added during its turn: its session restarts with it (brief, settings) and carries on
      afterTurn: async run => {
        const added = this.addedDuringTurn.get(run)
        if (!added) return undefined
        this.addedDuringTurn.delete(run)
        await this.closeAgent(run)
        return `${added.join(', ')} ${added.length === 1 ? 'is' : 'are'} added to this run and writable now (your brief lists where). Carry on with what you were doing.`
      },
      ...(d.resources ? { agentSlot: (run: string) => d.resources!.acquire(run, 'agents') } : {}),
      windows: existsSync(usage) ? JSON.parse(readFileSync(usage, 'utf8')) : undefined,
      onWindows: w => { mkdirSync(d.dataDir, { recursive: true }); writeFileSync(usage, JSON.stringify(w) + '\n'); d.onWindows?.(w) },
    })
  }

  /** the project's settings changed (saved from the screen): new runs and steps use them from now on */
  reconfigure(project: Project) {
    this.d.project = project
    this.tracker = trackerFor(project, { az: this.d.az, ...this.d.jira })
    this.forge = forgeFor(project, { az: this.d.az, gh: this.d.gh })
  }

  runDir = (run: string) => join(this.d.dataDir, 'runs', run)
  state = (run: string): RunState | undefined => this.d.store.state(run)
  private planFile = (run: string) => join(this.runDir(run), 'plan.md')
  private prFile = (run: string) => join(this.runDir(run), 'pr.md')
  private repoConfig = (key: string): Repo => this.d.project.repos.find(r => r.key === key)!
  private now = () => (this.d.now ?? Date.now)()
  private must = (run: string) => this.d.store.state(run)!

  /** a heavy step (an install, verify) holds a shared build slot while it runs */
  private async building<T>(run: string, fn: () => Promise<T>): Promise<T> {
    const free = this.d.resources ? await this.d.resources.acquire(run, 'builds') : () => {}
    try { return await fn() } finally { free() }
  }

  /** run.json; one written before runs had several repos (repo + worktree) reads as a single-repo run */
  private meta(run: string): Meta {
    const m = JSON.parse(readFileSync(join(this.runDir(run), 'run.json'), 'utf8')) as Meta & { repo?: string }
    if (!m.repos) m.repos = [{ key: m.repo!, worktree: m.worktree, base: m.base }]
    const s = this.d.store.state(run)
    return { ...m, ...(this.d.project.brief.length ? { brief: this.d.project.brief } : {}), ...(s?.device ? { device: s.device } : {}), ...(s?.devServer ? { devServer: s.devServer } : {}) }
  }

  /** the agent's folder: the worktree with one repo, the run's root with several */
  private static layout(root: string, repos: RunRepo[]) { return repos.length === 1 ? repos[0]!.worktree : root }

  /** kind: overrides the work item type (a Task may be a fix); repos: else the project's defaults; base: the first repo's */
  /** the run a ticket gets ("fso-204598", "shop-SGL-692"); throws for something that isn't one of the project's tickets */
  runId(ticket: number | string): string {
    const parsed = this.tracker.parseKey(String(ticket))
    const p = this.d.project
    if (!parsed) throw new Error(`${ticket} is not a ticket of project ${p.key} (${p.tracker.kind === 'jira' ? `${p.tracker.key}-<number>` : 'a work item number'})`)
    return `${p.key}-${parsed.id}`
  }

  /** patch: "<customer>/<app>", the customer patch the change goes on (in the run's repo that has patch commands) */
  /** the run a task without a ticket gets: named from its first line */
  taskRunId(task: string): string {
    const s = slug(task.trim().split('\n')[0] ?? '')
    if (!s) throw new Error('describe the task in a few words: its first line names the run and the branch')
    return `${this.d.project.key}-${s}`
  }

  /** the new-run form's look at a ticket before a run exists */
  async lookup(ticket: number | string) {
    const run = this.runId(ticket)
    const t = await this.tracker.read(this.tracker.parseKey(String(ticket))!.id)
    return { run, exists: !!this.d.store.state(run), key: t.key, title: t.title, kind: t.kind, type: t.type ?? '', url: t.url, board: t.board ?? '', customer: t.customer ?? '', tags: t.tags ?? [], comments: t.comments ?? 0, area: t.area ?? '', platform: t.platform ?? '',
      // the run's environment as the ticket suggests it (the form fills it in)
      vars: detectVars(this.d.project.vars, t) }
  }

  /** a repo's bases to start from: its default, then the branches its release patterns match, newest version first */
  bases(repo: string): string[] {
    const c = this.repoConfig(repo)
    const refs = c.releaseBases.length ? new TextDecoder().decode(Bun.spawnSync(['git', 'for-each-ref', '--format=%(refname:short)', ...c.releaseBases.map(p => `refs/remotes/${p}`)], { cwd: c.path }).stdout).split('\n').filter(Boolean) : []
    const ver = (r: string) => (/(\d+)\.(\d+)\.(\d+)/.exec(r) ?? []).slice(1).map(Number)
    const newer = (a: string, b: string) => { const [x, y] = [ver(a), ver(b)]; for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0); return a.localeCompare(b) }
    return [c.defaultBase, ...refs.filter(r => r !== c.defaultBase).sort(newer)]
  }

  /** every remote branch and tag of a repo, the most recently changed first (the base picker's search) */
  refs(repo: string): string[] {
    const c = this.repoConfig(repo)
    return new TextDecoder().decode(Bun.spawnSync(['git', 'for-each-ref', '--sort=-committerdate', '--count=500', '--format=%(refname:short)', 'refs/remotes/origin', 'refs/tags'], { cwd: c.path }).stdout)
      .split('\n').filter(r => r && r !== 'origin/HEAD' && r !== 'origin')
  }

  private patchRepo() { return this.d.project.repos.find(r => r.patches) }

  /** the customer/app pairs the project has patches for */
  async patchChoices(): Promise<string[]> {
    const r = this.patchRepo()
    if (!r?.patches?.choices) return []
    const res = await sh(r.patches.choices, r.path, this.d.gitEnv)
    return res.code === 0 ? res.out.split('\n').map(x => x.trim()).filter(x => /^[\w.-]+\/[\w.-]+$/.test(x)) : []
  }

  /** whether customer/app has a patch for the base, in the project's words */
  async checkPatch(patch: string, base: string): Promise<{ ok: boolean; text: string }> {
    const r = this.patchRepo()
    const [customer, app] = patch.split('/')
    if (!r?.patches?.check || !customer || !app) return { ok: true, text: '' }
    const res = await sh(fillSh(r.patches.check, { customer, app, base }), r.path, this.d.gitEnv)
    return { ok: res.code === 0, text: tail(res.out || res.err, 1) }
  }

  async start(ticket: number | string, o: { base?: string; bases?: Record<string, string>; kind?: 'bug' | 'feature'; repos?: string[]; device?: 'android' | 'ios'; patch?: string; devServer?: boolean; model?: string; task?: string; note?: string; logins?: string; vars?: Record<string, string>; headless?: boolean } = {}): Promise<string> {
    const p = this.d.project
    const run = o.task?.trim() && !String(ticket).trim() ? this.taskRunId(o.task) : this.runId(ticket)
    if (o.device && !p.devices?.[o.device]) throw new Error(`project ${p.key} has no devices configured for ${o.device} (devices.${o.device} in its config)`)
    // a task described instead of a ticket: no tracker, its first line the title, its words the ticket's text
    const task = o.task?.trim() && !String(ticket).trim() ? o.task.trim() : undefined
    const id = task ? slug(task.split('\n')[0]!) : this.tracker.parseKey(String(ticket))!.id
    if (this.d.store.state(run)) throw new Error(`run ${run} exists already: flow status ${run}`)
    const keys = o.repos?.length ? o.repos : p.repos.some(r => r.default) ? p.repos.filter(r => r.default).map(r => r.key) : [p.repos[0]!.key]
    const unknown = keys.filter(k => !p.repos.some(r => r.key === k))
    if (unknown.length) throw new Error(`no repo ${unknown.join(', ')} in project ${p.key} (it has ${p.repos.map(r => r.key).join(', ')})`)
    const web = o.devServer ? keys.find(k => this.repoConfig(k).devServer) : undefined
    if (o.devServer && !web) throw new Error(`no repo of this run has a dev server (devServer in the repo's config): ${keys.join(', ')}`)
    let patch: Meta['patch']
    if (o.patch) {
      const [customer, app, ...more] = o.patch.split('/')
      if (!customer || !app || more.length || !/^[\w.-]+$/.test(customer + app)) throw new Error(`--patch is <customer>/<app>, not "${o.patch}"`)
      const repo = keys.find(k => this.repoConfig(k).patches)
      if (!repo) throw new Error(`no repo of this run has patch commands (patches in the repo's config): ${keys.join(', ')}`)
      patch = { customer, app, repo }
    }
    const t = task ? { id, key: '', title: task.split('\n')[0]!.trim().slice(0, 120), kind: 'feature' as const, url: '', text: task } : await this.tracker.read(id)
    const kind = o.kind ?? t.kind
    const root = join(p.worktrees, String(id))
    const repos = keys.map((k, i) => ({ key: k, worktree: join(root, k), base: o.bases?.[k] ?? (i === 0 ? o.base : undefined) ?? this.repoConfig(k).defaultBase }))
    // bases reach git and the project's shell commands: plain ref names only
    for (const r of repos) if (!/^[A-Za-z0-9][\w./-]*$/.test(r.base) || r.base.includes('..') || r.base.endsWith('/')) throw new Error(`base "${r.base}" is not a branch name`)
    const branch = task ? `${kind === 'bug' ? 'fix' : 'feat'}/${id}` : p.naming.branch.replaceAll('{type}', kind === 'bug' ? 'fix' : 'feat').replaceAll('{id}', String(id)).replaceAll('{key}', t.key)
    const m: Meta = { id, key: t.key, title: t.title, kind, url: t.url, branch, base: repos[0]!.base, repos, worktree: Pipeline.layout(root, repos), ...(o.device ? { platform: o.device } : {}), ...(patch ? { patch } : {}), ...(web ? { web } : {}), ...(o.model ? { model: o.model } : {}), ...(task ? { task: true } : {}),
      ...(p.vars.length ? { vars: resolveVars(p.vars, { ...detectVars(p.vars, t), ...o.vars }) } : {}), ...(o.headless !== undefined ? { headless: o.headless } : {}) }
    mkdirSync(this.runDir(run), { recursive: true })
    writeFileSync(join(this.runDir(run), 'run.json'), JSON.stringify(m, null, 2) + '\n')
    // what you add before the start: a note into the agent's brief; test logins in a file only you can read, which
    // the agent is pointed at (never their values) and ship checks the change against
    if (o.note?.trim()) writeFileSync(join(this.runDir(run), 'note.md'), o.note.trim() + '\n')
    // logins written in the ticket join them; the ticket the agent quotes from keeps a pointer instead
    const red = redactLogins(t.text)
    const logins = [o.logins?.trim(), ...red.found.map(f => `from the ticket, ${f.label}: ${f.value}`)].filter(Boolean).join('\n')
    if (logins) writeFileSync(join(this.runDir(run), 'logins.md'), logins + '\n', { mode: 0o600 })
    writeFileSync(join(this.runDir(run), 'ticket.md'), task ? `# ${t.title}\n\n${red.text}\n` : `# ${t.key} ${t.title}\n${t.url}\n\n${red.text}\n`)
    this.d.store.append(run, 'human', { type: 'run.created', ticket: t.key || 'task', title: t.title, project: p.key, base: m.base, repos: m.repos.map(r => r.key) })
    if (!(await this.setup(run, m))) return run
    await this.planStep(run, red.text)
    return run
  }

  /** a worktree per repo; false (and setup.failed) when one can't be made */
  private async setup(run: string, m: Meta): Promise<boolean> {
    const notes: string[] = []
    try {
      for (const r of m.repos) {
        const c = this.repoConfig(r.key)
        const log = join(this.runDir(run), 'setup.log')
        const ignore = [...this.d.project.ignore, ...(c.appEnv ? [`/${c.appEnv.file}`] : [])]
        const w = await this.building(run, () => createWorktree({ repo: c.path, worktree: r.worktree, branch: m.branch, base: r.base, install: c.install, localFiles: this.d.project.localFiles, indexes: this.d.project.indexes, ignore, log }))
        notes.push(...w.notes.map(n => `${r.key}: ${n}`))
        // before the device's build reads it: the app's env with this run's values (the license from the login step)
        if (c.appEnv) {
          const f = join(this.runDir(run), 'logins.md')
          const set = writeAppEnv(r.worktree, this.appEnvFor(c.appEnv, m), parseLogins(existsSync(f) ? readFileSync(f, 'utf8') : ''))
          if (set) { logLine(log, `${r.key}: app env ${set}`); notes.push(`${r.key}: app env ${set}`) }
        }
      }
    } catch (e) {
      this.d.store.append(run, 'engine', { type: 'setup.failed', reason: (e as Error).message })
      return false
    }
    if (m.patch) {
      try { await this.applyPatch(run, m) } catch (e) {
        this.d.store.append(run, 'engine', { type: 'setup.failed', reason: `patch: ${(e as Error).message}` })
        return false
      }
    }
    if (m.platform) {
      try { await this.bootDevice(run, m.platform, m.repos[0]!.worktree) } catch (e) {
        this.d.store.append(run, 'engine', { type: 'setup.failed', reason: `device: ${(e as Error).message}` })
        return false
      }
    }
    if (m.web) {
      try { await this.bootDevServer(run, m) } catch (e) {
        await this.releaseDevice(run)
        this.d.store.append(run, 'engine', { type: 'setup.failed', reason: `dev server: ${(e as Error).message}` })
        return false
      }
    }
    if (notes.length) writeFileSync(join(this.runDir(run), 'setup-notes.txt'), notes.join('\n') + '\n')
    this.d.store.append(run, 'engine', { type: 'setup.done' })
    return true
  }

  /**
   * The customer's patch, staged by the project's apply command, then committed by flow in the worktree only (never
   * pushed, commit hooks skipped so nothing reformats the customer's code): verify, review and the agent then see
   * only the fix on top of it.
   */
  private async applyPatch(run: string, m: Meta) {
    const { customer, app, repo } = m.patch!
    const r = m.repos.find(x => x.key === repo)!, c = this.repoConfig(repo)
    const res = await sh(fillSh(c.patches!.apply, { customer, app, base: r.base, main: c.path }), r.worktree, this.d.gitEnv)
    if (res.code !== 0) throw new Error(tail(res.err || res.out) || `the apply command exited ${res.code}`)
    const git = gitIn(r.worktree, this.d.gitEnv)
    if (git('diff', '--cached', '--quiet').code === 0) throw new Error(`the apply command staged nothing (${tail(res.out, 2) || 'no output'})`)
    const commit = git('commit', '--no-verify', '-q', '-m', `customer patch ${customer}/${app} (local to flow, never pushed)`)
    if (commit.code !== 0) throw new Error(`committing it locally failed: ${commit.err}`)
    this.d.store.append(run, 'engine', { type: 'patch.applied', customer, app, summary: tail(res.out, 1), commit: git('rev-parse', 'HEAD').out })
  }

  /**
   * The project's write-back on the whole change (the patch and the fix, new files included): the patch commit is
   * undone for the duration (HEAD back on the base, the patch staged), then the worktree is put back exactly.
   */
  private async writeBack(run: string, m: Meta, dryRun: boolean): Promise<string> {
    const { customer, app, repo } = m.patch!, s = this.must(run)
    const r = m.repos.find(x => x.key === repo)!, c = this.repoConfig(repo)
    const git = gitIn(r.worktree, this.d.gitEnv)
    const commit = s.patch!.commit
    if (git('rev-parse', 'HEAD').out !== commit) throw new Error(`${repo}: HEAD is no longer the patch commit ${commit.slice(0, 8)}; put it back before the write-back`)
    const added = git('ls-files', '--others', '--exclude-standard').out.split('\n').filter(Boolean)
    git('reset', '--soft', '-q', `${commit}~1`)
    try {
      if (added.length) git('add', '-N', '--', ...added) // new files belong in the patch too
      const res = await sh(fillSh(c.patches!.writeBack, { customer, app, base: r.base, dryRun: dryRun ? '--dry-run' : '' }), r.worktree, this.d.gitEnv)
      const out = (res.out + res.err).trim()
      if (res.code !== 0) throw new Error(`the write-back${dryRun ? ' dry run' : ''} failed (exit ${res.code}):\n${tail(out)}`)
      return `${out}${added.length ? `\nnew files included: ${added.join(', ')}` : ''}\n`
    } finally {
      if (added.length) git('reset', '-q', '--', ...added)
      git('reset', '--soft', '-q', commit)
    }
  }

  /** after a restart: this project's runs whose device is still up hold their device slot again */
  adoptDevices() {
    for (const s of this.d.store.runs()) {
      if (s.project !== this.d.project.key || this.deviceSlots.has(s.id) || !existsSync(join(this.runDir(s.id), 'device.json'))) continue
      this.deviceSlots.set(s.id, this.d.resources?.hold(s.id, 'devices') ?? (() => {}))
    }
  }

  /** the run's own device: a device slot, free ports (not another run's), boot, Metro, install; the slot is freed on failure */
  /** the run's device stopped and booted again with the project's current commands (the app built and installed) */
  /**
   * A repo the run lacks, added while it waits: its own worktree on the run's branch beside the others (from the
   * repo's default base unless given), the app env and git-excludes as at setup. The agent's next turn starts a new
   * process (resuming its session in the same folder) whose brief and settings include it.
   */
  async addRepo(run: string, key: string, base?: string, o: { byAgent?: boolean } = {}): Promise<string> {
    const s = this.must(run), m = this.meta(run)
    if (s.status === 'done' || s.status === 'failed') throw new Error(`${run} is ${s.status}`)
    if (m.repos.some(r => r.key === key)) throw new Error(`${run} has ${key} already`)
    if (!this.d.project.repos.some(r => r.key === key)) throw new Error(`project ${this.d.project.key} has no repo ${key}`)
    const c = this.repoConfig(key), from = base ?? c.defaultBase
    if (!/^[A-Za-z0-9][\w./-]*$/.test(from) || from.includes('..') || from.endsWith('/')) throw new Error(`base "${from}" is not a branch name`)
    const worktree = join(dirname(m.repos[0]!.worktree), key), log = join(this.runDir(run), 'setup.log')
    const ignore = [...this.d.project.ignore, ...(c.appEnv ? [`/${c.appEnv.file}`] : [])]
    await this.building(run, () => createWorktree({ repo: c.path, worktree, branch: m.branch, base: from, install: c.install, localFiles: this.d.project.localFiles, indexes: this.d.project.indexes, ignore, log }))
    if (c.appEnv) {
      const f = join(this.runDir(run), 'logins.md')
      const set = writeAppEnv(worktree, this.appEnvFor(c.appEnv, m), parseLogins(existsSync(f) ? readFileSync(f, 'utf8') : ''))
      if (set) logLine(log, `${key}: app env ${set}`)
    }
    // the agent's folder stays the one its session lives in; the repos list grows
    writeFileSync(join(this.runDir(run), 'run.json'), JSON.stringify({ ...m, repos: [...m.repos, { key, worktree, base: from }] }, null, 2) + '\n')
    this.d.store.append(run, o.byAgent ? 'agent' : 'human', { type: 'repo.added', repo: key, base: from })
    // the agent's process holds its settings: it restarts now, or (added by the agent itself) when its turn ends
    if (o.byAgent) this.addedDuringTurn.set(run, [...(this.addedDuringTurn.get(run) ?? []), key])
    else await this.closeAgent(run)
    return o.byAgent ? `${key} is at ${worktree}, on ${m.branch} (from ${from}). End your turn now: flow restarts your session with it writable and sends you on.`
      : `${key} added at ${worktree} on ${m.branch} (from ${from}); the agent's next turn has it`
  }

  /**
   * The run's repos brought up to their bases: fetched, then the base merged under the agent's change, which stays
   * uncommitted (set aside and put back). A change that conflicts with the base is left exactly as it was, the files
   * named; the agent resolves it on the new base only once told (a message).
   */
  async sync(run: string): Promise<string[]> {
    const m = this.meta(run), out: string[] = [], env = this.d.gitEnv ?? process.env
    const git = (cwd: string, ...a: string[]) => { const x = Bun.spawnSync(['git', ...a], { cwd, env }); return { code: x.exitCode, out: new TextDecoder().decode(x.stdout).trim(), err: new TextDecoder().decode(x.stderr).trim() } }
    for (const r of m.repos) {
      const f = git(r.worktree, 'fetch', '-q', 'origin')
      if (f.code !== 0) throw new Error(`${r.key}: git fetch failed: ${f.err.split('\n')[0]}`)
      if (git(r.worktree, 'merge-base', '--is-ancestor', r.base, 'HEAD').code === 0) { out.push(`${r.key}: up to date with ${r.base}`); continue }
      const dirty = git(r.worktree, 'status', '--porcelain').out !== ''
      if (dirty && git(r.worktree, 'stash', 'push', '-u', '-q', '-m', 'flow sync').code !== 0) throw new Error(`${r.key}: could not set the change aside`)
      const merged = git(r.worktree, 'merge', '--no-edit', '--no-verify', '-q', r.base)
      if (merged.code !== 0) {
        git(r.worktree, 'merge', '--abort')
        if (dirty) git(r.worktree, 'stash', 'pop', '-q')
        throw new Error(`${r.key}: the run's commits conflict with ${r.base}: ${merged.out || merged.err}`.slice(0, 500))
      }
      if (dirty && git(r.worktree, 'stash', 'pop', '-q').code !== 0) {
        // the change and the new base touch the same lines: back to where it was, the change untouched
        const files = git(r.worktree, 'diff', '--name-only', '--diff-filter=U').out.split('\n').filter(Boolean)
        git(r.worktree, 'reset', '-q', '--hard', 'ORIG_HEAD')
        git(r.worktree, 'stash', 'pop', '-q')
        throw new Error(`${r.key}: the change conflicts with ${r.base} in ${files.join(', ') || '(unknown files)'}; nothing was changed: message the agent to bring its change onto the new base, or sync by hand in ${r.worktree}`)
      }
      out.push(`${r.key}: brought up to ${r.base}`)
    }
    const moved = out.filter(x => x.includes('brought up')).map(x => x.split(':')[0]!)
    if (moved.length) this.d.store.append(run, 'human', { type: 'run.synced', repos: moved })
    return out
  }

  /**
   * The run's device and dev server stopped and started again, with the settings as they are now. With a platform,
   * a run that has no device gets one (its agent's next turn has it, and argent back).
   */
  async restartDevice(run: string, add?: 'android' | 'ios') {
    const s = this.must(run), m = this.meta(run)
    if (s.status === 'done' || s.status === 'failed') throw new Error(`${run} is ${s.status}: nothing to restart`)
    if (add && !s.device && !m.platform) {
      if (!this.d.project.devices?.[add]) throw new Error(`project ${this.d.project.key} has no devices configured for ${add} (devices.${add} in its config)`)
      m.platform = add
      writeFileSync(join(this.runDir(run), 'run.json'), JSON.stringify(m, null, 2) + '\n')
    }
    const platform = s.device?.platform ?? m.platform
    const web = !!m.web && !!this.repoConfig(m.web).devServer
    if (!platform && !web) throw new Error(`${run} has no device or dev server`)
    await this.releaseDevice(run)
    await this.closeAgent(run) // its next turn gets the device's new id (and the dev server's port) in its brief
    if (platform) await this.bootDevice(run, platform, m.repos[0]!.worktree)
    if (web) await this.bootDevServer(run, m)
  }

  private async bootDevice(run: string, platform: 'android' | 'ios', worktree: string) {
    const free = this.d.resources ? await this.d.resources.acquire(run, 'devices') : () => {}
    try {
      const taken = new Set<number>()
      const runs = join(this.d.dataDir, 'runs')
      for (const other of existsSync(runs) ? readdirSync(runs) : []) {
        const f = join(runs, other, 'device.json')
        if (other !== run && existsSync(f)) { const d = JSON.parse(readFileSync(f, 'utf8')) as DeviceState; taken.add(d.consolePort).add(d.consolePort + 1).add(d.metroPort) }
      }
      const d = await this.building(run, () => startDevice({ spec: { ...this.d.project.devices!, headless: this.meta(run).headless ?? this.d.project.devices!.headless }, platform, run, runDir: this.runDir(run), worktree, taken, readyTimeoutMs: this.d.deviceReadyTimeoutMs, log: join(this.runDir(run), 'setup.log'), cacheDir: join(this.d.dataDir, 'app-cache', this.d.project.key), mainCheckout: this.repoConfig(this.meta(run).repos[0]!.key).path }))
      this.deviceSlots.set(run, free)
      this.d.store.append(run, 'engine', { type: 'device.ready', platform, id: d.id, metroPort: d.metroPort })
    } catch (e) { free(); throw e }
  }

  /** the run's own dev server, in a build slot while it starts (a first build is heavy), on a port no other run holds */
  private async bootDevServer(run: string, m: Meta) {
    const r = m.repos.find(x => x.key === m.web)!, c = this.repoConfig(m.web!).devServer!
    const taken = new Set<number>()
    const runs = join(this.d.dataDir, 'runs')
    for (const other of existsSync(runs) ? readdirSync(runs) : []) {
      const f = join(runs, other, 'devserver.json')
      if (other !== run && existsSync(f)) taken.add((JSON.parse(readFileSync(f, 'utf8')) as DevServerState).port)
    }
    const d = await this.building(run, () => startDevServer({ run, repo: r.key, cmd: c.cmd, portStart: c.portStart, url: c.url, runDir: this.runDir(run), worktree: r.worktree, taken, readyTimeoutMs: this.d.devServerReadyTimeoutMs }))
    this.d.store.append(run, 'engine', { type: 'devserver.ready', repo: d.repo, port: d.port, url: d.url })
  }

  /** stop the run's device and dev server and free the device slot (at ship, or by hand); nothing to do when it has none */
  async releaseDevice(run: string) {
    const web = join(this.runDir(run), 'devserver.json')
    await this.browsers.stop(run, this.runDir(run))
    if (existsSync(web)) {
      await stopDevServer(JSON.parse(readFileSync(web, 'utf8')) as DevServerState, this.runDir(run))
      if (this.d.store.state(run)?.devServer) this.d.store.append(run, 'engine', { type: 'devserver.stopped' })
    }
    const f = join(this.runDir(run), 'device.json')
    if (!existsSync(f) || !this.d.project.devices) return
    await stopDevice(JSON.parse(readFileSync(f, 'utf8')) as DeviceState, this.d.project.devices, this.runDir(run))
    this.deviceSlots.get(run)?.()
    this.deviceSlots.delete(run)
    this.d.store.append(run, 'engine', { type: 'device.released' })
  }

  async approve(run: string, answers: Record<string, string> = {}) {
    const s = this.must(run)
    if (s.needs?.kind !== 'plan' || !s.plan) throw new Error(`${run}: no plan is waiting for a decision (${s.status})`)
    const unknown = Object.keys(answers).filter(k => !s.plan!.questions.some(q => q.id === k))
    if (unknown.length) throw new Error(`${run}: the plan has no question ${unknown.join(', ')}`)
    const all = Object.fromEntries(s.plan.questions.map(q => [q.id, answers[q.id] ?? q.default]))
    this.d.store.append(run, 'human', { type: 'plan.decided', by: 'human', answers: all })
    await this.buildStep(run)
  }

  /**
   * The plan's deadline passed with no answer (never for a held question): the advisor decides; a question the agent
   * can look up itself goes back to it, once; without an advisor (or one that can't be read) the defaults.
   */
  async decideByDeadline(run: string) {
    const s = this.must(run)
    if (s.needs?.kind !== 'plan' || !s.plan) throw new Error(`${run}: no plan is waiting for a decision`)
    if (s.needs.held) throw new Error(`${run}: the plan has a held question; only you can answer it`)
    const advice = await this.advise(run)
    if (advice?.lookups.length && !s.plan.returned) {
      this.d.store.append(run, 'engine', { type: 'plan.returned', lookups: advice.lookups.map(l => l.id) })
      const r = await this.say(run, lookupPrompt(advice.lookups, this.planFile(run)))
      if (!r.ok || this.ended(run, r.text)) return
      const p = this.readPlan(run)
      if ('plan' in p) await this.submitPlan(run, p.plan)
      else this.d.store.append(run, 'engine', { type: 'run.blocked', reason: `the plan ${this.planFile(run)} ${p.problem}; message the agent, or write the plan yourself` })
      return
    }
    const answered = Object.fromEntries(Object.entries(advice?.answers ?? {}))
    const answers = Object.fromEntries(s.plan.questions.map(q => [q.id, answered[q.id]?.answer ?? q.default]))
    const reasons = Object.fromEntries(Object.entries(answered).map(([k, v]) => [k, v.reason]))
    this.d.store.append(run, 'engine', advice && Object.keys(answered).length ? { type: 'plan.decided', by: 'advisor', answers, reasons } : { type: 'plan.decided', by: 'deadline', answers })
    await this.buildStep(run)
  }

  /** the advisor's answers to the plan's open questions: a fresh read-only session (the reviewer's); null without one */
  private async advise(run: string): Promise<Advice | null> {
    const s = this.must(run), m = this.meta(run)
    if (!this.d.makeReviewer || !s.plan?.questions.length) return null
    const settings = writeRunSettings({ dir: join(this.runDir(run), 'advisor'), worktree: m.worktree, allow: m.repos.map(r => r.worktree).filter(w => w !== m.worktree), deny: [join(this.d.dataDir, 'token')], sandbox: this.d.project.sandbox, claudeMdExcludes: this.d.project.claudeMdExcludes, denyTools: this.d.project.denyTools })
    const advisor = this.d.makeReviewer({ cwd: m.worktree, settings, maxTurns: this.d.project.review.maxTurns, ...(m.model ? { model: m.model } : {}) })
    try {
      const read = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8') : '')
      const r = await this.runner.turnWith(run, advisor, advisorPrompt({ key: m.key, title: m.title, ticket: read(join(this.runDir(run), 'ticket.md')), plan: read(this.planFile(run)), questions: s.plan.questions }), { ownSession: false })
      if (!r.ok) return null
      try { return parseAdvice(r.text, s.plan.questions) } catch { return null }
    } finally { await advisor.close?.() }
  }

  /** a message from the human: goes to the run's session; afterwards the run carries on from where it is */
  async message(run: string, text: string) {
    this.d.store.append(run, 'human', { type: 'human.message', text })
    const r = await this.say(run, fromHuman(text), 'you')
    if (!r.ok || this.ended(run, r.text)) return
    const s = this.must(run)
    if (s.status !== 'running') return // the agent asked something back, or the run was done or failed already
    if (s.stage === 'plan') {
      // the agent may have rewritten the plan: it is submitted again (with a new deadline)
      const p = this.readPlan(run)
      if ('plan' in p) await this.submitPlan(run, p.plan)
      else this.d.store.append(run, 'engine', { type: 'run.blocked', reason: `the plan ${this.planFile(run)} ${p.problem}; message the agent, or write the plan yourself` })
    } else if (s.stage === 'build' || s.stage === 'verify' || s.stage === 'review') {
      this.d.store.append(run, 'agent', { type: 'build.done' })
      await this.verifyLoop(run)
    } else if (s.stage === 'ship') {
      // at the ship gate (or with a draft PR open): a change is verified again; otherwise the gate is back as it was
      if (await this.changedSinceVerify(run)) { this.d.store.append(run, 'agent', { type: 'build.done', reason: 'changed after it was verified' }); await this.verifyLoop(run) }
      else this.d.store.append(run, 'engine', { type: 'run.ready' })
    }
  }

  /** the worktrees' content, all repos */
  private async content(m: Meta) { return (await Promise.all(m.repos.map(r => contentHash(r.worktree)))).join(',') }
  private async changedSinceVerify(run: string) {
    const v = this.must(run).verifiedTree
    return v === undefined || (await this.content(this.meta(run))) !== v
  }

  /** a commit, a push and a draft PR for each repo the run changed */
  async ship(run: string): Promise<{ number: number; url: string }[]> {
    const s = this.must(run)
    const m = this.meta(run), n = this.d.project.naming
    const gate = s.needs?.kind === 'ship' || (s.needs?.kind === 'patch' && s.patch) || (s.needs?.kind === 'pr' && !m.patch)
    if (!gate) throw new Error(`${run} is not ready to ship (${s.stage}, ${s.status}${s.needs ? `: ${s.needs.ask}` : ''})`)
    // never ship what was not verified: a change since (an edit by hand) is verified again first
    if (s.verifiedTree !== undefined && (await this.changedSinceVerify(run))) {
      this.d.store.append(run, 'engine', { type: 'build.done', reason: 'changed after it was verified; ship once it is ready again' })
      await this.verifyLoop(run)
      return []
    }
    // a ship that breaks off (a hook refuses the commit, the push or the PR fails) says so on the run; shipping
    // again carries on from where it stopped
    try { return await this.shipNow(run, s, m, n) } catch (e) {
      // the reason as plain words on one line (a hook's terminal output has colour codes and boxes)
      if (this.d.store.state(run)?.stage === 'ship') this.d.store.append(run, 'engine', { type: 'ship.failed', reason: plainOutput((e as Error).message, 6).split('\n').map(l => l.trim()).join(' · ').slice(0, 400) })
      throw e
    }
  }

  private async shipNow(run: string, s: RunState, m: Meta, n: Project['naming']): Promise<{ number: number; url: string }[]> {
    if (m.patch) {
      // a customer patch run ends in the patch written back, not a PR: a dry run first, then (ship again) for real
      const others = m.repos.filter(r => r.key !== m.patch!.repo && changedFiles(r.worktree).length).map(r => r.key)
      if (others.length) throw new Error(`${run}: a patch run ships only its patch, but ${others.join(', ')} changed too`)
      const pr = m.repos.find(r => r.key === m.patch!.repo)
      if (pr) this.noLogins(run, '', [{ r: pr, files: changedFiles(pr.worktree) }])
      const first = s.needs!.kind === 'ship'
      const report = await this.writeBack(run, m, first)
      writeFileSync(join(this.runDir(run), 'patch-report.txt'), report)
      this.d.store.append(run, 'human', first ? { type: 'patch.checked', report } : { type: 'patch.written', report })
      if (!first) { this.keepLearnings(run); await this.releaseDevice(run) }
      return []
    }
    // each repo with something of its own: uncommitted changes, or commits not on origin yet (a push that failed),
    // or no PR yet; a repo whose PR is open and current is left alone
    const prFor = (key: string) => (s.prs ?? []).find(p => (m.repos.length > 1 ? p.repo === key : true))
    const changed: { r: RunRepo; files: string[] }[] = []
    for (const r of m.repos) {
      if (!(await pending(r.worktree, r.base))) continue
      const files = changedFiles(r.worktree)
      if (!files.length && prFor(r.key) && (await pushed(r.worktree, m.branch))) continue
      changed.push({ r, files })
    }
    if (!changed.length) throw new Error(s.prs?.length ? `${run}: nothing new to ship; the draft PR is current` : `${run}: nothing to ship, no repo has changes`)
    const pr = existsSync(this.prFile(run)) ? readFileSync(this.prFile(run), 'utf8') : ''
    this.noLogins(run, pr, changed)
    const summary = prSummary(pr, m.title)
    // a task has no ticket to link to or name: its PR is the description, its title and commits the summary alone
    // what the plan's deadline decided (the advisor, or the defaults) is listed for the human to confirm
    const p = s.plan, unconfirmed = p && p.decidedBy && p.decidedBy !== 'human' ? p.questions.map(q => `- ${q.text} → ${p.answers?.[q.id] ?? q.default}${p.reasons?.[q.id] ? ` (${p.reasons[q.id]})` : ''}`) : []
    const decisions = unconfirmed.length ? `\n\nDecisions taken without the developer's confirmation (please confirm):\n${unconfirmed.join('\n')}` : ''
    const body = n.prBody === 'ticket-link' && m.url ? m.url : (pr.replace(/^#\s+.+\n?/m, '').trim() || `${m.key} ${m.title}\n${m.url}`.trim()) + decisions
    // checked before anything is pushed: the PR's description is the agent's, whole
    if (!pr.trim() && n.prBody !== 'ticket-link') throw new Error(`${run}: the agent wrote no PR description (${this.prFile(run)}): message it to write one, then ship again`)
    const max = this.d.project.forge.kind === 'azure' ? 4000 : 65_536
    if (body.length > max) throw new Error(`${run}: the PR description is ${body.length} characters and ${this.d.project.forge.kind === 'azure' ? 'Azure' : 'GitHub'} takes ${max}: message the agent to cut ${body.length - max} from ${this.prFile(run)}, then ship again`)
    const title = n.prTitle === 'key' && m.key ? m.key : `${m.key} ${summary}`.trim()
    const message = (files: string[], repo: string) => (n.commit === 'key-summary' ? `${m.key} ${summary}`.trim().slice(0, 100) : commitMessage({ id: m.task ? '' : m.id, title: m.title, kind: m.kind }, files, repo))
    const created: { number: number; url: string }[] = [], updated: { number: number; repo?: string }[] = []
    for (const { r, files } of changed) {
      // ship is refused unless verify passed for exactly this tree: a hook objecting only to lint the files already had is passed
      const shipped = await shipChange({ worktree: r.worktree, branch: m.branch, message: message(files, r.key), env: this.commitEnv(), verified: true })
      if (shipped.bypassed) this.d.store.append(run, 'engine', { type: 'run.note', text: `${r.key}: ${shipped.bypassed}` })
      const open = prFor(r.key)
      if (open) { updated.push({ number: open.number, ...(m.repos.length > 1 ? { repo: r.key } : {}) }); continue }
      const origin = Bun.spawnSync(['git', 'remote', 'get-url', 'origin'], { cwd: r.worktree })
      const repository = new TextDecoder().decode(origin.stdout).trim().replace(/\.git$/, '').split(/[/:]/).pop()!
      const c = await this.forge.draftPr({ repository, head: m.branch, base: r.base.replace(/^origin\//, ''), title, body, ...(typeof m.id === 'number' ? { workItem: m.id } : {}) })
      this.d.store.append(run, 'human', { type: 'pr.opened', url: c.url, number: c.number, ...(m.repos.length > 1 ? { repo: r.key } : {}) })
      created.push(c)
    }
    if (!created.length && updated[0]) this.d.store.append(run, 'human', { type: 'pr.updated', ...updated[0] })
    this.keepLearnings(run)
    await this.releaseDevice(run)
    return created
  }

  /**
   * The same fix onto another line (release fix → develop): a new run on <to> with each repo's shipped commits
   * applied uncommitted, then verify and review as usual and a stop to ship. A conflict blocks it, naming the files.
   */
  async port(source: string, to = 'develop'): Promise<string> {
    const src = this.d.store.state(source)
    if (!src?.pr) throw new Error(`${source} is not shipped yet: port a run that has its draft PR`)
    const m = this.meta(source), p = this.d.project, short = to.split('/').pop()!
    if (m.base.replace(/^origin\//, '') === to) throw new Error(`${source} is on ${to} already: port the release run instead`)
    const run = `${source}-${short}`
    if (this.d.store.state(run)) throw new Error(`run ${run} exists already`)
    // the port's own folder, named after its run: a port of a port can't land in the first port's
    const root = join(p.worktrees, run.slice(p.key.length + 1))
    const repos = m.repos.map(r => ({ key: r.key, worktree: join(root, r.key), base: `origin/${to}` }))
    const { device: _, devServer: __, ...src0 } = m // the source's device and dev server are its own; the port starts its own
    const pm: Meta = { ...src0, base: `origin/${to}`, branch: `${m.branch}-${short}`, repos, worktree: Pipeline.layout(root, repos) }
    mkdirSync(this.runDir(run), { recursive: true })
    writeFileSync(join(this.runDir(run), 'run.json'), JSON.stringify(pm, null, 2) + '\n')
    for (const f of ['ticket.md', 'plan.md']) if (existsSync(join(this.runDir(source), f))) writeFileSync(join(this.runDir(run), f), readFileSync(join(this.runDir(source), f)))
    const from = m.base.replace(/^origin\//, '')
    const pr = existsSync(this.prFile(source)) ? readFileSync(this.prFile(source), 'utf8') : `# ${m.title}\n`
    const prs = (src.prs ?? [src.pr]).map(x => `#${x.number}`).join(', ')
    writeFileSync(this.prFile(run), pr.replace(/^(#\s+.+\n?)/m, `$1\nPort of ${src.ticket} PR ${prs} (${from}) to ${to}.\n`))
    this.d.store.append(run, 'human', { type: 'run.created', ticket: m.key, title: m.title, project: p.key, base: pm.base, repos: pm.repos.map(r => r.key) })
    if (!(await this.setup(run, pm))) return run
    this.d.store.append(run, 'engine', { type: 'plan.submitted', summary: `Port of ${src.ticket} PR ${prs} (${from}) to ${to}`, questions: [] })
    const conflicts: string[] = []
    for (const [i, r] of repos.entries()) {
      const git = (...a: string[]) => { const x = Bun.spawnSync(['git', ...a], { cwd: r.worktree, env: this.d.gitEnv ?? process.env }); return { code: x.exitCode, out: new TextDecoder().decode(x.stdout).trim() } }
      const commits = git('log', '--reverse', '--format=%H', `${m.repos[i]!.base}..${m.branch}`).out.split('\n').filter(Boolean)
      if (!commits.length) continue
      if (git('cherry-pick', '--no-commit', ...commits).code !== 0) {
        const files = git('diff', '--name-only', '--diff-filter=U').out.split('\n').filter(Boolean)
        conflicts.push(...(files.length ? files : ['(unknown files)']).map(f => (repos.length > 1 ? `${r.key}/${f}` : f)))
        continue
      }
      git('reset', '--quiet') // the change stays in the working tree, as an agent's would
    }
    if (conflicts.length) {
      this.d.store.append(run, 'engine', { type: 'run.blocked', reason: `the port conflicts in ${conflicts.join(', ')}: message the agent to resolve them, or resolve them by hand in ${pm.worktree}` })
      return run
    }
    this.d.store.append(run, 'engine', { type: 'build.done' })
    await this.verifyLoop(run)
    return run
  }

  /**
   * A message to the run's agent. An agent with no session yet gets the step it never began (a restart killed its
   * turn first: the plan, the build), or else the run's context (a port's), then the message.
   */
  private say(run: string, text: string, from: 'flow' | 'you' = 'flow') {
    const s = this.must(run), m = this.meta(run)
    const first = s.stage === 'plan' && !existsSync(this.planFile(run)) ? `${planPrompt(m, this.ticketText(run), this.planFile(run), this.planKind(run))}\n\n${text}`
      : s.stage === 'build' && !existsSync(this.prFile(run)) ? `${buildPrompt(m, this.answers(s), this.prFile(run))}\n\n${text}`
      : contextPrompt(m, this.planFile(run), this.prFile(run), text)
    return this.runner.turn(run, s.session ? text : first, from)
  }

  /** the ticket's text as the plan step had it (ticket.md without its heading) */
  private ticketText(run: string) {
    const f = join(this.runDir(run), 'ticket.md')
    return existsSync(f) ? readFileSync(f, 'utf8').split('\n\n').slice(1).join('\n\n').trim() : ''
  }

  private answers(s: RunState) { return (s.plan?.questions ?? []).map(q => ({ id: q.id, text: q.text, answer: s.plan?.answers?.[q.id] ?? q.default })) }

  private agentFor(run: string): RunAgent {
    const cached = this.agents.get(run)
    if (cached) return cached
    const m = this.meta(run)
    const others = m.repos.map(r => r.worktree).filter(w => w !== m.worktree)
    const dir = this.runDir(run)
    // of the run folder the agent writes only these: the plan, the PR description, how the run ended, its evidence,
    // and the test logins (a password the app made it change; ship checks the change against them all)
    const own = [this.planFile(run), this.prFile(run), join(dir, 'resolution.md'), join(dir, 'blocked.md'), join(dir, 'learnings.md'), join(dir, 'evidence'), join(dir, 'tests'), join(dir, 'logins.md'), this.answersFile(run)]
    // a run without a device of its own must not drive the ones running here (the human's, other runs'): they run
    // the main checkout's code through its Metro, not this change. argent is off for it, adb points at no device
    const dev = this.d.store.state(run)?.device
    const denyTools = [...this.d.project.denyTools, ...(dev ? [] : ['mcp__argent'])]
    const settings = writeRunSettings({ dir: this.runDir(run), worktree: m.worktree, allow: [...others, ...own], deny: [join(this.d.dataDir, 'token')], sandbox: this.d.project.sandbox, claudeMdExcludes: this.d.project.claudeMdExcludes, denyTools, allowTools: ['mcp__flow'], memory: memoryDir(this.repoConfig(m.repos[0]!.key).path) })
    // the run's tools: flow's MCP server for this run, beside the user's own servers
    const mcpConfig = join(dir, 'mcp.json')
    writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { flow: { command: self('mcp')[0], args: self('mcp').slice(1), env: { FLOW_RUN: run, FLOW_DATA: this.d.dataDir } } } }, null, 2) + '\n')
    // the run's own emulator is the one adb (and the tools on it) talk to; Metro's port for React Native's CLI.
    // a tool such as verify can take minutes
    const env = { MCP_TOOL_TIMEOUT: '1800000', ...(dev ? { ...(dev.platform === 'android' ? { ANDROID_SERIAL: dev.id } : {}), RCT_METRO_PORT: String(dev.metroPort) } : { ANDROID_SERIAL: 'no-device-for-this-run' }) }
    const note = existsSync(join(dir, 'note.md')) ? readFileSync(join(dir, 'note.md'), 'utf8') : undefined
    const appendSystemPrompt = runBrief({ ...this.meta(run), run, runDir: dir, planFile: this.planFile(run), prFile: this.prFile(run), ...(note ? { note } : {}), logins: existsSync(join(dir, 'logins.md')), tools: this.d.project.tools, browser: !!this.browserSpec(run), otherRepos: this.otherRepos(run),
      env: this.d.project.vars.filter(v => this.meta(run).vars?.[v.name]).map(v => `${v.label ?? v.name}: ${this.meta(run).vars![v.name]}`),
      ...(dev ? {} : { noDevice: { canAdd: !!(this.d.project.devices?.android || this.d.project.devices?.ios) } }) })
    const agent = this.d.makeAgent({ cwd: m.worktree, settings, resume: this.d.store.state(run)?.session, appendSystemPrompt, mcpConfig, env, ...(m.model ? { model: m.model } : {}) })
    this.agents.set(run, agent)
    return agent
  }

  /**
   * A change verify set aside for its base run, left in a stash when the service stopped mid-way: put back while
   * the worktree has nothing else, otherwise named for you. What it did, per repo.
   */
  async restoreStashes(run: string): Promise<string[]> {
    if (!existsSync(join(this.runDir(run), 'run.json'))) return []
    const out: string[] = []
    for (const r of this.meta(run).repos) {
      if (!existsSync(r.worktree)) continue
      const list = new TextDecoder().decode(Bun.spawnSync(['git', 'stash', 'list', '--format=%gd %s'], { cwd: r.worktree }).stdout).split('\n')
      const ref = list.find(l => l.endsWith('flow verify: base run'))?.split(' ')[0]
      if (!ref) continue
      if (changedFiles(r.worktree).length) { out.push(`${r.key}: verify set the change aside when the service stopped, and the worktree has changed since; it is in ${ref} (git stash list)`); continue }
      const pop = Bun.spawnSync(['git', 'stash', 'pop', '--index', ref], { cwd: r.worktree, env: this.d.gitEnv })
      out.push(pop.exitCode === 0 ? `${r.key}: the change was set aside by verify when the service stopped; it is back` : `${r.key}: the change verify set aside is in ${ref} and could not be put back (git stash list)`)
    }
    return out
  }

  /** shipped and merged, or given up: the run is done (it leaves the attention list) */
  done(run: string, reason?: string) {
    const s = this.must(run)
    // confirmed by you that no change was needed: what the agent learned on the way is kept
    if (!reason && s.needs?.kind === 'resolution') this.keepLearnings(run)
    this.d.store.append(run, reason ? 'engine' : 'human', { type: 'run.done', ...(reason ? { reason } : {}) })
  }

  /** the line a run's base names (patch/3.20, develop), and its first repo's default line */
  defaultLine(run: string) { return this.firstRepo(run).defaultBase.replace(/^origin\//, '') }
  private firstRepo(run: string) {
    const f = join(this.runDir(run), 'run.json')
    return this.repoConfig(existsSync(f) ? this.meta(run).repos[0]!.key : this.d.project.repos[0]!.key)
  }
  /**
   * The lines a shipped fix still has to reach, with no port of it yet: those the plan's Target lines name, or (a
   * plan that didn't say) the default line for a fix on a release line. Empty: nothing holds the run back.
   */
  unported(run: string): string[] {
    const s = this.must(run), base = s.base.replace(/^origin\//, '')
    const lines = s.plan?.targets ?? (base === this.defaultLine(run) ? [] : [this.defaultLine(run)])
    const ported = (line: string) => this.d.store.runs().some(x => x.id === `${run}-${line.split('/').pop()}`)
    return lines.filter(l => l !== base && !ported(l))
  }


  /** the run's learnings.md into its repos' memory and flow's backlog (after you shipped, or confirmed no change) */
  private keepLearnings(run: string) {
    const f = join(this.runDir(run), 'learnings.md')
    if (!existsSync(f)) return
    // a line with a test login in it never reaches the memory every later agent reads
    const secrets = this.secrets(run)
    const text = readFileSync(f, 'utf8').split('\n').filter(l => !secrets.some(x => l.includes(x))).join('\n')
    saveLearnings({ run, text, backlog: join(this.d.dataDir, 'backlog.md'),
      memory: key => { try { return memoryDir(this.repoConfig(key).path) } catch { return undefined } } })
  }

  /** the run's draft PRs on the code host: all merged, some closed (none open any more), or still open */
  async prsState(run: string): Promise<'merged' | 'closed' | 'open'> {
    const s = this.must(run)
    const prs = s.prs?.length ? s.prs : s.pr ? [s.pr] : []
    const states = await Promise.all(prs.map(p => this.forge.prState(p)))
    if (!states.length || states.some(x => x === 'open' || x === 'unknown')) return 'open'
    return states.every(x => x === 'merged') ? 'merged' : 'closed'
  }

  /**
   * The run gone: its device and dev server stopped, its worktrees and local branch removed (a PR's branch stays
   * on origin), its folder archived under runs/.removed. Work that was never shipped is refused unless forced.
   */
  async remove(run: string, o: { force?: boolean } = {}): Promise<{ removed: string[] }> {
    this.must(run)
    const dir = this.runDir(run)
    const m = existsSync(join(dir, 'run.json')) ? this.meta(run) : undefined
    if (m && !o.force) {
      const lost: string[] = []
      for (const r of m.repos) {
        if (!existsSync(r.worktree)) continue
        const files = changedFiles(r.worktree)
        if (files.length) lost.push(`${r.key}: ${files.join(', ')}`)
        else if ((await pending(r.worktree, r.base)) && !(await pushed(r.worktree, m.branch))) lost.push(`${r.key}: commits not on origin`)
      }
      if (lost.length) throw new Error(`${run} has work not shipped (${lost.join('; ')}); remove it with force to drop it`)
    }
    await this.releaseDevice(run)
    await this.closeAgent(run)
    this.agents.delete(run)
    this.queue.delete(run); this.ends.delete(run); this.addedDuringTurn.delete(run)
    const removed: string[] = []
    // worktrees another run's folder names are that run's (a failed port pointed at its source's): left alone
    const runs = join(this.d.dataDir, 'runs')
    const others = new Set((existsSync(runs) ? readdirSync(runs) : []).filter(x => x !== run && !x.startsWith('.')).flatMap(x => {
      try { return (JSON.parse(readFileSync(join(runs, x, 'run.json'), 'utf8')) as Meta).repos.map(r => r.worktree) } catch { return [] }
    }))
    for (const r of m?.repos ?? []) {
      if (others.has(r.worktree)) continue
      const repo = this.repoConfig(r.key).path
      if (existsSync(r.worktree)) {
        const res = Bun.spawnSync(['git', 'worktree', 'remove', '--force', '--force', r.worktree], { cwd: repo, env: this.d.gitEnv })
        if (res.exitCode !== 0) rmSync(r.worktree, { recursive: true, force: true })
        removed.push(r.worktree)
      }
      Bun.spawnSync(['git', 'worktree', 'prune'], { cwd: repo, env: this.d.gitEnv })
      // the branch goes with the worktree this run made; without one (setup refused an existing branch, or the
      // worktree was removed by hand) only when origin has all of it
      const onOrigin = Bun.spawnSync(['git', 'merge-base', '--is-ancestor', `refs/heads/${m!.branch}`, `refs/remotes/origin/${m!.branch}`], { cwd: repo }).exitCode === 0
      if (removed.includes(r.worktree) || onOrigin) Bun.spawnSync(['git', 'branch', '-D', m!.branch], { cwd: repo, env: this.d.gitEnv })
      try { rmdirSync(dirname(r.worktree)) } catch {} // the run's own folder, once empty
    }
    if (existsSync(dir)) {
      const archive = join(this.d.dataDir, 'runs', '.removed')
      mkdirSync(archive, { recursive: true })
      renameSync(dir, join(archive, `${run}-${this.now()}`))
    }
    this.d.store.append(run, 'human', { type: 'run.removed' })
    return { removed }
  }

  /** a message for the agent while it works: sent first with its next turn (a message written mid-turn can be lost) */
  queueMessage(run: string, text: string) { this.queue.set(run, [...(this.queue.get(run) ?? []), text]) }
  takeQueued(run: string): string[] { const q = this.queue.get(run) ?? []; this.queue.delete(run); return q }
  private queue = new Map<string, string[]>()

  /** the tools of the run's agent (its flow MCP server) */
  tools(run: string): ToolDef[] { return toolList(this.d.project.tools, !!this.must(run).device, !!this.browserSpec(run), this.otherRepos(run)) }
  private otherRepos(run: string) { const m = this.meta(run); return this.d.project.repos.map(r => r.key).filter(k => !m.repos.some(r => r.key === k)) }

  /** the run's browser settings: its dev server's, when the run has a dev server running; its start page filled */
  private browserSpec(run: string) {
    const s = this.must(run)
    const b = s.devServer ? this.repoConfig(s.devServer.repo).devServer?.browser : undefined
    if (!b) return undefined
    const m = this.meta(run), start = b.start ? fillVars(b.start, m.vars ?? {}) : ''
    return { ...b, start: start || undefined, headed: m.headless === undefined ? b.headed : !m.headless }
  }

  /** a repo's app env with the run's values filled in; a value whose variables are all empty is not set */
  private appEnvFor(spec: NonNullable<Repo['appEnv']>, m: Meta) {
    const set = Object.fromEntries(Object.entries(spec.set).map(([k, v]) => [k, fillVars(v, m.vars ?? {})]).filter(([, v]) => v))
    return { ...spec, set }
  }

  /** a tool call from the run's agent: on this run only */
  async callTool(run: string, name: string, args: Record<string, unknown>): Promise<{ ok: boolean; text: string }> {
    this.must(run)
    const m = this.meta(run), dir = this.runDir(run)
    const f = join(dir, 'device.json')
    const device = existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as DeviceState) : undefined
    return callTool({
      run, runDir: dir, worktree: m.worktree, base: m.base, ...(device ? { device } : {}),
      ...(device && this.d.project.devices?.[device.platform]?.app ? { app: this.d.project.devices[device.platform]!.app } : {}),
      check: () => this.verifyAll(run, m),
      ticket: async id => {
        if (!id) return fenced('ticket', existsSync(join(dir, 'ticket.md')) ? readFileSync(join(dir, 'ticket.md'), 'utf8') : '(no ticket: a task)').text
        const k = this.tracker.parseKey(id)
        if (!k) throw new Error(`${id} is not a ticket of project ${this.d.project.key}`)
        const t = await this.tracker.read(k.id)
        const red = redactLogins(t.text)
        if (red.found.length) appendFileSync(join(dir, 'logins.md'), red.found.map(f => `from ticket ${t.key}, ${f.label}: ${f.value}`).join('\n') + '\n', { mode: 0o600 })
        return fenced('ticket', `# ${t.key} ${t.title}\n${t.url}\n\n${red.text}`).text
      },
      end: (kind, text) => { this.ends.set(run, { kind, text }) },
      addRepo: (key: string) => this.addRepo(run, key, undefined, { byAgent: true }),
      ...(this.browserSpec(run) ? { browser: (action: string, a: { target?: string; text?: string }) => this.browsers.act({ run, runDir: dir, devPort: this.must(run).devServer!.port, spec: this.browserSpec(run)! }, action, a) } : {}),
    }, this.d.project.tools, name, args)
  }

  /** the agent's turn running now ended at once (its process killed); the run blocks, saying you stopped it */
  async stopTurn(run: string) { await this.agents.get(run)?.stop?.() }

  /** the run's agent process closed (it holds about 2 GB); its next turn starts one again on the same session */
  async closeAgent(run: string) { const a = this.agents.get(run); this.agents.delete(run); await a?.close?.() }

  async close() { await Promise.all([...this.agents.values()].map(a => a.close?.())) }

  private readPlan(run: string): { plan: ReturnType<typeof parsePlan> & { targets?: string[] } } | { problem: string } {
    if (!existsSync(this.planFile(run))) return { problem: 'is missing' }
    let md: string, plan: ReturnType<typeof parsePlan>
    try { md = readFileSync(this.planFile(run), 'utf8'); plan = parsePlan(md) } catch (e) { return { problem: `can't be read: ${(e as Error).message}` } }
    const gaps = planGaps(md, this.planKind(run))
    const targets = planFacts(md).targets
    return gaps.length ? { problem: `lacks: ${gaps.join('; ')}` } : { plan: { ...plan, ...(targets ? { targets } : {}) } }
  }

  /** what the run's plan has to say: a bug's reproduction; the lines the fix is for, where the project has release lines */
  private planKind(run: string) {
    const m = this.meta(run)
    return { bug: m.kind === 'bug', releaseLines: m.repos.some(r => this.repoConfig(r.key).releaseBases.length > 0), runDir: this.runDir(run) }
  }

  private async planStep(run: string, ticket: string) {
    const r = await this.runner.turn(run, planPrompt(this.meta(run), ticket, this.planFile(run), this.planKind(run)))
    if (!r.ok || this.ended(run)) return
    let p = this.readPlan(run)
    if ('problem' in p) {
      const again = await this.runner.turn(run, planRetryPrompt(this.planFile(run), p.problem))
      if (!again.ok || this.ended(run)) return
      p = this.readPlan(run)
      if ('problem' in p) { this.d.store.append(run, 'engine', { type: 'run.blocked', reason: `the agent wrote no plan (${this.planFile(run)} ${p.problem}); message it, or write the plan yourself` }); return }
    }
    await this.submitPlan(run, p.plan)
  }

  private async submitPlan(run: string, plan: ReturnType<typeof parsePlan> & { targets?: string[] }) {
    const held = plan.questions.some(q => q.held)
    const deadline = plan.questions.length && !held ? this.now() + this.d.project.plan.deadlineMinutes * 60_000 : undefined
    this.d.store.append(run, 'agent', { type: 'plan.submitted', summary: plan.summary, questions: plan.questions, ...(deadline ? { deadline } : {}), ...(plan.targets ? { targets: plan.targets } : {}) })
    if (this.must(run).stage === 'build') await this.buildStep(run)
  }

  private async buildStep(run: string) {
    let r = await this.runner.turn(run, buildPrompt(this.meta(run), this.answers(this.must(run)), this.prFile(run)))
    if (!r.ok || this.ended(run, r.text)) return
    // ended early (no PR description, no ask, resolve or block): told to finish, twice at most, then the run stops for you
    // (a customer patch run ships by writing the patch back: no PR description)
    const needsPr = !this.meta(run).patch
    for (let i = 0; i < 2 && needsPr && !existsSync(this.prFile(run)); i++) {
      r = await this.say(run, finishBuildPrompt(this.prFile(run)))
      if (!r.ok || this.ended(run, r.text)) return
    }
    if (needsPr && !existsSync(this.prFile(run))) { this.d.store.append(run, 'engine', { type: 'run.blocked', reason: `the agent ended the build three times without ${this.prFile(run)}; message it, or write the PR description yourself` }); return }
    this.d.store.append(run, 'agent', { type: 'build.done' })
    await this.verifyLoop(run)
  }

  /** the run's test logins must not ship: a secret-looking word of them in a changed file or pr.md refuses */
  /** the run's test logins as the words to look for: 6 characters or more, with a digit or a symbol (not a plain name) */
  private secrets(run: string): string[] {
    const f = join(this.runDir(run), 'logins.md')
    if (!existsSync(f)) return []
    return loginValues(readFileSync(f, 'utf8'))
  }

  private noLogins(run: string, pr: string, changed: { r: RunRepo; files: string[] }[]) {
    const secrets = this.secrets(run)
    if (!secrets.length) return
    const where: string[] = []
    if (secrets.some(x => pr.includes(x))) where.push('pr.md')
    for (const { r, files } of changed) for (const file of files) {
      const p = join(r.worktree, file)
      if (existsSync(p) && statSync(p).isFile() && statSync(p).size < 2_000_000 && secrets.some(x => readFileSync(p, 'utf8').includes(x))) where.push(file)
    }
    if (where.length) throw new Error(`${run}: a test login is in ${where.join(', ')}; take it out (message the agent), then ship again`)
  }

  /**
   * After a turn: the agent ended the run itself (resolution.md: no change needed; blocked.md: it can't go on), or
   * its last paragraph asks the human something. The run then stops for you; the file is kept under a dated name.
   */
  private ended(run: string, text = ''): boolean {
    const dir = this.runDir(run)
    const told = this.ends.get(run)
    if (told) {
      this.ends.delete(run)
      const line = told.text.split('\n')[0]!.slice(0, 300)
      if (told.kind === 'ask') this.d.store.append(run, 'agent', { type: 'agent.asked', question: told.text.slice(0, 1000) })
      else if (told.kind === 'block') this.d.store.append(run, 'agent', { type: 'run.blocked', reason: `the agent is blocked: ${line}` })
      else { writeFileSync(join(dir, `resolution-${this.now()}.md`), told.text + '\n'); this.d.store.append(run, 'agent', { type: 'run.resolved', summary: line, text: told.text.slice(0, 4000) }) }
      return true
    }
    const gist = (t: string) => t.split('\n').map(l => l.replace(/^#+\s*/, '').trim()).filter(Boolean).slice(0, 2).join(' — ').slice(0, 300)
    for (const name of ['blocked', 'resolution'] as const) {
      const f = join(dir, `${name}.md`)
      if (!existsSync(f)) continue
      const body = readFileSync(f, 'utf8'), kept = `${name}-${this.now()}.md`
      renameSync(f, join(dir, kept))
      if (name === 'blocked') this.d.store.append(run, 'agent', { type: 'run.blocked', reason: `the agent is blocked: ${gist(body)} (${kept})` })
      else this.d.store.append(run, 'agent', { type: 'run.resolved', summary: gist(body), text: body.slice(0, 4000) })
      return true
    }
    const last = text.trim().split(/\n\s*\n/).pop()?.trim() ?? ''
    if (/\?[)*_"'»]*$/.test(last) && last.length <= 1000) { this.d.store.append(run, 'agent', { type: 'agent.asked', question: last }); return true }
    return false
  }

  /** verify every repo; with several repos each finding names its repo */
  private async verifyAll(run: string, m: Meta): Promise<{ ok: boolean; findings: string[] }> {
    let ok = true
    const findings: string[] = []
    for (const r of m.repos) {
      const res = await this.building(run, () => verify(r.worktree, this.repoConfig(r.key).verify))
      ok &&= res.ok
      findings.push(...res.steps.flatMap(s => s.newFindings).map(f => (m.repos.length > 1 ? `${r.key}: ${f}` : f)))
    }
    // only the fix, nothing that shouldn't be published: the change beyond the plan's PR extras, and the description
    const plan = existsSync(this.planFile(run)) ? planFacts(readFileSync(this.planFile(run), 'utf8')) : { extras: { tests: false, comments: false } }
    const own: string[] = []
    for (const r of m.repos) own.push(...(await drift(r.worktree, plan.extras)).map(f => (m.repos.length > 1 ? `${r.key}: ${f}` : f)))
    if (existsSync(this.prFile(run))) {
      const ev = join(this.runDir(run), 'evidence')
      own.push(...prProblems(readFileSync(this.prFile(run), 'utf8'), { repro: plan.repro, evidence: existsSync(ev) ? readdirSync(ev) : [] }))
    }
    return { ok: ok && !own.length, findings: [...findings, ...own] }
  }

  private async verifyLoop(run: string) {
    const m = this.meta(run)
    for (;;) {
      let res, tree
      try { tree = await this.content(m); res = await this.verifyAll(run, m) }
      catch (e) { this.d.store.append(run, 'engine', { type: 'run.blocked', reason: `verify could not run: ${(e as Error).message}` }); return }
      this.d.store.append(run, 'engine', { type: 'verify.result', ok: res.ok, newFindings: res.findings, tree })
      let s = this.must(run)
      let prompt = fixPrompt(res.findings)
      if (s.stage === 'review') {
        const found = await this.reviewStep(run)
        s = this.must(run)
        if (s.stage !== 'build' || !found) return // clean, skipped, or stopped for the human (review cap)
        prompt = reviewFixPrompt(found, this.answersFile(run))
      }
      if (s.stage !== 'build') return // stopped for the human (red too often)
      const r = await this.say(run, prompt)
      if (!r.ok || this.ended(run, r.text)) return
      this.d.store.append(run, 'agent', { type: 'build.done' })
    }
  }

  /** the independent review; returns its findings when the agent has something to fix */
  /**
   * The independent review: each of the project's lenses a fresh read-only session, in parallel, on the ticket, the
   * plan, the PR description, the change and the author's earlier answers. An unreadable answer is asked for once
   * more; a lens that still can't be read is noted, and the review is skipped only when none could be read.
   */
  private async reviewStep(run: string): Promise<(Finding & { lens: Lens })[] | null> {
    const m = this.meta(run), c = this.d.project.review
    const skip = (reason: string) => { this.d.store.append(run, 'engine', { type: 'review.skipped', reason }); return null }
    if (!c.enabled) return skip('review is off for this project')
    if (!this.d.makeReviewer) return skip('no reviewer configured')
    const others = m.repos.map(r => r.worktree).filter(w => w !== m.worktree)
    const read = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8') : '')
    const change = m.repos.length > 1 ? m.repos.map(r => `### ${r.key} (${r.worktree})\n${changeText(r.worktree) || '(no change)'}`).join('\n\n') : changeText(m.repos[0]!.worktree)
    const ev = join(this.runDir(run), 'evidence')
    const evidence = existsSync(ev) ? readdirSync(ev).filter(f => /\.(png|jpe?g|webp|gif)$/i.test(f)).sort().map(f => join(ev, f)) : []
    const base = { key: m.key, title: m.title, ticket: read(join(this.runDir(run), 'ticket.md')), plan: read(this.planFile(run)), change, pr: read(this.prFile(run)), answers: read(this.answersFile(run)), evidence }
    const one = async (lens: Lens) => {
      const settings = writeRunSettings({ dir: join(this.runDir(run), 'reviewer', lens), worktree: m.worktree, allow: others, deny: [join(this.d.dataDir, 'token')], sandbox: this.d.project.sandbox, claudeMdExcludes: this.d.project.claudeMdExcludes, denyTools: this.d.project.denyTools })
      // the run's model for the reviewers too (a run started on sonnet is reviewed on sonnet)
      const reviewer = this.d.makeReviewer!({ cwd: m.worktree, settings, maxTurns: c.maxTurns, ...(m.model ? { model: m.model } : {}) })
      try {
        let r = await this.runner.turnWith(run, reviewer, reviewPrompt({ ...base, ...(c.lenses.length > 1 ? { lens } : {}) }), { ownSession: false })
        if (!r.ok) return { lens, error: `the ${lens} review did not finish: ${r.text.split('\n')[0]!.slice(0, 200)}` }
        try { return { lens, ...parseFindings(r.text) } } catch (first) {
          r = await this.runner.turnWith(run, reviewer, 'Answer again with the short note and exactly one ```json block holding the array of findings (an empty array if none).', { ownSession: false })
          if (!r.ok) return { lens, error: `the ${lens} review did not finish` }
          try { return { lens, ...parseFindings(r.text) } } catch (e) { return { lens, error: `the ${lens} review unreadable: ${(e as Error).message} (first answer: ${(first as Error).message})` } }
        }
      } finally { await reviewer.close?.() }
    }
    const results = await Promise.all(c.lenses.map(one))
    const read_ = results.filter(x => !('error' in x)) as { lens: Lens; findings: Finding[]; dropped: number; below: Finding[]; note: string }[]
    const errors = results.filter(x => 'error' in x).map(x => (x as { error: string }).error)
    if (!read_.length) return skip(errors.join('; '))
    // tagged by lens only when there are several
    const findings = read_.flatMap(x => x.findings.map(f => (c.lenses.length > 1 ? { ...f, lens: x.lens } : f))) as (Finding & { lens: Lens })[]
    const n = this.must(run).loops.review + 1
    writeFileSync(join(this.runDir(run), 'review.json'), JSON.stringify({ review: n, at: this.now(), findings, dropped: read_.reduce((k, x) => k + x.dropped, 0), below: read_.flatMap(x => x.below), lenses: read_.map(x => ({ lens: x.lens, findings: x.findings.length, dropped: x.dropped, below: x.below, note: x.note })), ...(errors.length ? { errors } : {}), note: read_.map(x => (c.lenses.length > 1 ? `${x.lens}: ${x.note}` : x.note)).join('\n\n') }, null, 2) + '\n')
    this.d.store.append(run, 'engine', { type: 'review.result', findings: findings.length })
    return findings.length ? findings : null
  }

  /** git's environment for flow's own commits: the project's commit identity when it names one */
  private commitEnv(): Record<string, string | undefined> {
    const who = this.d.project.commitAs, env = this.d.gitEnv ?? process.env
    return who ? { ...env, GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email, GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email } : env
  }

  private answersFile(run: string) { return join(this.runDir(run), 'review-answers.md') }
}
