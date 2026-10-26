import type { Window } from './agent/stream.ts'

export interface Windows { fiveHour?: Window; week?: Window }
export interface UsageLimits { fiveHour: number; week: number }

/** start turns while both windows are under these shares; the rest stays for the developer's own sessions */
export const DEFAULT_LIMITS: UsageLimits = { fiveHour: 0.9, week: 0.95 }

export type TurnGate = { ok: true } | { ok: false; window: keyof Windows; until: number }

/** May a new agent turn start now? Uses the latest windows the CLI reported (rate_limit_event). */
export function canStartTurn(windows: Windows, now: number, limits: UsageLimits = DEFAULT_LIMITS): TurnGate {
  // the weekly window first: when both are full, the week is the later and the honest answer
  for (const name of ['week', 'fiveHour'] as const) {
    const w = windows[name]
    if (!w) continue
    const until = w.resetsAt * 1000
    if (now >= until) continue // rolled over since it was reported
    // allowed_warning (the CLI's notice from about 85%) still allows turns; only a refusal or our own limit waits
    if (!w.status.startsWith('allowed') || w.utilization >= limits[name]) return { ok: false, window: name, until }
  }
  return { ok: true }
}
