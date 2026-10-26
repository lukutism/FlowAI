/**
 * A desktop notification when a run starts needing you (a plan to approve, ready to ship, blocked, failed), so a
 * screen doesn't have to be watched. macOS: through osascript, the texts passed as arguments, never as script.
 */
import type { RunState } from './run.ts'

const WHAT: Record<string, string> = { plan: 'Plan to approve', ship: 'Ready to ship', pr: 'Draft PR to review', patch: 'Write-back to check', question: 'The agent asks', verify: 'Verify keeps failing', review: 'Review keeps finding', blocked: 'Blocked', setup: 'Setup failed', resolution: 'No change needed' }

/** what to say when a run went from before to after; null when nothing new needs you */
export function notice(before: RunState | undefined, after: RunState): { title: string; text: string } | null {
  if (!before || !after.needs) return null
  if (!['needs-you', 'blocked', 'failed'].includes(after.status)) return null
  if (before.needs?.kind === after.needs.kind && before.needs.ask === after.needs.ask && before.status === after.status) return null
  return { title: `flow · ${after.ticket} ${after.title}`.slice(0, 80), text: `${WHAT[after.needs.kind] ?? 'Needs you'}: ${after.needs.ask}`.slice(0, 200) }
}

export function show(n: { title: string; text: string }) {
  if (process.platform !== 'darwin') return
  try {
    Bun.spawn(['osascript', '-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', n.title, n.text], { stdout: 'ignore', stderr: 'ignore' })
  } catch {}
}
