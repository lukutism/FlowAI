#!/usr/bin/env bun
/**
 * The run's PreToolUse hook. The agent works inside its worktree and never publishes: commits, pushes, PRs and
 * ticket writes are flow's ship step, after verify and review. Everything else is the user's own permission setup.
 * Run as a hook: reads the hook input on stdin, FLOW_WORKTREE names the run's worktree.
 * It is a second line behind Claude Code's OS sandbox, not a sandbox itself: it reads shell lines the way the shell
 * does (quotes, substitutions, wrappers like env or timeout, bash -c) so a plain or lightly disguised publish is caught.
 */
import { lstatSync, readlinkSync, realpathSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

export interface HookInput { tool_name?: string; tool_input?: Record<string, unknown>; hook_event_name?: string }
export interface Decision { deny: true; reason: string }

const SHIP = 'flow ships the change itself after verify and review (commit, push, draft PR); keep your changes in the working tree'
const TRACKER = 'flow writes to the tracker and the code host itself; only read them'
const SECRET = 'flow\'s own files (its token) are not for the agent'

/** $'…' (ANSI-C quoting) from i, just after the quote: its text with the escapes decoded, and the index after it */
function ansiC(line: string, i: number): [string, number] {
  let out = '', j = i
  for (; j < line.length && line[j] !== "'"; j++) {
    if (line[j] !== '\\') { out += line[j]; continue }
    const n = line[++j] ?? ''
    const hex = n === 'x' ? /^[0-9a-fA-F]{1,2}/.exec(line.slice(j + 1)) : n === 'u' || n === 'U' ? /^[0-9a-fA-F]{1,8}/.exec(line.slice(j + 1)) : null
    const oct = /^[0-7]{1,3}/.exec(line.slice(j))
    if (hex) { out += String.fromCodePoint(parseInt(hex[0], 16)); j += hex[0].length }
    else if (oct && n !== '') { out += String.fromCharCode(parseInt(oct[0], 8)); j += oct[0].length - 1 }
    else out += ({ n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v' } as Record<string, string>)[n] ?? n
  }
  return [out, j + 1]
}

/** a shell line as simple commands, each its words with the quotes taken off; command substitutions come out as
 * commands of their own, since they run too (also inside double quotes) */
export function commands(line: string): string[][] {
  const out: string[][] = []
  let words: string[] = [], word = '', inWord = false, skip = false
  // here-documents waiting for the end of their line: their text is the program's input
  let docs: { delim: string; strip: boolean; prog: string }[] = []
  // the word after a redirection is its file, not part of the command
  const endWord = () => { if (inWord) { if (skip) skip = false; else words.push(word) } word = ''; inWord = false }
  const endCmd = () => { endWord(); if (words.length) out.push(words); words = [] }
  /** the text of $( ... ) from i (just after the parenthesis), and the index after its closing one */
  const paren = (i: number): [string, number] => {
    let depth = 1, j = i, q = ''
    for (; j < line.length; j++) {
      const c = line[j]!
      if (q) { if (c === q) q = ''; else if (c === '\\' && q === '"') j++; continue }
      if (c === "'" || c === '"') q = c
      else if (c === '\\') j++
      else if (c === '(') depth++
      else if (c === ')' && --depth === 0) break
    }
    return [line.slice(i, j), j + 1]
  }
  const tick = (i: number): [string, number] => { const j = line.indexOf('`', i); const e = j < 0 ? line.length : j; return [line.slice(i, e), e + 1] }
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!
    if (c === '\\') { if (line[i + 1] !== '\n') { word += line[i + 1] ?? ''; inWord = true } i++; continue }
    if (c === "'") { const j = line.indexOf("'", i + 1); const e = j < 0 ? line.length : j; word += line.slice(i + 1, e); inWord = true; i = e; continue }
    if (c === '"') {
      let j = i + 1
      while (j < line.length && line[j] !== '"') {
        if (line[j] === '\\') { word += line[j + 1] ?? ''; j += 2; continue }
        if (line[j] === '$' && line[j + 1] === '(') { const [inner, k] = paren(j + 2); out.push(...commands(inner)); word += '$()'; j = k; continue }
        if (line[j] === '`') { const [inner, k] = tick(j + 1); out.push(...commands(inner)); j = k; continue }
        word += line[j++]!
      }
      inWord = true; i = j; continue
    }
    if (c === '$' && line[i + 1] === "'") { const [text, k] = ansiC(line, i + 2); word += text; inWord = true; i = k - 1; continue }
    if (c === '$' && line[i + 1] === '"') continue // $"…" is a double-quoted word
    if (c === '$' && line[i + 1] === '{') {
      // ${…} is part of the word (${#a} is no comment, ${D} no group)
      let depth = 0, j = i + 1
      for (; j < line.length; j++) { if (line[j] === '{') depth++; else if (line[j] === '}' && --depth === 0) break }
      word += line.slice(i, j + 1); inWord = true; i = j; continue
    }
    if ((c === '<' || c === '>') && line[i + 1] === '(') { const [inner, k] = paren(i + 2); out.push(...commands(inner)); word += '<()'; inWord = true; i = k - 1; continue }
    if (c === '>' || c === '<' || (c === '&' && line[i + 1] === '>')) {
      // a redirection: its file descriptor before it and its file after it are not the command's words
      if (inWord && /^\d+$/.test(word)) { word = ''; inWord = false } else endWord()
      let j = i
      while (j < line.length && '<>&'.includes(line[j]!)) j++
      const op = line.slice(i, j)
      if (op === '<<' || op === '<<-') {
        let k = j, delim = ''
        while (line[k] === ' ' || line[k] === '\t') k++
        for (; k < line.length && !/[\s;&|<>()]/.test(line[k]!); k++) if (!`'"\\`.includes(line[k]!)) delim += line[k]
        docs.push({ delim, strip: op === '<<-', prog: basename(words.find(x => !/^\w+=/.test(x)) ?? '') })
        i = k - 1; continue
      }
      if (/&$/.test(op) && /[\d-]/.test(line[j] ?? '')) { while (/[\d-]/.test(line[j] ?? '')) j++ } else skip = true
      i = j - 1; continue
    }
    if (c === '$' && line[i + 1] === '(') { const [inner, k] = paren(i + 2); out.push(...commands(inner)); word += '$()'; inWord = true; i = k - 1; continue }
    if (c === '`') { const [inner, k] = tick(i + 1); out.push(...commands(inner)); i = k - 1; continue }
    if (c === '#' && !inWord) { const j = line.indexOf('\n', i); i = j < 0 ? line.length : j - 1; continue }
    if (c === '\n' && docs.length) {
      // the here-documents' text follows this line: a shell's or an interpreter's is code, anything else's data
      endCmd()
      let pos = i + 1
      for (const d of docs) {
        const body: string[] = []
        while (pos <= line.length) {
          const e = line.indexOf('\n', pos), ln = line.slice(pos, e < 0 ? line.length : e)
          pos = e < 0 ? line.length + 1 : e + 1
          if ((d.strip ? ln.replace(/^\t+/, '') : ln) === d.delim) break
          body.push(ln)
        }
        if (SHELLS.has(d.prog)) out.push(...commands(body.join('\n')))
        else if (INTERPRETERS.has(d.prog.replace(/\d+(\.\d+)?$/, ''))) out.push([d.prog, '-c', body.join('\n')])
      }
      docs = []
      i = pos - 1; continue
    }
    if (';&|\n()'.includes(c)) { endCmd(); continue }
    if (/\s/.test(c)) { endWord(); continue }
    word += c; inWord = true
  }
  endCmd()
  return out
}

/** wrappers that run the command after them, with how many of their own words to skip */
const KEYWORDS = new Set(['if', 'then', 'elif', 'else', 'fi', 'do', 'done', 'while', 'until', 'case', 'esac', 'select', '!', '{', '}', '[[', ']]'])
function unwrap(w: string[]): string[] {
  for (;;) {
    while (w.length && (/^\w+=/.test(w[0]!) || KEYWORDS.has(w[0]!))) w = w.slice(1)
    if (!w.length) return w
    const p = basename(w[0]!)
    let i = 1
    const opts = (withArg: string[] = []) => { while (i < w.length && w[i]!.startsWith('-')) i += withArg.includes(w[i]!) ? 2 : 1 }
    if (['sudo', 'nohup', 'command', 'exec', 'builtin', 'time', 'caffeinate', 'stdbuf'].includes(p)) opts(['-u', '-g', '-w'])
    else if (p === 'env') {
      // env -S 'a command line': its words are the command
      const k = w.findIndex(x => x === '-S' || x === '--split-string')
      if (k > 0 && w[k + 1] !== undefined) { w = [...(commands(w[k + 1]!)[0] ?? []), ...w.slice(k + 2)]; continue }
      opts(['-u', '-C']); while (i < w.length && /^\w+=/.test(w[i]!)) i++
    }
    else if (p === 'nice') opts(['-n'])
    else if (p === 'timeout') { opts(['-s', '-k', '--signal', '--kill-after']); i++ }
    else if (p === 'xargs') opts(['-n', '-I', '-P', '-L', '-s', '-d', '-E', '-a'])
    else return [p, ...w.slice(1)]
    w = w.slice(i)
  }
}

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish'])
const INTERPRETERS = new Set(['node', 'bun', 'deno', 'python', 'python3', 'perl', 'ruby', 'osascript'])
/** what a script in another language would have to say to publish: loose on purpose, it can't be parsed */
const SCRIPT_PUBLISH = /\bgit\b\W{1,6}(?:-\w+\W{1,6}\S+\W{1,6})*(push|commit|merge|rebase|pull|cherry-pick|am|revert|filter-branch|filter-repo|update-ref|tag|worktree)\b/

const GIT_PUBLISH = new Set(['push', 'commit', 'merge', 'pull', 'rebase', 'worktree', 'cherry-pick', 'revert', 'am', 'filter-branch', 'filter-repo', 'update-ref', 'replace', 'commit-tree', 'fast-import', 'send-pack', 'http-push'])
const GIT_OPT_ARG = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix', '--config-env', '--list-cmds'])
const TAG_READ = /^(-l|--list|-n\d*|--contains|--no-contains|--points-at|--merged|--no-merged|--sort(=.*)?|--format(=.*)?|-v|--verify|--column|--no-column|-i|--ignore-case)$/

/** a git command (its words after `git`) that publishes, rewrites history, moves a branch or changes git's config */
function gitWrites(w: string[]): boolean {
  let i = 0
  const config: string[] = []
  while (i < w.length && w[i]!.startsWith('-')) {
    const o = w[i]!
    if (o === '-c' || o === '--config-env') config.push(w[i + 1] ?? '')
    if (o.startsWith('--config-env=')) config.push(o.slice(13))
    i += GIT_OPT_ARG.has(o) ? 2 : 1
  }
  if (config.some(c => /^(alias\.|include)/i.test(c))) return true
  const sub = w[i] ?? '', args = w.slice(i + 1)
  const has = (...f: string[]) => args.some(a => f.includes(a))
  const positional = args.filter(a => !a.startsWith('-'))
  if (has('--help', '-h')) return false
  // listing worktrees, and giving up a merge, rebase or cherry-pick (back to how it was), change nothing of flow's
  if (sub === 'worktree' && args[0] === 'list') return false
  if (/^(merge|rebase|cherry-pick|revert|am)$/.test(sub) && args.length && args.every(a => a === '--abort' || a === '--quit')) return false
  if (GIT_PUBLISH.has(sub)) return true
  switch (sub) {
    case 'remote': return /^(add|remove|rm|rename|set-url|set-head|set-branches|prune|update)$/.test(args[0] ?? '')
    case 'tag': return args.length > 0 && !TAG_READ.test(args[0]!)
    // a reset that moves the branch (to another commit, or any mode) is flow's; unstaging files is not
    case 'reset': {
      if (has('--hard', '--keep', '--merge', '--soft', '--mixed')) return true
      const dd = args.indexOf('--'), before = (dd < 0 ? args : args.slice(0, dd)).filter(a => !a.startsWith('-'))
      return before.some(a => a !== 'HEAD' && (/[~^@]/.test(a) || /^[0-9a-f]{7,40}$/.test(a) || /^(origin|upstream)\//.test(a) || /^(refs|heads)\//.test(a)))
    }
    case 'clean': return args.some(a => /^-\w*f/.test(a)) || has('--force')
    case 'branch': return has('-d', '-D', '--delete', '-f', '--force', '-m', '-M', '--move', '-u', '--set-upstream-to', '--unset-upstream') || args.some(a => /^-\w*[dDfmM]/.test(a) || a.startsWith('--set-upstream-to='))
    case 'checkout': return has('-B')
    case 'switch': return has('-C', '--force-create')
    case 'symbolic-ref': return has('-d', '--delete') || positional.length >= 2
    case 'notes': return /^(add|append|copy|edit|merge|prune|remove)$/.test(args[0] ?? '')
    case 'config': {
      if (/^(set|unset|edit|rename-section|remove-section)$/.test(args[0] ?? '')) return true
      if (/^(get|list)$/.test(args[0] ?? '') || has('--get', '--get-all', '--get-regexp', '--get-urlmatch', '--list', '-l', '--get-color', '--get-colorbool')) return false
      if (has('--unset', '--unset-all', '--add', '--replace-all', '--edit', '-e', '--rename-section', '--remove-section')) return true
      const valued = new Set(['--file', '-f', '--blob', '--type', '--default', '--comment'])
      return args.filter((a, k) => !a.startsWith('-') && !valued.has(args[k - 1] ?? '')).length >= 2
    }
  }
  return false
}

const WRITE_METHOD = /(?:-X|--request|--method)\s*=?\s*['"]?(POST|PUT|PATCH|DELETE)\b/i
const TRACKER_HOST = /dev\.azure\.com|visualstudio\.com|api\.github\.com|github\.com\/[^/\s]+\/[^/\s]+\/(?:pulls|issues)|atlassian\.net|\/rest\/api\/\d/i

function trackerWrite(s: string): boolean {
  if (/ (--help|-h)\b/.test(s)) return false
  if (/^gh (pr (create|merge|close|edit|comment|review|ready|reopen)|issue (create|comment|close|edit|reopen|delete|transfer|pin|lock)|release (create|edit|delete|upload)|repo (create|delete|edit|rename|archive|sync|fork)|label (create|edit|delete|clone)|workflow (run|enable|disable)|run (rerun|cancel|delete)|secret (set|delete)|variable (set|delete)|gist (create|edit|delete)|cache delete)\b/.test(s)) return true
  if (/^gh api\b/.test(s)) {
    if (WRITE_METHOD.test(s)) return true
    // fields make it a POST, unless it says GET or it is a GraphQL query (not a mutation)
    const fields = / -(f|F) |--(field|raw-field|input)\b/.test(s)
    const get = /(?:-X|--method)[ =]GET\b/i.test(s), graphql = /^gh api graphql\b/.test(s)
    if (fields && !get && (!graphql || /\bmutation\b/.test(s))) return true
  }
  if (/^az (repos|boards|pipelines|devops)\b/.test(s) && /\b(create|update|delete|set-vote|complete|abandon|add|remove|reactivate|run|queue)\b/.test(s)) return true
  if (/^az rest\b/.test(s) && (/ (--method|-m)[ =](?!get\b)\w/i.test(s) || / (--body|-b)[ =]/.test(s))) return true
  if (/^az devops invoke\b/.test(s) && / --http-method[ =](?!get\b)\w/i.test(s)) return true
  if (/^(curl|http|wget)\b/.test(s) && TRACKER_HOST.test(s) && (WRITE_METHOD.test(s) || / (-[a-zA-Z]*[dFT]|--data[\w-]*|--form|--json|--upload-file|--post-data|--post-file|--body-data|--body-file|--method)\b/.test(s))) return true
  return false
}

function check(line: string, depth = 0): Decision | null {
  if (depth > 4) return { deny: true, reason: 'too many nested shells to check' }
  // a shell reading its commands from a pipe: what it runs can't be seen here
  if (/\|\s*(?:\S*\/)?(?:sudo\s+)?(?:ba|z|da|k|fi)?sh\b(?!\s+-\w*c)(?:\s+-[a-zA-Z]+)*\s*(?:$|[;&|)\n])/.test(line)) return { deny: true, reason: "a shell reading commands from a pipe can't be checked: run the commands themselves" }
  for (const words of commands(line)) {
    const d = checkWords(words, depth)
    if (d) return d
  }
  return null
}

function checkWords(words: string[], depth: number): Decision | null {
  const w = unwrap(words)
  if (!w.length) return null
  // find -exec runs a command of its own for each file
  if (w[0] === 'find') {
    const k = w.findIndex(a => /^-(exec|execdir|ok|okdir)$/.test(a))
    if (k >= 0) { const d = checkWords(w.slice(k + 1).filter(a => a !== '{}' && a !== '+'), depth + 1); if (d) return d }
  }
  const [p = '', ...rest] = w
  if (p === 'git' && gitWrites(rest)) return { deny: true, reason: SHIP }
  if (trackerWrite(w.join(' '))) return { deny: true, reason: TRACKER }
  if (p === 'eval') { const d = check(rest.join(' '), depth + 1); if (d) return d }
  if (SHELLS.has(p)) {
    const k = rest.findIndex(a => /^-\w*c\w*$/.test(a))
    const payload = k >= 0 ? rest[k + 1] : undefined
    if (payload !== undefined) { const d = check(payload, depth + 1); if (d) return d }
  }
  if (INTERPRETERS.has(p.replace(/\d+(\.\d+)?$/, '')) || INTERPRETERS.has(p)) {
    const k = rest.findIndex(a => /^(-e|-c|-p|--eval|--print|-pe|-ne)$/.test(a))
    if (k >= 0 && SCRIPT_PUBLISH.test(rest[k + 1] ?? '')) return { deny: true, reason: SHIP }
  }
  return null
}

/** the real path: symlinks resolved as far as the path exists, the rest as written */
function real(p: string, depth = 0): string {
  let head = p, tail = ''
  for (;;) {
    try { return tail ? join(realpathSync(head), tail) : realpathSync(head) } catch {}
    // a symlink whose target doesn't exist yet: a write would create the target, so the target is what counts
    try { if (depth < 20 && lstatSync(head).isSymbolicLink()) return real(tail ? join(resolve(dirname(head), readlinkSync(head)), tail) : resolve(dirname(head), readlinkSync(head)), depth + 1) } catch {}
    const up = dirname(head)
    if (up === head) return p
    tail = tail ? join(basename(head), tail) : basename(head)
    head = up
  }
}

/** git's own files and Claude Code's settings: writing them would run code outside the sandbox later */
const PROTECTED = /(^|\/)\.git(\/|$)|(^|\/)\.claude\/settings(\.local)?\.json$/i

function insideWorktree(file: string, worktree: string, allow: string[]): boolean {
  const p = real(resolve(worktree, file))
  const within = (dir: string) => { const d = real(resolve(dir)); return p === d || p.startsWith(d + '/') }
  return within(worktree) || allow.some(within) || [tmpdir(), '/tmp', '/private/tmp'].some(within)
}

/** the ways a shell line could name a file: as written, with ~ and with $HOME */
const spellings = (f: string) => {
  const h = homedir()
  return f.startsWith(h + '/') ? [f, '~' + f.slice(h.length), '$HOME' + f.slice(h.length), '${HOME}' + f.slice(h.length)] : [f]
}

/**
 * allow: other folders or files the agent may edit (the run's plan.md and pr.md).
 * deny: files no shell command may name (flow's token); reading them with Read or Grep is closed by the settings.
 */
export function guard(input: HookInput, ctx: { worktree: string; allow?: string[]; deny?: string[] }): Decision | null {
  const tool = input.tool_name ?? '', args = input.tool_input ?? {}
  if (tool === 'Bash' && typeof args.command === 'string') {
    if ((ctx.deny ?? []).flatMap(spellings).some(f => (args.command as string).includes(f))) return { deny: true, reason: SECRET }
    return check(args.command)
  }
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool)) {
    const file = String(args.file_path ?? args.notebook_path ?? '')
    if (!file || !insideWorktree(file, ctx.worktree, ctx.allow ?? [])) return { deny: true, reason: `edit only inside this run's worktree (${ctx.worktree})` }
    if (PROTECTED.test(real(resolve(ctx.worktree, file)))) return { deny: true, reason: 'git\'s own files and Claude Code\'s settings are not the change; leave them as they are' }
  }
  return null
}

if (import.meta.main) {
  const list = (v?: string) => (v ?? '').split(':').filter(Boolean)
  let d: Decision | null
  // fail closed: a guard that can't read its input or doesn't know where the run lives refuses (the hook only runs
  // for the tools it guards)
  try {
    const input = JSON.parse(await Bun.stdin.text()) as HookInput
    const worktree = process.env.FLOW_WORKTREE
    d = worktree ? guard(input, { worktree, allow: list(process.env.FLOW_ALLOW), deny: list(process.env.FLOW_DENY) }) : { deny: true, reason: 'flow guard: FLOW_WORKTREE is not set' }
  } catch (e) { d = { deny: true, reason: `flow guard failed: ${e instanceof Error ? e.message : e}` } }
  if (d) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `flow: ${d.reason}` } }))
}
