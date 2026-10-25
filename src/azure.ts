/**
 * Azure DevOps through the `az` CLI (the user's own sign-in): reading a work item, opening a draft PR.
 * Writes happen only in flow's ship step, never from an agent (the guard refuses `az boards/repos` writes).
 */
export type Az = (args: string[]) => { code: number; out: string; err: string }

export const realAz: Az = args => {
  const r = Bun.spawnSync(['az', ...args])
  return { code: r.exitCode, out: new TextDecoder().decode(r.stdout), err: new TextDecoder().decode(r.stderr) }
}

export interface AzureRef { org: string; project: string }
export interface Ticket { id: number; key: string; title: string; kind: 'bug' | 'feature'; url: string; text: string; type?: string; board?: string; customer?: string; tags?: string[]; comments?: number; area?: string; platform?: string }

export function htmlToText(html: string): string {
  return html
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<(br|\/div|\/p|\/li|\/h\d|\/tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .split('\n').map(l => l.trim()).filter(Boolean).join('\n')
}

const firstError = (err: string) => err.split('\n').find(l => l.startsWith('ERROR')) ?? err.trim()

export function azureTicket(az: Az, t: AzureRef, id: number): Ticket {
  const r = az(['boards', 'work-item', 'show', '--id', String(id), '--org', t.org, '-o', 'json'])
  if (r.code !== 0) throw new Error(`az boards work-item show ${id} failed: ${firstError(r.err)} (signed in? az login)`)
  const f = JSON.parse(r.out).fields as Record<string, string | undefined>
  // a ticket may live in another project of the organisation (a customer's board): use its own
  const project = f['System.TeamProject'] ?? t.project
  const c = az(['devops', 'invoke', '--area', 'wit', '--resource', 'comments', '--route-parameters', `project=${project}`, `workItemId=${id}`,
    '--org', t.org, '--api-version', '7.1-preview', '-o', 'json'])
  const comments = c.code === 0 ? ((JSON.parse(c.out).comments ?? []) as { createdDate: string; createdBy?: { displayName?: string }; text?: string }[]) : []
  const sections: string[] = []
  const add = (label: string, html?: string) => { const s = htmlToText(html ?? ''); if (s) sections.push(`${label}:\n${s}`) }
  add('Description', f['System.Description'])
  add('Repro steps', f['Microsoft.VSTS.TCM.ReproSteps'])
  add('Acceptance criteria', f['Microsoft.VSTS.Common.AcceptanceCriteria'])
  // comments override the description: newest first, the way a reader should take them
  const lines = [...comments].sort((a, b) => b.createdDate.localeCompare(a.createdDate))
    .map(x => `${x.createdDate.slice(0, 10)} ${x.createdBy?.displayName ?? '?'}: ${htmlToText(x.text ?? '').replace(/\n/g, ' ')}`)
  if (lines.length) sections.push(`Comments (newest first):\n${lines.join('\n')}`)
  return {
    id, key: `#${id}`, title: String(f['System.Title'] ?? ''), kind: /bug|issue/i.test(f['System.WorkItemType'] ?? '') ? 'bug' : 'feature',
    url: `${t.org}/${project}/_workitems/edit/${id}`, text: sections.join('\n\n'),
    type: f['System.WorkItemType'] ?? '', board: project, customer: (f['Custom.CustomerName'] ?? '').trim(),
    tags: (f['System.Tags'] ?? '').split(';').map(x => x.trim()).filter(Boolean), comments: comments.length, area: (f['Custom.SolutionArea'] ?? '').trim(), platform: (f['Custom.TargetPlatform'] ?? '').trim(),
  }
}

export function azureDraftPr(az: Az, t: AzureRef, repository: string, o: { head: string; base: string; title: string; body: string; workItem: number }): { number: number; url: string } {
  const r = az(['repos', 'pr', 'create', '--org', t.org, '--project', t.project, '--repository', repository,
    '--source-branch', o.head, '--target-branch', o.base, '--title', o.title, '--description', o.body, '--draft', 'true',
    '--work-items', String(o.workItem), '-o', 'json'])
  if (r.code !== 0) throw new Error(`az repos pr create failed: ${firstError(r.err)}`)
  const number = JSON.parse(r.out).pullRequestId as number
  return { number, url: `${t.org}/${t.project}/_git/${repository}/pullrequest/${number}` }
}
