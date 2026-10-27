import { describe, expect, test } from 'bun:test'
import { act } from 'react'
import { testRender } from '@opentui/react/test-utils'
import type { RunEvent, RunState } from '../src/run.ts'
import type { Command } from '../src/service.ts'
import { App, type FlowApi } from '../src/tui/app.tsx'
import { stopShells } from '../src/tui/detail.tsx'
import type { Entry } from '../src/transcript.ts'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The Runs screen and run detail, driven by keys, against a stand-in service connection.
const NOW = Date.parse('2026-10-25T12:00:00Z')
const base = (id: string, over: Partial<RunState>): RunState => ({ id, ticket: `#${id.split('-')[1]}`, title: `Title ${id}`, project: 'fso', base: 'origin/develop',
  stage: 'build', status: 'running', loops: { verify: 0, verifyRuns: 0, review: 0 }, tokens: 264_000, compactions: 0, createdAt: NOW - 14 * 60_000, updatedAt: NOW - 60_000, ...over })
const runs = [
  base('fso-105', { stage: 'plan', status: 'needs-you', needs: { kind: 'plan', ask: '1 open question', held: false, deadline: NOW + 12 * 60_000 },
    plan: { summary: 'Guard the walk.', questions: [{ id: 'Q1', text: 'Also guard the order list?', default: 'no', held: false }] } }),
  base('fso-104', { stage: 'ship', status: 'needs-you', needs: { kind: 'ship', ask: 'verified' } }),
  base('fso-103', { stage: 'verify' }),
]

function api(list = runs) {
  const sent: Command[] = []
  const listeners = new Set<(m: { type: string; notice?: { run: string; text: string } }) => void>()
  const a: FlowApi = {
    runs: new Map(list.map(r => [r.id, r])), windows: { fiveHour: { utilization: 0.07, resetsAt: Date.parse('2026-10-25T14:00:00Z') / 1000, status: 'allowed' }, week: { utilization: 0.55, resetsAt: 1, status: 'allowed' } },
    listen: f => { listeners.add(f); return () => listeners.delete(f) },
    send: async c => { sent.push(c); return { ok: true, run: 'run' in c ? c.run : 'x' } },
    events: async run => [{ seq: 1, at: NOW - 14 * 60_000, run, actor: 'human', type: 'run.created', ticket: '#105', title: 't', project: 'fso', base: 'b' }, { seq: 2, at: NOW - 13 * 60_000, run, actor: 'agent', type: 'plan.submitted', summary: 's', questions: [] }] as RunEvent[],
    file: async (_run, name) => (name === 'plan.md' ? '# Plan\n\nGuard the walk against missing assets.\n'
      : name === 'review.json' ? JSON.stringify({ review: 2, findings: [{ severity: 'P1', file: 'src/b.ts', line: 4, problem: 'the order list still shows 8' }], dropped: 1, below: [{ severity: 'P2', file: 'src/c.ts', problem: 'maybe a rounding edge', confidence: 55 }] }) : ''),
  }
  return { a, sent, push: (m: { type: string; notice?: { run: string; text: string } }) => listeners.forEach(f => f(m)) }
}
async function screen(list = runs, size = { width: 130, height: 34 }, more: Partial<FlowApi> = {}) {
  const f = api(list)
  Object.assign(f.a, more)
  let quit = false
  const s = await testRender(<App api={f.a} now={() => NOW} onQuit={() => { quit = true }} />, size)
  const frame = async () => { await act(async () => { await Bun.sleep(1) }); await s.renderOnce(); return s.captureCharFrame() }
  // a lone Escape is only known after a short pause (it could start a key sequence), so wait for it
  const press = async (...keys: string[]) => {
    for (const k of keys) await act(async () => { k === 'enter' ? s.mockInput.pressEnter() : k === 'esc' ? s.mockInput.pressEscape() : k === 'ctrl+k' ? s.mockInput.pressKey('k', { ctrl: true }) : k === 'down' ? s.mockInput.pressArrow('down') : k === 'tab' ? s.mockInput.pressKey('\t') : s.mockInput.pressKey(k); if (k === 'esc') await Bun.sleep(80) })
    return frame()
  }
  // content that loads (a file, a reply) arrives when it arrives: wait for it, up to 3s, rather than a fixed pause
  const until = async (text: string) => { let f = ''; for (let i = 0; i < 100 && !(f = await frame()).includes(text); i++) await act(async () => { await Bun.sleep(30) }); return f }
  return { s, f, frame, press, until, quit: () => quit }
}

