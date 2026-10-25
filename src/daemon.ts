import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FlowClient } from './client.ts'

/** Where the background service tells clients how to reach it: its port and pid, and a token only the user can read. */
export const serviceFile = (data: string) => join(data, 'service.json')

export function token(data: string): string {
  const f = join(data, 'token')
  if (!existsSync(f)) {
    mkdirSync(data, { recursive: true })
    writeFileSync(f, randomBytes(24).toString('hex'), { mode: 0o600 })
  }
  chmodSync(f, 0o600)
  return readFileSync(f, 'utf8').trim()
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

/** the running service's address, or null (a file left by a dead process is cleaned up) */
export function running(data: string): { port: number; pid: number } | null {
  const f = serviceFile(data)
  if (!existsSync(f)) return null
  const s = JSON.parse(readFileSync(f, 'utf8')) as { port: number; pid: number }
  if (alive(s.pid)) return s
  rmSync(f, { force: true })
  return null
}

/**
 * One service per data folder: two writing the same event log could record an impossible history. The lock file
 * names the holder; one left by a dead process is taken over.
 */
export function lock(data: string): boolean {
  const f = join(data, 'serve.lock')
  mkdirSync(data, { recursive: true })
  for (let i = 0; i < 2; i++) {
    try { writeFileSync(f, String(process.pid), { flag: 'wx' }); return true } catch {}
    const pid = Number(readFileSync(f, 'utf8'))
    if (pid !== process.pid && alive(pid)) return false
    rmSync(f, { force: true })
  }
  return false
}
export const unlock = (data: string) => rmSync(join(data, 'serve.lock'), { force: true })

export const announce = (data: string, port: number) => writeFileSync(serviceFile(data), JSON.stringify({ port, pid: process.pid }) + '\n')
export const withdraw = (data: string) => rmSync(serviceFile(data), { force: true })

/**
 * cli: when the connection drops, where the service is now (it may have restarted on another port); with no
 * service running at all, one is started again (the serve lock keeps it to one).
 */
export async function connect(data: string, cli?: string): Promise<FlowClient | null> {
  const s = running(data)
  if (!s) return null
  let startedAt = 0
  const again = async () => {
    const now = running(data)
    if (now) return { url: `ws://127.0.0.1:${now.port}`, token: token(data) }
    if (cli && Date.now() - startedAt > 15_000) { startedAt = Date.now(); spawnService(data, cli) }
    return null
  }
  return FlowClient.connect(`ws://127.0.0.1:${s.port}`, token(data), again)
}

function spawnService(data: string, cli: string) {
  mkdirSync(data, { recursive: true })
  const log = openSync(join(data, 'service.log'), 'a')
  Bun.spawn([process.execPath, cli, 'serve'], { stdio: ['ignore', log, log], env: process.env }).unref()
}

/** start `flow serve` in the background (its output in service.log) and wait until it answers */
export async function startService(data: string, cli: string): Promise<FlowClient> {
  spawnService(data, cli)
  for (let i = 0; i < 100; i++) {
    await Bun.sleep(100)
    const c = await connect(data, cli).catch(() => null)
    if (c) return c
  }
  throw new Error(`the flow service did not start; see ${join(data, 'service.log')}`)
}
