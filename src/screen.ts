/**
 * A run's device in the browser: frames from the emulator or simulator (screenshots), and taps, swipes, keys and
 * text sent back through adb. With it the emulator can run without a window (devices.headless) and still be seen
 * and used. The iOS simulator is shown only: simctl has no input (serve-sim or baguette can add it).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DeviceState } from './device.ts'

export type Input =
  | { type: 'tap'; x: number; y: number }
  | { type: 'swipe'; x1: number; y1: number; x2: number; y2: number; ms: number }
  | { type: 'key'; key: Key }
  | { type: 'text'; text: string }

export const KEYS = { back: 'KEYCODE_BACK', home: 'KEYCODE_HOME', apps: 'KEYCODE_APP_SWITCH', enter: 'KEYCODE_ENTER', delete: 'KEYCODE_DEL', menu: 'KEYCODE_MENU', up: 'KEYCODE_DPAD_UP', down: 'KEYCODE_DPAD_DOWN', left: 'KEYCODE_DPAD_LEFT', right: 'KEYCODE_DPAD_RIGHT', tab: 'KEYCODE_TAB', escape: 'KEYCODE_ESCAPE' } as const
export type Key = keyof typeof KEYS

const coord = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 20_000
/** what the page sent, if it is one of the inputs (anything else is refused) */
export function parseInput(v: unknown): Input | null {
  const o = v as Record<string, unknown>
  if (!o || typeof o !== 'object') return null
  if (o.type === 'tap' && coord(o.x) && coord(o.y)) return { type: 'tap', x: o.x as number, y: o.y as number }
  if (o.type === 'swipe' && [o.x1, o.y1, o.x2, o.y2].every(coord) && typeof o.ms === 'number' && o.ms >= 0 && o.ms <= 5000)
    return { type: 'swipe', x1: o.x1 as number, y1: o.y1 as number, x2: o.x2 as number, y2: o.y2 as number, ms: o.ms }
  if (o.type === 'key' && typeof o.key === 'string' && Object.hasOwn(KEYS, o.key)) return { type: 'key', key: o.key as Key }
  if (o.type === 'text' && typeof o.text === 'string' && o.text.length > 0 && o.text.length <= 500) return { type: 'text', text: o.text }
  return null
}

