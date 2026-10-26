/**
 * A run's environment (hwt's questions at creation): which cloud the app talks to, its application id, the portal's
 * tenant. A project names its variables; a run's values come from the form or --var, else from the variable one
 * follows (the portal's HUB follows the app's cloud), else the default; empty keeps the template's value. They fill
 * {NAME} in the app env's values and the browser's start page.
 */
export interface Var { name: string; label?: string; choices?: string[]; default?: string; from?: string; repos?: string[]; detect?: { field: 'environment' | 'customer' | 'application' | 'tags'; map?: Record<string, string> } }
export interface TicketFacts { environment?: string; customer?: string; application?: string; tags?: string[] }

/** values the ticket suggests (the form fills them in, still yours to change): a field mapped by pattern, or as it is */
export function detectVars(vars: Var[], t: TicketFacts): Record<string, string> {
  const out: Record<string, string> = {}
  for (const v of vars) {
    if (!v.detect) continue
    const src = (v.detect.field === 'tags' ? (t.tags ?? []).join(' ') : t[v.detect.field] ?? '').trim()
    if (!src) continue
    const value = v.detect.map ? Object.entries(v.detect.map).find(([re]) => new RegExp(re, 'i').test(src))?.[1] : src
    // ticket text goes into an env file and a URL: a plain value only
    if (value && /^[\w.:/@#?=&%+~-]+$/.test(value)) out[v.name] = value
  }
  return out
}

export function resolveVars(vars: Var[], given: Record<string, string>): Record<string, string> {
  for (const k of Object.keys(given)) if (!vars.some(v => v.name === k)) throw new Error(`no variable ${k} (${vars.map(v => v.name).join(', ')})`)
  for (const [k, v] of Object.entries(given)) if (/[\n\r"'`\\]/.test(v)) throw new Error(`${k}: a value can't hold a line break, a quote or a backslash`)
  const out: Record<string, string> = {}
  // in the order given, so a variable can follow one named before it
  for (const v of vars) out[v.name] = given[v.name]?.trim() || (v.from ? out[v.from] : '') || v.default || ''
  return out
}

/** {NAME} filled from the run's values; a text whose every variable is empty is empty (nothing to set) */
export function fillVars(text: string, values: Record<string, string>): string {
  const names = [...text.matchAll(/\{([A-Z][A-Z0-9_]*)\}/g)].map(m => m[1]!)
  if (names.length && names.every(n => !values[n])) return ''
  return text.replace(/\{([A-Z][A-Z0-9_]*)\}/g, (all, n: string) => (n in values ? values[n]! : all))
}
