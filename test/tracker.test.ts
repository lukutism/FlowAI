import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { githubForge, type Gh } from '../src/forge.ts'
import { adfToMarkdown, jiraTracker } from '../src/jira.ts'

// Jira (read-only REST, the token from the keychain) and GitHub (through gh), with stand-ins for the network.
const jira = { kind: 'jira' as const, site: 'https://example.atlassian.net', key: 'SGL', email: 'me@example.com', keychain: 'flow-jira' }
const doc = (...paragraphs: string[]) => ({ type: 'doc', content: paragraphs.map(t => ({ type: 'paragraph', content: [{ type: 'text', text: t }] })) })
const issue = {
  key: 'SGL-692', fields: {
    summary: 'New success modal text', issuetype: { name: 'Story' }, status: { name: 'To Do' },
    description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Show ' }, { type: 'text', text: 'Ačiū', marks: [{ type: 'strong' }] }] }, { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'LT and EN' }] }] }] }] },
    comment: { comments: [
      { author: { displayName: 'PO' }, created: '2026-10-01T10:00:00.000+0300', body: doc('older') },
      { author: { displayName: 'QA' }, created: '2026-10-05T10:00:00.000+0300', body: doc('web and app') },
    ] },
    attachment: [{ filename: 'design.png', content: 'https://example.atlassian.net/att/1', mimeType: 'image/png', size: 10 }],
  },
}

describe('jiraTracker', () => {
  const calls: { url: string; auth: string | null }[] = []
  const t = jiraTracker(jira, {
    secret: () => 'tok', fetch: async (url, init) => { calls.push({ url: String(url), auth: new Headers(init?.headers).get('Authorization') }); return Response.json(issue) },
  })
  test('keys of the project are recognised (any case); others are not', async () => {
    expect(t.parseKey('sgl-692')).toEqual({ id: 'SGL-692', key: 'SGL-692' })
    expect(t.parseKey('ABC-1')).toBeNull()
    expect(t.parseKey('692')).toBeNull()
    expect(t.parseKey('https://x.atlassian.net/browse/SGL-692')).toEqual({ id: 'SGL-692', key: 'SGL-692' })
  })
  test('the issue as the agent reads it: Markdown from Jira\'s document format, comments newest first, attachments named', async () => {
    const tk = await t.read('SGL-692')
    expect(tk).toMatchObject({ id: 'SGL-692', key: 'SGL-692', title: 'New success modal text', kind: 'feature', url: 'https://example.atlassian.net/browse/SGL-692' })
    expect(tk.text).toBe(['Description:', 'Show **Ačiū**\n\n- LT and EN', '', 'Comments (newest first):', '2026-10-05 QA: web and app', '2026-10-01 PO: older', '', 'Attachments:', '- design.png (image/png) https://example.atlassian.net/att/1'].join('\n'))
    expect(calls[0]).toEqual({ url: expect.stringContaining('/rest/api/3/issue/SGL-692?fields='), auth: `Basic ${btoa('me@example.com:tok')}` })
  })
  test('no token in the keychain: says how to store one, and never shows a token', async () => {
    const none = jiraTracker(jira, { secret: () => '', fetch: async () => Response.json(issue) })
    await expect(none.read('SGL-1')).rejects.toThrow(/no Jira token in the keychain \(flow-jira\).*security add-generic-password/s)
  })
  test('a rejected token or a missing issue says which', async () => {
    await expect(jiraTracker(jira, { secret: () => 'x', fetch: async () => new Response('', { status: 401 }) }).read('SGL-1')).rejects.toThrow(/rejected the token \(401\)/)
    await expect(jiraTracker(jira, { secret: () => 'x', fetch: async () => new Response('', { status: 404 }) }).read('SGL-9')).rejects.toThrow(/SGL-9 not found/)
  })
  test('unknown document nodes keep their text rather than vanish', async () => {
    expect(adfToMarkdown({ type: 'doc', content: [{ type: 'panel', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'inside a panel' }] }] }] })).toBe('inside a panel')
  })
})

describe('githubForge', () => {
  test('a draft PR through gh; the body goes through a file; the number comes from the URL gh prints', async () => {
    const calls: string[][] = []
    let body = ''
    const gh: Gh = args => {
      calls.push(args)
      const f = args[args.indexOf('--body-file') + 1]
      if (f) body = readFileSync(f, 'utf8')
      return { code: 0, out: 'https://github.com/OWNER/shop-web-app/pull/57\n', err: '' }
    }
    const pr = await githubForge({ kind: 'github', owner: 'OWNER' }, gh).draftPr({ repository: 'shop-web-app', head: 'SGL-692', base: 'main', title: 'SGL-692', body: 'https://example.atlassian.net/browse/SGL-692' })
    expect(pr).toEqual({ number: 57, url: 'https://github.com/OWNER/shop-web-app/pull/57' })
    expect(calls[0]).toEqual(expect.arrayContaining(['pr', 'create', '-R', 'OWNER/shop-web-app', '--draft', '--base', 'main', '--head', 'SGL-692', '--title', 'SGL-692']))
    expect(body).toBe('https://example.atlassian.net/browse/SGL-692')
  })
  test('the state of a PR from gh: OPEN, MERGED, CLOSED', async () => {
    for (const [state, want] of [['OPEN', 'open'], ['MERGED', 'merged'], ['CLOSED', 'closed']] as const) {
      const calls: string[][] = []
      const gh: Gh = args => { calls.push(args); return { code: 0, out: JSON.stringify({ state }), err: '' } }
      expect(await githubForge({ kind: 'github', owner: 'OWNER' }, gh).prState({ number: 57, url: 'https://github.com/OWNER/shop-web-app/pull/57' })).toBe(want)
      expect(calls[0]).toEqual(['pr', 'view', '57', '-R', 'OWNER/shop-web-app', '--json', 'state'])
    }
  })
  test('gh not logged in says so', async () => {
    const gh: Gh = () => ({ code: 1, out: '', err: 'To get started with GitHub CLI, please run:  gh auth login' })
    await expect(githubForge({ kind: 'github', owner: 'O' }, gh).draftPr({ repository: 'r', head: 'h', base: 'b', title: 't', body: 'b' })).rejects.toThrow(/gh auth login/)
  })
})

describe('azure tickets from any board', () => {
  test('a number, or a link from any board of the organisation (the customer\'s or the product\'s)', async () => {
    const { azureTracker } = await import('../src/tracker.ts')
    const t = azureTracker(() => ({ code: 1, out: '', err: '' }), { org: 'https://dev.azure.com/org', project: 'product' })
    expect(t.parseKey('204598')).toEqual({ id: 204598, key: '#204598' })
    expect(t.parseKey('https://dev.azure.com/org/customer-hub/_workitems/edit/204598/')).toEqual({ id: 204598, key: '#204598' })
    expect(t.parseKey('https://dev.azure.com/org/product/_workitems/edit/201601')).toEqual({ id: 201601, key: '#201601' })
    expect(t.parseKey('nope')).toBeNull()
  })
})
