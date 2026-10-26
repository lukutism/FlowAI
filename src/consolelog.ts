/**
 * The app's JS console from the device log. React Native writes console.log there as text, objects through its own
 * inspect ({ a: 1, b: [ 'x' ] }, arguments joined by ', ', long ones broken over lines that the log splits); this
 * parses it back, so the device page can open objects and arrays like the browser's console. Text that isn't such
 * a list of values (a single string argument is written bare) stays text.
 */
export type Value =
  | { kind: 'object'; entries: [string, Value][] }
  | { kind: 'array'; items: Value[] }
  | { kind: 'string' | 'number' | 'boolean' | 'null' | 'undefined' | 'special'; text: string }

export interface ConsoleEntry { time: string; level: 'log' | 'debug' | 'warn' | 'error'; text: string; values: Value[] | null }

/** the values of a console line, or null when it is plain text */
export function parseConsole(text: string): Value[] | null {
  let i = 0, cut = false
  const ws = () => { while (i < text.length && /\s/.test(text[i]!)) i++ }
  // the device log keeps about 4 KB of an entry: a value cut off there is shown as far as it goes
  const CUT: Value = { kind: 'special', text: '… (cut off by the device log)' }
  const end = () => { if (i >= text.length) { cut = true; return true } return false }
  const fail = (): never => { throw new Error('not a value') }
  const quoted = (): string => {
    const q = text[i++]
    let out = ''
    while (text[i] !== q) {
      if (end()) return out + '…'
      if (text[i] === '\\') {
        const n = text[++i]
        out += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'u' ? String.fromCharCode(parseInt(text.slice(i + 1, (i += 4) + 1), 16)) : n
        i++
      } else out += text[i++]
    }
    i++
    return out
  }
  const value = (): Value => {
    ws()
    const c = text[i]
    if (c === '{') {
      i++; ws()
      const entries: [string, Value][] = []
      if (text[i] === '}') { i++; return { kind: 'object', entries } }
      for (;;) {
        ws()
        if (end()) { entries.push(['…', CUT]); return { kind: 'object', entries } }
        let key: string
        if (text[i] === "'" || text[i] === '"') key = quoted()
        else if (text[i] === '[') { const end = text.indexOf(']', i); if (end < 0) fail(); key = text.slice(i, end + 1); i = end + 1 }
        else { const m = /^[\w$]+/.exec(text.slice(i)); if (!m) fail(); key = m![0]; i += key.length }
        ws(); if (end()) { entries.push([key, CUT]); return { kind: 'object', entries } }
        if (text[i++] !== ':') fail()
        entries.push([key, value()])
        ws()
        if (end()) return { kind: 'object', entries: [...entries, ['…', CUT]] }
        if (text[i] === ',') { i++; continue }
        if (text[i] === '}') { i++; return { kind: 'object', entries } }
        fail()
      }
    }
    if (c === '[') {
      // [Object], [Function name], [Getter], [TOO BIG …]: a special word, not an array
      const special = /^\[(Object|Array|Circular|Getter|Setter|Getter\/Setter|Function[^\]]*|TOO BIG[^\]]*)\]/.exec(text.slice(i))
      if (special) { i += special[0].length; return { kind: 'special', text: special[0] } }
      // such a word the device log cut off before its ]
      if (/^\[(Object|Array|Circular|Getter|Setter|Function|TOO BIG)[^\]]*$/.test(text.slice(i))) { i = text.length; cut = true; return CUT }
      i++; ws()
      const items: Value[] = []
      if (text[i] === ']') { i++; return { kind: 'array', items } }
      for (;;) {
        items.push(value())
        ws()
        if (end()) return { kind: 'array', items: [...items, CUT] }
        if (text[i] === ',') { i++; continue }
        if (text[i] === ']') { i++; return { kind: 'array', items } }
        fail()
      }
    }
    if (end()) return CUT
    if (c === "'" || c === '"') return { kind: 'string', text: quoted() }
    const m = /^(-?(?:\d+\.?\d*(?:e[+-]?\d+)?|Infinity|NaN)|true|false|null|undefined)(?=[\s,}\]]|$)/.exec(text.slice(i))
    if (!m) fail()
    i += m![0].length
    const t = m![0]
    return { kind: t === 'true' || t === 'false' ? 'boolean' : t === 'null' ? 'null' : t === 'undefined' ? 'undefined' : 'number', text: t }
  }
  try {
    const out: Value[] = []
    for (;;) {
      out.push(value())
      ws()
      if (i >= text.length) break
      if (text[i] !== ',') return null
      i++
    }
    // a lone string, number or word is just text; a list of values has something to open, or several arguments
    return out.some(v => v.kind === 'object' || v.kind === 'array') || (out.length > 1 && !cut) ? out : null
  } catch { return null }
}

/** whether a { or [ is still open (quotes not counted: a guess, good enough to join an object's lines) */
const open = (t: string) => (t.match(/[[{]/g)?.length ?? 0) > (t.match(/[\]}]/g)?.length ?? 0)

const LEVEL: Record<string, ConsoleEntry['level']> = { V: 'debug', D: 'debug', I: 'log', W: 'warn', E: 'error', F: 'error' }

/** the app's device log (logcat -v time): its JS console entries (one per timestamp, lines merged) and the native rest */
export function consoleEntries(log: string): { console: ConsoleEntry[]; native: string[] } {
  const out: ConsoleEntry[] = [], native: string[] = []
  let last: { key: string; entry: ConsoleEntry } | undefined
  for (const line of log.split('\n')) {
    if (!line.trim()) continue
    const m = /^\d\d-\d\d (\d\d:\d\d:\d\d\.\d+) ([VDIWEF])\/ReactNativeJS\(\s*\d+\): ?(.*)$/.exec(line)
    if (!m) { native.push(line); last = undefined; continue }
    const key = `${m[1]} ${m[2]}`
    // a line of the same entry (one timestamp): an object's next line is indented or closes it, or one is still open;
    // another console call in the same millisecond starts afresh
    if (last?.key === key && (/^[\s\]}]/.test(m[3]!) || open(last.entry.text))) { last.entry.text += `\n${m[3]}`; continue }
    const entry: ConsoleEntry = { time: m[1]!, level: LEVEL[m[2]!] ?? 'log', text: m[3]!, values: null }
    out.push(entry)
    last = { key, entry }
  }
  for (const e of out) e.values = parseConsole(e.text)
  return { console: out, native }
}
