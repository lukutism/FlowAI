/**
 * The screen as text, from the running service (started if needed): for checking the UI without a terminal.
 *   bun scripts/ui-snapshot.tsx [--open [--pane <n>]] [--new <ticket>] [--keys 4,enter,j]   --open: the selected run's detail; --new: the new-run form for a ticket
 */
import { act } from 'react'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { testRender } from '@opentui/react/test-utils'
import { connect, startService } from '../src/daemon.ts'
import { App } from '../src/tui/app.tsx'

const DATA = process.env.FLOW_DATA ?? join(homedir(), '.local', 'share', 'flow')
const c = (await connect(DATA).catch(() => null)) ?? (await startService(DATA, join(import.meta.dir, '..', 'src', 'cli.tsx')))
const s = await testRender(<App api={c} onQuit={() => {}} />, { width: Number(process.env.COLUMNS ?? 140), height: Number(process.env.LINES ?? 30) })
const show = async (title: string) => { await act(async () => { await Bun.sleep(300) }); await s.renderOnce(); console.log(`--- ${title}\n${s.captureCharFrame().split('\n').filter(l => l.trim()).join('\n')}`) }
await show('runs')
if (process.argv.includes('--open')) { await act(async () => { s.mockInput.pressEnter() }); await show('detail') }
const pane = process.argv.indexOf('--pane')
if (pane > 0) { for (let i = 0; i < Number(process.argv[pane + 1] ?? 1); i++) await act(async () => { s.mockInput.pressKey(']') }); await act(async () => { await Bun.sleep(1500) }); await show('pane') }
const ks = process.argv.indexOf('--keys')
if (ks > 0) {
  for (const k of (process.argv[ks + 1] ?? '').split(',')) await act(async () => { k === 'enter' ? s.mockInput.pressEnter() : k === 'esc' ? s.mockInput.pressEscape() : s.mockInput.pressKey(k); await Bun.sleep(k === 'esc' ? 100 : 30) })
  await act(async () => { await Bun.sleep(Number(process.env.WAIT ?? 1500)) })
  await show('keys')
}
const nw = process.argv.indexOf('--new')
if (nw > 0) {
  await act(async () => { s.mockInput.pressKey('n') })
  for (const k of process.argv[nw + 1] ?? '') await act(async () => { s.mockInput.pressKey(k) })
  await act(async () => { await Bun.sleep(Number(process.env.WAIT ?? 4000)) })
  await show('new run')
}
s.renderer.destroy(); c.close(); process.exit(0)
