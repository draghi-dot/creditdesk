/**
 * Shared contract for the people side of the workspace: employees and their
 * departments, cases (a problem sent to a department), company contacts,
 * requests drafted for a company and the company activity log. The engine
 * stores all of it; the browser only displays and submits.
 */

import type { AgentId, Finding } from './assessment'

export type DepartmentId = 'legal' | 'finance' | 'credit' | 'compliance'

export const DEPARTMENTS: { id: DepartmentId; name: string; handles: string }[] = [
  { id: 'legal', name: 'Legal', handles: 'Litigation, contract terms and legal standing' },
  { id: 'finance', name: 'Finance', handles: 'Statements, reconciliation, cash flow and collateral' },
  { id: 'credit', name: 'Credit', handles: 'Applications, missing documents and client requests' },
  { id: 'compliance', name: 'Compliance', handles: 'Identity, KYC and public registers' },
]

export const departmentName = (id: DepartmentId) => DEPARTMENTS.find(d => d.id === id)?.name ?? id

/** Where a problem goes by default, from the check that found it. The employee can pick another department. */
const ROUTING: Record<AgentId, DepartmentId> = {
  legal: 'legal', research: 'compliance', ledger: 'finance', cashflow: 'finance', credit: 'finance', collateral: 'finance',
  intake: 'credit', extraction: 'credit', policy: 'credit', handoff: 'credit',
}
export const departmentFor = (finding: Pick<Finding, 'worker'>): DepartmentId => ROUTING[finding.worker] ?? 'credit'

export interface User {
  id: string
  name: string
  title: string
  department: DepartmentId
  initials: string
}

export type CaseStatus = 'open' | 'in_progress' | 'waiting' | 'resolved'
export const caseStatusLabels: Record<CaseStatus, string> = { open: 'Open', in_progress: 'In progress', waiting: 'Waiting on company', resolved: 'Resolved' }

export interface Case {
  id: string
  /** Short reference shown to people, e.g. LEG-12. */
  ref: string
  companyId: string
  companyName: string
  runId: string | null
  /** The finding as it was when the case was opened. */
  finding: Finding | null
  department: DepartmentId
  title: string
  status: CaseStatus
  assignee: string | null
  createdBy: string
  createdAt: string
  updatedAt: string
}

export type CaseEventKind = 'opened' | 'comment' | 'status' | 'assigned' | 'moved' | 'contact' | 'request' | 'email' | 'report' | 'suggestion'

export interface CaseEvent {
  id: string
  caseId: string
  ts: string
  author: string
  kind: CaseEventKind
  text: string
  data?: any
}

export interface Contact {
  id: string
  companyId: string
  name: string
  role: string
  email: string
  phone: string
  /** From the dossier as submitted, added by an employee, or found in public sources by the assistant. */
  source: 'dossier' | 'added' | 'public'
  /** True when there is no address that can receive mail. */
  placeholder: boolean
  addedBy: string | null
  addedAt: string | null
  /** Public contacts: the page the address was found on, and whether the engine found it printed there. */
  sourceUrl: string | null
  verified: boolean | null
}

/** How Send delivers: a copy to the sender's own mailbox (test) or to the company (live). */
export type Delivery = 'test' | 'live'
export interface WorkspaceSettings { delivery: Delivery }

export type RequestStatus = 'draft' | 'sent' | 'failed'

/** A message to a company representative: drafted by the assistant or an employee, sent only by an employee. */
export interface CompanyRequest {
  id: string
  companyId: string
  caseId: string | null
  to: { name: string; email: string }
  subject: string
  body: string
  requirements: string[]
  status: RequestStatus
  draftedBy: string
  createdAt: string
  sentBy: string | null
  sentAt: string | null
  sentFrom: string | null
  error: string | null
  /** Where the message actually went; differs from `to` for a test delivery. */
  deliveredTo?: string | null
  testDelivery?: boolean
}

/** What the assistant suggests for one problem: an internal comment and what to ask of the company. */
export interface Suggestion {
  findingId: string
  department: DepartmentId
  comment: string
  requirement: string
}

/** The assistant's suggestions for every problem of one assessment run. */
export interface SuggestionSet {
  runId: string
  items: Suggestion[]
  author: string
  unsupported: string[]
  createdAt: string
}

/** One entry of a company's activity log, chained per company by SHA-256 like the run log. */
export interface ActivityEvent {
  id: string
  companyId: string
  time: string
  action: string
  detail: string
  actor: string
  previousHash: string
  payload?: any
  hash: string
}

export interface GmailState {
  /** An OAuth client is set up for the workspace. */
  configured: boolean
  /** The acting employee's connected mailbox, if any. */
  connected: { email: string; connectedAt: string } | null
  redirectUri: string
}

/** The assistant's (or the engine's) written note on a case. */
export interface CaseReport {
  title: string
  paragraphs: string[]
}

/** True for addresses that cannot receive mail: reserved test domains used when no contact is on file. */
export const undeliverable = (email: string) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || /\.(invalid|example|test|localhost)$/i.test(email) || /@example\.(com|org|net)$/i.test(email)
