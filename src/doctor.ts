/**
 * flow doctor: what a run would trip on, found before it starts (the CLIs, logins to the tracker and the code host,
 * the checkouts, the device tools and template, the app env template, disk, the service). Every check only reads:
 * the keychain is asked whether the token is there, never for it; no model is called.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Project } from './config.ts'

export interface Check { ok: boolean; what: string; fix?: string }
export interface DoctorDeps {
  run(argv: string[], cwd?: string): Promise<{ code: number; out: string; err: string }>
  exists(path: string): boolean
  /** free space, in GB, on the volume of path */
  freeGB(path: string): number
  serviceUp(): boolean
}

const expand = (p: string) => p.replace(/^~(?=\/|$)/, homedir())

export async function doctor(projects: Project[], d: DoctorDeps): Promise<Check[]> {
  const out: Check[] = []
  const tool = async (what: string, argv: string[], fix: string) => { const r = await d.run(argv).catch(() => ({ code: 127, out: '', err: '' })); out.push({ ok: r.code === 0, what, ...(r.code === 0 ? {} : { fix }) }) }
  await tool('claude CLI', ['claude', '--version'], 'install Claude Code and sign in with your subscription (claude, then /login)')
  await tool('git', ['git', '--version'], 'install git')
  const sdk = process.env.ANDROID_HOME ?? join(homedir(), 'Library/Android/sdk')
  for (const p of projects) {
    for (const r of p.repos) {
      const path = expand(r.path)
      const here = d.exists(path)
      out.push({ ok: here, what: `${p.key}/${r.key}: checkout ${r.path}`, ...(here ? {} : { fix: `clone the repo there, or fix repos[].path in ${p.key}.json` }) })
      if (here) await tool(`${p.key}/${r.key}: origin`, ['git', '-C', path, 'remote', 'get-url', 'origin'], 'the checkout needs an origin remote (flow fetches and pushes there)')
      if (here && r.appEnv?.from) { const f = join(path, r.appEnv.from); out.push({ ok: d.exists(f), what: `${p.key}/${r.key}: app env template ${r.appEnv.from}`, ...(d.exists(f) ? {} : { fix: `appEnv.from names a file the checkout doesn't have` }) }) }
    }
    const tracker = p.tracker, forge = p.forge
    if (tracker.kind === 'azure' || forge.kind === 'azure') await tool(`${p.key}: az signed in`, ['az', 'account', 'show', '-o', 'none'], 'az login (and az extension add --name azure-devops)')
    if (forge.kind === 'github') await tool(`${p.key}: gh signed in`, ['gh', 'auth', 'status'], 'gh auth login')
    if (tracker.kind === 'jira') await tool(`${p.key}: Jira token in the keychain (${tracker.keychain})`, ['security', 'find-generic-password', '-s', tracker.keychain],
      `make an API token at https://id.atlassian.com/manage-profile/security/api-tokens, then: security add-generic-password -U -s ${tracker.keychain} -a ${tracker.email} -w`)
    if (p.devices?.android) {
      await tool('adb', [join(sdk, 'platform-tools/adb'), 'version'], 'install the Android SDK platform tools (or set ANDROID_HOME)')
      const avds = await d.run([join(sdk, 'emulator/emulator'), '-list-avds']).catch(() => ({ code: 127, out: '', err: '' }))
      const t = p.devices.android.template
      const has = avds.code === 0 && (!t || avds.out.split('\n').map(x => x.trim()).includes(t))
      out.push({ ok: has, what: `android template ${t ?? '(none)'}`, ...(has ? {} : { fix: avds.code === 0 ? `make the AVD ${t} in Android Studio (Device Manager), or fix devices.android.template` : 'install the Android emulator (SDK Manager)' }) })
      await tool('argent (drives the emulator)', ['sh', '-c', 'command -v argent'], 'npx @swmansion/argent@latest init -y')
    }
    if (p.devices?.ios) await tool('xcrun simctl', ['xcrun', 'simctl', 'help'], 'install Xcode and its command line tools')
    if (p.repos.some(r => r.devServer?.browser)) await tool('agent-browser (the web runs\' browser)', ['sh', '-c', 'command -v agent-browser'], 'npm i -g agent-browser')
    if (p.indexes.some(x => x.sync?.startsWith('codegraph'))) await tool('codegraph (the runs\' code index)', ['sh', '-c', 'command -v codegraph'], 'install codegraph, or take the index out of indexes')
    const free = d.freeGB(expand(p.worktrees))
    out.push({ ok: free >= 20, what: `disk free where the worktrees go (${p.worktrees})`, ...(free >= 20 ? {} : { fix: `${Math.round(free)} GB free: a run's worktrees and builds take several GB; free some, or remove finished runs (flow rm)` }) })
  }
  const up = d.serviceUp()
  out.push({ ok: up, what: 'flow service', ...(up ? {} : { fix: 'flow (the screen starts it) or flow serve' }) })
  // one line per check, even when several projects name the same tool
  return out.filter((c, i) => out.findIndex(x => x.what === c.what) === i)
}

export const report = (checks: Check[]) => checks.map(c => (c.ok ? `✓ ${c.what}` : `✗ ${c.what} — ${c.fix}`)).join('\n')
