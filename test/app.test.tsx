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
    for (const k of keys) await act(async () => { k === 'enter' ? s.mockInput.pressEnter() : k === 'esc' ? s.mockInput.pressEscape() : k === 'ctrl+k' ? s.mockInput.pressKey('k', { ctrl: true }) : k === 'tab' ? s.mockInput.pressKey('\t') : s.mockInput.pressKey(k); if (k === 'esc') await Bun.sleep(80) })
    return frame()
  }
  return { s, f, frame, press, quit: () => quit }
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
    const t = await screen([base('fso-104', { stage: 'ship', status: 'needs-you', needs: { kind: 'pr', ask: 'review' }, pr: { number: 4711, url: 'u' } }), base('fso-103', {})])
    try {
      await t.press('enter', 'p')
      expect(t.f.sent).toEqual([{ cmd: 'port', run: 'fso-104' }])
      expect(await t.press('esc', 'j', 'enter', 'p')).toContain('#103 has no draft PR to port yet')
    } finally { t.s.renderer.destroy() }
  })
  test('n starts a run: project, ticket number and an optional base, typed in place', async () => {
    const t = await screen()
    try {
      expect(await t.press('n')).toContain('New run')
      await t.press(...'fso 204598 origin/patch/3.18.41 repos=mobile,portal'.split(''), 'enter')
      expect(t.f.sent).toEqual([{ cmd: 'start', project: 'fso', ticket: 204598, base: 'origin/patch/3.18.41', repos: ['mobile', 'portal'] }])
    } finally { t.s.renderer.destroy() }
  })
  test('n takes a Jira key as the ticket too', async () => {
    const t = await screen()
    try {
      await t.press('n', ...'spk SGL-692'.split(''), 'enter')
      expect(t.f.sent).toEqual([{ cmd: 'start', project: 'spk', ticket: 'SGL-692' }])
    } finally { t.s.renderer.destroy() }
  })
  test('n with device=android asks for the run\'s own device', async () => {
    const t = await screen()
    try {
      await t.press('n', ...'fso 204598 device=android'.split(''), 'enter')
      expect(t.f.sent).toEqual([{ cmd: 'start', project: 'fso', ticket: 204598, device: 'android' }])
      expect(await t.press('n', ...'fso 1 device=tv'.split(''), 'enter')).toContain('device is android or ios')
    } finally { t.s.renderer.destroy() }
  })
  test('n with patch=<customer>/<app> starts a customer patch run', async () => {
    const t = await screen()
    try {
      await t.press('n', ...'fso 204598 origin/patch/3.18.41 patch=acme/product'.split(''), 'enter')
      expect(t.f.sent).toEqual([{ cmd: 'start', project: 'fso', ticket: 204598, base: 'origin/patch/3.18.41', patch: 'acme/product' }])
    } finally { t.s.renderer.destroy() }
  })
  test('n with a malformed entry says what it needs and sends nothing', async () => {
    const t = await screen()
    try {
      expect(await t.press('n', ...'fso'.split(''), 'enter')).toContain('type: <project> <ticket> [base] [repos=a,b] [device=android|ios] [patch=customer/app]')
      expect(t.f.sent).toEqual([])
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
      expect(f).toMatch(/Agent +Metro +Dev server +Shell/)
      expect(await t.press('esc')).toContain('Needs attention')
    } finally { t.s.renderer.destroy() }
  })
  test('the Agent pane: the session so far, then live; who said what, the tools run, refusals, turn ends', async () => {
    const tr: Entry[] = [
      { at: NOW - 5 * 60_000, own: true, kind: 'prompt', from: 'flow', text: 'You are working on ticket #105\nline 2\nline 3' },
      { at: NOW - 4 * 60_000, own: true, kind: 'text', text: 'I will start in the walk.' },
      { at: NOW - 4 * 60_000, own: true, kind: 'tool', id: 't', name: 'Bash', input: { command: 'yarn tsc -p apps/product' } },
      { at: NOW - 3 * 60_000, own: true, kind: 'denied', tool: 'Bash', input: { command: 'git commit -m x' } },
      { at: NOW - 2 * 60_000, own: true, kind: 'result', ok: true, text: '', turns: 4, reason: '', session: 's', tokens: { input: 1000, output: 2000, cacheRead: 600_000, cacheWrite: 23_000 } },
    ]
    const t = await screen(runs, undefined, { transcript: async () => tr })
    try {
      const f = await t.press('enter')
      expect(f).toMatch(/11:55 flow +You are working on ticket #105 +\(\+2 lines\)/)
      expect(f).toMatch(/11:56 claude +I will start in the walk\./)
      expect(f).toMatch(/⋯ Bash +yarn tsc -p apps\/product/)
      expect(f).toMatch(/✕ Bash +git commit -m x +refused by flow/)
      expect(f).toContain('── turn ended · 626k tokens · 4 turns ──')
      await act(async () => { t.f.push({ type: 'agent', run: 'fso-105', entry: { at: NOW, own: true, kind: 'text', text: 'And now the order list.' } } as never) })
      expect(await t.frame()).toMatch(/12:00 claude +And now the order list\./)
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
  test('] moves to Metro: the run\'s log; a run without a device says why there is none', async () => {
    const withDevice = [base('fso-105', { device: { platform: 'android', id: 'emulator-5700', metroPort: 8300 } })]
    const t = await screen(withDevice, undefined, { log: async (_r, name) => (name === 'metro' ? [' BUNDLE  ./index.js 78%', ' WARN  Require cycle'] : []) })
    try {
      await t.press('enter', ']')
      await act(async () => { await Bun.sleep(20) })
      const f = await t.frame()
      expect(f).toMatch(/Metro :8300 ● running +metro\.log/)
      expect(f).toContain('BUNDLE  ./index.js 78%')
      expect(await t.press(']')).toContain('This run has no dev server: start a run with one')
    } finally { t.s.renderer.destroy() }
    const u = await screen()
    try { expect(await u.press('enter', ']')).toContain('This run has no device, so no Metro') } finally { u.s.renderer.destroy() }
  })
  test('the files: a click opens one in the right pane', async () => {
    const t = await screen()
    try {
      const p = at(await t.press('enter'), 'plan.md  ')
      await act(async () => { await t.s.mockMouse.click(p.x, p.y) })
      expect(await t.frame()).toContain('Guard the walk against missing assets.')
    } finally { t.s.renderer.destroy() }
  })
  test('the Shell pane: a real shell in the run\'s worktree; i types into it, ctrl+] leaves; v splits it with the session', async () => {
    const wt = mkdtempSync(join(tmpdir(), 'flow-shell-'))
    process.env.FLOW_SHELL = '/bin/sh'
    const t = await screen(runs, undefined, { file: async (_r, name) => (name === 'run.json' ? JSON.stringify({ worktree: wt }) : '') })
    try {
      await t.press('enter', 'i')
      await act(async () => { await Bun.sleep(300) })
      for (const k of 'echo hi-from-$((40+2))') await act(async () => { t.s.mockInput.pressKey(k) })
      await act(async () => { t.s.mockInput.pressEnter() })
      await act(async () => { await Bun.sleep(400) })
      let f = await t.frame()
      expect(f).toContain('hi-from-42')
      expect(f).toContain('typing in Shell')
      await act(async () => { t.s.mockInput.pressKey(']', { ctrl: true }) })
      f = await t.frame()
      expect(f).toContain('esc back   [ ] pane')
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
    const list = [...runs, base('spk-7', { project: 'spk', title: 'Order text' })]
    const t = await screen(list)
    try {
      const f = await t.press('/', ...'project:spk'.split(''), 'enter')
      expect(f).toContain('filter project:spk')
      expect(f).toContain('1 of 4 runs match')
      expect(f).toContain('∿ flow  spk')
      expect(f).toMatch(/#7 +Order text/)
      expect(f).not.toMatch(/#103 +Title/)
      expect(await t.press('esc')).toContain('filter none')
    } finally { t.s.renderer.destroy() }
  })
})

describe('the command palette', () => {
  test('ctrl+k opens it; typing narrows it; enter runs the chosen command', async () => {
    const list = [base('fso-104', { stage: 'ship', status: 'needs-you', needs: { kind: 'pr', ask: 'review' }, pr: { number: 4711, url: 'u' } })]
    const t = await screen(list)
    try {
      expect(await t.press('ctrl+k')).toContain('Open #104')
      const f = await t.press(...'port'.split(''))
      expect(f).toContain('Port #104 to develop')
      expect(f).not.toContain('Open #104')
      await t.press('enter')
      expect(t.f.sent).toEqual([{ cmd: 'port', run: 'fso-104' }])
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
      await t.press(':', ...'show fso'.split(''), 'enter')
      expect(await t.frame()).toContain('filter project:fso')
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
      expect(p).toMatch(/fso +FSO +tickets Azure DevOps · PRs Azure DevOps · 4 runs/)
      expect(p).toContain('repos mobile, portal · devices android · customer patches in mobile · plan defaults after 30 min')
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
    try { expect(await click(t, '4 Projects')).toContain('from ~/.config/flow/projects/<key>.json') } finally { t.s.renderer.destroy() }
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
      expect(await click(t, 'n new')).toContain('New run')
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
  test('a command in the palette is clicked to run it', async () => {
    const list = [base('fso-104', { stage: 'ship', status: 'needs-you', needs: { kind: 'pr', ask: 'review' }, pr: { number: 4711, url: 'u' } })]
    const t = await screen(list)
    try {
      await t.press('ctrl+k')
      await click(t, 'Port #104 to develop')
      expect(t.f.sent).toEqual([{ cmd: 'port', run: 'fso-104' }])
    } finally { t.s.renderer.destroy() }
  })
})

describe('projects and the attention list from the keyboard', () => {
  const mixed = [...runs, base('spk-7', { project: 'spk', title: 'Order text' })]
  test('p opens the project picker with each project\'s runs; choosing one filters the screen to it', async () => {
    const t = await screen(mixed, undefined, { projects: [...projects, { ...projects[0]!, key: 'spk', name: 'SPK' }] })
    try {
      const f = await t.press('p')
      expect(f).toMatch(/✓ all projects +4 runs/)
      expect(f).toMatch(/fso +FSO +3 runs/)
      expect(f).toMatch(/spk +SPK +1 run/)
      const g = await t.press('j', 'j', 'enter')
      expect(g).toContain('∿ flow  spk ▾')
      expect(g).toContain('filter project:spk')
      expect(g).toMatch(/#7 +Order text/)
      expect(g).not.toMatch(/#103 +Title fso-103/)
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
  test('a click on an attention item focuses it', async () => {
    const t = await screen()
    try {
      const p = at(await t.frame(), 'Ready to ship')
      await act(async () => { await t.s.mockMouse.click(p.x, p.y) })
      expect(await t.frame()).toMatch(/▌#104 /)
    } finally { t.s.renderer.destroy() }
  })
})
