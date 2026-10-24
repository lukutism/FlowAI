import { describe, expect, test } from 'bun:test'
import { azureDraftPr, azureTicket, htmlToText, type Az } from '../src/azure.ts'

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
  test('title, kind, link, and the text: description, repro steps, comments newest first', () => {
    const { az } = fakeAz({ 'work-item show': wi, 'devops invoke': comments })
    const t = azureTicket(az, tracker, 186278)
    expect(t).toMatchObject({ id: 186278, key: '#186278', title: 'Asset list crashes on large orders', kind: 'bug', url: 'https://dev.azure.com/example/example/_workitems/edit/186278' })
    expect(t.text).toBe(['Description:', 'Open order 700216740 and walk assets.', '', 'Repro steps:', '- Open order', '- Edit 90 assets', '',
      'Comments (newest first):', '2026-10-05 PO: newer: 1,500 assets in prod', '2026-10-01 Tester: older'].join('\n'))
  })
  test('anything but a Bug is a feature', () => {
    const { az } = fakeAz({ 'work-item show': { ...wi, fields: { ...wi.fields, 'System.WorkItemType': 'User Story' } } })
    expect(azureTicket(az, tracker, 1).kind).toBe('feature')
  })
  test('az failing (not signed in) says so', () => {
    expect(() => azureTicket(fakeAz({}).az, tracker, 1)).toThrow(/az boards work-item show 1 failed.*az login/)
  })
})

describe('azureDraftPr', () => {
  test('a draft PR from the branch, linked to the work item; returns its number and link', () => {
    const { az, calls } = fakeAz({ 'pr create': { pullRequestId: 4711 } })
    const pr = azureDraftPr(az, tracker, 'mobile-app', { head: 'fix/186278', base: 'develop', title: 'fix(cmms): #186278 x', body: 'body', workItem: 186278 })
    expect(pr).toEqual({ number: 4711, url: 'https://dev.azure.com/example/example/_git/mobile-app/pullrequest/4711' })
    expect(calls[0]).toEqual(expect.arrayContaining(['--draft', 'true', '--work-items', '186278', '--source-branch', 'fix/186278', '--target-branch', 'develop', '--repository', 'mobile-app']))
  })
})

test('htmlToText keeps list items and line breaks', () => {
  expect(htmlToText('<p>a&amp;b</p><ul><li>one</li><li>two</li></ul>')).toBe('a&b\n- one\n- two')
})
