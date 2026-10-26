/**
 * A project's settings as the screen edits them: each section's fields over the project's own file (its JSON as
 * written, so what you don't touch stays as it was), a value read or set by its path, and the changes for the save.
 */

export type Path = (string | number)[]
export type Json = Record<string, unknown>

export type FieldKind = 'text' | 'number' | 'percent' | 'toggle' | 'select' | 'list' | 'map' | 'locked' | 'heading' | 'add'
export interface FieldDef {
  kind: FieldKind; label: string; path?: Path; hint?: string
  /** select: the choices; toggle: shown the other way round (on means the setting is false) */
  options?: string[]; invert?: boolean
  /** what is used when the file says nothing */
  fallback?: unknown
  /** add: what the path is set to when chosen (a dev server's first settings, say) */
  value?: unknown
}

export const SECTIONS = ['General', 'Tickets & PRs', 'Repos', 'Agents & limits', 'Permissions', 'Devices', 'Customer patches', 'Naming'] as const
export type Section = (typeof SECTIONS)[number]

export function get(json: unknown, path: Path): unknown {
  let v: unknown = json
  for (const k of path) v = v && typeof v === 'object' ? (v as Record<string | number, unknown>)[k] : undefined
  return v
}

/** the JSON with one value set (undefined removes it), the rest untouched; missing objects on the way are made */
export function set<T extends Json>(json: T, path: Path, value: unknown): T {
  const out = structuredClone(json) as Json
  let o: Record<string | number, unknown> = out
  for (const [i, k] of path.slice(0, -1).entries()) {
    if (!o[k] || typeof o[k] !== 'object') o[k] = typeof path[i + 1] === 'number' ? [] : {}
    o = o[k] as Record<string | number, unknown>
  }
  const last = path[path.length - 1]!
  if (value === undefined) delete o[last]; else o[last] = value
  return out as T
}

const repoKey = (json: Json, i: number) => String(get(json, ['repos', i, 'key']) ?? i)

