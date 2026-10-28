/**
 * Starts, streams and cancels assessment runs. Each run appends its events to
 * the store and fans them out to live subscribers.
 */

import { randomUUID } from 'node:crypto'
import type { AgentId, AssessmentSummary, DossierUpload, EventPayloads, EventType, ProviderInfo, RunEvent } from '../../src/assessment.ts'
import { ROLES } from '../../src/assessment.ts'
import type { Analysis, Company, Policy, Scenario, Simulation } from '../../src/types.ts'
import { evaluate, scenarioLabels } from '../../src/analysis.ts'
import type { Store } from '../store.ts'
import type { CodexConfig } from './codex.ts'
import type { Blackboard, RunEnv } from './run.ts'
import { schedule } from './run.ts'
import { WORKERS } from './workers.ts'

type Listener = (e: RunEvent) => void

/**
 * What-if analysis of a completed run: every scenario re-evaluated with the
 * run's own recorded observations and policy, under the analyst's assumptions.
 * Source data and the run log are unchanged.
 */
export function whatIf(company: Company, run: AssessmentSummary, settings: Simulation): Record<Scenario, Analysis> {
  if (run.status !== 'completed' || !run.observations) throw Object.assign(new Error('What-if analysis needs a completed run.'), { status: 409 })
  return Object.fromEntries((Object.keys(scenarioLabels) as Scenario[]).map(s => [s, evaluate(company, run.policy, run.observations!, s, settings)])) as Record<Scenario, Analysis>
}

export function parseSimulation(body: any): Simulation {
  const out: Simulation = {}
  const num = (key: 'amount' | 'months' | 'cashflowChange', min: number, max: number) => {
    const v = body?.[key]
    if (v === undefined) return
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw Object.assign(new Error(key + ' must be a number between ' + min + ' and ' + max), { status: 400 })
    out[key] = v
  }
  num('amount', 10_000, 100_000_000)
  num('months', 1, 360)
  num('cashflowChange', -100, 100)
  if (body?.assumeCashVerified !== undefined) out.assumeCashVerified = body.assumeCashVerified === true
  return out
}

export class Engine {
  private readonly store: Store
  private readonly documentsDir: string
  private readonly active = new Map<string, { companyId: string; controller: AbortController }>()
  private readonly listeners = new Map<string, Set<Listener>>()
  codex: CodexConfig | null

  constructor(store: Store, documentsDir: string, codex: CodexConfig | null) {
    this.store = store
    this.documentsDir = documentsDir
    this.codex = codex
    for (const runId of store.unfinished()) store.append(runId, 'run_failed', null, { reason: 'The engine stopped while this run was in progress.' })
  }

  get provider(): ProviderInfo {
    return this.codex ? { id: 'codex', model: this.codex.model, effort: this.codex.effort } : { id: 'none', model: null, effort: null }
  }

  activeRun(companyId: string): string | null {
    for (const [runId, run] of this.active) if (run.companyId === companyId) return runId
    return null
  }

  /** `company` is the dossier as the run will review it; `uploads` are the analyst's documents in it. */
  start(company: Company, policy: Policy, uploads: DossierUpload[] = [], startedBy: string | null = null): string {
    const existing = this.activeRun(company.id)
    if (existing) throw Object.assign(new Error('An assessment is already running for this company.'), { status: 409, runId: existing })
    const runId = randomUUID()
    const controller = new AbortController()
    const provider = this.provider
    this.store.createRun(runId, company.id, provider, policy, startedBy)
    this.active.set(runId, { companyId: company.id, controller })
    const emit = <T extends EventType>(type: T, worker: AgentId | null, payload: EventPayloads[T]): RunEvent<T> => {
      const event = this.store.append(runId, type, worker, payload)
      for (const listener of this.listeners.get(runId) ?? []) listener(event)
      return event
    }
    emit('run_created', null, { companyId: company.id, companyName: company.name, policy, provider, roles: ROLES, uploads, ...(startedBy ? { startedBy } : {}) })
    const env: RunEnv = { runId, company, policy, documentsDir: this.documentsDir, provider, codex: this.codex, emit, signal: controller.signal }
    const board: Blackboard = { documents: new Map(), missing: [], extracted: new Map(), mismatches: [], ledger: [], observations: null, legalSummary: null, identity: [], findings: [], checks: [] }
    void (async () => {
      emit('run_started', null, {})
      try {
        await schedule(env, ROLES, WORKERS, board)
        const decision = this.store.run(runId)?.decision
        emit('run_completed', null, { decision: decision as EventPayloads['run_completed']['decision'], findings: this.store.run(runId)?.findings ?? 0 })
      } catch (err) {
        if (controller.signal.aborted) emit('run_cancelled', null, { by: String(controller.signal.reason?.message ?? controller.signal.reason ?? 'analyst') })
        else emit('run_failed', null, { reason: err instanceof Error ? err.message : String(err) })
      } finally {
        this.active.delete(runId)
      }
    })()
    return runId
  }

  cancel(runId: string, by: string): boolean {
    const run = this.active.get(runId)
    if (!run) return false
    run.controller.abort(new Error(by))
    return true
  }

  subscribe(runId: string, listener: Listener): () => void {
    let set = this.listeners.get(runId)
    if (!set) this.listeners.set(runId, set = new Set())
    set.add(listener)
    return () => { set!.delete(listener); if (!set!.size) this.listeners.delete(runId) }
  }

  isActive(runId: string): boolean {
    return this.active.has(runId)
  }
}
