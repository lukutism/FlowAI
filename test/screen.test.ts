import { describe, expect, test } from 'bun:test'
import { inputArgs, parseInput } from '../src/screen.ts'

// A run's device in the browser: what the page sends is checked, then becomes one adb input command.
const android = { run: 'fso-1', platform: 'android' as const, id: 'emulator-5700', consolePort: 5700, metroPort: 8300, pids: [] }

describe('input from the web view', () => {
  test('taps, swipes and keys become adb input commands on the run\'s own emulator', () => {
    expect(inputArgs(android, { type: 'tap', x: 540.4, y: 1200 })).toEqual(['-s', 'emulator-5700', 'shell', 'input', 'tap', '540', '1200'])
    expect(inputArgs(android, { type: 'swipe', x1: 500, y1: 1800, x2: 500, y2: 400, ms: 250 })).toEqual(['-s', 'emulator-5700', 'shell', 'input', 'swipe', '500', '1800', '500', '400', '250'])
    expect(inputArgs(android, { type: 'key', key: 'back' })).toEqual(['-s', 'emulator-5700', 'shell', 'input', 'keyevent', 'KEYCODE_BACK'])
  })
  test('text is one quoted word for the device\'s shell: spaces and quotes stay text', () => {
    expect(inputArgs(android, { type: 'text', text: `it's a; rm -rf /` })).toEqual(['-s', 'emulator-5700', 'shell', 'input', 'text', `'it'\\''s%sa;%srm%s-rf%s/'`])
  })
  test('anything else is refused: unknown keys, bad numbers, other shapes', () => {
    expect(parseInput({ type: 'key', key: 'KEYCODE_POWER; reboot' })).toBeNull()
    expect(parseInput({ type: 'tap', x: 'a', y: 1 })).toBeNull()
    expect(parseInput({ type: 'tap', x: -1, y: 1 })).toBeNull()
    expect(parseInput({ type: 'exec', cmd: 'x' })).toBeNull()
    expect(parseInput({ type: 'text', text: 'x'.repeat(2000) })).toBeNull()
    expect(parseInput({ type: 'tap', x: 1, y: 2 })).toEqual({ type: 'tap', x: 1, y: 2 })
  })
  test('an iOS simulator is shown, not driven (simctl has no input)', () => {
    expect(inputArgs({ ...android, platform: 'ios', id: 'UDID' }, { type: 'tap', x: 1, y: 1 })).toBeNull()
  })
})

describe('the video stream', () => {
  test("stopping it ends flow's own screenrecord only, not other tools' recordings on the device", async () => {
    const { mkdtempSync, readFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { video } = await import('../src/screen.ts')
    const log = join(mkdtempSync(join(tmpdir(), 'flow-video-')), 'adb.log')
    process.env.FLOW_ADB = join(import.meta.dir, 'fake-adb.ts'); process.env.FAKE_ADB_LOG = log
    const stop = video({ run: 'r', platform: 'android', id: 'emulator-5700', consolePort: 5700, metroPort: 8300, pids: [] }, { width: 1080, height: 2400 }, () => {})
    await Bun.sleep(300)
    stop()
    await Bun.sleep(300)
    const calls = readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l) as string[])
    const kill = calls.find(c => c.includes('pkill'))!
    expect(kill).toContain('-f')
    expect(kill.join(' ')).toContain('screenrecord --output-format=h264 --size 540x1200')
  })
})