/** each section's fields; Repos shows the chosen repo's */
export function fields(section: Section, json: Json, repo = 0): FieldDef[] {
  const tracker = String(get(json, ['tracker', 'kind']) ?? ''), forge = String(get(json, ['forge', 'kind']) ?? '')
  const r = (k: string) => ['repos', repo, k]
  switch (section) {
    case 'General': return [
      { kind: 'locked', label: 'Key', path: ['key'], hint: "it names the runs; it can't change" },
      { kind: 'text', label: 'Name', path: ['name'] },
      { kind: 'text', label: 'Worktrees', path: ['worktrees'], hint: "where runs' worktrees go" },
      { kind: 'list', label: 'Brief', path: ['brief'], hint: 'what agents should know: tools to check data with, where things are (a line each)' },
      { kind: 'list', label: 'Local files', path: ['localFiles'], hint: "the main checkout's ignored files each worktree gets: .claude, .mcp.json, .npmrc" },
      { kind: 'list', label: 'Not loaded', path: ['claudeMdExcludes'], hint: "CLAUDE.md files agents skip: another tool's, in a folder above" },
      { kind: 'toggle', label: 'License', path: ['login', 'license'], fallback: false, hint: "the new run's Login step asks for a license too (the app's)" },
    ]
    case 'Tickets & PRs': return [
      { kind: 'heading', label: 'Tickets', hint: tracker === 'jira' ? 'Jira' : 'Azure DevOps' },
      ...(tracker === 'jira' ? [
        { kind: 'text' as const, label: 'Site', path: ['tracker', 'site'] }, { kind: 'text' as const, label: 'Project key', path: ['tracker', 'key'] },
        { kind: 'text' as const, label: 'Email', path: ['tracker', 'email'] }, { kind: 'text' as const, label: 'Keychain item', path: ['tracker', 'keychain'], fallback: 'flow-jira', hint: 'holds the API token' },
      ] : [
        { kind: 'text' as const, label: 'Organisation', path: ['tracker', 'org'] },
        { kind: 'text' as const, label: 'Project', path: ['tracker', 'project'], hint: 'tickets may sit on any board of the organisation' },
      ]),
      { kind: 'heading', label: 'Pull requests', hint: forge === 'github' ? 'GitHub · drafts' : 'Azure DevOps · drafts, linked to the work item' },
      ...(forge === 'github' ? [{ kind: 'text' as const, label: 'Owner', path: ['forge', 'owner'] }]
        : [{ kind: 'text' as const, label: 'Organisation', path: ['forge', 'org'] }, { kind: 'text' as const, label: 'Project', path: ['forge', 'project'] }]),
    ]
    case 'Repos': {
      const verify = (get(json, r('verify')) as { name?: string; kind?: string }[] | undefined) ?? []
      const dev = get(json, r('devServer')), patches = get(json, r('patches'))
      return [
        { kind: 'text', label: 'Checkout', path: r('path'), hint: 'its worktrees are made from it' },
        { kind: 'text', label: 'Base', path: r('defaultBase'), hint: "a run's default" },
        { kind: 'list', label: 'Release lines', path: r('releaseBases'), hint: "the form's base list" },
        { kind: 'text', label: 'Install', path: r('install') },
        { kind: 'toggle', label: 'Default', path: r('default'), fallback: false, hint: 'runs get it when they name no repo' },
        { kind: 'text', label: 'Ticket match', path: r('match'), hint: 'its platform or tags pick this repo' },
        { kind: 'heading', label: 'Checks', hint: 'run on the change and on the base; only new findings count' },
        ...verify.flatMap((v, i) => [
          { kind: 'text' as const, label: `${v.name ?? i} (${v.kind ?? '?'})`, path: [...r('verify'), i, 'cmd'] },
          { kind: 'toggle' as const, label: '  changed files', path: [...r('verify'), i, 'changedOnly'], fallback: false, hint: 'only the files the run changed' },
        ]),
        { kind: 'heading', label: 'Dev server', hint: dev ? 'for runs started with one' : 'none for this repo' },
        ...(dev ? [
          { kind: 'text' as const, label: 'Command', path: [...r('devServer'), 'cmd'], hint: '{port}: its own' },
          { kind: 'number' as const, label: 'First port', path: [...r('devServer'), 'portStart'], fallback: 5300 },
          { kind: 'text' as const, label: 'Url', path: [...r('devServer'), 'url'], fallback: 'http://localhost:{port}' },
        ] : [{ kind: 'add' as const, label: 'Add a dev server', path: r('devServer'), value: { cmd: 'npm run dev -- --port {port}', portStart: 5300, url: 'http://localhost:{port}' } }]),
        { kind: 'heading', label: 'Customer patches', hint: patches ? 'commands, run in the worktree' : 'none for this repo' },
        ...(patches ? [
          { kind: 'text' as const, label: 'Apply', path: [...r('patches'), 'apply'] }, { kind: 'text' as const, label: 'Write back', path: [...r('patches'), 'writeBack'] },
          { kind: 'text' as const, label: 'List', path: [...r('patches'), 'choices'] }, { kind: 'text' as const, label: 'Check', path: [...r('patches'), 'check'] },
        ] : []),
      ]
    }
    case 'Agents & limits': return [
      { kind: 'number', label: 'Agents at once', path: ['agent', 'maxParallel'], fallback: 2, hint: "this project's; the machine's are in flow.json" },
      { kind: 'percent', label: 'Stop at (5 h)', path: ['usage', 'fiveHour'], fallback: 0.9, hint: 'turns start only below this share of the 5-hour window' },
      { kind: 'percent', label: 'Stop at (week)', path: ['usage', 'week'], fallback: 0.95 },
      { kind: 'number', label: 'Plan deadline', path: ['plan', 'deadlineMinutes'], fallback: 30, hint: 'minutes; then the defaults (held questions wait for you)' },
      { kind: 'toggle', label: 'Review', path: ['review', 'enabled'], fallback: true, hint: 'an independent reviewer before ship' },
    ]
    case 'Permissions': return [
      { kind: 'heading', label: 'Always', hint: "flow's guard: agents can't change these" },
      { kind: 'locked', label: 'no commits', hint: 'commit, push or rewrite history (flow commits and pushes at ship)' },
      { kind: 'locked', label: 'no tracker', hint: 'write to the tracker or open PRs (flow does, as you)' },
      { kind: 'locked', label: 'no outside', hint: "edit files outside the run's worktree and folders" },
      { kind: 'heading', label: 'OS sandbox', hint: "Claude Code's, around every shell command of an agent" },
      { kind: 'toggle', label: 'On', path: ['sandbox', 'enabled'], fallback: false },
      { kind: 'toggle', label: 'Strict', path: ['sandbox', 'failIfUnavailable'], fallback: false, hint: "stop the run if the sandbox can't start" },
      { kind: 'toggle', label: 'Stay inside', path: ['sandbox', 'allowUnsandboxedCommands'], invert: true, fallback: true, hint: "commands can't leave it" },
      { kind: 'list', label: 'Writable', path: ['sandbox', 'filesystem', 'allowWrite'], hint: "+ the run's worktree and folder, always" },
      { kind: 'list', label: 'Outside', path: ['sandbox', 'excludedCommands'], hint: 'commands that run without the sandbox' },
      { kind: 'toggle', label: 'Domains only', path: ['sandbox', 'network', 'strictAllowlist'], fallback: false, hint: 'the network only to these' },
      { kind: 'toggle', label: 'Local servers', path: ['sandbox', 'network', 'allowLocalBinding'], fallback: false, hint: 'Metro, dev servers' },
      { kind: 'list', label: 'Domains', path: ['sandbox', 'network', 'allowedDomains'] },
      { kind: 'heading', label: 'Review and plan' },
      { kind: 'toggle', label: 'Review', path: ['review', 'enabled'], fallback: true, hint: 'read-only, findings ≥80% go back to the agent' },
      { kind: 'number', label: 'Plan deadline', path: ['plan', 'deadlineMinutes'], fallback: 30, hint: 'minutes' },
      { kind: 'heading', label: 'Tools' },
      { kind: 'list', label: 'Denied tools', path: ['denyTools'], hint: "tools agents can't call: an MCP server's write tools (permission rules)" },
    ]
    case 'Devices': {
      const d = get(json, ['devices'])
      if (!d) return [{ kind: 'heading', label: 'Devices', hint: 'none: runs here get no emulator or simulator' }, { kind: 'add', label: 'Add devices', path: ['devices'], value: { metro: 'npx react-native start --port {metroPort}', consolePortStart: 5700, metroPortStart: 8300 } }]
      const platform = (p: 'android' | 'ios'): FieldDef[] => get(json, ['devices', p]) ? [
        { kind: 'heading', label: p === 'android' ? 'Android' : 'iOS' },
        ...(['template', 'prepare', 'create', 'id', 'boot', 'ready', 'install', 'stop', 'remove'] as const).map(k => ({ kind: 'text' as const, label: k[0]!.toUpperCase() + k.slice(1), path: ['devices', p, k] })),
        { kind: 'toggle', label: 'Boot stays', path: ['devices', p, 'bootStays'], fallback: false, hint: 'it keeps running (an emulator)' },
      ] : [{ kind: 'add', label: `Add ${p === 'android' ? 'Android' : 'iOS'}`, path: ['devices', p], value: { boot: '', bootStays: p === 'android', ready: '' } }]
      return [
        { kind: 'text', label: 'Metro', path: ['devices', 'metro'], hint: '{metroPort}: its own' },
        { kind: 'number', label: 'First console', path: ['devices', 'consolePortStart'], fallback: 5700 },
        { kind: 'number', label: 'First Metro', path: ['devices', 'metroPortStart'], fallback: 8300 },
        { kind: 'toggle', label: 'Headless', path: ['devices', 'headless'], fallback: false, hint: 'no emulator window ({headless} in its boot): see it in the browser' },
        ...platform('android'), ...platform('ios'),
      ]
    }
    case 'Customer patches': return [
      { kind: 'map', label: 'Apps', path: ['patchApps'], hint: "app=pattern on a ticket's area or title (picking → product)" },
      { kind: 'heading', label: 'Commands', hint: `in Repos, per repo (${((get(json, ['repos']) as Json[] | undefined) ?? []).map((_, i) => i).filter(i => get(json, ['repos', i, 'patches'])).map(i => repoKey(json, i)).join(', ') || 'none yet'})` },
    ]
    case 'Naming': return [
      { kind: 'text', label: 'Branch', path: ['naming', 'branch'], fallback: '{type}/{id}', hint: '{type} fix or feat, {id}, {key}' },
      { kind: 'select', label: 'Commit', path: ['naming', 'commit'], options: ['conventional', 'key-summary'], fallback: 'conventional' },
      { kind: 'select', label: 'PR title', path: ['naming', 'prTitle'], options: ['key-summary', 'key'], fallback: 'key-summary' },
      { kind: 'select', label: 'PR body', path: ['naming', 'prBody'], options: ['full', 'ticket-link'], fallback: 'full' },
    ]
  }
}

