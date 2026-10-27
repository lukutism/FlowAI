import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { callTool, type ToolHost } from '../src/runtools.ts'

// The ticket's attachments: flow downloads one into the run folder with its own sign-in.
const host = (o: Partial<ToolHost> = {}): ToolHost => ({ run: 'r', runDir: mkdtempSync(join(tmpdir(), 'flow-tools-')), worktree: '/w', base: 'b', check: async () => ({ ok: true, findings: [] }), ticket: async () => 'the ticket', end: () => {}, ...o })

describe('the ticket tool: an attachment', () => {
  test('saved under the run folder, named from the link, the path given back', async () => {
    const h = host({ attachment: async () => new Uint8Array([7, 8]) })
    const r = await callTool(h, [], 'ticket', { attachment: 'https://example.atlassian.net/rest/api/3/attachment/content/10042', name: 'screen recording.mp4' })
    expect(r).toMatchObject({ ok: true, text: expect.stringContaining(join(h.runDir, 'attachments', 'screen-recording.mp4')) })
    expect([...readFileSync(join(h.runDir, 'attachments', 'screen-recording.mp4'))]).toEqual([7, 8])
  })
  test("a tracker that can't download says so", async () => {
    expect(await callTool(host(), [], 'ticket', { attachment: 'https://x/y' })).toMatchObject({ ok: false, text: expect.stringMatching(/can't download attachments/) })
  })
})

describe('add_repo without its repo', () => {
  test('says which repos it can add, instead of "no repo"', async () => {
    const h = host({ addRepo: async () => 'added', otherRepos: ['web', 'admin'] })
    expect(await callTool(h, [], 'add_repo', {})).toMatchObject({ ok: false, text: 'add_repo needs the repo: one of web, admin' })
  })
})
