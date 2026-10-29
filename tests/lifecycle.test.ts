// From an application to a signed credit client, and what the bank does when
// monitoring then finds something serious. No model, no network: the engine
// writes the assistant's texts itself, and the news signal is a planted test.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { Company } from '../src/types.ts'
import type { ClientRisk, CompanyRequest, Workflow } from '../src/workspace.ts'
import type { ClientStatus, MonitorEvent } from '../src/monitoring.ts'
import { type EngineProcess, readStream, startEngine } from './support/engine.ts'

const COMPANY = 'TEST-DOS-001' // AAGES S.A.: eligible, no problems
let engine: EngineProcess
let runId = ''
const as = (user: string) => ({
  get: async <T = any>(path: string): Promise<T> => (await fetch(engine.url + '/api' + path, { headers: { 'x-user': user } })).json() as Promise<T>,
  post: async <T = any>(path: string, body: unknown = {}): Promise<{ status: number; body: T }> => {
    const res = await fetch(engine.url + '/api' + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-user': user }, body: JSON.stringify(body) })
    return { status: res.status, body: await res.json() as T }
  },
})
const analyst = as('u-credit-1') // Elena Dumitrescu
const approver = as('u-finance-2') // Cristina Dobre
const step = (who: ReturnType<typeof as>, action: string, extra: object = {}) => who.post<Workflow & { error: string }>('/companies/' + COMPANY + '/workflow', { runId, action, ...extra })

before(async () => {
  engine = await startEngine({ CREDITDESK_LLM: 'none', CREDITDESK_ANAF: 'off', CREDITDESK_MONITOR_WEB: 'off', CREDITDESK_SEND_DELAY_MS: '50' })
  runId = (await analyst.post<{ runId: string }>('/companies/' + COMPANY + '/runs')).body.runId
  await readStream(engine.url + '/api/runs/' + runId + '/stream?after=0')
})
after(async () => { await engine?.stop() })

test('an eligible application goes through every section, a recommendation, a second approval, the contract and the signature', async () => {
  assert.deepEqual((await step(analyst, 'approve')).body.error, 'Every section has to be reviewed first')
  for (const section of ['findings', 'financials', 'documents', 'scenarios', 'audit']) assert.equal((await step(analyst, 'review', { section })).status, 200)
  assert.equal((await step(analyst, 'approve')).body.error, 'An analyst has to record an approval recommendation first')
  await analyst.post('/activity', { companyId: COMPANY, action: 'Review recorded', detail: 'Strong coverage and clean dossier; I recommend approval.', payload: { runId, recommendation: 'approval' } })
  // Four eyes: the analyst who recommended cannot approve.
  const self = await step(analyst, 'approve')
  assert.deepEqual([self.status, self.body.error], [409, 'A second employee has to approve (switch employee from the menu)'])
  assert.equal((await step(approver, 'sign')).body.error, 'The contract has to be sent for signature first')
  const approved = await step(approver, 'approve')
  assert.deepEqual([approved.status, approved.body.approval?.by], [200, 'Cristina Dobre'])
  const sent = await step(analyst, 'send')
  assert.match(sent.body.sent!.to, /representative|@/)
  const signed = await step(analyst, 'sign')
  assert.deepEqual([signed.body.signed?.by, signed.body.client], ['Elena Dumitrescu', true])
  // It is now a credit client: a credit line made from the application, monitored from now on, out of Run all.
  const { clients } = await analyst.get<{ clients: Company[] }>('/clients')
  const client = clients.find(c => c.id === COMPANY)!
  assert.deepEqual([client.creditLine!.limit, client.creditLine!.drawn, client.creditLine!.approvedBy, client.creditLine!.relationshipManager], [client.tables.solicitari[0].suma_solicitata, 0, 'Cristina Dobre', 'Elena Dumitrescu'])
  const monitoring = await analyst.get<{ clients: ClientStatus[] }>('/monitoring')
  assert.ok(monitoring.clients.some(c => c.companyId === COMPANY), 'monitored')
  const log = (await analyst.get<{ action: string; actor: string }[]>('/activity?company=' + COMPANY)).map(e => e.action)
  assert.deepEqual(log.filter(a => /Credit approval|Contract|credit client/.test(a)), ['Credit approval granted', 'Contract sent for signature', 'Contract signature recorded', 'Became a credit client'])
})

test('a critical signal: the assistant weighs it and proposes what to do; the watchlist opens a case; a freeze needs a second employee', async () => {
  await analyst.post('/monitoring/simulate', { companyId: COMPANY, kind: 'news-insolvency' })
  await analyst.post('/monitoring/check', { companyId: COMPANY })
  let event: MonitorEvent | undefined
  for (let i = 0; i < 200 && !event; i++) { event = (await analyst.get<{ events: MonitorEvent[] }>('/monitoring')).events.find(e => e.companyId === COMPANY && e.severity === 'alert'); if (!event) await new Promise(r => setTimeout(r, 50)) }
  assert.ok(event, 'the critical signal was raised')
  const note = await analyst.post<{ severity: string; grade: string; actions: { kind: string }[]; exposure: string; author: string }>('/monitoring/assess', { companyId: COMPANY, eventId: event!.id })
  assert.deepEqual([note.status, note.body.severity, note.body.grade, note.body.author], [200, 'critical', 'red', 'engine'])
  assert.deepEqual(note.body.actions.map(a => a.kind), ['watchlist', 'information', 'freeze', 'reassess', 'legal'])
  assert.match(note.body.exposure, /^Drawn RON\s0, undrawn RON\s[\d,]+ of RON\s[\d,]+; \d+ months to maturity\.$/)
  const talk = await analyst.post<{ answer: string }>('/monitoring/discuss', { companyId: COMPANY, eventId: event!.id, question: 'How bad is this for our loan?', history: [] })
  assert.equal(talk.status, 200)
  // Watchlist: a case in Credit, owned by the employee.
  const watched = await analyst.post<ClientRisk>('/clients/' + COMPANY + '/watchlist', { grade: 'red', reason: 'Insolvency reported in the press' })
  assert.equal(watched.status, 200, JSON.stringify(watched.body))
  assert.deepEqual([watched.body.watchlist?.grade, watched.body.watchlist?.owner], ['red', 'Elena Dumitrescu'])
  const caseId = watched.body.watchlist!.caseId!
  const opened = await analyst.get<{ case: { department: string; assignee: string; title: string } }>('/cases/' + caseId)
  assert.deepEqual([opened.case.department, opened.case.assignee, opened.case.title], ['credit', 'Elena Dumitrescu', 'Early warning: Insolvency reported in the press'])
  // The request for information is drafted into that case, for the employee to send.
  const notice = await analyst.post<{ request: CompanyRequest }>('/monitoring/notice', { companyId: COMPANY, eventId: event!.id, language: 'en' })
  assert.deepEqual([notice.status, notice.body.request.caseId, notice.body.request.status], [201, caseId, 'draft'])
  assert.match(notice.body.request.body, /information undertakings of facility CL-\d{4}-001/)
  // Freeze: asked by one employee, approved by another.
  assert.equal((await analyst.post<ClientRisk>('/clients/' + COMPANY + '/freeze', { reason: 'Insolvency reported' })).body.freeze?.status, 'requested')
  const self = await analyst.post<{ error: string }>('/clients/' + COMPANY + '/freeze/approve')
  assert.deepEqual([self.status, self.body.error], [409, 'A second employee has to approve the freeze (switch employee from the menu)'])
  assert.deepEqual((await approver.post<ClientRisk>('/clients/' + COMPANY + '/freeze/approve')).body.freeze?.status, 'active')
  const log = (await analyst.get<{ action: string; actor: string }[]>('/activity?company=' + COMPANY)).filter(e => /watchlist|freeze|information/i.test(e.action)).map(e => e.action + ' · ' + e.actor)
  assert.deepEqual(log, ['Client put on the watchlist (red) · Elena Dumitrescu', 'Request for information drafted · Elena Dumitrescu', 'Drawdown freeze requested · Elena Dumitrescu', 'Drawdown freeze approved · Cristina Dobre'])
})
