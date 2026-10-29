/**
 * Shared contract for credit clients and their live monitoring: what an
 * approved credit line holds, and the events the monitoring checks raise.
 */

export interface CreditLine {
  facilityId: string
  product: string
  limit: number
  currency: string
  drawn: number
  rate: number
  termMonths: number
  approvedAt: string
  approvedBy: string
  startDate: string
  maturity: string
  nextReview: string
  relationshipManager: string
  covenants: { dscrMin: number; leverageMax: number; liquidityMin: number }
  collateral: { type: string; acceptedValue: number }[]
}

export type MonitorSeverity = 'info' | 'watch' | 'alert'
export type MonitorSource = 'anaf' | 'web' | 'covenants' | 'engine'
export const sourceLabels: Record<MonitorSource, string> = { anaf: 'ANAF register', web: 'Public news', covenants: 'Credit line', engine: 'Monitoring' }

export interface MonitorEvent {
  id: string
  companyId: string
  ts: string
  source: MonitorSource
  severity: MonitorSeverity
  title: string
  /** What was found, with the matching passage quoted for news. */
  detail: string
  data?: {
    url?: string; sha256?: string; published?: string | null; site?: string; runId?: string; note?: string; foundBy?: string
    /** Raised from a test signal an employee planted, not from the real source. */
    simulated?: boolean
    /** What the worker did to find it, in order. */
    steps?: string[]
    /** A snapshot of the page as read is kept (news). */
    snapshot?: boolean
  }
  reviewedBy?: string
  reviewedAt?: string
}

export type MonitorWorker = 'anaf' | 'news' | 'covenants'
export const workerLabels: Record<MonitorWorker, string> = { anaf: 'ANAF register', news: 'News crawler', covenants: 'Covenants' }

/** One worker's verdict at the last check: a word for the tile and a sentence for the detail. */
export interface CheckResult { tone: 'ok' | 'watch' | 'alert' | 'off'; label: string; detail: string }

/** A step a worker is taking right now, streamed live (not stored). */
export interface MonitorActivity { companyId: string; worker: MonitorWorker; state: 'working' | 'done' | 'failed'; text: string; ts: string }

export interface ClientStatus {
  companyId: string
  lastCheck: string | null
  nextCheck: string | null
  checking: boolean
  queued: boolean
  /** Worst unreviewed event: alert, watch; ok when checked and nothing open. */
  status: 'ok' | 'watch' | 'alert' | 'unknown'
  open: number
  results: Record<string, string>
  /** Per worker, at the last check. */
  checks: Partial<Record<MonitorWorker, CheckResult>>
  /** The worker checking this client right now. */
  working: MonitorWorker | null
  /** Test signals planted for this client and not cleared yet. */
  planted: SimulationKind[]
}

/** Test signals an employee can plant for a client, to rehearse what monitoring does when something happens. */
export type SimulationKind = 'news-insolvency' | 'news-lawsuit' | 'register-vat' | 'register-inactive' | 'covenant-dscr'
export const SIMULATIONS: { kind: SimulationKind; worker: MonitorWorker; label: string; what: string }[] = [
  { kind: 'news-insolvency', worker: 'news', label: 'Insolvency in the news', what: 'A test article saying the company filed for insolvency is added to the news the crawler reads.' },
  { kind: 'news-lawsuit', worker: 'news', label: 'Lawsuit in the news', what: 'A test article about a commercial lawsuit against the company is added to the news.' },
  { kind: 'register-vat', worker: 'anaf', label: 'VAT registration cancelled', what: 'The next register reading answers that the company is no longer registered for VAT.' },
  { kind: 'register-inactive', worker: 'anaf', label: 'Declared inactive by ANAF', what: 'The next register reading answers that ANAF declared the company an inactive taxpayer.' },
  { kind: 'covenant-dscr', worker: 'covenants', label: 'DSCR below the covenant', what: 'New quarterly figures put debt service coverage at 1.05×, under the agreed minimum.' },
]
export interface Simulation { companyId: string; kind: SimulationKind; createdAt: string; createdBy: string }

/** A news source the crawler read in a check, and how many articles it gave. */
export interface CrawlSource { name: string; url: string; items: number; status: string; about: 'company' | 'headlines' }
/** An article about a client the crawler found, and what it made of it once opened. */
export interface CrawledPage {
  url: string; title: string; site: string; source: string; published: string | null; foundAt: string
  status: 'listed' | 'read' | 'blocked' | 'unreadable' | 'simulated'; readAt: string | null; sha256: string | null
  topic: string | null; severity: MonitorSeverity | null; sentence: string | null; note: string | null; snapshot: boolean; text?: string
  /** Why it got its severity, and who judged it: the light model, or the keyword rules when no model answered. */
  reason?: string | null; judgedBy?: string
}
export interface Crawl { crawl: { at: string; sources: CrawlSource[]; found: number; opened: number } | null; pages: CrawledPage[] }

/** A worker's steps for reading: runs of feeds read or sources searched folded into one line each. */
export function compactSteps(steps: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < steps.length; i++) {
    const read = /^Reading ([^\s:]+)$/.exec(steps[i])
    const searched = /^Searching (.+) for (“.+”)$/.exec(steps[i])
    if (read) {
      const run: string[] = []
      while (i < steps.length && /^Reading ([^\s:]+)$/.test(steps[i])) run.push(steps[i++].slice(8))
      i--
      out.push(run.length > 1 ? 'Read ' + run.length + ' news feeds: ' + run.map(r => r.split('/')[0]).join(', ') : steps[i])
    } else if (searched) {
      const run: string[] = []
      while (i < steps.length && /^Searching (.+) for “.+”$/.test(steps[i])) run.push(/^Searching (.+) for “.+”$/.exec(steps[i++])![1])
      i--
      out.push(run.length > 1 ? 'Searched ' + run.length + ' sources for ' + searched[2] + ': ' + run.join(', ') : steps[i])
    } else out.push(steps[i])
  }
  return out
}
