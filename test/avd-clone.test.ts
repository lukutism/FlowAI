import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The Android device commands' helper: a run's own AVD cloned from a template, and removed again.
const SCRIPT = join(import.meta.dir, '..', 'scripts', 'avd-clone.sh')
const sh = (home: string, ...a: string[]) => Bun.spawnSync([SCRIPT, ...a], { env: { ...process.env, ANDROID_AVD_HOME: home } })

function home() {
  const h = mkdtempSync(join(tmpdir(), 'flow-avd-'))
  mkdirSync(join(h, 'Pixel.avd', 'hardware-qemu.ini.lock'), { recursive: true })
  writeFileSync(join(h, 'Pixel.avd', 'config.ini'), 'AvdId=Pixel\navd.ini.displayname=Pixel\nhw.gpu.mode=auto\nhw.ramSize=4096\n')
  writeFileSync(join(h, 'Pixel.avd', 'userdata.img'), 'data')
  writeFileSync(join(h, 'Pixel.avd', 'emu-launch-params.txt'), '-avd Pixel')
  writeFileSync(join(h, 'Pixel.ini'), `avd.ini.encoding=UTF-8\npath=${h}/Pixel.avd\npath.rel=avd/Pixel.avd\ntarget=android-34\n`)
  return h
}

describe('avd-clone.sh', () => {
  test('a clone under the new name: same images, its own id, GPU rendering, no locks or last launch', () => {
    const h = home()
    expect(sh(h, 'Pixel', 'flow-fso-1').exitCode).toBe(0)
    expect(readFileSync(join(h, 'flow-fso-1.avd', 'userdata.img'), 'utf8')).toBe('data')
    const cfg = readFileSync(join(h, 'flow-fso-1.avd', 'config.ini'), 'utf8')
    expect(cfg).toContain('AvdId=flow-fso-1\n')
    expect(cfg).toContain('avd.ini.displayname=flow-fso-1\n')
    expect(cfg).toContain('hw.gpu.mode=host\n')
    expect(cfg).toContain('hw.ramSize=4096\n')
    expect(cfg).not.toContain('AvdId=Pixel')
    expect(existsSync(join(h, 'flow-fso-1.avd', 'hardware-qemu.ini.lock'))).toBe(false)
    expect(existsSync(join(h, 'flow-fso-1.avd', 'emu-launch-params.txt'))).toBe(false)
    expect(readFileSync(join(h, 'flow-fso-1.ini'), 'utf8')).toBe(`avd.ini.encoding=UTF-8\npath=${h}/flow-fso-1.avd\npath.rel=avd/flow-fso-1.avd\ntarget=android-34\n`)
    expect(existsSync(join(h, 'Pixel.avd', 'hardware-qemu.ini.lock'))).toBe(true)
  })
  test('--remove deletes the clone and leaves the template', () => {
    const h = home()
    sh(h, 'Pixel', 'flow-fso-2')
    expect(sh(h, '--remove', 'flow-fso-2').exitCode).toBe(0)
    expect(existsSync(join(h, 'flow-fso-2.avd')) || existsSync(join(h, 'flow-fso-2.ini'))).toBe(false)
    expect(existsSync(join(h, 'Pixel.avd'))).toBe(true)
  })
  test('an unknown template is refused, naming it', () => {
    const r = sh(home(), 'Nope', 'flow-x')
    expect(r.exitCode).toBe(1)
    expect(r.stderr.toString()).toContain('no AVD Nope')
  })
})

describe('android-dev-host.sh', () => {
  test('writes debug_http_host for the app (the emulator\'s alias for the Mac, the run\'s Metro port), then starts it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flow-adb-')), log = join(dir, 'log')
    writeFileSync(join(dir, 'adb'), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${log}\n`, { mode: 0o755 })
    const r = Bun.spawnSync([join(import.meta.dir, '..', 'scripts', 'android-dev-host.sh'), 'emulator-5700', 'com.example.app', '8301'], { env: { ...process.env, ADB: join(dir, 'adb') } })
    expect(r.exitCode).toBe(0)
    const calls = readFileSync(log, 'utf8').trim().split('\n')
    expect(calls[0]).toBe('-s emulator-5700 shell am force-stop com.example.app')
    expect(calls[1]).toBe(`-s emulator-5700 shell run-as com.example.app sh -c 'mkdir -p shared_prefs && echo "<map><string name=\\"debug_http_host\\">10.0.2.2:8301</string></map>" > shared_prefs/com.example.app_preferences.xml'`)
    expect(calls[2]).toBe('-s emulator-5700 shell monkey -p com.example.app -c android.intent.category.LAUNCHER 1')
  })
})