/** adb's arguments for an input on the run's emulator; null where the device can't take input */
export function inputArgs(d: DeviceState, i: Input): string[] | null {
  if (d.platform !== 'android') return null
  const on = ['-s', d.id, 'shell', 'input']
  const n = (v: number) => String(Math.round(v))
  if (i.type === 'tap') return [...on, 'tap', n(i.x), n(i.y)]
  if (i.type === 'swipe') return [...on, 'swipe', n(i.x1), n(i.y1), n(i.x2), n(i.y2), n(i.ms)]
  if (i.type === 'key') return [...on, 'keyevent', KEYS[i.key]]
  // adb joins its arguments into a command for the device's shell: the text goes as one quoted word, spaces as %s
  return [...on, 'text', `'${i.text.replace(/ /g, '%s').replace(/'/g, `'\\''`)}'`]
}

export const adb = () => process.env.FLOW_ADB ?? join(process.env.ANDROID_HOME ?? join(process.env.HOME ?? '', 'Library/Android/sdk'), 'platform-tools/adb')

/** the device's screen now, as an image */
export async function frame(d: DeviceState): Promise<{ type: string; bytes: Uint8Array }> {
  if (d.platform === 'android') {
    const p = Bun.spawn([adb(), '-s', d.id, 'exec-out', 'screencap', '-p'], { stdout: 'pipe', stderr: 'pipe', env: process.env })
    const bytes = new Uint8Array(await new Response(p.stdout).arrayBuffer())
    if ((await p.exited) !== 0 || !bytes.length) throw new Error(`adb screencap failed: ${(await new Response(p.stderr).text()).trim()}`)
    return { type: 'image/png', bytes }
  }
  const dir = mkdtempSync(join(tmpdir(), 'flow-frame-'))
  try {
    const f = join(dir, 'frame.jpg')
    const p = Bun.spawn(['xcrun', 'simctl', 'io', d.id, 'screenshot', '--type=jpeg', f], { stdout: 'ignore', stderr: 'pipe' })
    if ((await p.exited) !== 0) throw new Error(`simctl screenshot failed: ${(await new Response(p.stderr).text()).trim()}`)
    return { type: 'image/jpeg', bytes: readFileSync(f) }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

export async function send(d: DeviceState, i: Input): Promise<void> {
  const args = inputArgs(d, i)
  if (!args) throw new Error('this device is shown, not driven, from the browser')
  const p = Bun.spawn([adb(), ...args], { stdout: 'ignore', stderr: 'pipe', env: process.env })
  if ((await p.exited) !== 0) throw new Error(`adb input failed: ${(await new Response(p.stderr).text()).trim()}`)
}

/** the emulator's screen size in pixels (what taps are given in) */
export async function deviceSize(d: DeviceState): Promise<{ width: number; height: number } | null> {
  if (d.platform !== 'android') return null
  const p = Bun.spawn([adb(), '-s', d.id, 'shell', 'wm', 'size'], { stdout: 'pipe', stderr: 'ignore', env: process.env })
  const out = await new Response(p.stdout).text()
  // an override (set by a test) wins over the physical size
  const m = /Override size: (\d+)x(\d+)/.exec(out) ?? /Physical size: (\d+)x(\d+)/.exec(out)
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null
}

/**
 * The emulator's screen as an H.264 stream from its own encoder (screenrecord), at half size; screenrecord stops
 * after three minutes, so it is started again until stop is called.
 */
export function video(d: DeviceState, size: { width: number; height: number }, onData: (chunk: Uint8Array) => void): () => void {
  let stopped = false, proc: Bun.Subprocess | undefined
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2)
  const w = even(size.width / 2), h = even(size.height / 2)
  void (async () => {
    while (!stopped) {
      proc = Bun.spawn([adb(), '-s', d.id, 'exec-out', 'screenrecord', '--output-format=h264', '--size', `${w}x${h}`, '--bit-rate', '4000000', '--time-limit', '180', '-'], { stdout: 'pipe', stderr: 'ignore', env: process.env })
      for await (const c of proc.stdout as ReadableStream<Uint8Array>) { if (stopped) break; onData(c) }
      await proc.exited
      if (!stopped) await Bun.sleep(200)
    }
  })()
  viewers.set(d.id, (viewers.get(d.id) ?? 0) + 1)
  return () => {
    if (stopped) return
    stopped = true
    try { proc?.kill() } catch {}
    // the encoder on the device outlives adb when the screen is still; the last viewer of a device stops it
    const left = (viewers.get(d.id) ?? 1) - 1
    viewers.set(d.id, left)
    if (!left) Bun.spawn([adb(), '-s', d.id, 'shell', 'pkill', '-INT', 'screenrecord'], { stdout: 'ignore', stderr: 'ignore', env: process.env })
  }
}
const viewers = new Map<string, number>()

/** the emulators adb sees (ids such as emulator-5554), whoever started them */
export async function emulators(): Promise<string[]> {
  const p = Bun.spawn([adb(), 'devices'], { stdout: 'pipe', stderr: 'ignore', env: process.env })
  const out = await new Response(p.stdout).text()
  await p.exited
  return out.split('\n').map(l => l.trim().split(/\s+/)).filter(x => x[1] === 'device' && /^emulator-\d+$/.test(x[0]!)).map(x => x[0]!)
}

/** the app's log on the device: the JS console (React Native) and errors; all: every line */
export async function appLog(d: DeviceState, all = false, lines = 300): Promise<string[]> {
  const argv = d.platform === 'android'
    ? [adb(), '-s', d.id, 'logcat', '-d', '-t', String(lines), '-v', 'time', ...(all ? [] : ['ReactNativeJS:V', 'ReactNative:W', 'AndroidRuntime:E', '*:E'])]
    : ['xcrun', 'simctl', 'spawn', d.id, 'log', 'show', '--last', '5m', '--style', 'compact', ...(all ? [] : ['--predicate', 'subsystem == "com.facebook.react.log" OR messageType == error'])]
  const p = Bun.spawn(argv, { stdout: 'pipe', stderr: 'ignore', env: process.env })
  const out = await new Response(p.stdout).text()
  await p.exited
  return out.split('\n').filter(Boolean).slice(-lines)
}