describe('Runs screen', () => {
  test('header with plan windows; what needs you with the deadline; the runs table with stage, status, tokens, next', async () => {
    const t = await screen()
    try {
      const f = await t.frame()
      expect(f).toContain('3 active')
      expect(f).toContain('5h 7%')
      expect(f).toContain('week 55%')
      expect(f).toMatch(/#105 +Title fso-105 +develop .*Plan approval +defaults in 12m +a approve/)
      expect(f).toContain('Guard the walk. · 1 open question')
      expect(f).toMatch(/#104 .*Ready to ship .*S ship/)
      expect(f).toMatch(/#103 +Title fso-103 +fso +develop +●─●─●─◎╌◌╌◌ +running +14m +264k +verifying/)
    } finally { t.s.renderer.destroy() }
  })
  test('a on a plan: the questions with their defaults, then y approves with the defaults', async () => {
    const t = await screen()
    try {
      const f = await t.press('a')
      expect(f).toContain('Approve #105 with the defaults and start the build?')
      expect(f).toContain('Q1 Also guard the order list? → no')
      await t.press('y')
      expect(t.f.sent).toEqual([{ cmd: 'approve', run: 'fso-105' }])
    } finally { t.s.renderer.destroy() }
  })
  test('an answer with spaces is kept whole: Q1=only the list Q2=no', async () => {
    const t = await screen([base('fso-105', { stage: 'plan', status: 'needs-you', needs: { kind: 'plan', ask: '2 open questions', held: false },
      plan: { summary: 's', questions: [{ id: 'Q1', text: 'a?', default: 'no', held: false }, { id: 'Q2', text: 'b?', default: 'yes', held: false }] } })])
    try {
      await t.press('a', 'e', ...'Q1=only the list q2=no', 'enter')
      expect(t.f.sent).toEqual([{ cmd: 'approve', run: 'fso-105', answers: { Q1: 'only the list', Q2: 'no' } }])
    } finally { t.s.renderer.destroy() }
  })
  test('other answers: e, type Q1=yes, enter', async () => {
    const t = await screen()
    try {
      await t.press('a', 'e', 'Q', '1', '=', 'y', 'e', 's', 'enter')
      expect(t.f.sent).toEqual([{ cmd: 'approve', run: 'fso-105', answers: { Q1: 'yes' } }])
    } finally { t.s.renderer.destroy() }
  })
  test('S on a verified run asks first, under its item; y ships', async () => {
    const t = await screen()
    try {
      const f = await t.press('j', 'S')
      expect(f).toContain('Ship #104?')
      await t.press('y')
      expect(t.f.sent).toEqual([{ cmd: 'ship', run: 'fso-104' }])
    } finally { t.s.renderer.destroy() }
  })
  test('S on a run that is not verified says so and sends nothing', async () => {
    const t = await screen()
    try {
      expect(await t.press('j', 'j', 'S')).toContain('#103 is not ready to ship')
      expect(t.f.sent).toEqual([])
    } finally { t.s.renderer.destroy() }
  })
  test('in a run\'s detail p ports it once it has its draft PR; otherwise it says why not', async () => {
    const t = await screen([base('fso-104', { base: 'origin/patch/3.18.41', stage: 'ship', status: 'needs-you', needs: { kind: 'pr', ask: 'review' }, pr: { number: 4711, url: 'u' } }), base('fso-103', {})], undefined, { projects: [{ key: 'fso', name: 'FSO', tracker: 'azure' as const, forge: 'azure' as const, repos: ['mobile'], devices: [], patches: [], deadlineMinutes: 30, defaultBase: 'origin/develop' }] })
    try {
      await t.press('enter', 'p')
      expect(t.f.sent).toEqual([{ cmd: 'port', run: 'fso-104' }])
      expect(await t.press('esc', 'j', 'enter', 'p')).toContain('#103 has no PR to port yet')
    } finally { t.s.renderer.destroy() }
  })
  test('m: typing a message (q included, it does not quit), enter sends it', async () => {
    const t = await screen()
    try {
      await t.press('m', 'q', 'u', 'i', 't', ' ', 'n', 'o', 'w', 'enter')
      expect(t.f.sent).toEqual([{ cmd: 'message', run: 'fso-105', text: 'quit now' }])
      expect(t.quit()).toBe(false)
    } finally { t.s.renderer.destroy() }
  })
  test('esc cancels a confirm without sending', async () => {
    const t = await screen()
    try {
      expect(await t.press('a')).toContain('Approve #105 with the defaults and start the build?')
      const f = await t.press('esc')
      expect(f).not.toContain('Approve #105 with the defaults and start the build?')
      expect(t.f.sent).toEqual([])
    } finally { t.s.renderer.destroy() }
  })
  test('a notice from the service shows at the bottom', async () => {
    const t = await screen()
    try {
      await act(async () => { t.f.push({ type: 'notice', notice: { run: 'fso-104', text: 'commit refused: subject too long' } }) })
      expect(await t.frame()).toContain('fso-104: commit refused: subject too long')
    } finally { t.s.renderer.destroy() }
  })
  test('the Resources panel: each kind of slot, who holds them, who waits for what', async () => {
    const f = api()
    f.a.resources = { limits: { agents: 2, builds: 1, devices: 4 }, holders: { agents: ['fso-105', 'fso-103'], builds: ['fso-103'], devices: [] }, waiting: [{ run: 'fso-104', kind: 'builds' }] }
    const s = await testRender(<App api={f.a} now={() => NOW} onQuit={() => {}} />, { width: 130, height: 34 })
    try {
      await act(async () => { await Bun.sleep(1) }); await s.renderOnce()
      const fr = s.captureCharFrame()
      expect(fr).toMatch(/Agents +━━━━ ━━━━ 2\/2 full +#105 plan 1m · #103 verify 1m/)
      expect(fr).toMatch(/Builds +━━━━ 1\/1 full +#103 verify 1m/)
      expect(fr).toMatch(/Devices +━━━━ ━━━━ ━━━━ ━━━━ 0\/4 +free/)
      expect(fr).toMatch(/Waiting +1\. #104 for a build slot · 1m/)
      expect(fr).toMatch(/Plan +5h +━+ 7% +week +━+ 55%/)
      expect(fr).toMatch(/builds 1\/1 +devices 0\/4/)
    } finally { s.renderer.destroy() }
  })
  test('no runs: says how to start one', async () => {
    const t = await screen([])
    try { expect(await t.frame()).toContain('No runs. Start one with n, or flow start <project> <ticket>') } finally { t.s.renderer.destroy() }
  })
})

describe('Run detail', () => {
  test('a run with a device names it and its Metro port', async () => {
    const t = await screen([base('fso-105', { device: { platform: 'android', id: 'emulator-5580', metroPort: 8090 } })])
    try { expect(await t.press('enter')).toContain('android emulator-5580 · Metro :8090') } finally { t.s.renderer.destroy() }
  })
  test('a customer patch run names its patch; S on a checked write-back asks before writing it back', async () => {
    const t = await screen([base('fso-105', { stage: 'ship', status: 'needs-you', needs: { kind: 'patch', ask: 'write-back dry run in patch-report.txt: ship again to write the patch back' }, patch: { customer: 'acme', app: 'product', commit: 'abc' } })])
    try {
      expect(await t.press('enter')).toContain('patch acme/product')
      await t.press('esc')
      expect(await t.press('S')).toContain('Write the patch back for #105?')
    } finally { t.s.renderer.destroy() }
  })
  test('enter opens it: what it needs, the plan with its questions, the checks, the timeline, the panes; esc goes back', async () => {
    const t = await screen()
    try {
      const f = await t.press('enter')
      expect(f).toContain('Needs you: 1 open question')
      expect(f).toContain('Guard the walk against missing assets.')
      expect(f).toContain('Q1 Also guard the order list?')
      expect(f).toContain('default: no')
      expect(f).toMatch(/review +1 finding · 1 below/)
      expect(f).toContain('R1 [P1] src/b.ts:4 the order list')
      expect(f).toMatch(/\d\d:\d\d setup +started from b/)
      expect(f).toMatch(/\d\d:\d\d plan +plan ready, no questions/)
      expect(f).toMatch(/Agent +Shell/) // no Metro without a device, no dev server without one
      expect(f).not.toMatch(/Metro|Dev server/)
      expect(await t.press('esc')).toContain('Needs attention')
    } finally { t.s.renderer.destroy() }
  })
  test('the Agent pane reads like Claude Code: who said what, each tool as Name(args) with what it returned, refusals, turn ends', async () => {
    const tr: Entry[] = [
      { at: NOW - 5 * 60_000, own: true, kind: 'prompt', from: 'flow', text: 'You are working on ticket #105\nline 2\nline 3' },
      { at: NOW - 4 * 60_000, own: true, kind: 'text', text: 'I will start in `walk.ts`:\n- guard the **walk**\n- then the list' },
      { at: NOW - 4 * 60_000, own: true, kind: 'tool', id: 't1', name: 'Read', input: { file_path: '/w/.flow/worktrees/105/mobile/src/walk.ts' } },
      { at: NOW - 4 * 60_000, own: true, kind: 'toolResult', id: 't1', text: '1\ta\n2\tb\n3\tc', error: false },
      { at: NOW - 4 * 60_000, own: true, kind: 'tool', id: 't2', name: 'Bash', input: { command: 'yarn tsc -p apps/product' } },
      { at: NOW - 4 * 60_000, own: true, kind: 'toolResult', id: 't2', text: 'one\ntwo\nthree\nfour\nfive', error: false },
      { at: NOW - 3 * 60_000, own: true, kind: 'denied', tool: 'Bash', input: { command: 'git commit -m x' } },
      { at: NOW - 2 * 60_000, own: true, kind: 'result', ok: true, text: '', turns: 4, reason: '', session: 's', tokens: { input: 1000, output: 2000, cacheRead: 600_000, cacheWrite: 23_000 } },
    ]
    const t = await screen(runs, undefined, { transcript: async () => tr })
    try {
      const f = await t.press('enter')
      expect(f).toMatch(/⏺ flow +11:55/)
      for (const l of ['⎿ You are working on ticket #105', 'line 2', 'line 3']) expect(f).toContain(l)
      expect(f).toContain('⏺ I will start in walk.ts:')
      expect(f).toContain('• guard the walk')
      expect(f).toContain('⏺ Read(src/walk.ts)')
      expect(f).toContain('⎿ Read 3 lines')
      expect(f).toContain('⏺ Bash(yarn tsc -p apps/product)')
      for (const l of ['⎿ one', 'two', 'three', '… +2 lines · o shows all']) expect(f).toContain(l)
      expect(f).not.toContain('four')
      expect(f).toContain('✕ Bash(git commit -m x)')
      expect(f).toContain('⎿ refused by flow')
      expect(f).toContain('── turn ended · 26k new · 600k from cache · 4 calls ──')
      await act(async () => { t.f.push({ type: 'agent', run: 'fso-105', entry: { at: NOW, own: true, kind: 'text', text: 'And now the order list.' } } as never) })
      expect(await t.frame()).toContain('⏺ And now the order list.')
    } finally { t.s.renderer.destroy() }
  })
  test('the whole of what flow sent: a long prompt shows its first lines, o shows all of it (and o again folds it)', async () => {
    const text = Array.from({ length: 9 }, (_, i) => `prompt line ${i + 1}`).join('\n')
    const t = await screen(runs, undefined, { transcript: async () => [{ at: NOW, own: true, kind: 'prompt', from: 'flow', text }] })
    try {
      const f = await t.press('enter')
      expect(f).toContain('prompt line 3')
      expect(f).not.toContain('prompt line 4')
      expect(f).toContain('… 6 more lines · o shows all')
      const g = await t.press('o')
      expect(g).toContain('prompt line 9')
      expect(await t.press('o')).not.toContain('prompt line 9')
    } finally { t.s.renderer.destroy() }
  })
  test('m types a message to the agent below its session; enter sends it', async () => {
    const t = await screen()
    try {
      await t.press('enter', 'm', ...'check q1'.split(''))
      expect(await t.frame()).toContain('› check q1▏')
      await t.press('enter')
      expect(t.f.sent).toEqual([{ cmd: 'message', run: 'fso-105', text: 'check q1' }])
    } finally { t.s.renderer.destroy() }
  })
  test('a run with a device has Metro: its log; a run with a dev server has that pane too', async () => {
    const withDevice = [base('fso-105', { device: { platform: 'android', id: 'emulator-5700', metroPort: 8300 }, devServer: { repo: 'portal', port: 5300, url: 'https://localhost:5300' } })]
    const t = await screen(withDevice, undefined, { log: async (_r, name) => (name === 'metro' ? [' BUNDLE  ./index.js 78%', ' WARN  Require cycle'] : [' VITE ready in 812 ms']) })
    try {
      expect(await t.press('enter')).toMatch(/Agent +Metro ● +Dev server ● +Shell/)
      await t.press(']')
      await act(async () => { await Bun.sleep(20) })
      const f = await t.frame()
      expect(f).toMatch(/Metro :8300 ● running +metro\.log/)
      expect(f).toContain('BUNDLE  ./index.js 78%')
      await t.press(']'); await act(async () => { await Bun.sleep(20) })
      expect(await t.frame()).toMatch(/dev server portal https:\/\/localhost:5300 ● running[\s\S]*VITE ready in 812 ms/)
    } finally { t.s.renderer.destroy() }
  })
  test('d opens the change: each file, its lines numbered before and after; a file too large is named', async () => {
    const patch = 'diff --git a/src/walk.ts b/src/walk.ts\n--- a/src/walk.ts\n+++ b/src/walk.ts\n@@ -1,2 +1,2 @@\n const a = 1\n-const left = need - got\n+const left = Math.max(0, need - got)\n'
    const t = await screen(runs, undefined, { diff: async () => [{ repo: 'mobile', file: 'src/walk.ts', status: 'M', added: 1, removed: 1, patch }, { repo: 'mobile', file: 'yarn.lock', status: 'M', added: 4000, removed: 10, patch: '' }] })
    try {
      await t.press('enter', 'd'); await act(async () => { await Bun.sleep(50) })
      const f = await t.frame()
      expect(f).toMatch(/Diff +2 files +\+4001 −11/)
      expect(f).toMatch(/M src\/walk\.ts +\+1 −1/)
      expect(f).toMatch(/1 +1 +const a = 1/)
      expect(f).toMatch(/2 +- const left = need - got/)
      expect(f).toMatch(/2 \+ const left = Math\.max\(0, need - got\)/)
      expect(f).toContain('too large to show here')
      expect(await t.press('esc')).not.toContain('from where the branch left its base')
    } finally { t.s.renderer.destroy() }
  })
  test('in the change, c comments the line under the cursor; S sends the comments to the agent as one message', async () => {
    const patch = 'diff --git a/src/walk.ts b/src/walk.ts\n--- a/src/walk.ts\n+++ b/src/walk.ts\n@@ -1,2 +1,2 @@\n const a = 1\n-const left = need - got\n+const left = Math.max(0, need - got)\n'
    const t = await screen(runs, undefined, { diff: async () => [{ repo: 'mobile', file: 'src/walk.ts', status: 'M', added: 1, removed: 1, patch }] })
    try {
      await t.press('enter', 'd'); await act(async () => { await Bun.sleep(50) })
      // the file, the hunk, a = 1, the removed line, the added one
      await t.press('j', 'j', 'j', 'j', 'c', ...'what if need is undefined?'.split(''))
      expect(await t.frame()).toContain('┃ what if need is undefined?▏')
      const f = await t.press('enter')
      expect(f).toContain('┃ what if need is undefined?')
      expect(f).toContain('1 comment not sent')
      await t.press('S')
      expect(t.f.sent).toEqual([{ cmd: 'message', run: 'fso-105', text: 'Review comments on your change (1):\n\nsrc/walk.ts:2\n> const left = Math.max(0, need - got)\nwhat if need is undefined?\n\nAddress each one in the code, or answer it if you disagree; then stop.' }])
      expect(await t.frame()).not.toContain('from where the branch left its base')
    } finally { t.s.renderer.destroy() }
  })
  test('a click on a changed file opens the change there; x removes a comment', async () => {
    const one = (file: string) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-x\n+y\n`
    const t = await screen(runs, undefined, { changes: async () => [{ repo: 'mobile', file: 'src/a.ts', added: 1, removed: 1, status: 'M' }, { repo: 'mobile', file: 'src/b.ts', added: 1, removed: 1, status: 'M' }],
      diff: async () => [{ repo: 'mobile', file: 'src/a.ts', status: 'M', added: 1, removed: 1, patch: one('src/a.ts') }, { repo: 'mobile', file: 'src/b.ts', status: 'M', added: 1, removed: 1, patch: one('src/b.ts') }] })
    try {
      await t.press('enter'); await act(async () => { await Bun.sleep(30) })
      const p = at(await t.frame(), 'M src/b.ts')
      await act(async () => { await t.s.mockMouse.click(p.x + 3, p.y) }); await act(async () => { await Bun.sleep(50) })
      expect(await t.frame()).toMatch(/▌ M src\/b\.ts/)
      await t.press('j', 'j', 'j', 'c', 'n', 'o', 'enter')
      expect(await t.frame()).toContain('1 comment not sent')
      // a comment not sent waits for the next time the change is opened
      await t.press('esc', 'd'); await act(async () => { await Bun.sleep(50) })
      expect(await t.frame()).toContain('1 comment not sent')
      await t.press(']', 'j', 'j', 'j')
      expect(await t.press('x')).not.toContain('comment not sent')
    } finally { t.s.renderer.destroy() }
  })
  test('the plan, the ticket, the PR, the review open as Markdown over the detail', async () => {
    const t = await screen(runs, undefined, { file: async (_r, n) => (n === 'plan.md' ? '# Plan\n\nClamp the **remaining** quantity.\n\n## Approach\n- one\n- two\n' : n === 'pr.md' ? '# Fix picking\n\nVerified: yarn tsc → ok\n' : '') })
    try {
      await t.press('enter', 'P')
      // the Markdown is rendered once the file came: wait for it rather than for a fixed time
      const until = async (text: string) => { let f = ''; for (let i = 0; i < 40 && !(f = await t.frame()).includes(text); i++) await act(async () => { await Bun.sleep(25) }); return f }
      const f = await until('Approach')
      expect(f).toContain('plan.md')
      expect(f).toContain('Approach')
      expect(f).not.toContain('## Approach')
      await t.press('esc')
      const p = at(await t.frame(), 'pr.md  ')
      await act(async () => { await t.s.mockMouse.click(p.x, p.y) })
      expect(await until('Verified: yarn tsc → ok')).toContain('Verified: yarn tsc → ok')
    } finally { t.s.renderer.destroy() }
  })
  test('a click on Agent puts you in its message box, which stays above the shell when split', async () => {
    const t = await screen()
    try {
      const f = await t.press('enter')
      const p = at(f, 'Agent')
      await act(async () => { await t.s.mockMouse.click(p.x + 1, p.y) })
      await t.press(...'hello'.split(''))
      const g = await t.frame()
      expect(g).toContain('› hello▏')
      await t.press('esc', 'v')
      const h = (await t.frame()).split('\n')
      const box = h.findIndex(l => l.includes('Message the agent'))
      const shell = h.findIndex(l => l.includes(' Shell ·'))
      expect(box).toBeGreaterThan(0)
      expect(box).toBeLessThan(shell)
    } finally { t.s.renderer.destroy(); stopShells() }
  })
  test('the Shell pane: a real shell in the run\'s worktree; i types into it, ctrl+] leaves; v splits it with the session', async () => {
    const wt = mkdtempSync(join(tmpdir(), 'flow-shell-'))
    process.env.FLOW_SHELL = '/bin/sh'
    const t = await screen(runs, undefined, { file: async (_r, name) => (name === 'run.json' ? JSON.stringify({ worktree: wt }) : '') })
    try {
      await t.press('enter', 'i')
      await act(async () => { await Bun.sleep(300) })
      // a click on the shell first, as a person does (it once made every key arrive twice)
      const sh = at(await t.frame(), ' Shell ·')
      await act(async () => { await t.s.mockMouse.click(sh.x + 30, sh.y + 2) })
      for (const k of 'echo hi-from-$((40+2))') await act(async () => { t.s.mockInput.pressKey(k) })
      await act(async () => { t.s.mockInput.pressEnter() })
      await act(async () => { await Bun.sleep(400) })
      let f = await t.frame()
      expect(f).toContain('hi-from-42')
      expect(f).not.toContain('eecchhoo')
      expect(f).toContain('typing in Shell')
      await act(async () => { t.s.mockInput.pressKey(']', { ctrl: true }) })
      f = await t.frame()
      expect(f).toContain('esc back   d diff   P plan   [ ] pane')
      f = await t.press('v')
      expect(f).toContain('split on')
      expect(f).toContain('No agent session recorded for this run yet.')
      expect(f).toContain('hi-from-42')
    } finally { t.s.renderer.destroy(); stopShells(); delete process.env.FLOW_SHELL }
  })
})

const ev = (seq: number, run: string, minsAgo: number, body: Record<string, unknown>, actor = 'engine') => ({ seq, at: NOW - minsAgo * 60_000, run, actor, ...body }) as RunEvent
const recent = [ev(1, 'fso-103', 20, { type: 'setup.done' }), ev(2, 'fso-103', 9, { type: 'build.done' }, 'agent'), ev(3, 'fso-104', 4, { type: 'pr.opened', url: 'u', number: 77 }, 'human')]
const projects = [{ key: 'fso', name: 'FSO', tracker: 'azure' as const, forge: 'azure' as const, repos: ['mobile', 'portal'], devices: ['android' as const], patches: ['mobile'], deadlineMinutes: 30 }]

describe('the design: header, sort, group, filter, activity, message line', () => {
  test('tabs, the connection, and the latest outcome at the bottom', async () => {
    const t = await screen(runs, undefined, { recent })
    try {
      const f = await t.frame()
      expect(f).toMatch(/∿ flow +all projects ▾ +1 Runs +2 Queue +3 Metrics +4 Projects +● connected/)
      expect(f).not.toMatch(/\d Activity|\d Resources/)
      expect(f).toContain('✓ fso-104 shipped: draft PR #77 · 4m ago')
    } finally { t.s.renderer.destroy() }
  })
  test('a dropped connection shows as disconnected, with a notice', async () => {
    const t = await screen(runs, undefined, { connected: false })
    try {
      await act(async () => { t.f.push({ type: 'closed' }) })
      const f = await t.frame()
      expect(f).toContain('● disconnected')
      expect(f).toContain('the flow service stopped: start flow again')
    } finally { t.s.renderer.destroy() }
  })
  test('the selected run\'s activity beside the resources, newest first', async () => {
    const t = await screen(runs, undefined, { recent })
    try {
      const f = await t.press('j', 'j')
      expect(f).toMatch(/Activity +#103 +↵ open run/)
      expect(f).toMatch(/11:51 +build +change made[\s\S]*11:40 +setup +worktrees ready/)
    } finally { t.s.renderer.destroy() }
  })
  test('s cycles the sort; the order follows', async () => {
    const list = [base('fso-1', { createdAt: NOW - 60 * 60_000, tokens: 10 }), base('fso-2', { createdAt: NOW - 5 * 60_000, tokens: 900_000 })]
    const t = await screen(list)
    try {
      expect(await t.frame()).toMatch(/sort newest[\s\S]*#2 [\s\S]*#1 /)
      expect(await t.press('s')).toMatch(/sort oldest[\s\S]*#1 [\s\S]*#2 /)
      expect(await t.press('s', 's')).toMatch(/sort tokens[\s\S]*#2 [\s\S]*#1 /)
    } finally { t.s.renderer.destroy() }
  })
  test('g groups by stage; enter on a group folds it', async () => {
    const t = await screen()
    try {
      const f = await t.press('g')
      expect(f).toContain('group stage')
      expect(f).toMatch(/▾ plan +1 run · 264k tokens[\s\S]*▾ verify +1 run[\s\S]*▾ ship +1 run/)
      const folded = await t.press('enter')
      expect(folded).toContain('▸ plan')
      expect(folded).not.toMatch(/#105 +Title fso-105 +fso/)
    } finally { t.s.renderer.destroy() }
  })
  test('/ filters by field and text; esc clears it', async () => {
    const list = [...runs, base('shop-7', { project: 'shop', title: 'Order text' })]
    const t = await screen(list)
    try {
      const f = await t.press('/', ...'project:shop'.split(''), 'enter')
      expect(f).toContain('filter project:shop')
      expect(f).toContain('1 of 4 runs match')
      expect(f).toContain('∿ flow  shop')
      expect(f).toMatch(/#7 +Order text/)
      expect(f).not.toMatch(/#103 +Title/)
      expect(await t.press('esc')).toContain('filter none')
    } finally { t.s.renderer.destroy() }
  })
})

describe('the command palette', () => {
  test('on the runs: the screen\'s commands and every run to open, typed to narrow', async () => {
    const t = await screen()
    try {
      const f = await t.press('ctrl+k')
      expect(f).toContain('New run')
      expect(f).toContain('Open #103 develop Title fso-103')
      expect(f).not.toContain('Message') // a run's own commands are in its detail
      await t.press(...'103'.split(''))
      const g = await t.frame()
      expect(g).toContain('▸ Open #103 develop Title fso-103')
      expect(g).not.toContain('Open #105')
      expect(await t.press('enter')).toContain('← esc  #103')
    } finally { t.s.renderer.destroy() }
  })
  test('in a run\'s detail: that run\'s commands, and the detail stays open under it', async () => {
    const list = [base('fso-104', { base: 'origin/patch/3.18.41', stage: 'ship', status: 'needs-you', needs: { kind: 'pr', ask: 'review' }, pr: { number: 4711, url: 'u' } })]
    const t = await screen(list, undefined, { file: async (_r, n) => (n === 'plan.md' ? '# Plan\n\nThe walk.\n' : ''), ...{ projects: [{ key: 'fso', name: 'FSO', tracker: 'azure' as const, forge: 'azure' as const, repos: ['mobile'], devices: [], patches: [], deadlineMinutes: 30, defaultBase: 'origin/develop' }] } })
    try {
      const f = await t.press('enter', 'ctrl+k')
      expect(f).toContain('#104 commands')
      for (const c of ['Message the agent', 'Open the change', 'Open the plan', 'Open the worktree in VS Code', 'Type in the shell', 'Port to develop']) expect(f).toContain(c)
      expect(f).not.toContain('Group by stage')
      expect(f).not.toContain('Open the review') // no review yet
      expect(f).not.toContain('dropping work') // one Remove; f in its question removes work not shipped too
      expect(f).toContain('Port to develop') // a release-line fix: its project's default line
      expect(await t.press('esc')).toContain('← esc  #104') // still the detail
      await t.press('ctrl+k', ...'plan'.split(''), 'enter')
      expect(await t.until('The walk.')).toContain('The walk.')
      await t.press('esc', 'ctrl+k', ...'port'.split(''), 'enter')
      expect(t.f.sent).toEqual([{ cmd: 'port', run: 'fso-104' }])
    } finally { t.s.renderer.destroy() }
  })
  test("remove from a run's detail: the question shows on the screen, y removes it and the list comes back", async () => {
    const list = [base('fso-104', { stage: 'setup', status: 'failed', needs: { kind: 'setup', ask: 'git worktree add failed' } })]
    for (const size of [{ width: 130, height: 34 }, { width: 220, height: 56 }, { width: 100, height: 26 }]) {
    const t = await screen(list, size)
    try {
      await t.press('enter', 'ctrl+k', ...'remove the run'.split(''))
      const f = await t.press('enter')
      expect(f).toContain('Remove #104?')
      expect(f).toContain('esc back') // on its own line, not over the detail's keys
      const g = await t.press('y')
      expect(t.f.sent).toContainEqual({ cmd: 'remove', run: 'fso-104', force: true })
      expect(g).not.toContain('← esc  #104')
      // the row says so until the run is gone
      expect(await t.frame()).toContain('removing…')
    } finally { t.s.renderer.destroy() }
    }
  })
  test('it is centred, and its list follows the cursor past the first screenful', async () => {
    const many = Array.from({ length: 30 }, (_, i) => base(`fso-${300 + i}`, { createdAt: NOW - i * 60_000 }))
    const t = await screen(many)
    try {
      const f = (await t.press('ctrl+k')).split('\n')
      const top = f.find(l => l.includes('›') && l.includes('commands'))!
      const left = top.indexOf('›')
      expect(Math.abs(left - (130 - 84) / 2)).toBeLessThan(5)
      const g = await t.press(...Array(25).fill('down'))
      expect(g).toMatch(/▸ Open #3\d\d/)
      expect(g).toMatch(/↑ \d+ more/)
    } finally { t.s.renderer.destroy() }
  })
  test('keys typed faster than the screen redraws all arrive', async () => {
    const t = await screen()
    try {
      await t.press('ctrl+k')
      await act(async () => { t.s.mockInput.pressKey('p'); t.s.mockInput.pressKey('o'); t.s.mockInput.pressKey('r') })
      expect(await t.frame()).toContain('› por▏')
    } finally { t.s.renderer.destroy() }
  })
  test(': opens it too; a filter from it applies; esc closes without doing anything', async () => {
    const t = await screen(runs, undefined, { projects })
    try {
      await t.press(':', ...'show failed'.split(''), 'enter')
      expect(await t.frame()).toContain('filter status:failed,blocked')
      await t.press(':', 'esc')
      expect(t.f.sent).toEqual([])
      expect(await t.frame()).not.toContain('↑↓ choose')
    } finally { t.s.renderer.destroy() }
  })
})

describe('the responsive rules', () => {
  test('80–99 columns: no project or token columns, the stage as a word, one-line attention, one Resources line, tab numbers', async () => {
    const t = await screen(runs, { width: 90, height: 30 }, { resources: { limits: { agents: 2, builds: 2, devices: 4 }, holders: { agents: ['fso-103'], builds: [], devices: [] }, waiting: [] } })
    try {
      const f = await t.frame()
      expect(f).toMatch(/1 Runs +2 +3 +4 /)
      expect(f).toMatch(/#103 +Title fso-103 +develop +verify +running +14m +verifying/)
      expect(f).not.toContain('Guard the walk.')
      expect(f).toMatch(/Agents \d\/2 +Builds/)
    } finally { t.s.renderer.destroy() }
  })
  test('under 80×24 a message instead of the screen', async () => {
    const t = await screen(runs, { width: 72, height: 20 })
    try { expect(await t.frame()).toContain('Flow needs at least 80×24 (now 72×20)') } finally { t.s.renderer.destroy() }
  })
  test('more runs than rows: the table scrolls with the selection', async () => {
    const many = Array.from({ length: 30 }, (_, i) => base(`fso-${200 + i}`, { createdAt: NOW - i * 60_000 }))
    const t = await screen(many, { width: 120, height: 30 })
    try {
      expect(await t.frame()).not.toMatch(/#229 +Title fso-229/)
      const f = await t.press(...Array(29).fill('j'))
      expect(f).toMatch(/#229 +Title fso-229/)
      expect(f).not.toMatch(/#200 +Title fso-200/)
    } finally { t.s.renderer.destroy() }
  })
})

describe('the other tabs', () => {
  test('2 Queue: who waits for which slot, paused runs, plans waiting for you', async () => {
    const list = [...runs, base('fso-106', { status: 'paused', pausedUntil: Date.parse('2026-10-25T14:00:00Z') })]
    const t = await screen(list, undefined, { resources: { limits: { agents: 2, builds: 1, devices: 4 }, holders: { agents: [], builds: ['fso-103'], devices: [] }, waiting: [{ run: 'fso-104', kind: 'builds' }] } })
    try {
      const f = await t.press('2')
      expect(f).toMatch(/1\. #104 +Title fso-104 +for a build slot/)
      expect(f).toMatch(/#106 +Title fso-106 +resumes at \d\d:00/)
      expect(f).toMatch(/#105 +Title fso-105 +defaults at \d\d:12 \(in 12m\)/)
    } finally { t.s.renderer.destroy() }
  })
  test('a device in use names its run and device', async () => {
    const list = [...runs, base('fso-106', { device: { platform: 'android', id: 'emulator-5700', metroPort: 8300 } })]
    const t = await screen(list, undefined, { resources: { limits: { agents: 2, builds: 2, devices: 4 }, holders: { agents: [], builds: [], devices: ['fso-106'] }, waiting: [] } })
    try { expect(await t.frame()).toMatch(/Devices +(━━━━ ){4}1\/4 +#106 android emulator-5700/) } finally { t.s.renderer.destroy() }
  })
  test('3 Metrics and 4 Projects', async () => {
    const t = await screen([...runs, base('fso-100', { stage: 'done', status: 'done', pr: { number: 1, url: 'u' }, tokens: 1_000_000, updatedAt: NOW - 60_000 })], undefined, { projects })
    try {
      expect(await t.press('3')).toMatch(/fso +4 +1 +3 +2 +1\.8M +1\.8M/)
      const p = await t.press('4')
      expect(p).toMatch(/fso +FSO +Azure DevOps +Azure DevOps +2 +android +yes +4/)
      expect(p).toMatch(/Repos +mobile · portal/)
      expect(p).toMatch(/Plan +defaults taken after 30 min/)
    } finally { t.s.renderer.destroy() }
  })
})

/** where a text is on the screen (first match), for clicking it */
const at = (frame: string, text: string) => {
  const lines = frame.split('\n')
  const y = lines.findIndex(l => l.includes(text))
  if (y < 0) throw new Error(`"${text}" is not on the screen`)
  return { x: lines[y]!.indexOf(text) + 1, y }
}

describe('the mouse', () => {
  const click = async (t: Awaited<ReturnType<typeof screen>>, text: string) => {
    const p = at(await t.frame(), text)
    await act(async () => { await t.s.mockMouse.click(p.x, p.y) })
    return t.frame()
  }
  test('a tab is clicked to open it', async () => {
    const t = await screen(runs, undefined, { projects })
    try { expect(await click(t, '4 Projects')).toMatch(/Projects +1 +↵ settings/) } finally { t.s.renderer.destroy() }
  })
  test('a click selects a run; a click on the selected run opens it', async () => {
    const t = await screen()
    try {
      expect(await click(t, 'Title fso-103   ')).toMatch(/Activity +#103/)
      expect(await click(t, 'Title fso-103   ')).toContain('Plan')
      expect(await click(t, 'esc back')).toContain('Needs attention')
    } finally { t.s.renderer.destroy() }
  })
  test('an item\'s key hint acts on it; the confirm\'s answers are clickable', async () => {
    const t = await screen()
    try {
      expect(await click(t, 'a approve')).toContain('Approve #105 with the defaults and start the build?')
      await click(t, 'y approve')
      expect(t.f.sent).toEqual([{ cmd: 'approve', run: 'fso-105' }])
    } finally { t.s.renderer.destroy() }
  })
  test('sort, group and the key line can be clicked', async () => {
    const t = await screen()
    try {
      expect(await click(t, 's sort')).toContain('sort oldest')
      expect(await click(t, 'g group')).toContain('group stage')
      expect(await click(t, 'n new')).toContain('a ticket to a draft PR')
    } finally { t.s.renderer.destroy() }
  })
  test('the wheel over the table moves the selection', async () => {
    const t = await screen()
    try {
      const lines = (await t.frame()).split('\n'), y = lines.findIndex(l => /#104 +Title fso-104 +fso/.test(l)) // the table's row, not the attention item
      await act(async () => { await t.s.mockMouse.scroll(5, y, 'down'); await t.s.mockMouse.scroll(5, y, 'down') })
      expect(await t.frame()).toMatch(/Activity +#103/)
    } finally { t.s.renderer.destroy() }
  })
  test('Add a repo opens a choice of the repos the run lacks; Remove asks once, and y removes work not shipped too (your decision)', async () => {
    const list = [base('fso-104', { repos: ['mobile'], stage: 'build', status: 'blocked', needs: { kind: 'blocked', ask: 'x' } })]
    const fso = { key: 'fso', name: 'FSO', tracker: 'azure' as const, forge: 'azure' as const, repos: ['mobile', 'portal'], devices: [], patches: [], deadlineMinutes: 30 }
    const t = await screen(list, undefined, { projects: [fso] })
    try {
      await t.press('enter', 'ctrl+k', ...'add a repo'.split(''), 'enter')
      const f = await t.frame()
      expect(f).toContain('#104 · add a repo')
      expect(f).toContain('Add portal')
      await t.press('enter')
      expect(t.f.sent).toEqual([{ cmd: 'addRepo', run: 'fso-104', repo: 'portal' }])
      // removing on the screen is your decision: the confirm says work not shipped goes too, and y does it
      await t.press('ctrl+k', ...'remove the run'.split(''), 'enter')
      const c = await t.frame()
      expect(c).toContain('with any work not shipped')
      expect(c).not.toContain('f also work not shipped')
      await t.press('y')
      expect(t.f.sent.at(-1)).toEqual({ cmd: 'remove', run: 'fso-104', force: true })
    } finally { t.s.renderer.destroy() }
  })
  test('a command in the palette is clicked to run it', async () => {
    const list = [base('fso-104', { base: 'origin/patch/3.18.41', stage: 'ship', status: 'needs-you', needs: { kind: 'pr', ask: 'review' }, pr: { number: 4711, url: 'u' } })]
    const t = await screen(list, undefined, { projects: [{ key: 'fso', name: 'FSO', tracker: 'azure' as const, forge: 'azure' as const, repos: ['mobile'], devices: [], patches: [], deadlineMinutes: 30, defaultBase: 'origin/develop' }] })
    try {
      await t.press('enter', 'ctrl+k')
      await click(t, 'Port to develop')
      expect(t.f.sent).toEqual([{ cmd: 'port', run: 'fso-104' }])
    } finally { t.s.renderer.destroy() }
  })
})

describe('projects and the attention list from the keyboard', () => {
  const mixed = [...runs, base('shop-7', { project: 'shop', title: 'Order text' })]
  test('p opens the project picker with each project\'s runs; choosing one filters the screen to it', async () => {
    const t = await screen(mixed, undefined, { projects: [...projects, { ...projects[0]!, key: 'shop', name: 'Shop' }] })
    try {
      const f = await t.press('p')
      expect(f).toMatch(/✓ all projects +4 runs/)
      expect(f).toMatch(/fso +FSO +3 runs/)
      expect(f).toMatch(/shop +Shop +1 run/)
      const g = await t.press('j', 'j', 'enter')
      expect(g).toContain('∿ flow  shop ▾')
      expect(g).toContain('filter project:shop')
      expect(g).toMatch(/#7 +Order text/)
      expect(g).not.toMatch(/#103 +Title fso-103/)
      // what needs you, and the counts, are the chosen project's too
      expect(g).not.toContain('#105'); expect(g).not.toContain('#104')
      expect(g).toMatch(/1 active +▲ 0 need you/)
      expect(await t.press('p', 'k', 'k', 'enter')).toContain('∿ flow  all projects ▾') // the picker opens on the current project
    } finally { t.s.renderer.destroy() }
  })
  test('a click on the project name opens the picker', async () => {
    const t = await screen(mixed)
    try {
      const p = at(await t.frame(), 'all projects ▾')
      await act(async () => { await t.s.mockMouse.click(p.x, p.y) })
      expect(await t.frame()).toMatch(/✓ all projects +4 runs/)
    } finally { t.s.renderer.destroy() }
  })
  test('tab moves the focus to Needs attention: j/k move through it, the keys act on the focused item, enter opens it', async () => {
    const t = await screen()
    try {
      const f = await t.press('tab')
      expect(f).toMatch(/▌Needs attention/)
      expect(f).toMatch(/▌#105 /)
      const g = await t.press('j')
      expect(g).toMatch(/▌#104 /)
      expect(g).not.toMatch(/▌#105 /)
      expect(await t.press('S')).toContain('Ship #104?')
      await t.press('n')
      expect(await t.press('enter')).toMatch(/Needs you: verified/)
      await t.press('esc')
      expect(await t.press('tab')).not.toMatch(/▌Needs attention/)
    } finally { t.s.renderer.destroy() }
  })
  test('the arrows run through both lists: up from the first run into Needs attention, down past its last item back to the runs', async () => {
    const t = await screen()
    try {
      const f = await t.press('k')
      expect(f).toMatch(/▌Needs attention/)
      expect(f).toMatch(/▌#104 /) // the last item needing you
      expect(await t.press('k')).toMatch(/▌#105 /)
      const g = await t.press('j', 'j')
      expect(g).not.toMatch(/▌Needs attention/) // back in the runs, on the first
      expect(await t.press('enter')).toContain('Needs you: 1 open question') // #105, the first run
    } finally { t.s.renderer.destroy() }
  })
  test('a click on an attention item focuses it', async () => {
    const t = await screen()
    try {
      const p = at(await t.frame(), 'Ready to ship')
      await act(async () => { await t.s.mockMouse.click(p.x, p.y) })
      expect(await t.frame()).toMatch(/▌#104 /)
    } finally { t.s.renderer.destroy() }
  })
})

describe('the new-run form', () => {
  const fso = { key: 'fso', name: 'FSO', tracker: 'azure' as const, forge: 'azure' as const, repos: ['mobile', 'portal'], devices: ['android' as const, 'ios' as const], patches: ['mobile'], deadlineMinutes: 30, defaults: ['mobile'], devServers: ['portal'],
    repoMatch: { mobile: '\\bmobile\\b|\\bapp\\b', portal: '\\bportal\\b|\\bweb\\b' }, patchApps: { cmms: 'cmms|maintenance', product: 'product|picking|material' } }
  const shop = { ...fso, key: 'shop', name: 'Shop', tracker: 'jira' as const, patches: [], devServers: [] }
  const found = { run: 'fso-204598', exists: false, key: '#204598', title: 'Picking – Remaining Required Quantity', kind: 'feature' as const, type: 'Task', url: 'u', board: 'acme-hub', customer: 'ACME', tags: ['3.18'], comments: 3 }
  const query = (o: { lookup?: unknown; fail?: string } = {}) => async (q: { q: string; base?: string }) => {
    if (q.q === 'bases') return { mobile: ['origin/develop', 'origin/patch/3.20.7', 'origin/patch/3.18.41'], portal: ['origin/develop'] }
    if (q.q === 'patches') return ['acme/cmms', 'acme/product', 'globex/cmms']
    if (q.q === 'refs') return ['origin/develop', 'origin/feature/picking', 'origin/patch/3.20.7', 'origin/patch/3.18.41', 'v3.18.41']
    if (q.q === 'checkPatch') return q.base === 'origin/patch/3.18.41' ? { ok: false, text: 'no acme/product patch for 3.18.41 (newest 3.18.39)' } : { ok: true, text: 'acme/product 3.20.7' }
    if (o.fail) throw new Error(o.fail)
    return o.lookup ?? found
  }
  const typeIn = async (t: Awaited<ReturnType<typeof screen>>, text: string) => { for (const k of text) await act(async () => { t.s.mockInput.pressKey(k) }); await act(async () => { await Bun.sleep(400) }) }
  const keys = async (t: Awaited<ReturnType<typeof screen>>, ...ks: string[]) => { for (const k of ks) await act(async () => { k === 'tab' ? t.s.mockInput.pressKey('\t') : k === 'right' ? t.s.mockInput.pressArrow('right') : k === 'left' ? t.s.mockInput.pressArrow('left') : k === 'up' ? t.s.mockInput.pressArrow('up') : k === 'down' ? t.s.mockInput.pressArrow('down') : k === 'enter' ? t.s.mockInput.pressEnter() : k === 'ctrl+s' ? t.s.mockInput.pressKey('s', { ctrl: true }) : k === 'shift+tab' ? t.s.mockInput.pressKey('\t', { shift: true }) : k === 'backspace' ? t.s.mockInput.pressBackspace() : k === 'home' || k === 'end' || k === 'delete' ? t.s.mockInput.pressKey(k.toUpperCase() as 'HOME') : t.s.mockInput.pressKey(k) }); await act(async () => { await Bun.sleep(30) }); return t.frame() }
  test('n opens it; the ticket is looked up as you type: its title, type, board, customer; the base and patch it points at', async () => {
    const t = await screen(runs, undefined, { projects: [fso, shop], query: query() as FlowApi['query'] })
    try {
      expect(await t.press('n')).toContain('a ticket to a draft PR')
      await typeIn(t, '204598')
      const f = await t.frame()
      expect(f).toContain('204598')
      expect(f).toContain('✓ Task · acme-hub')
      expect(f).toContain('Picking – Remaining Required Quantity')
      expect(f).toContain('customer ACME · 3 comments · tags 3.18')
      expect(f).toMatch(/Base +patch\/3\.18\.41 ▾ +the ticket's release line/)
      expect(f).toMatch(/\(•\) feature/)
      expect(f).toMatch(/Patch +acme\/product ▾ +the ticket points at it \(ACME\)/) // ACME, and picking → product
      expect(f).toContain('⚠ no acme/product patch for 3.18.41 (newest 3.18.39)')
      expect(f).toContain('apply the acme/product')
    } finally { t.s.renderer.destroy() }
  })
  test('it refuses to start what would fail, and says why; with the fields fixed it starts the run', async () => {
    const t = await screen(runs, undefined, { projects: [fso, shop], query: query() as FlowApi['query'] })
    try {
      await t.press('n'); await typeIn(t, '204598')
      const refused = await keys(t, 'enter')
      expect(refused).toContain('the customer patch does not fit this base')
      expect(refused).toMatch(/▌ Patch/) // the focus goes to what is wrong
      expect(t.f.sent).toEqual([])
      // up to the base: type to search, ↵ picks 3.20.7, where the patch fits
      await keys(t, 'up', 'up', 'up', 'up', '3', '.', '2')
      const list = await t.frame()
      expect(list).toMatch(/› 3\.2▏ +1 of 5/)
      expect(list).toContain('▸ patch/3.20.7')
      await keys(t, 'enter')
      expect(await t.frame()).toContain('✓ acme/product 3.20.7')
      // a device: down to Device, → android
      await keys(t, 'down', 'down', 'down', 'right')
      await keys(t, 'ctrl+s') // start now, past Notes and Login
      expect(t.f.sent).toEqual([{ cmd: 'start', project: 'fso', ticket: 204598, base: 'origin/patch/3.20.7', kind: 'feature', repos: ['mobile'], device: 'android', patch: 'acme/product' }])
    } finally { t.s.renderer.destroy() }
  })
  test('repos are toggled with space; a repo with a dev server offers one; the model can be chosen', async () => {
    const t = await screen(runs, undefined, { projects: [fso], query: query({ lookup: { ...found, tags: [], customer: '', board: 'fso' } }) as FlowApi['query'] })
    try {
      await t.press('n'); await typeIn(t, '204598')
      await keys(t, 'tab', 'tab', 'tab', 'right', ' ')
      const f = await t.frame()
      expect(f).toMatch(/\[x\] mobile +\[x\] portal/)
      expect(f).toMatch(/Dev server +\(•\) none +\( \) portal/)
      await keys(t, 'tab', 'tab', 'right', 'tab', 'tab', 'tab', 'right', 'ctrl+s') // past Window (headless, the default)
      expect(t.f.sent).toEqual([{ cmd: 'start', project: 'fso', ticket: 204598, base: 'origin/develop', kind: 'feature', repos: ['mobile', 'portal'], devServer: true, model: 'opus' }])
    } finally { t.s.renderer.destroy() }
  })
  test('the ticket picks the repos it targets and the patch\'s app; you can still change them', async () => {
    const t = await screen(runs, undefined, { projects: [fso], query: query({ lookup: { ...found, customer: '', platform: 'Mobile; Portal', tags: [] } }) as FlowApi['query'] })
    try {
      await t.press('n'); await typeIn(t, '204598')
      const f = await t.frame()
      expect(f).toMatch(/\[x\] mobile +\[x\] portal +from the ticket/)
      expect(f).toMatch(/Patch +acme\/product ▾/) // the board names ACME, the title says picking
      // the patch picker (portal brings a Dev server field): none is there to choose, the ticket's first
      expect(f).toMatch(/Dev server +\(•\) none/)
      await keys(t, 'tab', 'tab', 'tab', 'tab', 'tab', 'tab', ' ')
      const p = await t.frame()
      expect(p).toMatch(/none +the fix goes on the release line only/)
      expect(p).toMatch(/acme\/product +the ticket points at it/)
      await keys(t, 'n', 'o', 'n', 'enter')
      expect(await t.frame()).toMatch(/Patch +none ▾/)
    } finally { t.s.renderer.destroy() }
  })
  test('a base typed that no branch matches is used as written', async () => {
    const t = await screen(runs, undefined, { projects: [fso], query: query({ lookup: { ...found, tags: [], customer: '', board: 'fso' } }) as FlowApi['query'] })
    try {
      await t.press('n'); await typeIn(t, '204598')
      await keys(t, 'tab', ...'a1b2c3'.split(''))
      expect(await t.frame()).toContain('nothing matches: ↵ uses "a1b2c3" as written')
      await keys(t, 'enter')
      expect(await t.frame()).toMatch(/Base +a1b2c3 ▾/)
    } finally { t.s.renderer.destroy() }
  })
  test('a ticket that can\'t be read, or that has a run already, is not started', async () => {
    const t = await screen(runs, undefined, { projects: [fso], query: query({ fail: 'az boards work-item show 9 failed: not found' }) as FlowApi['query'] })
    try {
      await t.press('n'); await typeIn(t, '9')
      expect(await t.frame()).toContain('✕ az boards work-item show 9 failed: not found')
      await keys(t, 'enter')
      expect(t.f.sent).toEqual([])
    } finally { t.s.renderer.destroy() }
    const u = await screen(runs, undefined, { projects: [fso], query: query({ lookup: { ...found, exists: true } }) as FlowApi['query'] })
    try {
      await u.press('n'); await typeIn(u, '204598')
      expect(await u.frame()).toContain('fso-204598 exists already')
      expect(await keys(u, 'enter')).toContain('fso-204598 exists already: open it from the runs')
      expect(u.f.sent).toEqual([])
    } finally { u.s.renderer.destroy() }
  })
  test('it opens on the project you are filtered to, else the one of your latest run', async () => {
    const t = await screen([base('shop-1', { project: 'shop', createdAt: NOW - 60_000 }), base('fso-2', { createdAt: NOW - 600_000 })], undefined, { projects: [fso, shop], query: query() as FlowApi['query'] })
    try {
      expect(await t.press('n')).toMatch(/\(•\) shop/)
      await t.press('esc', '/', ...'project:fso'.split(''), 'enter')
      const f = await t.press('n')
      expect(f).toContain('New run · FSO') // the screen's project: not asked
      expect(f).not.toMatch(/Project +\(/)
    } finally { t.s.renderer.destroy() }
  })
  test('three steps: the run, notes as long as you like (enter is a new line), then logins; the password never shows', async () => {
    const t = await screen(runs, undefined, { projects: [{ ...fso, license: true }], query: query() as FlowApi['query'] })
    try {
      await t.press('n', 'enter')
      await typeIn(t, 'Fix the walk')
      expect(await keys(t, 'enter')).toContain('▸ 2 Notes')
      await typeIn(t, 'Use order ')
      expect(await t.frame()).toContain('Use order ▏') // the space shows as soon as it is typed
      await typeIn(t, '700216740')
      await keys(t, 'enter')
      await typeIn(t, 'tablet layout too')
      const n = await t.frame()
      expect(n).toContain('Use order 700216740')
      expect(n).toContain('tablet layout too')
      expect(n).toContain('2 Notes · 2 lines')
      // the cursor moves: typed in where it is, deleted there, and up a line keeps the column
      await keys(t, 'left', 'left', 'left'); await typeIn(t, 'X')
      expect(await t.frame()).toContain('tablet layout Xtoo')
      await keys(t, 'backspace', 'up'); await typeIn(t, '#')
      expect(await t.frame()).toContain('Use order 7002#16740')
      await keys(t, 'backspace')
      const o = at(await t.frame(), 'Use order')
      await act(async () => { await t.s.mockMouse.click(o.x + 3, o.y) }); await act(async () => { await Bun.sleep(30) })
      await typeIn(t, '@')
      expect(await t.frame()).toContain('Use @order 700216740') // a click put the cursor there
      await keys(t, 'backspace', 'down', 'end')
      expect(await keys(t, 'tab')).toContain('▸ 3 Login')
      await typeIn(t, 'tester@example.com')
      await keys(t, 'tab'); await typeIn(t, 's3cret-pass')
      await keys(t, 'tab'); await typeIn(t, 'LIC-1234')
      const f = await t.frame()
      expect(f).toContain('tester@example.com')
      expect(f).not.toContain('s3cret-pass')
      expect(f).not.toContain('LIC-1234')
      await keys(t, 'enter')
      expect(t.f.sent[0]).toMatchObject({ cmd: 'start', task: 'Fix the walk', note: 'Use order 700216740\ntablet layout too', logins: 'email: tester@example.com\npassword: s3cret-pass\nlicense: LIC-1234' })
    } finally { t.s.renderer.destroy() }
  })
  test("the run's environment: the ticket's suggestion filled in, a choice changed with ←→, a following one shown; sent with the start", async () => {
    const vars = [
      { name: 'CLOUD', label: 'Cloud', choices: ['https://qa.example.cloud', 'https://demo.example.cloud'], repos: ['mobile'] },
      { name: 'APP_ID', label: 'App id', default: '0', repos: ['mobile'] },
      { name: 'HUB', label: 'Portal HUB', from: 'CLOUD', repos: ['portal'] },
    ]
    const t = await screen(runs, undefined, { projects: [{ ...fso, vars }], query: query({ lookup: { ...found, customer: '', tags: [], vars: { CLOUD: 'https://qa.example.cloud' } } }) as FlowApi['query'] })
    try {
      await t.press('n'); await typeIn(t, '204598')
      await keys(t, 'enter', 'tab')
      const f = await t.frame()
      expect(f).toContain('▸ 3 Login & environment')
      expect(f).toMatch(/Cloud +https:\/\/qa\.example\.cloud +from the ticket/)
      expect(f).toMatch(/App id +default: 0/)
      expect(f).not.toContain('Portal HUB') // the run has no portal
      await keys(t, 'tab', 'tab', 'right') // past email and password, onto Cloud
      expect(await t.frame()).toMatch(/Cloud +https:\/\/demo\.example\.cloud/)
      await keys(t, 'tab'); await typeIn(t, '12')
      await keys(t, 'enter')
      expect(t.f.sent[0]).toMatchObject({ cmd: 'start', ticket: 204598, vars: { CLOUD: 'https://demo.example.cloud', APP_ID: '12' } })
    } finally { t.s.renderer.destroy() }
  })
  test('a device run: Window is headless by default; shown is sent as headless: false', async () => {
    const t = await screen(runs, undefined, { projects: [fso], query: query({ lookup: { ...found, customer: '', tags: [] } }) as FlowApi['query'] })
    try {
      await t.press('n'); await typeIn(t, '204598')
      expect(await t.frame()).not.toContain('Window')
      for (let i = 0; i < 12 && !(await t.frame()).match(/▌ Device/); i++) await keys(t, 'tab')
      await keys(t, 'right') // android
      const f = await t.frame()
      expect(f).toMatch(/Window +\(•\) headless +\( \) shown/)
      await keys(t, 'tab', 'right')
      expect(await t.frame()).toMatch(/Window +\( \) headless +\(•\) shown/)
      await keys(t, 'ctrl+s')
      expect(t.f.sent[0]).toMatchObject({ cmd: 'start', device: 'android', headless: false })
    } finally { t.s.renderer.destroy() }
  })
  test('no license field unless the project asks for one; shift+tab goes back a step', async () => {
    const t = await screen(runs, undefined, { projects: [fso], query: query() as FlowApi['query'] })
    try {
      await t.press('n', 'enter'); await typeIn(t, 'Fix the walk')
      await keys(t, 'enter', 'tab')
      const f = await t.frame()
      expect(f).toContain('Password')
      expect(f).not.toContain('License')
      expect(await keys(t, 'shift+tab')).toContain('▸ 2 Notes')
    } finally { t.s.renderer.destroy() }
  })
  test('no ticket: leave it empty and describe the task; the branch is named from it', async () => {
    const t = await screen(runs, undefined, { projects: [fso], query: query() as FlowApi['query'] })
    try {
      await t.press('n', 'enter')
      expect(await t.frame()).toContain('type the ticket, or leave it empty and describe the task')
      await typeIn(t, 'Show the order number on the list') // the refusal put the cursor on Task
      const f = await t.frame()
      expect(f).toMatch(/Task +Show the order number on the list▏/)
      expect(f).toContain('create feat/show-the-order-number-on-the-list from origin/develop in mobile')
      await keys(t, 'enter', 'tab', 'enter') // Notes, Login, start
      expect(t.f.sent).toEqual([{ cmd: 'start', project: 'fso', ticket: '', task: 'Show the order number on the list', base: 'origin/develop', kind: 'feature', repos: ['mobile'] }])
    } finally { t.s.renderer.destroy() }
  })
  test('esc closes it; start now can be clicked', async () => {
    const t = await screen(runs, undefined, { projects: [shop], query: query({ lookup: { ...found, run: 'shop-SGL-692', key: 'SGL-692', tags: [], customer: '', board: 'SGL' } }) as FlowApi['query'] })
    try {
      await t.press('n')
      expect(await t.press('esc')).not.toContain('a ticket to a draft PR')
      await t.press('n'); await typeIn(t, 'SGL-692')
      const p = at(await t.frame(), 'ctrl+s start now')
      await act(async () => { await t.s.mockMouse.click(p.x + 2, p.y) })
      expect(t.f.sent).toEqual([{ cmd: 'start', project: 'shop', ticket: 'SGL-692', base: 'origin/develop', kind: 'feature', repos: ['mobile'] }])
    } finally { t.s.renderer.destroy() }
  })
})

describe('the overlays sit in the middle of the screen', () => {
  test('the new-run form is centred, at any width', async () => {
    for (const width of [130, 200]) {
      const t = await screen(runs, { width, height: 40 }, { projects: [{ key: 'fso', name: 'FSO', tracker: 'azure', forge: 'azure', repos: ['mobile'], devices: [], patches: [], deadlineMinutes: 30 }] })
      try {
        const lines = (await t.press('n')).split('\n')
        const top = lines.find(l => l.includes('╭'))!
        const left = top.indexOf('╭'), right = width - 1 - top.lastIndexOf('╮')
        expect(Math.abs(left - right)).toBeLessThanOrEqual(2)
      } finally { t.s.renderer.destroy() }
    }
  })
})

describe('project settings', () => {
  const raw = {
    key: 'fso', name: 'FSO', worktrees: '~/fso/.flow/worktrees',
    tracker: { kind: 'azure', org: 'https://dev.azure.com/o', project: 'product-app' }, forge: { kind: 'azure', org: 'https://dev.azure.com/o', project: 'product-app' },
    repos: [{ key: 'mobile', path: '~/fso/m', defaultBase: 'origin/develop', verify: [] }, { key: 'portal', path: '~/fso/p', defaultBase: 'origin/develop', verify: [] }],
    sandbox: { enabled: true, filesystem: { allowWrite: ['~/.npm'] } },
  }
  const summary = [{ key: 'fso', name: 'FSO', tracker: 'azure' as const, forge: 'azure' as const, repos: ['mobile', 'portal'], devices: ['android' as const], patches: [], deadlineMinutes: 30, defaults: ['mobile'], maxParallel: 2, usage: { fiveHour: 0.9, week: 0.95 }, review: true, sandbox: { enabled: true, writable: 1, domains: 0, strict: false } }]
  const open = async (reply: (c: Command) => { ok: true; run: string } | { ok: false; error: string } = () => ({ ok: true, run: '' })) => {
    const t = await screen(runs, undefined, { projects: summary, query: (async (q: { q: string }) => (q.q === 'projectFile' ? { path: '/home/me/.config/flow/projects/fso.json', json: raw } : [])) as FlowApi['query'] })
    t.f.a.send = async c => { t.f.sent.push(c); return reply(c) }
    return t
  }
  const k = async (t: Awaited<ReturnType<typeof screen>>, ...ks: string[]) => { for (const x of ks) await act(async () => { x === 'enter' ? t.s.mockInput.pressEnter() : x === 'esc' ? t.s.mockInput.pressEscape() : x === 'tab' ? t.s.mockInput.pressKey('\t') : x === 'backspace' ? t.s.mockInput.pressKey('\b') : x === ' ' ? t.s.mockInput.pressKey(' ') : t.s.mockInput.pressKey(x); if (x === 'esc') await Bun.sleep(80) }); await act(async () => { await Bun.sleep(20) }); return t.frame() }
  test('4 Projects: each project and what it is set to; ↵ opens its settings', async () => {
    const t = await open()
    try {
      const f = await t.press('4')
      expect(f).toMatch(/▌  fso +FSO +Azure DevOps +Azure DevOps +2 +android/)
      expect(f).toMatch(/Sandbox +on · 1 writable folders · 0 network domains/)
      const g = await k(t, 'enter')
      expect(g).toMatch(/fso  FSO +settings/)
      expect(g).toMatch(/General[\s\S]*Permissions[\s\S]*Naming/)
    } finally { t.s.renderer.destroy() }
  })
  test('a toggle changed, shown against the file, saved on y', async () => {
    const t = await open()
    try {
      await t.press('4'); await k(t, 'enter')
      await k(t, 'j', 'j', 'j', 'j', 'enter') // Permissions, its first field: the sandbox on
      const f = await k(t, ' ')
      expect(f).toMatch(/▌ On +\[ \] off/)
      expect(f).toContain('1 change not saved')
      const r = await k(t, 'S')
      expect(r).toContain("Save fso's settings?")
      expect(r).toMatch(/sandbox\.enabled[\s\S]*- true +\+ false/)
      await k(t, 'y')
      expect(t.f.sent).toEqual([{ cmd: 'saveProject', project: 'fso', json: { ...raw, sandbox: { ...raw.sandbox, enabled: false } } }])
      expect(await t.frame()).not.toContain('change not saved')
    } finally { t.s.renderer.destroy() }
  })
  test('a burst of keys typed faster than the screen redraws: every one lands, and enter keeps them all', async () => {
    const t = await open()
    try {
      await t.press('4'); await k(t, 'enter'); await k(t, 'enter') // the fields of General; Name first
      await k(t, 'enter')
      await act(async () => { for (const c of ' Hub') t.s.mockInput.pressKey(c); t.s.mockInput.pressEnter() })
      const f = await k(t, 'S')
      expect(f).toMatch(/name[\s\S]*- "?FSO"? +\+ "?FSO Hub"?/)
    } finally { t.s.renderer.destroy() }
  })
  test('a list: added to in its editor; a text typed; leaving with changes asks once', async () => {
    const t = await open()
    try {
      await t.press('4'); await k(t, 'enter', 'j', 'j', 'j', 'j', 'enter')
      await k(t, 'j', 'j', 'j', 'enter') // Writable
      await k(t, 'a', ...'~/.m2'.split(''), 'enter')
      expect(await t.frame()).toContain('▸ ~/.m2')
      await k(t, 'enter')
      expect(await t.frame()).toMatch(/Writable +~\/\.npm  ~\/\.m2/)
      const r = await k(t, 'S')
      expect(r).toMatch(/sandbox\.filesystem\.allowWrite[\s\S]*\+ ~\/\.m2/)
      await k(t, 'n', 'tab', 'k', 'k', 'k', 'k', 'tab', 'j', 'enter') // General → Name
      for (let i = 0; i < 3; i++) await k(t, 'backspace')
      await k(t, ...'Field Service OS'.split(''), 'enter')
      expect(await t.frame()).toMatch(/Name +Field Service OS/)
      expect(await k(t, 'esc')).toContain('2 changes not saved: S shows and saves them · esc again leaves without them')
      expect(await k(t, 'esc')).toMatch(/Projects +1/)
      expect(t.f.sent).toEqual([])
    } finally { t.s.renderer.destroy() }
  })
  test('a save refused names what is wrong', async () => {
    const t = await open(() => ({ ok: false, error: 'fso.json: repos: Array must contain at least 1 element(s)' }))
    try {
      await t.press('4'); await k(t, 'enter', 'enter', 'j')
      await k(t, 'enter', 'x', 'enter', 'S', 'y')
      expect(await t.frame()).toContain('fso.json: repos: Array must contain at least 1 element(s)')
    } finally { t.s.renderer.destroy() }
  })
})

describe('fixes from use', () => {
  test('runs of one ticket each appear once in the commands, told apart by line; scrolling adds none', async () => {
    const same = ['fso-1', 'fso-1-develop', 'fso-1-develop-develop'].map((id, i) => base(id, { ticket: '#1', title: 'Picking quantity', base: i ? 'origin/develop' : 'origin/patch/3.18.41', createdAt: NOW - i * 60_000 }))
    const t = await screen(same)
    try {
      await t.press('ctrl+k')
      const before = (await t.frame()).split('\n').filter(l => l.includes('Open #1')).length
      for (let i = 0; i < 8; i++) await act(async () => { t.s.mockInput.pressArrow('down') })
      for (let i = 0; i < 8; i++) await act(async () => { t.s.mockInput.pressArrow('up') })
      const after = (await t.frame()).split('\n').filter(l => l.includes('Open #1')).length
      expect(before).toBe(3)
      expect(after).toBe(3)
      expect(await t.frame()).toContain('Open #1 3.18.41 Picking quantity')
    } finally { t.s.renderer.destroy() }
  })
  test('a ticket pasted into the form (a link from the board too), a command filter pasted into the palette', async () => {
    const fso = { key: 'fso', name: 'FSO', tracker: 'azure' as const, forge: 'azure' as const, repos: ['mobile'], devices: [], patches: [], deadlineMinutes: 30 }
    const t = await screen(runs, undefined, { projects: [fso], query: (async (q: { q: string }) => (q.q === 'bases' ? { mobile: ['origin/develop'] } : q.q === 'lookup' ? { run: 'fso-9', exists: false, key: '#9', title: 'Nine', kind: 'bug', type: 'Bug', url: 'u', board: 'b', customer: '', tags: [], comments: 0 } : [])) as FlowApi['query'] })
    try {
      await t.press('n')
      await act(async () => { await t.s.mockInput.pasteBracketedText('https://dev.azure.com/o/acme-hub/_workitems/edit/9/') })
      expect(await t.frame()).toContain('https://dev.azure.com/o/acme-hub/_workitems/edit/9/')
      await t.press('esc')
      await t.press('ctrl+k')
      await act(async () => { await t.s.mockInput.pasteBracketedText('new run') })
      expect(await t.frame()).toContain('› new run▏')
      await t.press('esc')
      // on the runs, a paste is not read as keys (a pasted q must not quit)
      await act(async () => { await t.s.mockInput.pasteBracketedText('q') })
      expect(t.quit()).toBe(false)
    } finally { t.s.renderer.destroy() }
  })
})

describe('the run detail acts on its own run', () => {
  test('opened from the palette while another run is selected: S ships the run on screen, and the screen stays on it', async () => {
    const t = await screen()
    try {
      await t.press('ctrl+k', '1', '0', '4', 'enter')
      const f = await t.press('S')
      expect(f).toContain('Ship #104?')
      expect(f).toContain('Agent') // still the detail
      await t.press('y')
      expect(t.f.sent).toEqual([{ cmd: 'ship', run: 'fso-104' }])
      expect(await t.frame()).toContain('Agent')
    } finally { t.s.renderer.destroy() }
  })
  test('cancelling a confirm goes back to the detail; list keys (/ j s g) do nothing there', async () => {
    const t = await screen()
    try {
      await t.press('ctrl+k', '1', '0', '4', 'enter')
      await t.press('S', 'n')
      const f = await t.press('/')
      expect(f).toContain('Agent')
      expect(f).not.toContain('Filter by status')
    } finally { t.s.renderer.destroy() }
  })
})

describe('the shell pane of a run without its worktree', () => {
  test('says so instead of crashing the screen (setup failed, or the worktree was removed)', async () => {
    const gone = base('fso-9', { stage: 'setup', status: 'failed', needs: { kind: 'setup', ask: 'base origin/x not found' } })
    const t = await screen([gone], { width: 130, height: 34 }, { file: async (_run: string, name: string) => (name === 'run.json' ? JSON.stringify({ worktree: '/nonexistent/flow/9/mobile' }) : '') })
    try {
      await t.press('enter')
      const f = await t.press('i')
      expect(f).toContain('The worktree is not there')
    } finally { stopShells(); t.s.renderer.destroy() }
  })
})

describe('what you typed is kept when the service refuses it', () => {
  const patch = 'diff --git a/src/walk.ts b/src/walk.ts\n--- a/src/walk.ts\n+++ b/src/walk.ts\n@@ -1,2 +1,2 @@\n const a = 1\n-const left = need - got\n+const left = Math.max(0, need - got)\n'
  test('review comments refused (the run is busy) stay, to send again', async () => {
    const t = await screen(runs, undefined, { diff: async () => [{ repo: 'mobile', file: 'src/walk.ts', status: 'M', added: 1, removed: 1, patch }] })
    t.f.a.send = async c => { t.f.sent.push(c); return { ok: false, error: 'fso-105 is busy: wait for its current step to end' } }
    try {
      await t.press('enter', 'd'); await act(async () => { await Bun.sleep(50) })
      await t.press('j', 'j', 'j', 'j', 'c', ...'why?'.split(''), 'enter', 'S'); await act(async () => { await Bun.sleep(20) })
      expect(t.f.sent).toHaveLength(1)
      expect(await t.frame()).toContain('1 comment not sent')
    } finally { t.s.renderer.destroy() }
  })
  test('a message to the agent refused stays in the box', async () => {
    const t = await screen()
    t.f.a.send = async c => { t.f.sent.push(c); return { ok: false, error: 'busy' } }
    try {
      await t.press('enter', 'm', ...'try again'.split(''), 'enter'); await act(async () => { await Bun.sleep(20) })
      expect(t.f.sent).toHaveLength(1)
      expect(await t.press('m')).toContain('try again▏')
    } finally { t.s.renderer.destroy() }
  })
})

describe('removing a run and marking it done', () => {
  test('from the detail\'s commands: remove asks first, then sends it; the screen goes back to the runs', async () => {
    const t = await screen()
    try {
      await t.press('ctrl+k', '1', '0', '4', 'enter')
      await t.press('ctrl+k', ...'remove the run'.split(''), 'enter')
      expect(await t.frame()).toContain('Remove #104?')
      await t.press('y')
      expect(t.f.sent).toEqual([{ cmd: 'remove', run: 'fso-104', force: true }])
    } finally { t.s.renderer.destroy() }
  })
  test("a run's commands: done is a confirmation of no change needed only (done removes the run, as Remove does); no duplicates", async () => {
    const t = await screen([base('fso-104', { stage: 'build', status: 'needs-you', needs: { kind: 'resolution', ask: 'no change needed: x' } }), base('fso-103', {})])
    try {
      await t.press('enter', 'ctrl+k')
      const f = await t.frame()
      for (const gone of ['Mark done', 'Back to the runs', "Show the agent's session"]) expect(f).not.toContain(gone)
      await t.press(...'confirm'.split(''), 'enter')
      expect(t.f.sent).toEqual([{ cmd: 'done', run: 'fso-104' }])
    } finally { t.s.renderer.destroy() }
  })
})

describe('the device in the browser', () => {
  test('a run with a device: its commands open the device\'s page', async () => {
    const opened: string[] = []
    const t = await screen([base('fso-105', { device: { platform: 'android', id: 'emulator-5580', metroPort: 8090 } })], undefined, { pageUrl: (p: string) => `http://127.0.0.1:1${p}?token=t`, openUrl: (u: string) => { opened.push(u) } })
    try {
      await t.press('enter', 'ctrl+k', ...'browser'.split(''), 'enter')
      expect(opened).toEqual(['http://127.0.0.1:1/device/fso-105?token=t'])
      expect(await t.frame()).toContain('b see it')
      await t.press('esc', 'enter', 'b')
      expect(opened).toHaveLength(2)
    } finally { t.s.renderer.destroy() }
  })
})

describe('a run with a PR', () => {
  test('o opens the PR in the browser from the attention item and the run list; in the run, the palette does (o there shows a whole tool output)', async () => {
    const opened: string[] = []
    const url = 'https://dev.azure.com/acme/hub/_git/hub/pullrequest/4711'
    const t = await screen([base('fso-104', { stage: 'ship', status: 'needs-you', needs: { kind: 'pr', ask: 'review' }, pr: { number: 4711, url } })], undefined, { openUrl: (u: string) => { opened.push(u) } })
    try {
      const f = await t.frame()
      expect(f).toContain('o open PR')
      const p = at(f, 'o open PR')
      await act(async () => { await t.s.mockMouse.click(p.x, p.y) }); await act(async () => { await Bun.sleep(30) })
      expect(opened).toEqual([url])
      await t.press('o')
      expect(opened).toHaveLength(2)
      await t.press('enter', 'ctrl+k', ...'PR #4711 in the browser'.split(''), 'enter')
      expect(opened).toHaveLength(3)
    } finally { t.s.renderer.destroy() }
  })
})

describe("the ticket's own page", () => {
  test('opened in the browser from the run (a click on ticket, or the palette); ticket.md stays one click away', async () => {
    const opened: string[] = []
    const t = await screen([base('fso-105', {})], undefined, { openUrl: (u: string) => { opened.push(u) }, file: async (_r: string, n: string) => (n === 'run.json' ? JSON.stringify({ worktree: '/w', url: 'https://dev.azure.com/acme/hub/_workitems/edit/105' }) : '') })
    try {
      await t.press('enter'); await act(async () => { await Bun.sleep(30) })
      const f = await t.frame()
      expect(f).toContain('ticket ↗')
      const p = at(f, 'ticket ↗')
      await act(async () => { await t.s.mockMouse.click(p.x, p.y) }); await act(async () => { await Bun.sleep(30) })
      expect(opened).toEqual(['https://dev.azure.com/acme/hub/_workitems/edit/105'])
      await t.press('ctrl+k', ...'ticket in'.split(''), 'enter')
      expect(opened).toHaveLength(2)
    } finally { t.s.renderer.destroy() }
  })
})

describe('80 to 89 columns', () => {
  test('every run and every item needing you stays on one line (they used to wrap)', async () => {
    const long = (id: string, over: Partial<RunState>) => base(id, { title: `A rather long title for the run ${id} that goes on`, ...over })
    const list = [
      long('fso-105', { stage: 'plan', status: 'needs-you', needs: { kind: 'plan', ask: '1 open question', held: false, deadline: NOW + 12 * 60_000 }, plan: { summary: 's', questions: [] } }),
      long('fso-104', { stage: 'ship', status: 'needs-you', needs: { kind: 'ship', ask: 'verified' } }),
      long('fso-103', { stage: 'verify', status: 'paused', pausedUntil: NOW + 3600_000 }),
      long('fso-102', { stage: 'build', loops: { verify: 2, verifyRuns: 2, review: 1 } }),
    ]
    for (const width of [80, 84, 89]) {
      const t = await screen(list, { width, height: 26 })
      try {
        const lines = (await t.frame()).split('\n')
        const row = (s: string) => lines.filter(l => l.includes(s))
        for (const l of lines) expect(l.trimEnd().length).toBeLessThanOrEqual(width)
        expect(lines.some(l => /^\s*(plan|by itself|12m)\s*$/.test(l))).toBe(false)
        expect(row('#103').some(l => l.includes('resumes'))).toBe(true)
        expect(row('#105').some(l => l.includes('a approve'))).toBe(true)
      } finally { t.s.renderer.destroy() }
    }
  })
})

describe('the worktree in the editor', () => {
  test('e in a run\'s detail opens its worktree with FLOW_EDITOR (VS Code\'s code by default)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'flow-ed-')), mark = join(dir, 'opened')
    const editor = join(dir, 'editor.sh')
    require('node:fs').writeFileSync(editor, `#!/bin/sh\necho "$1" > ${mark}\n`, { mode: 0o755 })
    const old = process.env.FLOW_EDITOR
    process.env.FLOW_EDITOR = editor
    const t = await screen(runs, undefined, { file: async (_r: string, n: string) => (n === 'run.json' ? JSON.stringify({ worktree: dir }) : '') })
    try {
      await t.press('enter'); await act(async () => { await Bun.sleep(30) })
      await t.press('e')
      for (let i = 0; i < 120 && !require('node:fs').existsSync(mark); i++) await Bun.sleep(25)
      expect(require('node:fs').readFileSync(mark, 'utf8').trim()).toBe(dir)
    } finally { process.env.FLOW_EDITOR = old; t.s.renderer.destroy() }
  })
})

describe('a run setting up', () => {
  test('opens on its Setup pane: each step as it happens, from the run\'s setup.log', async () => {
    const asked: string[] = []
    const t = await screen([base('fso-106', { stage: 'setup', status: 'running' })], undefined, { log: async (_r: string, name: string) => { asked.push(name); return ['10:59:01 fetching origin in ~/fso/m', '10:59:40 install', '$ yarn install --frozen-lockfile', '[2/4] Fetching packages...'] } })
    try {
      await t.press('enter'); await act(async () => { await Bun.sleep(50) })
      const f = await t.frame()
      expect(f).toMatch(/Setup ●? *Agent/)
      expect(f).toContain('[2/4] Fetching packages...')
      expect(asked).toContain('setup')
    } finally { t.s.renderer.destroy() }
  })
})
