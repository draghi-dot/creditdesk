/**
 * New assessments for many companies, a few at a time. Each one is an
 * ordinary run (its own log, kept like any other); the batch only decides
 * when the next one starts.
 */

import type { DossierUpload } from '../../src/assessment.ts'
import type { Company, Policy } from '../../src/types.ts'
import type { Engine } from './engine.ts'

export interface BatchStatus {
  active: boolean
  total: number
  queued: number
  running: { companyId: string; runId: string }[]
  finished: { companyId: string; runId: string | null; status: string }[]
  startedBy: string | null
  startedAt: string | null
}

const TERMINAL = new Set(['run_completed', 'run_failed', 'run_cancelled'])

export class Batch {
  private readonly engine: Engine
  private readonly dossier: (companyId: string) => Promise<{ company: Company; uploads: DossierUpload[] }>
  private queue: string[] = []
  private running = new Map<string, string>()
  /** Runs being prepared (dossier read) but not started yet; they count against the limit. */
  private starting = 0
  private finished: BatchStatus['finished'] = []
  private total = 0
  private limit = 3
  private policy: Policy | null = null
  private startedBy: string | null = null
  private startedAt: string | null = null

  constructor(engine: Engine, dossier: (companyId: string) => Promise<{ company: Company; uploads: DossierUpload[] }>) {
    this.engine = engine
    this.dossier = dossier
  }

  status(): BatchStatus {
    return {
      active: this.queue.length > 0 || this.running.size > 0 || this.starting > 0, total: this.total, queued: this.queue.length,
      running: [...this.running].map(([companyId, runId]) => ({ companyId, runId })), finished: this.finished, startedBy: this.startedBy, startedAt: this.startedAt,
    }
  }

  /** Queue every company that is not already being assessed. */
  start(companyIds: string[], policy: Policy, limit: number, startedBy: string): BatchStatus {
    if (this.status().active) throw Object.assign(new Error('Assessments for all companies are already running.'), { status: 409 })
    this.queue = companyIds.filter(id => !this.engine.activeRun(id))
    this.running.clear()
    this.finished = []
    this.total = this.queue.length
    this.limit = Math.max(1, limit)
    this.policy = policy
    this.startedBy = startedBy
    this.startedAt = new Date().toISOString()
    void this.pump()
    return this.status()
  }

  /** Stop starting new runs; the ones already running finish normally. */
  stop(): BatchStatus {
    for (const companyId of this.queue) this.finished.push({ companyId, runId: null, status: 'not started' })
    this.queue = []
    return this.status()
  }

  private async pump(): Promise<void> {
    while (this.running.size + this.starting < this.limit && this.queue.length) {
      const companyId = this.queue.shift()!
      this.starting++
      try {
        const { company, uploads } = await this.dossier(companyId)
        const runId = this.engine.start(company, this.policy!, uploads, this.startedBy)
        this.running.set(companyId, runId)
        const unsubscribe = this.engine.subscribe(runId, e => {
          if (!TERMINAL.has(e.type)) return
          unsubscribe()
          this.running.delete(companyId)
          this.finished.push({ companyId, runId, status: e.type.replace('run_', '') })
          void this.pump()
        })
      } catch (err) {
        this.finished.push({ companyId, runId: null, status: 'not started: ' + (err instanceof Error ? err.message : String(err)) })
      } finally {
        this.starting--
      }
    }
  }
}
