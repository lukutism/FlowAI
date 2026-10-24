/**
 * Real check of a project's device commands: boot a run's own device and Metro, show what came up, then stop
 * and remove everything. --no-build skips prepare and install (the slow part).
 *   bun scripts/device-check.ts <project.json> <android|ios> <app worktree> [--no-build]
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { loadProject } from '../src/config.ts'
import { startDevice, stopDevice } from '../src/device.ts'

const [projectFile, platform, dir] = process.argv.slice(2)
if (!projectFile || (platform !== 'android' && platform !== 'ios') || !dir) throw new Error('bun scripts/device-check.ts <project.json> <android|ios> <app worktree> [--no-build]')
const spec = loadProject(projectFile).devices
if (!spec?.[platform]) throw new Error(`${projectFile} has no devices.${platform}`)
if (process.argv.includes('--no-build')) spec[platform] = { ...spec[platform]!, prepare: undefined, install: undefined }
const runDir = mkdtempSync(join(tmpdir(), 'flow-devcheck-'))
const t0 = Date.now()
const s = await startDevice({ spec, platform, run: 'check', runDir, worktree: resolve(dir) })
console.log(`up after ${Math.round((Date.now() - t0) / 1000)} s: ${s.platform} ${s.id}, console :${s.consolePort}, Metro :${s.metroPort}, pids ${s.pids.join(' ')} (logs in ${runDir})`)
console.log(`Metro: ${await (await fetch(`http://127.0.0.1:${s.metroPort}/status`)).text()}`)
await stopDevice(s, spec, runDir)
console.log('stopped and removed')
