/**
 * The new run's notes as a text box: rows cut at the width as typed (spaces kept: a word-wrap would drop the space
 * you just typed), a cursor moved with the arrows, Home/End or a click, typing and pasting in at the cursor.
 */
export interface Notes { text: string; at: number }
export interface Row { start: number; text: string }
export type NoteKey = 'left' | 'right' | 'up' | 'down' | 'home' | 'end' | 'backspace' | 'delete'

export function rows(text: string, width: number): Row[] {
  const out: Row[] = []
  let start = 0
  for (const line of text.split('\n')) {
    if (!line) out.push({ start, text: '' })
    for (let i = 0; i < line.length; i += width) out.push({ start: start + i, text: line.slice(i, i + width) })
    start += line.length + 1
  }
  return out
}

/** the row the cursor is on, and its column there */
export function cursor(text: string, width: number, at: number): { row: number; col: number } {
  const rs = rows(text, width)
  let row = 0
  while (row + 1 < rs.length && rs[row + 1]!.start <= at) row++
  return { row, col: at - rs[row]!.start }
}

/** the place in the text at a row and column of the box (a click) */
export function at(text: string, width: number, row: number, col: number): number {
  const rs = rows(text, width), r = rs[Math.max(0, Math.min(row, rs.length - 1))]!
  return r.start + Math.max(0, Math.min(col, r.text.length))
}

/** text typed or pasted goes in at the cursor; a key moves it or deletes around it */
export function edit(n: Notes, input: string | { key: NoteKey }, width: number): Notes {
  if (typeof input === 'string') {
    const s = input.replace(/\r\n?/g, '\n')
    return { text: n.text.slice(0, n.at) + s + n.text.slice(n.at), at: n.at + s.length }
  }
  const { row, col } = cursor(n.text, width, n.at), rs = rows(n.text, width), r = rs[row]!
  switch (input.key) {
    case 'left': return { ...n, at: Math.max(0, n.at - 1) }
    case 'right': return { ...n, at: Math.min(n.text.length, n.at + 1) }
    case 'home': return { ...n, at: r.start }
    case 'end': return { ...n, at: r.start + r.text.length }
    case 'up': return { ...n, at: row === 0 ? 0 : at(n.text, width, row - 1, col) }
    case 'down': return { ...n, at: row === rs.length - 1 ? n.text.length : at(n.text, width, row + 1, col) }
    case 'backspace': return n.at === 0 ? n : { text: n.text.slice(0, n.at - 1) + n.text.slice(n.at), at: n.at - 1 }
    case 'delete': return { ...n, text: n.text.slice(0, n.at) + n.text.slice(n.at + 1) }
  }
}
