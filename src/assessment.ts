/**
 * The assessment run contract, shared by the engine and the workspace.
 *
 * A run is an ordered, hash-chained event log written by the engine as its
 * workers actually execute. The workspace never infers progress from time:
 * `foldRun` turns the events received so far into the view, so the live
 * run, a reload mid-run and a completed assessment all render from the same
 * fold over the same events.
 */

import type { Analysis, Decision, Policy, Scenario } from './types.ts'

export type AgentId = 'intake' | 'research' | 'extraction' | 'credit' | 'legal' | 'ledger' | 'cashflow' | 'collateral' | 'policy' | 'handoff'

export interface RoleDef {
  id: AgentId
  name: string
  role: string
  dependsOn: AgentId[]
}

/** Roles and dependencies are fixed in code; everything else comes from execution. */
export const ROLES: RoleDef[] = [
  { id: 'intake', name: 'Case coordinator', role: 'Document intake & routing', dependsOn: [] },
  { id: 'research', name: 'Identity research', role: 'Company identity & public sources', dependsOn: ['intake'] },
  { id: 'extraction', name: 'Document extraction', role: 'Fields and positions from original PDFs', dependsOn: ['intake'] },
  { id: 'ledger', name: 'Financial reconciliation', role: 'Documents against recorded data', dependsOn: ['extraction'] },
  { id: 'credit', name: 'Credit & fiscal', role: 'Credit reports, arrears, tax status', dependsOn: ['extraction'] },
  { id: 'legal', name: 'Legal review', role: 'Litigation and contract terms', dependsOn: ['extraction'] },
  { id: 'cashflow', name: 'Cash flow & repayment', role: 'Coverage, liquidity, leverage', dependsOn: ['ledger'] },
  { id: 'collateral', name: 'Collateral', role: 'Coverage and guarantors', dependsOn: ['extraction'] },
  { id: 'policy', name: 'Policy evaluation', role: 'Decision under active policy', dependsOn: ['research', 'credit', 'legal', 'cashflow', 'collateral'] },
  { id: 'handoff', name: 'Analyst handoff', role: 'Memo for the credit analyst', dependsOn: ['policy'] },
]

/** PDF points, top-left origin. */
export interface Box { x0: number; y0: number; x1: number; y1: number }

export interface EvidenceMark {
  box: Box
  label: string
  /** `issue` is the problem itself; `reference` is what it was compared with. */
  tone: 'issue' | 'reference'
}
export interface EvidenceRef {
  documentId: string
  kind: string
  file: string
  sha256: string
  page: number
  pageCount: number
  pageWidth: number
  pageHeight: number
  marks: EvidenceMark[]
}

/** The documents a complete term-loan dossier must contain. */
export const REQUIRED_DOCUMENTS = [
  'cerere_finantare', 'identificare_kyc_demo', 'situatii_2024', 'situatii_2025', 'balanta', 'cashflow', 'creante_datorii_comerciale',
  'credite_leasing', 'serviciu_datorie', 'garantii', 'garanti', 'crc_demo', 'cip_demo', 'situatie_fiscala', 'litigii_demo', 'contract_demo',
]
/** Policy checks that cannot run without a given document. */
export const DEPENDENT_CHECKS: Record<string, string[]> = {
  cashflow: ['FIN-01', 'FIN-02'], situatii_2024: ['FIN-03', 'FIN-04'], situatii_2025: ['FIN-03', 'FIN-04'], crc_demo: ['CRD-01'],
}

export type FindingImpact = 'data' | 'block' | 'condition' | 'info'
export interface Finding {
  id: string
  worker: AgentId
  impact: FindingImpact
  title: string
  /** What the worker saw, with the exact figures. */
  observed: string
  /** What that was checked against. */
  comparedAgainst: string
  whyItMatters: string
  effect: string
  ruleIds: string[]
  evidence: EvidenceRef[]
  /** Set when the problem is a required document that is not in the dossier. */
  missingDocument?: string
}

/** Facts the engine established from the documents, used by the policy rules. */
export interface Discrepancy {
  field: string
  documentId: string
  printed: unknown
  recorded: unknown
  description: string
}
export interface Observations {
  missingDocuments: string[]
  discrepancies: Discrepancy[]
}

