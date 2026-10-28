/**
 * Durable run log (node:sqlite). Events are append-only and hash-chained per
 * run; the run row is a summary that is only ever derived from its events.
 */

import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { AgentId, AskAnswer, AssessmentSummary, DossierUpload, EventPayloads, EventType, ProviderInfo, RunEvent, RunStatus } from '../src/assessment.ts'
import { canonicalEvent, digestOf } from '../src/assessment.ts'
import type { Policy } from '../src/types.ts'

export const GENESIS = '0'.repeat(64)
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

interface RunRow {
  id: string
  company_id: string
  status: RunStatus
  decision: string | null
  findings: number
  created_at: string
  ended_at: string | null
  provider: string
  policy: string
  observations: string | null
  digest: string | null
  started_by: string | null
}

export class Store {
  readonly db: DatabaseSync
  private readonly heads = new Map<string, { seq: number; hash: string }>()

  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true })
    this.db = new DatabaseSync(file)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL,
        status TEXT NOT NULL,
        decision TEXT,
        findings INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        ended_at TEXT,
        provider TEXT NOT NULL,
        policy TEXT NOT NULL,
        observations TEXT
      );
      CREATE INDEX IF NOT EXISTS runs_company ON runs (company_id, created_at);
      CREATE TABLE IF NOT EXISTS events (
        run_id TEXT NOT NULL REFERENCES runs(id),
        seq INTEGER NOT NULL,
        ts TEXT NOT NULL,
        type TEXT NOT NULL,
        worker TEXT,
        payload TEXT NOT NULL,
        prev_hash TEXT NOT NULL,
        hash TEXT NOT NULL,
        PRIMARY KEY (run_id, seq)
      );
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS questions (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        ts TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS questions_run ON questions (run_id, ts);
      CREATE TABLE IF NOT EXISTS uploads (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        path TEXT NOT NULL,
        uploaded_at TEXT NOT NULL,
        removed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS uploads_company ON uploads (company_id, uploaded_at);
    `)
    const columns = (this.db.prepare('PRAGMA table_info(runs)').all() as { name: string }[]).map(c => c.name)
    if (!columns.includes('digest')) this.db.exec('ALTER TABLE runs ADD COLUMN digest TEXT')
    if (!columns.includes('started_by')) this.db.exec('ALTER TABLE runs ADD COLUMN started_by TEXT')
  }

  createRun(id: string, companyId: string, provider: ProviderInfo, policy: Policy, startedBy: string | null = null): void {
    this.db.prepare('INSERT INTO runs (id, company_id, status, created_at, provider, policy, started_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, companyId, 'created', new Date().toISOString(), JSON.stringify(provider), JSON.stringify(policy), startedBy)
  }

  /** Append the next event of a run and fold it into the run summary. */
  append<T extends EventType>(runId: string, type: T, worker: AgentId | null, payload: EventPayloads[T]): RunEvent<T> {
    const head = this.head(runId)
    const base = { runId, seq: head.seq + 1, ts: new Date().toISOString(), type, worker, payload, prevHash: head.hash }
    const event: RunEvent<T> = { ...base, hash: sha256(canonicalEvent(base)) }
    this.db.prepare('INSERT INTO events (run_id, seq, ts, type, worker, payload, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(runId, event.seq, event.ts, type, worker, JSON.stringify(payload), event.prevHash, event.hash)
    this.heads.set(runId, { seq: event.seq, hash: event.hash })
    this.summarize(event)
    return event
  }

  private head(runId: string): { seq: number; hash: string } {
    const cached = this.heads.get(runId)
    if (cached) return cached
    const row = this.db.prepare('SELECT seq, hash FROM events WHERE run_id = ? ORDER BY seq DESC LIMIT 1').get(runId) as { seq: number; hash: string } | undefined
    return row ?? { seq: 0, hash: GENESIS }
  }

  private summarize(e: RunEvent): void {
    const set = (sql: string, ...args: (string | number | null)[]) => this.db.prepare('UPDATE runs SET ' + sql + ' WHERE id = ?').run(...args, e.runId)
    switch (e.type) {
      case 'run_started': return void set('status = ?', 'running')
      case 'finding_raised': return void set('findings = findings + 1')
      case 'decision_reached': {
        const p = e.payload as EventPayloads['decision_reached']
        return void set('decision = ?, observations = ?, digest = ?', p.decision, JSON.stringify(p.observations), JSON.stringify(digestOf(p.scenarios.baza)))
      }
      case 'run_completed': return void set('status = ?, ended_at = ?', 'completed', e.ts)
      case 'run_failed': return void set('status = ?, ended_at = ?', 'failed', e.ts)
      case 'run_cancelled': return void set('status = ?, ended_at = ?', 'cancelled', e.ts)
    }
  }

  events(runId: string, after = 0): RunEvent[] {
    const rows = this.db.prepare('SELECT * FROM events WHERE run_id = ? AND seq > ? ORDER BY seq').all(runId, after) as Record<string, any>[]
    return rows.map(r => ({ runId: r.run_id, seq: r.seq, ts: r.ts, type: r.type, worker: r.worker, payload: JSON.parse(r.payload), prevHash: r.prev_hash, hash: r.hash }))
  }

  run(id: string): AssessmentSummary | null {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | undefined
    return row ? summary(row) : null
  }

  runs(companyId?: string): AssessmentSummary[] {
    const rows = (companyId
      ? this.db.prepare('SELECT * FROM runs WHERE company_id = ? ORDER BY created_at DESC').all(companyId)
      : this.db.prepare('SELECT * FROM runs ORDER BY created_at DESC').all()) as unknown as RunRow[]
    return rows.map(summary)
  }

  /** Recompute every hash of a run from its stored content. */
  verify(runId: string): { ok: boolean; events: number; brokenAt: number | null } {
    let prev = GENESIS
    const events = this.events(runId)
    for (const e of events) {
      if (e.prevHash !== prev || sha256(canonicalEvent(e)) !== e.hash) return { ok: false, events: events.length, brokenAt: e.seq }
      prev = e.hash
    }
    return { ok: true, events: events.length, brokenAt: null }
  }

  /** Analyst questions about a run, kept outside the run's own sealed log. */
  saveQuestion(answer: AskAnswer): void {
    this.db.prepare('INSERT INTO questions (id, run_id, ts, payload) VALUES (?, ?, ?, ?)').run(answer.id, answer.runId, answer.ts, JSON.stringify(answer))
  }

  questions(runId: string): AskAnswer[] {
    return (this.db.prepare('SELECT payload FROM questions WHERE run_id = ? ORDER BY ts').all(runId) as { payload: string }[]).map(r => JSON.parse(r.payload))
  }

  saveUpload(upload: DossierUpload, path: string): void {
    this.db.prepare('INSERT INTO uploads (id, company_id, kind, payload, path, uploaded_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(upload.id, upload.companyId, upload.kind, JSON.stringify(upload), path, upload.uploadedAt)
  }

  /** Uploads of a company; removed ones only when asked (old runs still refer to them). */
  uploads(companyId: string, includeRemoved = false): (DossierUpload & { path: string })[] {
    const rows = this.db.prepare('SELECT * FROM uploads WHERE company_id = ? ORDER BY uploaded_at').all(companyId) as { payload: string; path: string; removed_at: string | null }[]
    return rows.filter(r => includeRemoved || !r.removed_at).map(r => ({ ...JSON.parse(r.payload), removedAt: r.removed_at, path: r.path }))
  }

  removeUpload(companyId: string, id: string): boolean {
    return this.db.prepare('UPDATE uploads SET removed_at = ? WHERE id = ? AND company_id = ? AND removed_at IS NULL').run(new Date().toISOString(), id, companyId).changes > 0
  }

  /** Runs that were active when the engine stopped. */
  unfinished(): string[] {
    return (this.db.prepare("SELECT id FROM runs WHERE status IN ('created', 'running')").all() as { id: string }[]).map(r => r.id)
  }
}

function summary(row: RunRow): AssessmentSummary {
  return {
    runId: row.id, companyId: row.company_id, status: row.status, decision: row.decision as AssessmentSummary['decision'],
    findings: row.findings, createdAt: row.created_at, endedAt: row.ended_at,
    provider: JSON.parse(row.provider), policy: JSON.parse(row.policy), observations: row.observations ? JSON.parse(row.observations) : null,
    digest: row.digest ? JSON.parse(row.digest) : null, startedBy: row.started_by ?? null,
  }
}
