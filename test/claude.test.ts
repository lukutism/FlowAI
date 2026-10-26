import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeAgent } from '../src/agent/claude.ts'
import type { AgentEvent } from '../src/agent/stream.ts'

const FAKE = join(import.meta.dir, 'fake-claude.ts')
const fx = (n: string) => join(import.meta.dir, 'fixtures', `${n}.jsonl`)
const agents: ClaudeAgent[] = []
afterEach(async () => { for (const a of agents.splice(0)) await a.close() })

function agent(turns: string[], extra: Partial<ConstructorParameters<typeof ClaudeAgent>[0]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'flow-claude-')), logFile = join(dir, 'log.jsonl')
  const a = new ClaudeAgent({ cwd: dir, settings: join(dir, 'settings.json'), bin: [process.execPath, FAKE], env: { FAKE_TURNS: turns.map(fx).join(','), FAKE_LOG: logFile }, ...extra })
  agents.push(a)
  const log = () => readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
  return { a, log, dir }
}
const all = async (it: AsyncIterable<AgentEvent>) => { const out: AgentEvent[] = []; for await (const e of it) out.push(e); return out }

describe('ClaudeAgent: one claude process per run, one message per turn', () => {
  test('a turn ends at its result; the next turn goes to the same process', async () => {
    const { a, log } = agent(['01-turn-tool', '02-resume'])
    const t1 = await all(a.turn('plan the fix'))
    expect(t1.at(-1)).toMatchObject({ kind: 'result', ok: true, text: '1' })
    const t2 = await all(a.turn('what did you answer?'))
    expect(t2.at(-1)).toMatchObject({ kind: 'result' })
    const l = log()
    expect(l.filter(x => x.argv).length).toBe(1) // one process
    expect(l.filter(x => x.prompt).map(x => x.prompt)).toEqual(['plan the fix', 'what did you answer?'])
  })
  test('runs on the subscription in stream mode, never prompts, with the run\'s settings; CLAUDECODE is not passed on', async () => {
    const { a, log, dir } = agent(['01-turn-tool'])
    await all(a.turn('x'))
    const { argv, claudecode, cwd } = log()[0]
    expect(argv).toEqual(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-prompts', 'none', '--settings', join(dir, 'settings.json')])
    expect(argv).not.toContain('--bare')
    expect(claudecode).toBeNull()
    expect(cwd).toEndWith(dir.split('/').pop()!)
  })
  test('resuming a session passes --resume', async () => {
    const { a, log } = agent(['02-resume'], { resume: 'abc-123' })
    await all(a.turn('x'))
    expect(log()[0].argv.slice(-2)).toEqual(['--resume', 'abc-123'])
  })
  test('a second message while a turn runs is refused (the CLI would lose it)', async () => {
    const { a } = agent(['01-turn-tool'])
    const first = a.turn('one')[Symbol.asyncIterator]()
    await first.next()
    await expect(all(a.turn('two'))).rejects.toThrow(/turn is still running/)
    while (!(await first.next()).done) {}
  })
  test('the CLI dying mid-turn is an error with its exit code and last stderr, not a silent hang', async () => {
    const { a } = agent(['01-turn-tool'])
    await expect(all(a.turn('CRASH'))).rejects.toThrow(/exited with 3.*something broke/s)
  })
  test('after a crash the next turn starts a new process on the same session (every turn used to fail)', async () => {
    const { a, log } = agent(['01-turn-tool'])
    await expect(all(a.turn('CRASH'))).rejects.toThrow(/exited with 3/)
    const t = await all(a.turn('carry on'))
    expect(t.at(-1)).toMatchObject({ kind: 'result', ok: true })
    const starts = log().filter(x => x.argv).map(x => x.argv as string[])
    expect(starts).toHaveLength(2)
    expect(starts[1]!.slice(starts[1]!.indexOf('--resume'), starts[1]!.indexOf('--resume') + 2)).toEqual(['--resume', '944ca44e-23ae-4522-b779-8be15378469e'])
  })
  test('stopped during a turn: the turn ends at once, saying you stopped it; the next turn resumes the session', async () => {
    const { a, log } = agent(['01-turn-tool', '02-resume'])
    const t = all(a.turn('HANG'))
    await Bun.sleep(300)
    const at = Date.now()
    await a.stop()
    await expect(t).rejects.toThrow(/stopped by you/)
    expect(Date.now() - at).toBeLessThan(2000)
    expect(log().filter(x => x.argv)).toHaveLength(1)
  })
  test('closed between turns (to free its memory), the next turn resumes the session in a new process', async () => {
    const { a, log } = agent(['01-turn-tool', '02-resume'])
    await all(a.turn('one'))
    await a.close()
    await all(a.turn('two'))
    const starts = log().filter(x => x.argv).map(x => x.argv as string[])
    expect(starts).toHaveLength(2)
    expect(starts[1]).toContain('--resume')
  })
})