/** What the directory needs from a run's base-scenario analysis. */
export interface AssessmentDigest {
  decision: Decision
  metrics: Analysis['metrics']
  reasons: { id: string; title: string; observed: string; impact: string }[]
  failing: string[]
}
export const digestOf = (a: Analysis): AssessmentDigest => ({
  decision: a.decision, metrics: a.metrics,
  reasons: a.reasons.map(r => ({ id: r.id, title: r.title, observed: r.observed, impact: r.impact })),
  failing: a.rules.filter(r => r.state !== 'pass' && r.state !== 'info').map(r => r.id),
})

export interface CheckResult {
  id: string
  title: string
  state: 'pass' | 'fail' | 'review' | 'missing' | 'info'
  observed: string
  expected: string
}

/** Structured content of a worker note, so it can be shown as data rather than prose. */
export interface NoteField { label: string; value: string; tone?: 'ok' | 'warn' }
export interface NotePoint { text: string; quote?: string; verified: boolean; review?: boolean }

/** The assessment report written at handoff (by the model when available, else by the engine). */
export interface ReportSection { title: string; paragraphs: string[]; findingIds: string[] }
export interface AssessmentReport { headline: string; summary: string; sections: ReportSection[]; nextSteps: string[] }

/** One analyst question about a run and the answer, with where to look. */
export interface AskAnswer {
  id: string
  runId: string
  ts: string
  question: string
  ok: boolean
  answer: string
  /** The finding the analyst asked about, if the question was asked from it. */
  about?: string | null
  /** The finding the answer is about, if any. */
  findingId: string | null
  /** Where the answer points in the original documents (located by the engine). */
  evidence: EvidenceRef[]
  author: string
  durationMs: number
  /** Figures in the answer that are not in the run's facts. */
  unsupported: string[]
}

/** A document the analyst added to a company's dossier after intake. */
export interface DossierUpload {
  id: string
  companyId: string
  kind: string
  /** Stored file name; also how the document is addressed in evidence. */
  file: string
  originalName: string
  sha256: string
  pages: number
  fields: number
  uploadedAt: string
  uploadedBy: string
  removedAt: string | null
  /** True when it replaces a document that was already in the dossier. */
  replaces: boolean
}

export interface ProviderInfo {
  id: 'codex' | 'none'
  model: string | null
  effort: string | null
}

export interface EventPayloads {
  run_created: { companyId: string; companyName: string; policy: Policy; provider: ProviderInfo; roles: RoleDef[]; uploads?: DossierUpload[] }
  run_started: Record<string, never>
  worker_waiting: { waitingFor: AgentId[] }
  worker_dispatched: { inputs: string }
  worker_activity: { text: string; documentId?: string; page?: number }
  worker_check: { check: CheckResult }
  finding_raised: { finding: Finding }
  llm_started: { provider: string; model: string; effort: string; purpose: string }
  llm_finished: { ok: boolean; durationMs: number; reason: string; usage?: Record<string, unknown> }
  worker_note: { title: string; text: string; author: string; verified: boolean; evidence: EvidenceRef[]; fields?: NoteField[]; points?: NotePoint[] }
  worker_completed: { summary: string }
  worker_failed: { reason: string }
  /** The recorded assessment: the full analysis of every financing scenario. */
  decision_reached: { decision: Decision; reasons: string[]; observations: Observations; scenarios: Record<Scenario, Analysis> }
  report_written: { report: AssessmentReport; author: string; verified: boolean; unsupported: string[] }
  run_completed: { decision: Decision; findings: number }
  run_failed: { reason: string }
  run_cancelled: { by: string }
}
export type EventType = keyof EventPayloads

export interface RunEvent<T extends EventType = EventType> {
  runId: string
  seq: number
  ts: string
  type: T
  worker: AgentId | null
  payload: EventPayloads[T]
  prevHash: string
  hash: string
}

/** The exact text each event hash covers. */
export function canonicalEvent(e: Pick<RunEvent, 'runId' | 'seq' | 'ts' | 'type' | 'worker' | 'payload' | 'prevHash'>): string {
  return JSON.stringify([e.runId, e.seq, e.ts, e.type, e.worker, e.payload, e.prevHash])
}

