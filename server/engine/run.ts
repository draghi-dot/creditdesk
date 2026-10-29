/**
 * One assessment run: dependency scheduling and the context each worker acts
 * through. Every state change is an appended event; nothing is timed.
 */

import { basename, join } from 'node:path'
import type { AgentId, CheckResult, EventPayloads, EventType, EvidenceMark, EvidenceRef, Finding, Observations, ProviderInfo, RoleDef, RunEvent } from '../../src/assessment.ts'
import type { Company, Policy, Row } from '../../src/types.ts'
import type { CodexConfig } from './codex.ts'
import type { PdfDocument } from './pdf.ts'
import { findQuote, readPdf } from './pdf.ts'
import type { FieldMismatch, LedgerIssue } from './reconcile.ts'
import { recordFor, sourceRows } from './reconcile.ts'
import { INDICATOR_LABELS, describeField, fieldValue } from '../../src/fields.ts'
import { documentFile } from './dossier.ts'

export interface Blackboard {
  /** Present original documents by kind, with their inventory row. */
  documents: Map<string, Row>
  missing: string[]
  extracted: Map<string, PdfDocument>
  mismatches: FieldMismatch[]
  ledger: LedgerIssue[]
  observations: Observations | null
  legalSummary: string | null
  identity: { label: string; value: string }[]
  findings: Finding[]
  checks: CheckResult[]
}

export interface RunEnv {
  runId: string
  company: Company
  policy: Policy
  documentsDir: string
  provider: ProviderInfo
  codex: CodexConfig | null
  emit: <T extends EventType>(type: T, worker: AgentId | null, payload: EventPayloads[T]) => RunEvent<T>
  signal: AbortSignal
}

/**
 * How long each step stays in view, per worker. The work itself takes
 * milliseconds; at that speed a run looks finished before anyone can follow
 * it. CREDITDESK_PACE scales it (1 by default, 0 turns it off; tests run at 0).
 */
