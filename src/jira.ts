import type { Ticket, Tracker } from './tracker.ts'

/**
 * Jira Cloud, read-only: REST v3 with basic auth, the API token from the macOS keychain (never logged, never in a
 * file or an error). Descriptions and comments come in Atlassian's document format and are turned into Markdown.
 */
export interface JiraConfig { kind: 'jira'; site: string; key: string; email: string; keychain: string }
export interface JiraDeps { fetch?: (url: string, init?: RequestInit) => Promise<Response>; secret?: (name: string) => string }

const keychain = (name: string) => {
  const r = Bun.spawnSync(['security', 'find-generic-password', '-s', name, '-w'])
  return r.exitCode === 0 ? new TextDecoder().decode(r.stdout).trim() : ''
}

type Node = { type: string; text?: string; attrs?: Record<string, any>; marks?: { type: string; attrs?: Record<string, any> }[]; content?: Node[] }

/** what a node without content still says (a link, a name), else its type: never silently nothing */
const said = (n: Node) => { const a = n.attrs ?? {}, v = a.url ?? a.text ?? a.title ?? a.alt; return v ? String(v) : `[${n.type}]` }

function inline(nodes: Node[] = []): string {
  return nodes.map(n => {
    if (n.type === 'text') {
      let t = n.text ?? ''
      for (const m of n.marks ?? []) {
        if (m.type === 'strong') t = `**${t}**`
        else if (m.type === 'em') t = `*${t}*`
        else if (m.type === 'code') t = `\`${t}\``
        else if (m.type === 'strike') t = `~~${t}~~`
        else if (m.type === 'link') t = `[${t}](${m.attrs?.href ?? ''})`
      }
      return t
    }
    if (n.type === 'hardBreak') return '\n'
    if (n.type === 'mention') return String(n.attrs?.text ?? '@someone')
    if (n.type === 'emoji') return String(n.attrs?.text ?? n.attrs?.shortName ?? '')
    if (n.type === 'date') return new Date(Number(n.attrs?.timestamp)).toISOString().slice(0, 10)
    if (n.type === 'inlineCard') return String(n.attrs?.url ?? '')
    if (n.type === 'status') return `[${n.attrs?.text ?? ''}]`
    return n.content ? inline(n.content) : (n.text ?? said(n))
  }).join('')
}

function block(n: Node): string {
  const kids = n.content ?? []
  switch (n.type) {
    case 'doc': return kids.map(block).filter(Boolean).join('\n\n')
    case 'paragraph': return inline(kids)
    case 'heading': return `${'#'.repeat(Number(n.attrs?.level ?? 1))} ${inline(kids)}`
    case 'bulletList': case 'orderedList': return kids.map((li, i) => `${n.type === 'orderedList' ? `${i + 1}.` : '-'} ${(li.content ?? []).map(block).join('\n')}`).join('\n')
    case 'codeBlock': return `\`\`\`${n.attrs?.language ?? ''}\n${kids.map(k => k.text ?? '').join('')}\n\`\`\``
    case 'blockquote': return kids.map(block).join('\n\n').split('\n').map(l => `> ${l}`).join('\n')
    case 'rule': return '---'
    case 'media': return `![${n.attrs?.alt ?? 'image'}](${n.attrs?.url ?? `attachment:${n.attrs?.alt ?? n.attrs?.id ?? 'image'}`})`
    case 'table': return kids.map(r => `| ${(r.content ?? []).map(c => (c.content ?? []).map(block).join(' ').replace(/\n/g, ' ')).join(' | ')} |`).join('\n')
    // unknown blocks (panel, expand, …): their content, never dropped
    default: return kids.length ? kids.map(block).filter(Boolean).join('\n\n') : (n.text ?? said(n))
  }
}

export const adfToMarkdown = (doc: unknown): string => (doc && typeof doc === 'object' ? block(doc as Node) : typeof doc === 'string' ? doc : '')

export function jiraTracker(t: JiraConfig, deps: JiraDeps = {}): Tracker {
  const tokenHelp = `https://id.atlassian.com/manage-profile/security/api-tokens, then: security add-generic-password -U -s ${t.keychain} -a ${t.email} -w`
  const get = async (path: string) => {
    const token = (deps.secret ?? keychain)(t.keychain)
    if (!token) throw new Error(`no Jira token in the keychain (${t.keychain}): create one at ${tokenHelp}`)
    let r: Response
    try {
      r = await (deps.fetch ?? fetch)(`${t.site}${path}`, { headers: { Authorization: `Basic ${btoa(`${t.email}:${token}`)}`, Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) })
    } catch (e) { throw new Error(`can't reach Jira (${t.site}): ${(e as Error).message.split('\n')[0]}`) }
    if (r.status === 401 || r.status === 403) throw new Error(`Jira rejected the token (${r.status}): create a new one at ${tokenHelp}`)
    return r
  }
  return {
    parseKey: arg => { const m = /^([A-Za-z][A-Za-z0-9]+)-(\d+)$/.exec(arg.trim()); return m && m[1]!.toUpperCase() === t.key.toUpperCase() ? { id: `${t.key.toUpperCase()}-${m[2]}`, key: `${t.key.toUpperCase()}-${m[2]}` } : null },
    async read(id): Promise<Ticket> {
      const key = String(id)
      const r = await get(`/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,description,issuetype,environment,comment,attachment`)
      if (r.status === 404) throw new Error(`${key} not found, or this account can't see it (${t.site}/browse/${key})`)
      if (!r.ok) throw new Error(`Jira answered ${r.status} for ${key}`)
      const j = await r.json() as any, f = j.fields ?? {}
      const sections: string[] = []
      const desc = adfToMarkdown(f.description)
      if (desc) sections.push(`Description:\n${desc}`)
      const env = adfToMarkdown(f.environment)
      if (env) sections.push(`Environment:\n${env}`)
      const comments = ((f.comment?.comments ?? []) as any[]).sort((a, b) => Date.parse(b.created) - Date.parse(a.created))
        .map(c => `${String(c.created).slice(0, 10)} ${c.author?.displayName ?? 'unknown'}: ${adfToMarkdown(c.body).replace(/\n+/g, ' ')}`)
      if (comments.length) sections.push(`Comments (newest first):\n${comments.join('\n')}`)
      const files = ((f.attachment ?? []) as any[]).map(a => `- ${a.filename} (${a.mimeType}) ${a.content}`)
      if (files.length) sections.push(`Attachments:\n${files.join('\n')}`)
      const k = j.key ?? key
      return { id: k, key: k, title: f.summary ?? '', kind: /bug/i.test(f.issuetype?.name ?? '') ? 'bug' : 'feature', url: `${t.site}/browse/${k}`, text: sections.join('\n\n'),
        type: f.issuetype?.name ?? '', board: t.key.toUpperCase(), customer: '', tags: (f.labels ?? []) as string[], comments: comments.length }
    },
  }
}