export type RunStatus = 'created' | 'running' | 'completed' | 'failed' | 'cancelled'
export type WorkerState = 'hidden' | 'waiting' | 'running' | 'done' | 'attention' | 'failed' | 'cancelled'

export interface WorkerLogEntry { seq: number; ts: string; text: string; documentId?: string; page?: number }
export interface WorkerView {
  role: RoleDef
  state: WorkerState
  waitingFor: AgentId[]
  activity: WorkerLogEntry | null
  log: WorkerLogEntry[]
  findings: string[]
  checks: CheckResult[]
  llm: { model: string; effort: string; purpose: string; running: boolean; ok?: boolean; durationMs?: number } | null
  summary: string | null
  startedAt: string | null
  endedAt: string | null
}
export type NoteView = EventPayloads['worker_note'] & { worker: AgentId; seq: number }
export interface FindingView extends Finding { seq: number; ts: string }

export interface RunView {
  runId: string
  companyId: string
  companyName: string
  status: RunStatus
  policy: Policy | null
  provider: ProviderInfo | null
  workers: Record<string, WorkerView>
  order: AgentId[]
  findings: FindingView[]
  notes: NoteView[]
  decision: EventPayloads['decision_reached'] | null
  report: EventPayloads['report_written'] | null
  /** Documents the analyst had added to the dossier when the run started. */
  uploads: DossierUpload[]
  failure: string | null
  createdAt: string | null
  endedAt: string | null
  seq: number
}

export function emptyRun(runId: string): RunView {
  return { runId, companyId: '', companyName: '', status: 'created', policy: null, provider: null, workers: {}, order: [], findings: [], notes: [], decision: null, report: null, uploads: [], failure: null, createdAt: null, endedAt: null, seq: 0 }
}

const terminal = (s: WorkerState) => s === 'done' || s === 'attention' || s === 'failed' || s === 'cancelled'

