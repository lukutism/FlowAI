#!/usr/bin/env bun
/**
 * The run's PreToolUse hook. The agent works inside its worktree and never publishes: commits, pushes, PRs and
 * ticket writes are flow's ship step, after verify and review. Everything else is the user's own permission setup.
 * Run as a hook: reads the hook input on stdin, FLOW_WORKTREE names the run's worktree.
 */
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

export interface HookInput { tool_name?: string; tool_input?: Record<string, unknown>; hook_event_name?: string }
export interface Decision { deny: true; reason: string }

const SHIP = 'flow ships the change itself after verify and review (commit, push, draft PR); keep your changes in the working tree'
const TRACKER = 'flow writes to the tracker and the code host itself; only read them'

/** quoted text is data (`echo "git push"`), not a command */
const unquote = (c: string) => c.replace(/'[^']*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""')
/** the simple commands in a shell line: split on ; && || | and newlines, subshells opened */
const segments = (c: string) => unquote(c).replace(/[()`]|\$\(/g, ' ; ').split(/;|&&|\|\||\||\n/).map(s => s.trim()).filter(Boolean)
/** leading VAR=x assignments, sudo, env, time, nohup */
const program = (s: string) => s.replace(/^(?:(?:\w+=\S*|sudo|env|time|nohup)\s+)*/, '')

const GIT_OPTS = String.raw`(?:\s+(?:-[cC]\s+\S+|--[\w-]+(?:=\S+)?|-\w+))*`
const GIT_PUBLISH = new RegExp(String.raw`^git${GIT_OPTS}\s+(push|commit|merge|rebase|worktree|cherry-pick|revert|am|filter-branch|filter-repo|update-ref|replace)\b`)
/** commands that also have read-only forms: only their writing forms (git remote -v, git tag -l stay allowed) */
const GIT_WRITE_FORM = new RegExp(String.raw`^git${GIT_OPTS}\s+(remote\s+(add|remove|rm|rename|set-url|set-head|set-branches|prune)\b|tag\s+(?!-l\b|--list\b|-n\b|--contains\b|--points-at\b)\S)`)
const GIT_DESTROY = new RegExp(String.raw`^git${GIT_OPTS}\s+(reset\b.*--hard|branch\b.*\s-[dD]\b|clean\b.*\s-\w*f)`)

const WRITE_METHOD = /(?:-X|--request|--method)\s*=?\s*['"]?(POST|PUT|PATCH|DELETE)\b/i
const TRACKER_HOST = /dev\.azure\.com|visualstudio\.com|api\.github\.com|github\.com\/[^/\s]+\/[^/\s]+\/(?:pulls|issues)|atlassian\.net|\/rest\/api\/\d/i

function trackerWrite(s: string): boolean {
  if (/^gh\s+(pr\s+(create|merge|close|edit|comment|review|ready|reopen)|issue\s+(create|comment|close|edit|reopen|delete)|release\s+(create|edit|delete|upload)|repo\s+(create|delete|edit|rename|archive)|label\s+(create|edit|delete))\b/.test(s)) return true
  if (/^gh\s+api\b/.test(s) && (WRITE_METHOD.test(s) || /\s-(f|F)\s|--(field|raw-field|input)\b/.test(s))) return true
  if (/^az\s+(repos|boards|pipelines|devops)\b/.test(s) && /\b(create|update|delete|set-vote|complete|abandon|add|remove|reactivate|run|queue)\b/.test(s)) return true
  if (/^(curl|http|wget)\b/.test(s) && TRACKER_HOST.test(s) && (WRITE_METHOD.test(s) || /\s(-d|--data[\w-]*|-F|--form|--json)\b/.test(s))) return true
  return false
}

function insideWorktree(file: string, worktree: string, allow: string[]): boolean {
  const p = resolve(worktree, file)
  const within = (dir: string) => { const d = resolve(dir); return p === d || p.startsWith(d + '/') }
  return within(worktree) || allow.some(within) || [tmpdir(), '/tmp', '/private/tmp'].some(within)
}

/** allow: other folders the agent may edit (the run folder: plan.md, pr.md) */
export function guard(input: HookInput, ctx: { worktree: string; allow?: string[] }): Decision | null {
  const tool = input.tool_name ?? '', args = input.tool_input ?? {}
  if (tool === 'Bash' && typeof args.command === 'string') {
    for (const seg of segments(args.command)) {
      const s = program(seg)
      if (GIT_PUBLISH.test(s) || GIT_WRITE_FORM.test(s) || GIT_DESTROY.test(s)) return { deny: true, reason: SHIP }
      if (trackerWrite(s)) return { deny: true, reason: TRACKER }
    }
    return null
  }
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool)) {
    const file = String(args.file_path ?? args.notebook_path ?? '')
    if (!file || !insideWorktree(file, ctx.worktree, ctx.allow ?? [])) return { deny: true, reason: `edit only inside this run's worktree (${ctx.worktree})` }
  }
  return null
}

if (import.meta.main) {
  const worktree = process.env.FLOW_WORKTREE
  let input: HookInput = {}
  try { input = JSON.parse(await Bun.stdin.text()) } catch {}
  // fail closed: a guard that can't tell where the run lives refuses edits and shell commands
  const d = worktree ? guard(input, { worktree, allow: (process.env.FLOW_ALLOW ?? '').split(':').filter(Boolean) }) : ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(input.tool_name ?? '') ? { deny: true, reason: 'flow guard: FLOW_WORKTREE is not set' } : null
  if (d) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `flow: ${d.reason}` } }))
}
