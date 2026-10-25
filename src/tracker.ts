import { azureTicket, type Az } from './azure.ts'
import type { Project } from './config.ts'
import { jiraTracker, type JiraDeps } from './jira.ts'

/** A ticket as flow and the agent read it. id: the work item number (Azure) or the key (Jira). */
export interface Ticket {
  id: number | string; key: string; title: string; kind: 'bug' | 'feature'; url: string; text: string
  /** for the new-run form's suggestions: the tracker's own type, the board it is on, the customer named on it, tags */
  type?: string; board?: string; customer?: string; tags?: string[]; comments?: number
  /** the product area it belongs to (which app of a customer's); the platform it targets */
  area?: string; platform?: string
}

/** Where tickets come from: it recognises its keys and reads a ticket. */
export interface Tracker {
  parseKey(arg: string): { id: number | string; key: string } | null
  read(id: number | string): Promise<Ticket>
}

export function azureTracker(az: Az, t: { org: string; project: string }): Tracker {
  return {
    parseKey: arg => { const m = /^#?(\d+)$/.exec(arg.trim()); return m ? { id: Number(m[1]), key: `#${m[1]}` } : null },
    read: async id => azureTicket(az, t, Number(id)),
  }
}

export function trackerFor(p: Project, deps: { az: Az } & JiraDeps): Tracker {
  return p.tracker.kind === 'azure' ? azureTracker(deps.az, p.tracker) : jiraTracker(p.tracker, deps)
}