/** Pure and idempotent: an event at or below the current seq changes nothing. */
export function foldRun(state: RunView, e: RunEvent): RunView {
  if (e.seq <= state.seq) return state
  const next: RunView = { ...state, seq: e.seq, workers: { ...state.workers } }
  const worker = e.worker ? next.workers[e.worker] : undefined
  const update = (patch: Partial<WorkerView>) => {
    if (!e.worker || !worker) return
    next.workers[e.worker] = { ...worker, ...patch }
  }
  const entry = (text: string, extra: Partial<WorkerLogEntry> = {}): WorkerLogEntry => ({ seq: e.seq, ts: e.ts, text, ...extra })
  switch (e.type) {
    case 'run_created': {
      const p = e.payload as EventPayloads['run_created']
      next.companyId = p.companyId
      next.companyName = p.companyName
      next.policy = p.policy
      next.provider = p.provider
      next.createdAt = e.ts
      next.uploads = p.uploads ?? []
      next.order = p.roles.map(r => r.id)
      for (const role of p.roles) next.workers[role.id] = { role, state: 'hidden', waitingFor: [], activity: null, log: [], findings: [], checks: [], llm: null, summary: null, startedAt: null, endedAt: null }
      break
    }
    case 'run_started':
      next.status = 'running'
      break
    case 'worker_waiting': {
      const p = e.payload as EventPayloads['worker_waiting']
      if (worker && worker.state === 'hidden') update({ state: 'waiting', waitingFor: p.waitingFor, log: [...worker.log, entry('Waiting for ' + p.waitingFor.map(id => next.workers[id]?.role.name ?? id).join(', '))] })
      else if (worker && worker.state === 'waiting') update({ waitingFor: p.waitingFor })
      break
    }
    case 'worker_dispatched': {
      const p = e.payload as EventPayloads['worker_dispatched']
      if (worker) { const a = entry('Dispatched · ' + p.inputs); update({ state: 'running', waitingFor: [], startedAt: e.ts, activity: a, log: [...worker.log, a] }) }
      break
    }
    case 'worker_activity': {
      const p = e.payload as EventPayloads['worker_activity']
      if (worker) { const a = entry(p.text, { documentId: p.documentId, page: p.page }); update({ activity: a, log: [...worker.log, a] }) }
      break
    }
    case 'worker_check': {
      const p = e.payload as EventPayloads['worker_check']
      if (worker) update({ checks: [...worker.checks.filter(c => c.id !== p.check.id), p.check] })
      break
    }
    case 'finding_raised': {
      const p = e.payload as EventPayloads['finding_raised']
      next.findings = [...state.findings, { ...p.finding, seq: e.seq, ts: e.ts }]
      if (worker) update({ findings: [...worker.findings, p.finding.id], log: [...worker.log, entry('Finding · ' + p.finding.title)] })
      break
    }
    case 'llm_started': {
      const p = e.payload as EventPayloads['llm_started']
      if (worker) { const a = entry('Model call · ' + p.purpose + ' (' + p.model + ', ' + p.effort + ')'); update({ llm: { model: p.model, effort: p.effort, purpose: p.purpose, running: true }, activity: a, log: [...worker.log, a] }) }
      break
    }
    case 'llm_finished': {
      const p = e.payload as EventPayloads['llm_finished']
      if (worker && worker.llm) update({ llm: { ...worker.llm, running: false, ok: p.ok, durationMs: p.durationMs }, log: [...worker.log, entry((p.ok ? 'Model answered in ' : 'Model call failed after ') + (p.durationMs / 1000).toFixed(1) + ' s' + (p.ok ? '' : ' · ' + p.reason))] })
      break
    }
    case 'worker_note': {
      const p = e.payload as EventPayloads['worker_note']
      if (e.worker) next.notes = [...state.notes, { ...p, worker: e.worker, seq: e.seq }]
      break
    }
    case 'worker_completed': {
      const p = e.payload as EventPayloads['worker_completed']
      if (worker) update({ state: worker.findings.length ? 'attention' : 'done', summary: p.summary, endedAt: e.ts, activity: null, log: [...worker.log, entry('Completed · ' + p.summary)] })
      break
    }
    case 'worker_failed': {
      const p = e.payload as EventPayloads['worker_failed']
      if (worker) update({ state: 'failed', summary: p.reason, endedAt: e.ts, activity: null, log: [...worker.log, entry('Failed · ' + p.reason)] })
      break
    }
    case 'decision_reached':
      next.decision = e.payload as EventPayloads['decision_reached']
      break
    case 'report_written':
      next.report = e.payload as EventPayloads['report_written']
      break
    case 'run_completed':
      next.status = 'completed'
      next.endedAt = e.ts
      break
    case 'run_failed':
      next.status = 'failed'
      next.failure = (e.payload as EventPayloads['run_failed']).reason
      next.endedAt = e.ts
      break
    case 'run_cancelled':
      next.status = 'cancelled'
      next.failure = 'Cancelled by ' + (e.payload as EventPayloads['run_cancelled']).by
      next.endedAt = e.ts
      for (const [id, w] of Object.entries(next.workers)) if (!terminal(w.state) && w.state !== 'hidden') next.workers[id] = { ...w, state: 'cancelled', activity: null }
      break
  }
  return next
}

export const foldAll = (runId: string, events: RunEvent[]) => events.reduce(foldRun, emptyRun(runId))

const IMPACT_RANK: Record<FindingImpact, number> = { data: 0, block: 1, condition: 2, info: 3 }

/**
 * Most important first: what stops a conclusion, then policy failures, then
 * conditions, then advisory points; within each, the ones behind the decision
 * come first, then in the order they were raised.
 */
export function rankFindings(findings: FindingView[], decision: EventPayloads['decision_reached'] | null): FindingView[] {
  const reasons = new Set((decision?.reasons ?? []).map(r => r.split(' ')[0]))
  const decisive = (f: FindingView) => f.ruleIds.some(id => reasons.has(id)) ? 0 : 1
  return [...findings].sort((a, b) => IMPACT_RANK[a.impact] - IMPACT_RANK[b.impact] || decisive(a) - decisive(b) || a.seq - b.seq)
}

/** A completed run's summary, as listed per company. */
export interface AssessmentSummary {
  runId: string
  companyId: string
  status: RunStatus
  decision: Decision | null
  findings: number
  createdAt: string
  endedAt: string | null
  provider: ProviderInfo
  policy: Policy
  observations: Observations | null
  digest: AssessmentDigest | null
}
