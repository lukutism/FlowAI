import { describe, expect, test } from 'bun:test'
import { at, edit, rows } from '../src/tui/notes.ts'

// The new run's notes: typed anywhere in them, the cursor moved with the arrows, Home/End or a click.
describe('the notes box', () => {
  test('lines cut at the width as typed, each with where it starts', () => {
    expect(rows('abcdef\n\nxy', 4)).toEqual([{ start: 0, text: 'abcd' }, { start: 4, text: 'ef' }, { start: 7, text: '' }, { start: 8, text: 'xy' }])
    expect(rows('', 4)).toEqual([{ start: 0, text: '' }])
    expect(rows('abcd', 4)).toEqual([{ start: 0, text: 'abcd' }]) // the cursor after a full line stays on it
  })
  test('typing, enter and pasting go in at the cursor; backspace and delete around it', () => {
    expect(edit({ text: 'held', at: 2 }, 'x', 10)).toEqual({ text: 'hexld', at: 3 })
    expect(edit({ text: 'held', at: 2 }, '\n', 10)).toEqual({ text: 'he\nld', at: 3 })
    expect(edit({ text: 'held', at: 2 }, 'ab\r\ncd', 10)).toEqual({ text: 'heab\ncdld', at: 7 })
    expect(edit({ text: 'held', at: 2 }, { key: 'backspace' }, 10)).toEqual({ text: 'hld', at: 1 })
    expect(edit({ text: 'held', at: 0 }, { key: 'backspace' }, 10)).toEqual({ text: 'held', at: 0 })
    expect(edit({ text: 'held', at: 2 }, { key: 'delete' }, 10)).toEqual({ text: 'hed', at: 2 })
  })
  test('the arrows, Home and End move the cursor; up and down keep the column where they can', () => {
    const n = { text: 'first line\nab\nthird', at: 7 }
    expect(edit(n, { key: 'left' }, 20).at).toBe(6)
    expect(edit(n, { key: 'right' }, 20).at).toBe(8)
    expect(edit(n, { key: 'down' }, 20).at).toBe(13) // 'ab' is shorter: its end
    expect(edit({ ...n, at: 12 }, { key: 'down' }, 20).at).toBe(15) // column 1 of 'third'
    expect(edit({ ...n, at: 12 }, { key: 'up' }, 20).at).toBe(1)
    expect(edit(n, { key: 'up' }, 20).at).toBe(0) // on the first line: its start
    expect(edit({ ...n, at: 16 }, { key: 'down' }, 20).at).toBe(19) // on the last: its end
    expect(edit(n, { key: 'home' }, 20).at).toBe(0)
    expect(edit(n, { key: 'end' }, 20).at).toBe(10)
    expect(edit({ ...n, at: 0 }, { key: 'left' }, 20).at).toBe(0)
    expect(edit({ ...n, at: 19 }, { key: 'right' }, 20).at).toBe(19)
  })
  test('a click puts the cursor at that row and column (past the end of a line: its end)', () => {
    const t = 'first line\nab\nthird'
    expect(at(t, 20, 1, 1)).toBe(12)
    expect(at(t, 20, 1, 9)).toBe(13)
    expect(at(t, 20, 9, 0)).toBe(14) // below the last row: the last row
    expect(at('abcdef', 4, 1, 1)).toBe(5)
  })
})
