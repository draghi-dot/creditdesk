import { useCallback, useEffect, useRef, useState } from 'react'
import type { AskAnswer, AssessmentSummary, DossierUpload, ProviderInfo, RunEvent, RunView } from './assessment'
import { canonicalEvent, emptyRun, foldRun } from './assessment'
import type { Analysis, Policy, Scenario, Simulation } from './types'

const USER_KEY = 'creditdesk.user'

/** The employee this browser acts as; every engine call carries it. */
export function actingUser(): string {
  try { return localStorage.getItem(USER_KEY) ?? '' } catch { return '' }
}
export function setActingUser(id: string) {
  try { localStorage.setItem(USER_KEY, id) } catch { /* private mode: this tab only */ }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch('/api' + path, { ...init, headers: { ...init?.headers, 'x-user': actingUser() } })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw Object.assign(new Error(body.error || 'The assessment engine answered ' + res.status), { status: res.status, body })
  return body as T
}

export interface EngineHealth { provider: ProviderInfo; providerDetail: string }

export const getHealth = () => api<EngineHealth>('/health')
export const listRuns = () => api<AssessmentSummary[]>('/runs')
export const startRun = (companyId: string, policy: Policy) =>
  api<{ runId: string }>('/companies/' + companyId + '/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ policy }) })
export const cancelRun = (runId: string) => api<{ cancelled: boolean }>('/runs/' + runId + '/cancel', { method: 'POST' })
/** What-if analysis, computed by the engine from the run's recorded facts and policy. */
export const runWhatIf = (runId: string, settings: Simulation) =>
  api<Record<Scenario, Analysis>>('/runs/' + runId + '/what-if', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ settings }) })
/** Ask about a run; the engine answers from its facts and locates what the answer points to. */
export const askQuestion = (runId: string, question: string, findingId?: string | null, askId?: string) =>
  api<AskAnswer>('/runs/' + runId + '/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question, findingId, askId }) })
/** The steps taken so far for a question being answered. */
export const askSteps = (runId: string, askId: string) => api<{ steps: string[] }>('/runs/' + runId + '/ask/' + askId)
export const listQuestions = (runId: string) => api<AskAnswer[]>('/runs/' + runId + '/questions')
export const getRun = (runId: string) => api<{ summary: AssessmentSummary; events: RunEvent[]; active: boolean }>('/runs/' + runId)
export const verifyRunOnServer = (runId: string) => api<{ ok: boolean; events: number; brokenAt: number | null }>('/runs/' + runId + '/verify')

export const pageImageUrl = (companyId: string, file: string, page: number) => '/api/documents/' + companyId + '/' + encodeURIComponent(file) + '/pages/' + page + '.png'
export const originalPdfUrl = (companyId: string, file: string, page: number) => '/api/documents/' + companyId + '/' + encodeURIComponent(file) + '#page=' + page

export interface DossierDocument { kind: string; documentId: string; file: string; pages: number; sha256: string; supplied: { uploadId: string; by: string; at: string; originalName: string; replaces: boolean; mode: string } | null }
export interface DossierState { documents: DossierDocument[]; missing: string[]; uploads: DossierUpload[] }
export const getDossier = (companyId: string) => api<DossierState>('/companies/' + companyId + '/documents')
/** For every company: required documents still missing, and the kinds the employees added. */
export type Dossiers = Record<string, { missing: string[]; added: string[] }>
export const getDossiers = () => api<Dossiers>('/dossiers')
/** Add a document to the dossier; the engine checks it is this company's document of this type before accepting it. */
export const addDocument = (companyId: string, kind: string, file: File) =>
  api<DossierUpload>('/companies/' + companyId + '/documents?kind=' + encodeURIComponent(kind) + '&name=' + encodeURIComponent(file.name), { method: 'POST', headers: { 'content-type': 'application/pdf' }, body: file })
export const removeDocument = (companyId: string, uploadId: string) => api<{}>('/companies/' + companyId + '/documents/' + uploadId, { method: 'DELETE' })

/** All runs the engine knows, refreshed on demand and while any is active. */
export function useRunIndex() {
  const [runs, setRuns] = useState<AssessmentSummary[] | null>(null)
  const [offline, setOffline] = useState(false)
  const refresh = useCallback(() => listRuns().then(r => { setRuns(r); setOffline(false) }).catch(() => { setOffline(true); setRuns(r => r ?? []) }), [])
  useEffect(() => { refresh() }, [refresh])
  const active = runs?.some(r => r.status === 'running' || r.status === 'created')
  useEffect(() => {
    const id = window.setInterval(refresh, active || offline ? 2500 : 15000)
    return () => window.clearInterval(id)
  }, [refresh, active, offline])
  return { runs, offline, refresh }
}

export function latestCompleted(runs: AssessmentSummary[] | null, companyId: string): AssessmentSummary | null {
  return runs?.find(r => r.companyId === companyId && r.status === 'completed') ?? null
}
export function activeRun(runs: AssessmentSummary[] | null, companyId: string): AssessmentSummary | null {
  return runs?.find(r => r.companyId === companyId && (r.status === 'running' || r.status === 'created')) ?? null
}

/**
 * Follow one run: replay its stored events, then stay on the live stream.
 * The view is the fold of exactly the events received.
 */
export function useRunStream(runId: string | null) {
  const [view, setView] = useState<RunView | null>(null)
  const [events, setEvents] = useState<RunEvent[]>([])
  const [connection, setConnection] = useState<'connecting' | 'live' | 'closed' | 'error'>('connecting')
  const last = useRef(0)
  useEffect(() => {
    if (!runId) return
    last.current = 0
    setView(emptyRun(runId))
    setEvents([])
    setConnection('connecting')
    const source = new EventSource('/api/runs/' + runId + '/stream?after=0')
    const pending: RunEvent[] = []
    let frame = 0
    const flush = () => {
      frame = 0
      const batch = pending.splice(0)
      if (!batch.length) return
      setEvents(prev => [...prev, ...batch])
      setView(prev => batch.reduce(foldRun, prev ?? emptyRun(runId)))
    }
    source.addEventListener('open', () => setConnection('live'))
    source.addEventListener('run', message => {
      const event = JSON.parse((message as MessageEvent).data) as RunEvent
      if (event.seq <= last.current) return
      last.current = event.seq
      pending.push(event)
      if (!frame) frame = requestAnimationFrame(flush)
    })
    source.addEventListener('end', () => { flush(); setConnection('closed'); source.close() })
    source.addEventListener('error', () => { if (source.readyState === EventSource.CLOSED) setConnection('error') })
    return () => { source.close(); if (frame) cancelAnimationFrame(frame) }
  }, [runId])
  return { view, events, connection }
}

/** Recompute the run's hash chain in the browser, independently of the engine. */
export async function verifyRunLocally(events: RunEvent[]): Promise<{ ok: boolean; brokenAt: number | null }> {
  let prev = '0'.repeat(64)
  for (const e of events) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalEvent(e)))
    const hash = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
    if (e.prevHash !== prev || hash !== e.hash) return { ok: false, brokenAt: e.seq }
    prev = e.hash
  }
  return { ok: true, brokenAt: null }
}

export const clock = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + '.' + iso.slice(20, 23)
export const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
export function duration(from: string | null, to: string | null | number): string {
  if (!from) return '—'
  const ms = (typeof to === 'number' ? to : to ? Date.parse(to) : Date.now()) - Date.parse(from)
  return ms < 1000 ? ms + ' ms' : ms < 60000 ? (ms / 1000).toFixed(1) + ' s' : Math.floor(ms / 60000) + ' min ' + Math.round(ms % 60000 / 1000) + ' s'
}