/** a field's value as shown: the file's, else what is used when it says nothing */
export function shown(f: FieldDef, json: Json): unknown { const v = f.path ? get(json, f.path) : undefined; return v === undefined ? f.fallback : v }

/** a map ({app: pattern}) as list items and back */
export const mapItems = (v: unknown) => Object.entries((v as Record<string, string>) ?? {}).map(([k, x]) => `${k}=${x}`)
export const itemsMap = (items: string[]) => Object.fromEntries(items.filter(i => i.includes('=')).map(i => [i.slice(0, i.indexOf('=')).trim(), i.slice(i.indexOf('=') + 1).trim()]).filter(([k]) => k))

/** a change for the save review: where (repos shown by key), and what was and is now (a list's items added and removed) */
export interface Change { where: string; before?: unknown; after?: unknown; added?: string[]; removed?: string[] }

export function changes(before: Json, after: Json): Change[] {
  const out: Change[] = []
  const where = (path: Path) => path.map((k, i) => (typeof k === 'number' && path[i - 1] === 'repos' ? repoKey(after, k) : String(k))).join('.')
  const walk = (a: unknown, b: unknown, path: Path) => {
    if (JSON.stringify(a) === JSON.stringify(b)) return
    if (Array.isArray(a) && Array.isArray(b) && [...a, ...b].every(x => typeof x !== 'object')) {
      const sa = a.map(String), sb = b.map(String)
      out.push({ where: where(path), added: sb.filter(x => !sa.includes(x)), removed: sa.filter(x => !sb.includes(x)) })
      return
    }
    const obj = (x: unknown) => x && typeof x === 'object'
    if (obj(a) && obj(b)) {
      const keys = [...new Set([...Object.keys(a as Json), ...Object.keys(b as Json)])]
      for (const k of keys) walk((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], [...path, Array.isArray(a) ? Number(k) : k])
      return
    }
    out.push({ where: where(path), before: a, after: b })
  }
  walk(before, after, [])
  return out
}
