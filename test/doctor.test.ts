import { describe, expect, test } from 'bun:test'
import { parseProject } from '../src/config.ts'
import { doctor, report, type DoctorDeps } from '../src/doctor.ts'

// flow doctor: what a run would trip on, found before it starts. Every check is read-only and asks no model.
const project = parseProject({
  key: 'ex', name: 'Ex', worktrees: '/wt',
  tracker: { kind: 'jira', site: 'https://x.atlassian.net', key: 'SGL', email: 'me@x.test', keychain: 'flow-jira' },
  forge: { kind: 'github', owner: 'OWNER' },
  repos: [{ key: 'web', path: '/repos/web', defaultBase: 'origin/main', verify: [], appEnv: { file: '.env', from: '.env.example', login: { license: 'LIC' } },
    devServer: { cmd: 'vite --port {port}', browser: { start: 'https://hub.example.com/dev' } } }],
  devices: { metro: 'npx react-native start', android: { template: 'pixel', create: 'x', id: 'emulator-{consolePort}', boot: 'x', ready: 'x', install: 'x', stop: 'x', remove: 'x' } },
  indexes: [{ dir: '.codegraph', sync: 'codegraph sync' }],
}, 't')

function deps(o: { fail?: RegExp; missing?: string[]; free?: number; service?: boolean } = {}): DoctorDeps & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    run: async argv => {
      const line = argv.join(' ')
      calls.push(line)
      if (o.fail?.test(line)) return { code: 1, out: '', err: 'not found' }
      if (line.includes('-list-avds')) return { code: 0, out: 'pixel\nother\n', err: '' }
      return { code: 0, out: 'ok', err: '' }
    },
    exists: p => !(o.missing ?? []).some(m => p.endsWith(m)),
    freeGB: () => o.free ?? 200,
    serviceUp: () => o.service ?? true,
  }
}

describe('flow doctor', () => {
  test('a healthy machine: every check passes, and the keychain is asked whether the token exists, never for it', async () => {
    const d = deps()
    const checks = await doctor([project], d)
    expect(checks.filter(c => !c.ok)).toEqual([])
    for (const what of ['claude', 'git', 'ex/web: checkout /repos/web', 'gh', 'Jira token', 'adb', 'android template pixel', 'agent-browser', 'codegraph', 'ex/web: app env template .env.example', 'disk', 'service']) expect(checks.map(c => c.what).join('\n')).toContain(what)
    const keychain = d.calls.find(c => c.startsWith('security '))!
    expect(keychain).toBe('security find-generic-password -s flow-jira')
    expect(d.calls.join('\n')).not.toMatch(/ -w\b/)
  })
  test('what is missing is named with how to fix it', async () => {
    const checks = await doctor([project], deps({ fail: /^gh auth|^security|-list-avds/, missing: ['/repos/web', '.env.example'], free: 5, service: false }))
    const bad = checks.filter(c => !c.ok)
    expect(bad.map(c => c.what)).toEqual(expect.arrayContaining(['ex: gh signed in', 'ex: Jira token in the keychain (flow-jira)', 'ex/web: checkout /repos/web', 'android template pixel', 'disk free where the worktrees go (/wt)', 'flow service']))
    expect(bad.find(c => c.what.includes('gh'))!.fix).toContain('gh auth login')
    expect(bad.find(c => c.what.includes('Jira'))!.fix).toContain('security add-generic-password')
    const text = report(checks)
    expect(text).toMatch(/^✗ ex: gh signed in — gh auth login/m)
    expect(text).toMatch(/^✓ claude/m)
    // the checkout is there, its app env template is not
    const env = await doctor([project], deps({ missing: ['.env.example'] }))
    expect(env.filter(c => !c.ok).map(c => c.what)).toEqual(['ex/web: app env template .env.example'])
  })
})
