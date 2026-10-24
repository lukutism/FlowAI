#!/usr/bin/env bun
/**
 * Stand-ins for tsc, eslint and jest in verify tests. They report a finding for every line containing ERR (tsc),
 * LINT (eslint) or FAIL (jest), in the formats the real tools use.
 *   bun fake-tools.ts tsc                     → `file(line,col): error TS2322: <line text>` for src/*.ts
 *   bun fake-tools.ts eslint <json> <files…>  → ESLint JSON
 *   bun fake-tools.ts jest <json> <files…>    → Jest JSON (one test per file)
 *   bun fake-tools.ts crash                   → exits 2 without output
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const [tool, out, ...files] = process.argv.slice(2)
const lines = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8').split('\n') : [])
if (tool === 'tsc') {
  let any = false
  for (const f of readdirSync('src').filter(f => f.endsWith('.ts')).sort())
    lines(join('src', f)).forEach((l, i) => { if (l.includes('ERR')) { any = true; console.log(`src/${f}(${i + 1},1): error TS2322: ${l.trim()}`) } })
  process.exit(any ? 2 : 0)
}
if (tool === 'eslint') {
  writeFileSync(out!, JSON.stringify(files.map(f => ({ filePath: resolve(f), messages: lines(f).flatMap((l, i) => (l.includes('LINT') ? [{ ruleId: 'no-lint', severity: 2, message: l.trim(), line: i + 1 }] : [])) }))))
  process.exit(0)
}
if (tool === 'jest') {
  const results = files.map(f => { const failed = lines(f).some(l => l.includes('FAIL')); return { name: resolve(f), status: failed ? 'failed' : 'passed', assertionResults: [{ fullName: `${f} works`, status: failed ? 'failed' : 'passed' }] } })
  writeFileSync(out!, JSON.stringify({ testResults: results }))
  process.exit(results.some(r => r.status === 'failed') ? 1 : 0)
}
if (tool === 'crash') process.exit(2)
