import { describe, expect, test } from 'bun:test'
import { canStartTurn } from '../src/usage.ts'

// The subscription's 5-hour and weekly windows are the only limits (no dollar budget). The engine starts a turn
// only while both have room, and otherwise says until when it waits.
const at = (iso: string) => Date.parse(iso)
const reset5h = at('2026-10-24T17:00:00Z') / 1000, resetWeek = at('2026-10-27T09:00:00Z') / 1000
const w = (u5: number, uw: number, s5 = 'allowed', sw = 'allowed') => ({ fiveHour: { utilization: u5, resetsAt: reset5h, status: s5 }, week: { utilization: uw, resetsAt: resetWeek, status: sw } })
const now = at('2026-10-24T14:00:00Z')

describe('canStartTurn: the plan windows decide', () => {
  test('room in both windows: go', () => expect(canStartTurn(w(0.07, 0.55), now)).toEqual({ ok: true }))
  test('no usage seen yet (first turn of the day): go', () => expect(canStartTurn({}, now)).toEqual({ ok: true }))
  test('5-hour window near its limit: wait until it resets', () =>
    expect(canStartTurn(w(0.92, 0.55), now)).toEqual({ ok: false, window: 'fiveHour', until: reset5h * 1000 }))
  test('week near its limit: wait for the weekly reset, even with room in the 5-hour window', () =>
    expect(canStartTurn(w(0.1, 0.97), now)).toEqual({ ok: false, window: 'week', until: resetWeek * 1000 }))
  test('the CLI says a window is not allowed: wait, whatever the utilization says', () =>
    expect(canStartTurn(w(0.4, 0.5, 'rejected'), now)).toMatchObject({ ok: false, window: 'fiveHour' }))
  test('a window whose reset time has passed has rolled over: go', () =>
    expect(canStartTurn(w(0.99, 0.5), at('2026-10-24T17:00:01Z'))).toEqual({ ok: true }))
  test('limits are settings: a stricter weekly limit keeps headroom for the developer\'s own sessions', () =>
    expect(canStartTurn(w(0.1, 0.81), now, { fiveHour: 0.9, week: 0.8 })).toMatchObject({ ok: false, window: 'week' }))
})
