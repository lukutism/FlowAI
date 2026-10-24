import { describe, expect, test } from 'bun:test'
import { Turns } from '../src/turns.ts'
import type { Windows } from '../src/usage.ts'

// Turns start only while the plan windows have room and fewer than maxParallel agents are mid-turn.
function setup(windows: Windows, maxParallel = 2) {
  let now = Date.parse('2026-10-24T14:00:00Z')
  const log: string[] = []
  const t = new Turns({
    maxParallel, limits: { fiveHour: 0.9, week: 0.95 }, windows: () => windows, now: () => now,
    sleep: async ms => { now += ms },
    onPause: (run, g) => log.push(`${run} paused ${g.window} until ${new Date(g.until).toISOString().slice(11, 16)}`),
    onResume: run => log.push(`${run} resumed`),
  })
  return { t, log, at: () => new Date(now).toISOString().slice(11, 16) }
}
const w = (u5: number, uw: number) => ({ fiveHour: { utilization: u5, resetsAt: Date.parse('2026-10-24T17:00:00Z') / 1000, status: 'allowed' }, week: { utilization: uw, resetsAt: Date.parse('2026-10-27T09:00:00Z') / 1000, status: 'allowed' } })

describe('Turns: the plan windows and the parallel limit decide when a turn starts', () => {
  test('room: starts at once, no pause recorded', async () => {
    const { t, log } = setup(w(0.1, 0.5))
    const release = await t.acquire('A')
    release()
    expect(log).toEqual([])
  })
  test('5-hour window full: the run is paused until the reset, then resumes by itself', async () => {
    const { t, log, at } = setup(w(0.95, 0.5))
    const release = await t.acquire('A')
    release()
    expect(log).toEqual(['A paused fiveHour until 17:00', 'A resumed'])
    expect(at()).toBe('17:00')
  })
  test('the parallel limit: a third run waits until one of two running turns ends', async () => {
    const { t } = setup(w(0.1, 0.5), 2)
    const order: string[] = []
    const a = await t.acquire('A'), b = await t.acquire('B')
    const c = t.acquire('C').then(r => { order.push('C started'); return r })
    await Bun.sleep(5)
    order.push('A ends'); a()
    ;(await c)(); b()
    expect(order).toEqual(['A ends', 'C started'])
  })
  test('releasing twice frees one slot, not two', async () => {
    const { t } = setup(w(0.1, 0.5), 1)
    const a = await t.acquire('A'); a(); a()
    const b = await t.acquire('B')
    let cStarted = false
    void t.acquire('C').then(() => { cStarted = true })
    await Bun.sleep(5)
    expect(cStarted).toBe(false)
    b()
  })
})
