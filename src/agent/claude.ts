import type { Subprocess } from 'bun'
import type { Agent } from './fake.ts'
import { parseLine, type AgentEvent } from './stream.ts'

export interface ClaudeOptions {
  /** the run's worktree */
  cwd: string
  /** the run's settings file (flow's hooks); added to the user's own settings, which all stay loaded */
  settings: string
  /** continue this session instead of starting a new one */
  resume?: string
  /** a model for this run; default: the user's own setting */
  model?: string
  /** how hard it thinks (low … max); default: the user's own setting */
  effort?: string
  /** plan: reads, never edits (the reviewer); default: the user's own permission mode */
  permissionMode?: string
  /** the run's brief, kept through compactions (unlike a message) */
  appendSystemPrompt?: string
  /** MCP servers added to the user's own (the run's flow tools) */
  mcpConfig?: string
  /** at most this many agentic turns per message (a reviewer's budget) */
  maxTurns?: number
  /** the CLI to run; tests pass a stand-in */
  bin?: string[]
  env?: Record<string, string>
}

/**
 * One `claude -p` process per run, on the user's subscription and full setup. Each turn writes one stream-json
 * message and reads events until its result. A message written while a turn runs can be lost by the CLI
 * (spike/FINDINGS.md), so a second turn is refused until the first has ended.
 */
export class ClaudeAgent implements Agent {
  private proc?: Subprocess<'pipe', 'pipe', 'pipe'>
  private lines?: AsyncIterator<string>
  private stderr = ''
  private busy = false

  constructor(private o: ClaudeOptions) {}

  async *turn(prompt: string): AsyncIterable<AgentEvent> {
    if (this.busy) throw new Error('a turn is still running: send the next message after its result')
    this.busy = true
    try {
      const proc = this.start()
      proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }) + '\n')
      await proc.stdin.flush()
      for (;;) {
        const next = await this.lines!.next()
        if (next.done) {
          const code = await proc.exited
          if (this.proc === proc) this.proc = undefined // the next turn starts a new process on the same session
          if (this.stopping) { this.stopping = false; throw new Error('the turn was stopped by you') }
          throw new Error(`claude exited with ${code} before the turn ended: ${this.stderr.trim().split('\n').slice(-3).join(' | ') || '(no stderr)'}`)
        }
        for (const e of parseLine(next.value)) {
          // the session to resume if this process ends (a crash, or closed to free its memory)
          if ((e.kind === 'session' || e.kind === 'result') && e.session) this.o = { ...this.o, resume: e.session }
          yield e
          if (e.kind === 'result') return
        }
      }
    } finally { this.busy = false }
  }

  /** the turn running now ended at once (the process killed); the next turn resumes the session */
  async stop() {
    const p = this.proc
    if (!p) return
    this.stopping = true
    p.kill()
    await p.exited
  }
  private stopping = false

  async close() {
    const p = this.proc
    if (!p) return
    this.proc = undefined
    try { p.stdin.end() } catch {}
    const done = await Promise.race([p.exited, Bun.sleep(5000).then(() => null)])
    if (done === null) p.kill()
  }

  private start() {
    if (this.proc) return this.proc
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-prompts', 'none', '--settings', this.o.settings, ...(this.o.resume ? ['--resume', this.o.resume] : []), ...(this.o.model ? ['--model', this.o.model] : []), ...(this.o.effort ? ['--effort', this.o.effort] : []), ...(this.o.permissionMode ? ['--permission-mode', this.o.permissionMode] : []), ...(this.o.appendSystemPrompt ? ['--append-system-prompt', this.o.appendSystemPrompt] : []), ...(this.o.mcpConfig ? ['--mcp-config', this.o.mcpConfig] : []), ...(this.o.maxTurns ? ['--max-turns', String(this.o.maxTurns)] : [])]
    const env: Record<string, string | undefined> = { ...process.env, ...this.o.env }
    delete env.CLAUDECODE // flow may itself run inside a Claude session; the agent is not nested in it
    const proc = Bun.spawn([...(this.o.bin ?? ['claude']), ...args], { cwd: this.o.cwd, env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
    this.proc = proc
    this.lines = readLines(proc.stdout)
    void (async () => { for await (const c of proc.stderr) this.stderr = (this.stderr + new TextDecoder().decode(c)).slice(-4000) })()
    return proc
  }
}

async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const dec = new TextDecoder()
  let buf = ''
  for await (const chunk of stream) {
    buf += dec.decode(chunk, { stream: true })
    let i: number
    while ((i = buf.indexOf('\n')) >= 0) { yield buf.slice(0, i); buf = buf.slice(i + 1) }
  }
  if (buf) yield buf
}