const STEP_MS: Record<AgentId, number> = { intake: 350, extraction: 1100, research: 900, ledger: 1200, credit: 1100, legal: 900, cashflow: 1400, collateral: 1000, policy: 1200, handoff: 900 }
export function pause(ms: number, signal: AbortSignal): Promise<void> {
  const scaled = ms * Number(process.env.CREDITDESK_PACE ?? 1)
  if (!(scaled > 0) || signal.aborted) return Promise.resolve()
  return new Promise(resolve => {
    const timer = setTimeout(done, scaled)
    function done() { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
    signal.addEventListener('abort', done, { once: true })
  })
}

export class WorkerContext {
  readonly id: AgentId
  readonly env: RunEnv
  readonly board: Blackboard
  private findingCount = 0

  constructor(id: AgentId, env: RunEnv, board: Blackboard) {
    this.id = id
    this.env = env
    this.board = board
  }

  get company() { return this.env.company }
  get tables() { return this.env.company.tables }
  get signal() { return this.env.signal }

  /** Throws once the run is cancelled, so workers stop at the next step. */
  checkpoint(): void {
    if (this.env.signal.aborted) throw this.env.signal.reason ?? new Error('cancelled')
  }

  /** Records a step, then lets it be seen for a moment before the next one (see `pause`). */
  async activity(text: string, documentId?: string, page?: number): Promise<void> {
    this.checkpoint()
    this.env.emit('worker_activity', this.id, { text, documentId, page })
    await pause(STEP_MS[this.id], this.env.signal)
    this.checkpoint()
  }

  check(check: CheckResult): void {
    this.board.checks.push(check)
    this.env.emit('worker_check', this.id, { check })
  }

  finding(f: Omit<Finding, 'id' | 'worker'>): void {
    this.checkpoint()
    this.findingCount++
    const finding: Finding = { ...f, id: this.id + '-' + this.findingCount, worker: this.id }
    this.board.findings.push(finding)
    this.env.emit('finding_raised', this.id, { finding })
  }

  note(note: EventPayloads['worker_note']): void {
    this.env.emit('worker_note', this.id, note)
  }

  file(kind: string): string | null {
    const doc = this.board.documents.get(kind)
    return doc ? documentFile(this.env.documentsDir, this.env.company, doc) : null
  }

  async pdf(kind: string): Promise<PdfDocument | null> {
    const cached = this.board.extracted.get(kind)
    if (cached) return cached
    const file = this.file(kind)
    return file ? readPdf(file) : null
  }

  /** Index of the first recorded row of a document matching `pick`. */
  rowIndex(kind: string, pick: (row: Row) => boolean): number {
    const doc = this.board.documents.get(kind)
    return doc ? sourceRows(this.tables, kind, doc.document_id).findIndex(pick) : -1
  }

  /**
   * Outline printed fields of one recorded row. `issue` fields are the
   * problem; `reference` fields are what they were compared with.
   */
  async mark(kind: string, rowIndex: number, issue: string[], reference: string[] = [], labels: Record<string, string> = {}): Promise<EvidenceRef[]> {
    const pdf = await this.pdf(kind)
    const doc = this.board.documents.get(kind)
    if (!pdf || !doc || rowIndex < 0) return []
    const record = recordFor(pdf, kind, rowIndex)
    if (!record) return []
    const marks: { page: number; mark: EvidenceMark }[] = []
    for (const [fields, tone] of [[issue, 'issue'], [reference, 'reference']] as const) {
      for (const field of fields) {
        const f = record.fields[field]
        if (!f) continue
        // Statements print one indicator per record: name the value after it.
        const indicator = field === 'valoare' ? record.fields.cod_indicator?.raw : undefined
        const thousands = record.fields.unitate?.raw === '1000' && /^-?\d/.test(f.raw) && field !== 'unitate' ? ' (in thousands)' : ''
        const label = labels[field] ?? (indicator ? (INDICATOR_LABELS[indicator] ?? indicator) + ': ' + fieldValue(field, f.raw) : describeField(field, f.raw) + thousands)
        marks.push({ page: f.page, mark: { box: f.lineBox, tone, label } })
      }
    }
    return this.refs(kind, pdf, doc, marks)
  }

  /** Outline a printed passage, if it really is in the document. */
  async quote(kind: string, text: string, label: string, tone: EvidenceMark['tone'], page?: number): Promise<EvidenceRef[]> {
    const pdf = await this.pdf(kind)
    const doc = this.board.documents.get(kind)
    if (!pdf || !doc) return []
    const hit = findQuote(pdf, text, page)
    return hit ? this.refs(kind, pdf, doc, [{ page: hit.page, mark: { box: hit.box, tone, label } }]) : []
  }

  private refs(kind: string, pdf: PdfDocument, doc: Row, marks: { page: number; mark: EvidenceMark }[]): EvidenceRef[] {
    const pages = [...new Set(marks.map(m => m.page))].sort((a, b) => a - b)
    return pages.map(page => ({
      documentId: doc.document_id, kind, file: basename(doc.fisier), sha256: doc.sha256, page, pageCount: pdf.pages.length,
      pageWidth: pdf.pages[page - 1].width, pageHeight: pdf.pages[page - 1].height,
      marks: marks.filter(m => m.page === page).map(m => m.mark),
    }))
  }
}

/** Merge evidence for the same page of the same document. */
export function mergeEvidence(refs: EvidenceRef[]): EvidenceRef[] {
  const out: EvidenceRef[] = []
  for (const ref of refs) {
    const same = out.find(r => r.documentId === ref.documentId && r.page === ref.page)
    if (same) same.marks.push(...ref.marks)
    else out.push({ ...ref, marks: [...ref.marks] })
  }
  return out
}

export type Worker = (ctx: WorkerContext) => Promise<string>

/**
 * Run the workers over the role graph. A worker is revealed (waiting) once
 * one of its dependencies has been dispatched, and dispatched once all of
 * them have completed. Independent workers run concurrently.
 */
export async function schedule(env: RunEnv, roles: RoleDef[], workers: Record<AgentId, Worker>, board: Blackboard): Promise<void> {
  const started = new Set<AgentId>()
  const done = new Set<AgentId>()
  const waitingShown = new Map<AgentId, string>()
  let inflight = 0
  let idle: () => void = () => {}
  const finished = new Promise<void>(resolve => { idle = resolve })
  let failure: unknown = null

  const reveal = () => {
    for (const role of roles) {
      if (started.has(role.id) || !role.dependsOn.some(d => started.has(d))) continue
      const pending = role.dependsOn.filter(d => !done.has(d))
      const key = pending.join(',')
      if (pending.length && waitingShown.get(role.id) !== key) {
        waitingShown.set(role.id, key)
        env.emit('worker_waiting', role.id, { waitingFor: pending })
      }
    }
  }

  const dispatch = () => {
    if (failure || env.signal.aborted) return
    for (const role of roles) {
      if (started.has(role.id) || !role.dependsOn.every(d => done.has(d))) continue
      started.add(role.id)
      const inputs = role.dependsOn.length ? 'after ' + role.dependsOn.map(d => roles.find(r => r.id === d)!.name).join(', ') : 'dossier ' + env.company.id
      env.emit('worker_dispatched', role.id, { inputs })
      const ctx = new WorkerContext(role.id, env, board)
      inflight++
      void (async () => {
        try {
          // Let sibling dispatch events land before this worker's first step, and the dispatch be seen.
          await new Promise(resolve => setImmediate(resolve))
          await pause(600, env.signal)
          const summary = await workers[role.id](ctx)
          env.emit('worker_completed', role.id, { summary })
          done.add(role.id)
        } catch (err) {
          if (env.signal.aborted) return
          failure ??= err
          env.emit('worker_failed', role.id, { reason: err instanceof Error ? err.message : String(err) })
          return
        }
        reveal()
        dispatch()
      })().finally(() => { if (--inflight === 0) idle() })
    }
    reveal()
  }

  dispatch()
  if (inflight) await finished
  if (env.signal.aborted) throw env.signal.reason ?? new Error('cancelled')
  if (failure) throw failure
}
