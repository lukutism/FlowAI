import { describe, expect, test } from 'bun:test'
import { act } from 'react'
import { testRender } from '@opentui/react/test-utils'
import type { RunEvent, RunState } from '../src/run.ts'
import type { Command } from '../src/service.ts'
import { App, type FlowApi } from '../src/tui/app.tsx'

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
async function screen(list = runs) {
  const f = api(list)
  let quit = false
  const s = await testRender(<App api={f.a} now={() => NOW} onQuit={() => { quit = true }} />, { width: 130, height: 34 })
  const frame = async () => { await act(async () => { await Bun.sleep(1) }); await s.renderOnce(); return s.captureCharFrame() }
  // a lone Escape is only known after a short pause (it could start a key sequence), so wait for it
  const press = async (...keys: string[]) => {
    for (const k of keys) await act(async () => { k === 'enter' ? s.mockInput.pressEnter() : k === 'esc' ? s.mockInput.pressEscape() : s.mockInput.pressKey(k); if (k === 'esc') await Bun.sleep(80) })
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
      expect(f).toContain('Q1 Also guard the order list? (default: no)')
      expect(f).toMatch(/#104 .*Ready to ship .*s ship/)
      expect(f).toMatch(/#103 +Title fso-103 +develop +●●●◎◌◌ +running +14m +264k +verifying/)
    } finally { t.s.renderer.destroy() }
  })
  test('a on a plan: the questions with their defaults, then y approves with the defaults', async () => {
    const t = await screen()
    try {
      const f = await t.press('a')
      expect(f).toContain('Approve #105 with the defaults?')
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
  test('s on a verified run asks first; y ships', async () => {
    const t = await screen()
    try {
      const f = await t.press('j', 's')
      expect(f).toContain('Ship #104?')
      await t.press('y')
      expect(t.f.sent).toEqual([{ cmd: 'ship', run: 'fso-104' }])
    } finally { t.s.renderer.destroy() }
  })
  test('s on a run that is not verified says so and sends nothing', async () => {
    const t = await screen()
    try {
      expect(await t.press('j', 'j', 's')).toContain('#103 is not ready to ship')
      expect(t.f.sent).toEqual([])
    } finally { t.s.renderer.destroy() }
  })
  test('p ports a run that has its draft PR; on others it says why not', async () => {
    const t = await screen([base('fso-104', { stage: 'ship', status: 'needs-you', needs: { kind: 'pr', ask: 'review' }, pr: { number: 4711, url: 'u' } }), base('fso-103', {})])
    try {
      await t.press('p')
      expect(t.f.sent).toEqual([{ cmd: 'port', run: 'fso-104' }])
      expect(await t.press('j', 'p')).toContain('#103 has no draft PR to port yet')
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
      expect(await t.press('a')).toContain('Approve #105 with the defaults?')
      const f = await t.press('esc')
      expect(f).not.toContain('Approve #105 with the defaults?')
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
      expect(fr).toMatch(/Agents +2\/2 +fso-105, fso-103/)
      expect(fr).toMatch(/Builds +1\/1 +fso-103/)
      expect(fr).toMatch(/Devices +0\/4/)
      expect(fr).toContain('Waiting  fso-104 for a build slot')
    } finally { s.renderer.destroy() }
  })
  test('no runs: says how to start one', async () => {
    const t = await screen([])
    try { expect(await t.frame()).toContain('No runs yet. Start one: flow start <project> <ticket>') } finally { t.s.renderer.destroy() }
  })
})

describe('Run detail', () => {
  test('a run with a device names it and its Metro port', async () => {
    const t = await screen([base('fso-105', { device: { platform: 'android', id: 'emulator-5580', metroPort: 8090 } })])
    try { expect(await t.press('enter')).toContain('Device android emulator-5580 · Metro :8090') } finally { t.s.renderer.destroy() }
  })
  test('a customer patch run names its patch; s on a checked write-back asks before writing it back', async () => {
    const t = await screen([base('fso-105', { stage: 'ship', status: 'needs-you', needs: { kind: 'patch', ask: 'write-back dry run in patch-report.txt: ship again to write the patch back' }, patch: { customer: 'acme', app: 'product', commit: 'abc' } })])
    try {
      expect(await t.press('enter')).toContain('Customer patch acme/product (applied locally, written back at ship)')
      await t.press('esc')
      expect(await t.press('s')).toContain('Write the patch back for #105?')
    } finally { t.s.renderer.destroy() }
  })
  test('enter opens it: what it needs, the plan, its questions, the timeline; esc goes back', async () => {
    const t = await screen()
    try {
      const f = await t.press('enter')
      expect(f).toContain('Needs you: 1 open question')
      expect(f).toContain('Guard the walk against missing assets.')
      expect(f).toContain('Q1 Also guard the order list? → default: no')
      expect(f).toMatch(/human +run\.created/)
      expect(f).toMatch(/agent +plan\.submitted/)
      expect(f).toContain('Review 2 1 finding(s) · 1 below 80% confidence left out')
      expect(f).toContain('R1 [P1] src/b.ts:4  the order list still shows 8')
      expect(f).toContain('55%  [P2] src/c.ts  maybe a rounding edge')
      expect(await t.press('esc')).toContain('Needs attention')
    } finally { t.s.renderer.destroy() }
  })
})
