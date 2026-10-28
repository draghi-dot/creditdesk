import { useCallback, useEffect, useState } from 'react'
import type { Policy } from './types'
import type { ActivityEvent, Case, CaseEvent, CaseReport, CaseStatus, CompanyRequest, Contact, Delivery, DepartmentId, GmailState, SuggestionSet, User, WorkspaceSettings } from './workspace'
import { api, setActingUser } from './runs'
import type { ClientStatus, MonitorEvent } from './monitoring'

export interface Session { user: User; users: User[]; gmail: GmailState }

export function useSession() {
  const [session, setSession] = useState<Session | null>(null)
  const refresh = useCallback(() => api<Session>('/me').then(s => { setSession(s); return s }).catch(() => null), [])
  useEffect(() => { refresh() }, [refresh])
  const switchUser = useCallback((id: string) => { setActingUser(id); return refresh() }, [refresh])
  return { session, refresh, switchUser }
}

const post = <T>(path: string, body: unknown = {}) => api<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

export const addUser = (input: { name: string; title: string; department: DepartmentId }) => post<User>('/users', input)

export const listCases = (filter: { department?: DepartmentId; company?: string } = {}) => api<Case[]>('/cases?' + new URLSearchParams(filter as Record<string, string>))
export const openCase = (input: { companyId: string; runId: string | null; findingId?: string; department: DepartmentId; note?: string; title?: string }) => post<{ case: Case; created: boolean }>('/cases', input)
export const getCase = (id: string) => api<{ case: Case; events: CaseEvent[]; requests: CompanyRequest[]; assistant: string | null }>('/cases/' + id)
export const updateCase = (id: string, change: { status?: CaseStatus; assignee?: string | null; department?: DepartmentId }) => post<Case>('/cases/' + id, change)
export const commentCase = (id: string, text: string) => post<CaseEvent>('/cases/' + id + '/comments', { text })
export const writeCaseReport = (id: string) => post<CaseEvent & { data: { report: CaseReport; author: string; unsupported: string[] } }>('/cases/' + id + '/report')

export interface Drafted { request: CompanyRequest; author: string; unsupported: string[] }
export const draftCaseRequest = (id: string, options: { language: 'en' | 'ro'; instructions?: string; contactId?: string }) => post<Drafted>('/cases/' + id + '/request', options)
export const draftCompanyRequest = (companyId: string, options: { findingIds?: string[]; language: 'en' | 'ro'; instructions?: string; contactId?: string }) => post<Drafted>('/companies/' + companyId + '/requests', options)
export const listRequests = (companyId: string) => api<CompanyRequest[]>('/companies/' + companyId + '/requests')
export const saveRequest = (id: string, change: Partial<Pick<CompanyRequest, 'subject' | 'body' | 'requirements' | 'to'>>) => post<CompanyRequest>('/requests/' + id, change)
export const sendRequest = (id: string) => post<CompanyRequest>('/requests/' + id + '/send')

export const listContacts = (companyId: string) => api<Contact[]>('/companies/' + companyId + '/contacts')
export const saveContact = (companyId: string, contact: { id?: string; name: string; role: string; email: string; phone: string }) => post<Contact[]>('/companies/' + companyId + '/contacts', contact)
export const removeContact = (companyId: string, id: string) => api<Contact[]>('/companies/' + companyId + '/contacts/' + id, { method: 'DELETE' })
/** Public contact research by the assistant; the result says what was found, in words. */
export const findContact = (companyId: string) => post<{ result: string; contacts: Contact[] }>('/companies/' + companyId + '/contacts/find')
export interface FindAllStatus { active: boolean; total: number; done: number; current: string | null; results: { companyId: string; result: string }[] }
export const findAllStatus = () => api<FindAllStatus>('/contacts/find-all')
export const findAllContacts = () => post<FindAllStatus>('/contacts/find-all')
export const getSettings = () => api<WorkspaceSettings>('/settings')
export const setDelivery = (delivery: Delivery) => post<WorkspaceSettings>('/settings', { delivery })

export const getSuggestions = (companyId: string) => api<SuggestionSet | null>('/companies/' + companyId + '/suggestions')
export const makeSuggestions = (companyId: string) => post<SuggestionSet>('/companies/' + companyId + '/suggestions')

export const listActivity = (companyId?: string) => api<ActivityEvent[]>('/activity' + (companyId ? '?company=' + companyId : ''))
export const recordActivity = (companyId: string, action: string, detail: string, payload?: unknown) => post<ActivityEvent>('/activity', { companyId, action, detail, payload })

export const getGmail = () => api<GmailState>('/gmail')
export const disconnectGmail = () => post<GmailState>('/gmail/disconnect')
/** Google's sign-in page; it comes back to `back` (a workspace route) with ?gmail=connected or an error. */
export const gmailConnectUrl = (userId: string, back: string) => '/api/gmail/connect?' + new URLSearchParams({ user: userId, back })

export interface BatchStatus { active: boolean; total: number; queued: number; running: { companyId: string; runId: string }[]; finished: { companyId: string; runId: string | null; status: string }[]; startedBy: string | null; startedAt: string | null }
export const batchStatus = () => api<BatchStatus>('/runs/all')
export const runAll = (policy: Policy) => post<BatchStatus>('/runs/all', { policy })
export const stopAll = () => post<BatchStatus>('/runs/all/stop')

/** Open cases, refreshed on demand. */
export function useCases(filter: { department?: DepartmentId; company?: string }) {
  const [cases, setCases] = useState<Case[] | null>(null)
  const key = JSON.stringify(filter)
  const refresh = useCallback(() => listCases(filter).then(setCases).catch(() => setCases(c => c ?? [])), [key])
  useEffect(() => { refresh() }, [refresh])
  return { cases, refresh }
}

// ─── Live monitoring of credit clients ─────────────────────────────────────
export interface MonitoringState { clients: ClientStatus[]; events: MonitorEvent[]; intervalMinutes: number }
export const getMonitoring = () => api<MonitoringState>('/monitoring')
export const checkNow = (companyId?: string) => post<ClientStatus[]>('/monitoring/check', companyId ? { companyId } : {})
export const researchClient = (companyId: string) => post<{ result: string }>('/monitoring/research', { companyId })
export const reviewEvent = (id: string) => post<MonitorEvent>('/monitoring/events/' + id + '/review')

/** Monitoring status and events, kept current from the engine's live feed. */
export function useMonitoring() {
  const [state, setState] = useState<MonitoringState | null>(null)
  const refresh = useCallback(() => getMonitoring().then(setState).catch(() => {}), [])
  useEffect(() => {
    refresh()
    const source = new EventSource('/api/monitoring/stream')
    let timer = 0
    source.addEventListener('monitor', () => { window.clearTimeout(timer); timer = window.setTimeout(refresh, 400) })
    return () => { source.close(); window.clearTimeout(timer) }
  }, [refresh])
  return { state, refresh }
}
