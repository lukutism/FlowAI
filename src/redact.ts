/**
 * Logins written in a ticket (a QA tenant's password in a comment): their values go to the run's logins.md, which
 * only the human reads and the agent may use on the device; the ticket text the agent quotes from keeps a pointer
 * instead, and what flow shows (the agent pane, transcripts) has the values masked.
 */
const LABEL = /\b(passwords?|passwort|passwd|pwd|pw|passcode|passphrase|licen[cs]e(?:[ _-]?key)?|api[ _-]?key|access[ _-]?token|token|secret|pin(?:[ _-]?code)?)\b(\s*(?::|=|\bis\b)\s*)(\S+)/gi
const POINTER = "[in the run's logins.md]"

/** a lone word that reads like a password: no spaces, 6 to 64 characters, letters mixed with digits or symbols */
const looksLikePassword = (v: string) => v.length >= 6 && v.length <= 64 && !/\s/.test(v) && /[a-zA-Z]/.test(v) && /[^a-zA-Z]/.test(v) && !/^https?:/i.test(v) && !v.includes('@')

export function redactLogins(text: string): { text: string; found: { label: string; value: string }[] } {
  const found: { label: string; value: string }[] = []
  const labelled = text.replace(LABEL, (all, label: string, sep: string, raw: string) => {
    const value = raw.replace(/[.,;:)\]}>"']+$/, '')
    if (value.length < 4 || value.startsWith('[in the run')) return all
    found.push({ label: label.replace(/^(api|access)[ _-]?/i, ''), value })
    return `${label}${sep}${POINTER}${raw.slice(value.length)}`
  })
  // an unlabelled login: an email, then the password alone on the next line
  const lines = labelled.split('\n')
  for (let i = 1; i < lines.length; i++) {
    const v = lines[i]!.trim()
    if (!/^\S+@\S+\.\S+$/.test(lines[i - 1]!.trim()) || !looksLikePassword(v)) continue
    found.push({ label: 'password', value: v })
    lines[i] = lines[i]!.replace(v, POINTER)
  }
  return { text: lines.join('\n'), found }
}

/** the values in a logins file (the login step's, the ticket's): words of 6+ characters with a non-letter in them */
export function loginValues(text: string): string[] {
  return [...new Set(text.split(/[\s,;:/|]+/).filter(w => w.length >= 6 && /[^a-zA-Z]/.test(w) && !/^https?$/i.test(w) && !w.startsWith('[in')))]
}

/** the known login values masked in text flow shows */
export function maskLogins(text: string, values: string[]): string {
  let out = text
  for (const v of [...values].sort((a, b) => b.length - a.length)) if (v) out = out.split(v).join('••••••')
  return out
}
