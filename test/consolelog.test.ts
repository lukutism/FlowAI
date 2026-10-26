import { describe, expect, test } from 'bun:test'
import { consoleEntries, parseConsole } from '../src/consolelog.ts'

// React Native writes console.log to the device log as text (its own inspect: { a: 1, b: [ 'x' ] }, arguments joined
// by ', '); the device page parses it back, so objects and arrays open like the browser's console.
describe('parseConsole', () => {
  test('an object, nested, with strings, numbers, booleans, null and undefined', () => {
    expect(parseConsole("{ id: 7, name: 'Order \\'A\\'', tags: [ 'x', 2 ], ok: true, none: null, gone: undefined, deep: { a: [Object] } }")).toEqual([{
      kind: 'object', entries: [
        ['id', { kind: 'number', text: '7' }],
        ['name', { kind: 'string', text: "Order 'A'" }],
        ['tags', { kind: 'array', items: [{ kind: 'string', text: 'x' }, { kind: 'number', text: '2' }] }],
        ['ok', { kind: 'boolean', text: 'true' }],
        ['none', { kind: 'null', text: 'null' }],
        ['gone', { kind: 'undefined', text: 'undefined' }],
        ['deep', { kind: 'object', entries: [['a', { kind: 'special', text: '[Object]' }]] }],
      ],
    }])
  })
  test('several arguments: a label and an object; quoted keys; functions', () => {
    expect(parseConsole("'user', { 'x-id': 1, run: [Function run] }")).toEqual([
      { kind: 'string', text: 'user' },
      { kind: 'object', entries: [['x-id', { kind: 'number', text: '1' }], ['run', { kind: 'special', text: '[Function run]' }]] },
    ])
  })
  test('several plain arguments are values too; an object the device log cut off shows as far as it goes', () => {
    expect(parseConsole("{ a: 1, b: [TOO BIG format")).toEqual([{ kind: 'object', entries: [['a', { kind: 'number', text: '1' }], ['b', { kind: 'special', text: '… (cut off by the device log)' }], ['…', { kind: 'special', text: '… (cut off by the device log)' }]] }])
    expect(parseConsole("'i18next: languageChanged', 'lt_LT'")).toEqual([{ kind: 'string', text: 'i18next: languageChanged' }, { kind: 'string', text: 'lt_LT' }])
    expect(parseConsole("'init', { debug: true,\n  res: { lt: { close: 'Uždar")).toEqual([{ kind: 'string', text: 'init' }, { kind: 'object', entries: [
      ['debug', { kind: 'boolean', text: 'true' }],
      ['res', { kind: 'object', entries: [['lt', { kind: 'object', entries: [['close', { kind: 'string', text: 'Uždar…' }], ['…', { kind: 'special', text: '… (cut off by the device log)' }]] }], ['…', { kind: 'special', text: '… (cut off by the device log)' }]] }],
      ['…', { kind: 'special', text: '… (cut off by the device log)' }],
    ] }])
  })
  test('plain text (a single string argument is written bare) is not parsed', () => {
    expect(parseConsole('Running "main" with {"rootTag":1}')).toBeNull()
    expect(parseConsole('fetch failed: 500')).toBeNull()
  })
  test('a multi-line object (long ones are broken over lines)', () => {
    expect(parseConsole("{ items: \n   [ { question: 'Kaip?', answer: 'Taip' },\n     { question: 'Kur?', answer: 'Čia' } ] }")).toEqual([{
      kind: 'object', entries: [['items', { kind: 'array', items: [
        { kind: 'object', entries: [['question', { kind: 'string', text: 'Kaip?' }], ['answer', { kind: 'string', text: 'Taip' }]] },
        { kind: 'object', entries: [['question', { kind: 'string', text: 'Kur?' }], ['answer', { kind: 'string', text: 'Čia' }]] },
      ] }]],
    }])
  })
})

describe('consoleEntries: the device log of the app, as console entries and the native rest', () => {
  const log = [
    '10-26 18:20:01.100 I/ReactNativeJS( 812): Running "main"',
    '10-26 18:20:02.200 I/ReactNativeJS( 812): { items: ',
    "10-26 18:20:02.200 I/ReactNativeJS( 812):    [ { a: 1 } ] }",
    '10-26 18:20:02.300 W/ReactNativeJS( 812): Warning: key missing',
    '10-26 18:20:02.400 E/ReactNativeJS( 812): TypeError: x is undefined',
    '10-26 18:20:02.400 E/ReactNativeJS( 812): Second error in the same millisecond',
    '10-26 18:20:02.500 D/OkHttp  ( 812): --> GET https://api.example/faq',
  ].join('\n')
  test('JS lines merged per entry (one timestamp), with their level; the rest is native', () => {
    const r = consoleEntries(log)
    expect(r.console.map(e => [e.time, e.level, e.text])).toEqual([
      ['18:20:01.100', 'log', 'Running "main"'],
      ['18:20:02.200', 'log', '{ items: \n   [ { a: 1 } ] }'],
      ['18:20:02.300', 'warn', 'Warning: key missing'],
      ['18:20:02.400', 'error', 'TypeError: x is undefined'],
      ['18:20:02.400', 'error', 'Second error in the same millisecond'],
    ])
    expect(r.console[1]!.values).toEqual([{ kind: 'object', entries: [['items', { kind: 'array', items: [{ kind: 'object', entries: [['a', { kind: 'number', text: '1' }]] }] }]] }])
    expect(r.console[0]!.values).toBeNull()
    expect(r.native).toEqual(['10-26 18:20:02.500 D/OkHttp  ( 812): --> GET https://api.example/faq'])
  })
})
