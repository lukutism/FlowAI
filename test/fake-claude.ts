#!/usr/bin/env bun
/**
 * A stand-in for the `claude` executable in process tests. Reads stream-json user messages on stdin, like
 * `claude -p --input-format stream-json`, and answers each with the next recorded session (FAKE_TURNS: fixture
 * paths, comma-separated). Logs its argv, env and the prompts it got to FAKE_LOG.
 * A prompt "CRASH" makes it write half a turn and exit 3, as a killed CLI would; "HANG" writes half a turn and hangs.
 */
import { appendFileSync, readFileSync } from 'node:fs'

const log = (o: object) => process.env.FAKE_LOG && appendFileSync(process.env.FAKE_LOG, JSON.stringify(o) + '\n')
log({ argv: process.argv.slice(2), claudecode: process.env.CLAUDECODE ?? null, cwd: process.cwd() })
const turns = (process.env.FAKE_TURNS ?? '').split(',').filter(Boolean)
let n = 0, buf = ''
for await (const chunk of Bun.stdin.stream()) {
  buf += new TextDecoder().decode(chunk)
  let i: number
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    if (!line.trim()) continue
    const prompt = JSON.parse(line).message.content
    log({ prompt })
    const lines = readFileSync(turns[n++ % turns.length]!, 'utf8').split('\n').filter(Boolean)
    if (prompt === 'HANG') { process.stdout.write(lines[0] + '\n'); await new Promise(() => {}) }
    if (prompt === 'CRASH') { process.stdout.write(lines[0] + '\n'); process.stderr.write('fatal: something broke\n'); process.exit(3) }
    for (const l of lines) { process.stdout.write(l + '\n'); await Bun.sleep(1) }
  }
}
