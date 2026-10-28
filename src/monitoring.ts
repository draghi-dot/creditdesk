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
  data?: { url?: string; sha256?: string; published?: string | null; site?: string; runId?: string; note?: string; foundBy?: string }
  reviewedBy?: string
  reviewedAt?: string
}

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
}
