import { describe, expect, test } from 'bun:test'
import { azureDraftPr, azurePrState, azureTicket, htmlToText, type Az } from '../src/azure.ts'

// flow reaches Azure DevOps through the `az` CLI the user is already signed in to; these pass a stand-in.
const tracker = { kind: 'azure' as const, org: 'https://dev.azure.com/example', project: 'example' }
function fakeAz(answers: Record<string, unknown>) {
  const calls: string[][] = []
  const az: Az = args => {
    calls.push(args)
    const key = Object.keys(answers).find(k => args.join(' ').includes(k))
    return key ? { code: 0, out: JSON.stringify(answers[key]), err: '' } : { code: 1, out: '', err: 'ERROR: not found' }
  }
  return { az, calls }
}

describe('azureTicket: the work item as the agent reads it', () => {
  const wi = { id: 186278, fields: {
    'System.Title': 'Asset list crashes on large orders', 'System.WorkItemType': 'Bug',
    'System.Description': '<div>Open order <b>700216740</b>&nbsp;and walk assets.</div>',
    'Microsoft.VSTS.TCM.ReproSteps': '<ol><li>Open order</li><li>Edit 90 assets</li></ol>',
  } }
  const comments = { comments: [
    { createdDate: '2026-10-01T10:00:00Z', createdBy: { displayName: 'Tester' }, text: '<p>older</p>' },
    { createdDate: '2026-10-05T10:00:00Z', createdBy: { displayName: 'PO' }, text: '<p>newer: 1,500 assets in prod</p>' },
  ] }
  test('title, kind, link, and the text: description, repro steps, comments newest first', async () => {
    const { az } = fakeAz({ 'work-item show': wi, 'devops invoke': comments })
    const t = await azureTicket(az, tracker, 186278)
    expect(t).toMatchObject({ id: 186278, key: '#186278', title: 'Asset list crashes on large orders', kind: 'bug', url: 'https://dev.azure.com/example/example/_workitems/edit/186278' })
    expect(t.text).toBe(['Description:', 'Open order 700216740 and walk assets.', '', 'Repro steps:', '- Open order', '- Edit 90 assets', '',
      'Comments (newest first):', '2026-10-05 PO: newer: 1,500 assets in prod', '2026-10-01 Tester: older'].join('\n'))
  })
  test('a work item from another project of the organisation: its own project for the comments and the link', async () => {
    const other = { ...wi, fields: { ...wi.fields, 'System.TeamProject': 'customer-hub' } }
    const { az, calls } = fakeAz({ 'work-item show': other, 'devops invoke': comments })
    const t = await azureTicket(az, tracker, 186278)
    expect(t.url).toBe('https://dev.azure.com/example/customer-hub/_workitems/edit/186278')
    expect(calls[1]).toContain('project=customer-hub')
    expect(t.text).toContain('newer: 1,500 assets in prod')
  })
  test('anything but a Bug is a feature', async () => {
    const { az } = fakeAz({ 'work-item show': { ...wi, fields: { ...wi.fields, 'System.WorkItemType': 'User Story' } } })
    expect((await azureTicket(az, tracker, 1)).kind).toBe('feature')
  })
  test('az failing (not signed in) says so', async () => {
    await expect(azureTicket(fakeAz({}).az, tracker, 1)).rejects.toThrow(/az boards work-item show 1 failed.*az login/)
  })
})

describe('azureDraftPr', () => {
  test('a draft PR from the branch, linked to the work item; returns its number and link', async () => {
    const { az, calls } = fakeAz({ 'pr create': { pullRequestId: 4711 } })
    const pr = await azureDraftPr(az, tracker, 'mobile-app', { head: 'fix/186278', base: 'develop', title: 'fix(cmms): #186278 x', body: 'body', workItem: 186278 })
    expect(pr).toEqual({ number: 4711, url: 'https://dev.azure.com/example/example/_git/mobile-app/pullrequest/4711' })
    expect(calls[0]).toEqual(expect.arrayContaining(['--draft', 'true', '--work-items', '186278', '--source-branch', 'fix/186278', '--target-branch', 'develop', '--repository', 'mobile-app']))
  })
  test('a task without a ticket links no work item (it used to pass --work-items 0)', async () => {
    const { az, calls } = fakeAz({ 'pr create': { pullRequestId: 1 } })
    await azureDraftPr(az, tracker, 'm', { head: 'feat/x', base: 'develop', title: 't', body: 'b', workItem: 0 })
    expect(calls[0]).not.toContain('--work-items')
  })
  test('a description over Azure\'s 4000 characters is cut, saying so (the PR was refused before)', async () => {
    const { az, calls } = fakeAz({ 'pr create': { pullRequestId: 1 } })
    await azureDraftPr(az, tracker, 'm', { head: 'h', base: 'b', title: 't', body: 'x'.repeat(5000), workItem: 1 })
    const d = calls[0]![calls[0]!.indexOf('--description') + 1]!
    expect(d.length).toBeLessThanOrEqual(4000)
    expect(d).toMatch(/cut at 4000 characters/)
  })
  test('the state of a PR: active is open, completed is merged, abandoned is closed', async () => {
    for (const [status, want] of [['active', 'open'], ['completed', 'merged'], ['abandoned', 'closed']] as const) {
      const { az, calls } = fakeAz({ 'pr show': { status } })
      expect(await azurePrState(az, tracker, 4711)).toBe(want)
      expect(calls[0]).toEqual(expect.arrayContaining(['repos', 'pr', 'show', '--id', '4711']))
    }
    expect(await azurePrState(fakeAz({}).az, tracker, 1)).toBe('unknown')
  })
})

test('htmlToText keeps list items and line breaks', async () => {
  expect(htmlToText('<p>a&amp;b</p><ul><li>one</li><li>two</li></ul>')).toBe('a&b\n- one\n- two')
})
