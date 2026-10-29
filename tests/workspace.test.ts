// Employees, departments, cases, contacts, requests and the activity log,
// through the real engine process. No model: the engine writes the drafts.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import type { Finding, RunEvent } from '../src/assessment.ts'
import type { ActivityEvent, Case, CaseEvent, CompanyRequest, Contact, SuggestionSet, User } from '../src/workspace.ts'
import { type EngineProcess, readStream, startEngine } from './support/engine.ts'

const COMPANY = 'TEST-DOS-018' // CONPET: requested amount conflict (a Finance problem)
let engine: EngineProcess
let runId = ''
let finding: Finding

const as = (user: string) => ({
  get: async <T = any>(path: string): Promise<T> => (await fetch(engine.url + '/api' + path, { headers: { 'x-user': user } })).json() as Promise<T>,
  post: async <T = any>(path: string, body: unknown = {}): Promise<{ status: number; body: T }> => {
    const res = await fetch(engine.url + '/api' + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-user': user }, body: JSON.stringify(body) })
    return { status: res.status, body: await res.json() as T }
  },
})
const legal = as('u-legal-1')
const finance = as('u-finance-1')

before(async () => {
  engine = await startEngine({ CREDITDESK_LLM: 'none', CREDITDESK_ANAF: 'off', GOOGLE_CLIENT_ID: 'client-123.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'secret', CREDITDESK_SEND_DELAY_MS: '250' })
  runId = (await legal.post<{ runId: string }>('/companies/' + COMPANY + '/runs')).body.runId
  const { arrivals } = await readStream(engine.url + '/api/runs/' + runId + '/stream?after=0')
  finding = arrivals.map(a => a.event).find((e): e is RunEvent<'finding_raised'> => e.type === 'finding_raised')!.payload.finding
})
after(async () => { await engine?.stop() })

test('the workspace opens as the Legal employee; others can be chosen or added', async () => {
  const me = await engine.get<{ user: User; users: User[] }>('/me')
  assert.equal(me.user.department, 'legal')
  assert.equal(me.users.length, 6)
  assert.equal((await finance.get<{ user: User }>('/me')).user.name, 'Andrei Popa')
  const added = await legal.post<User>('/users', { name: 'Dana Pavel', title: 'Paralegal', department: 'legal' })
  assert.equal(added.status, 201)
  assert.equal(added.body.initials, 'DP')
  assert.equal((await legal.post('/users', { name: 'X', department: 'nowhere' })).status, 400)
  // The run records who started it.
  assert.equal((await engine.get('/runs/' + runId)).summary.startedBy, 'Ioana Marinescu')
})

test('a problem is sent to a department once, and its case keeps a timeline', async () => {
  const opened = await legal.post<{ case: Case; created: boolean }>('/cases', { companyId: COMPANY, runId, findingId: finding.id, department: 'finance', note: 'Please confirm which amount is right.' })
  assert.equal(opened.status, 201)
  const c = opened.body.case
  assert.deepEqual([c.department, c.status, c.title, c.createdBy, c.finding?.id], ['finance', 'open', finding.title, 'Ioana Marinescu', finding.id])
  assert.match(c.ref, /^#\d+$/)
  // Opening a case starts the assistant: it looks up the company contact, then writes the suggested email.
  let assisted: { assistant: string | null; events: CaseEvent[]; requests: CompanyRequest[] }
  for (;;) { assisted = await legal.get('/cases/' + c.id); if (!assisted.assistant && assisted.requests.length) break; await new Promise(r => setTimeout(r, 50)) }
  assert.deepEqual(assisted.events.map(e => [e.kind, e.author]), [['opened', 'Ioana Marinescu'], ['contact', 'Assistant'], ['request', 'Assistant']])
  assert.match(assisted.events[1].text, /no model available to search the web/)
  assert.equal(assisted.requests.length, 1)
  assert.equal(assisted.requests[0].to.email, '', 'no contact was found, so the draft has no recipient yet')
  assert.ok(assisted.requests[0].body.includes('Ioana Marinescu'))
  const again = await legal.post<{ case: Case; created: boolean }>('/cases', { companyId: COMPANY, runId, findingId: finding.id, department: 'finance', note: 'Second look.' })
  assert.deepEqual([again.status, again.body.created, again.body.case.id], [200, false, c.id])
  assert.equal((await legal.post('/cases', { companyId: COMPANY, runId, findingId: 'nope', department: 'legal' })).status, 400)

  assert.equal((await finance.post('/cases/' + c.id, { status: 'in_progress', assignee: 'u-finance-1' })).status, 200)
  assert.equal((await finance.post('/cases/' + c.id + '/comments', { text: 'Checking the application against the contract.' })).status, 201)
  const detail = await finance.get<{ case: Case; events: CaseEvent[] }>('/cases/' + c.id)
  assert.deepEqual([detail.case.status, detail.case.assignee], ['in_progress', 'Andrei Popa'])
  assert.deepEqual(detail.events.map(e => [e.kind, e.author]), [
    ['opened', 'Ioana Marinescu'], ['contact', 'Assistant'], ['request', 'Assistant'], ['comment', 'Ioana Marinescu'], ['status', 'Andrei Popa'], ['assigned', 'Andrei Popa'], ['comment', 'Andrei Popa'],
  ])
  assert.deepEqual((await legal.get<Case[]>('/cases?department=finance')).map(x => x.id), [c.id])
  assert.deepEqual(await legal.get<Case[]>('/cases?department=legal'), [])
})

test('contacts: the dossier has no reachable representative until one is added', async () => {
  const initial = await legal.get<Contact[]>('/companies/' + COMPANY + '/contacts')
  assert.equal(initial.length, 1)
  assert.deepEqual([initial[0].source, initial[0].placeholder, initial[0].email], ['dossier', true, ''])
  assert.equal((await legal.post('/companies/' + COMPANY + '/contacts', { name: 'Maria Enache', email: 'not-an-email' })).status, 400)
  const saved = await legal.post<Contact[]>('/companies/' + COMPANY + '/contacts', { name: 'Maria Enache', role: 'CFO', email: 'maria.enache@conpet.example.ro', phone: '+40 244 000 000' })
  assert.equal(saved.status, 201)
  assert.deepEqual([saved.body[0].name, saved.body[0].placeholder, saved.body[0].addedBy], ['Maria Enache', false, 'Ioana Marinescu'])
})

test('the assistant drafts a request for a case; Send records it as sent, simulated, with who, when and to whom', async () => {
  const [c] = await legal.get<Case[]>('/cases?company=' + COMPANY)
  const drafted = await legal.post<{ request: CompanyRequest; author: string }>('/cases/' + c.id + '/request', { language: 'en' })
  assert.equal(drafted.status, 201)
  const r = drafted.body.request
  assert.equal(drafted.body.author, 'engine')
  assert.deepEqual([r.status, r.caseId, r.to.email, r.to.name], ['draft', c.id, 'maria.enache@conpet.example.ro', 'Maria Enache'])
  assert.ok(r.subject.includes('CONPET SA') && r.subject.includes(c.ref))
  assert.ok(r.requirements.length > 0 && r.body.includes(r.requirements[0]) && r.body.includes('Ioana Marinescu'))
  const edited = await legal.post<CompanyRequest>('/requests/' + r.id, { subject: 'CONPET SA: please confirm the requested amount' })
  assert.equal(edited.body.subject, 'CONPET SA: please confirm the requested amount')
  const started = Date.now()
  const sent = await legal.post<CompanyRequest>('/requests/' + r.id + '/send')
  assert.ok(Date.now() - started >= 200, 'Send takes a moment, like a real one')
  assert.equal(sent.status, 200)
  assert.deepEqual([sent.body.status, sent.body.simulated, sent.body.sentBy, sent.body.deliveredTo], ['sent', true, 'Ioana Marinescu', 'maria.enache@conpet.example.ro'])
  assert.ok(Date.parse(sent.body.sentAt!) >= started)
  const timeline = await legal.get<{ events: CaseEvent[]; requests: CompanyRequest[] }>('/cases/' + c.id)
  assert.deepEqual([timeline.events.at(-1)!.kind, timeline.events.at(-1)!.data.simulated], ['email', true])
  assert.equal((await legal.post<{ error: string }>('/requests/' + r.id + '/send')).status, 409, 'sent once')
  assert.equal(timeline.requests.length, 2, 'the assistant suggestion and the employee draft')
})

test('the assistant suggests a comment and a requirement per problem, and writes a case report', async () => {
  const made = await legal.post<SuggestionSet>('/companies/' + COMPANY + '/suggestions')
  assert.equal(made.status, 201)
  assert.deepEqual(made.body.items.map(i => [i.findingId, i.department]), [[finding.id, 'finance']])
  assert.ok(made.body.items[0].requirement.length > 10)
  assert.deepEqual(await legal.get('/companies/' + COMPANY + '/suggestions'), made.body)
  const [c] = await legal.get<Case[]>('/cases?company=' + COMPANY)
  const report = await legal.post<CaseEvent>('/cases/' + c.id + '/report')
  assert.equal(report.status, 201)
  assert.equal(report.body.kind, 'report')
  assert.ok(report.body.data.report.paragraphs.length >= 3)
  assert.ok(report.body.data.report.paragraphs.some((p: string) => /sent to Maria Enache <maria\.enache@conpet\.example\.ro> by Ioana Marinescu on .*simulated/.test(p)), 'the report says what was sent, to whom, when, and that delivery was simulated')
})

test('the company activity log records who did what, chained so it can be verified', async () => {
  assert.equal((await finance.post('/activity', { companyId: COMPANY, action: 'Analyst note added', detail: 'Called the CFO.' })).status, 201)
  const log = await legal.get<ActivityEvent[]>('/activity?company=' + COMPANY)
  assert.deepEqual(log.map(e => [e.action, e.actor]), [['Problem sent to Finance', 'Ioana Marinescu'], ['Company contact researched', 'engine'], ['Contact saved', 'Ioana Marinescu'], ['Request sent (simulated)', 'Ioana Marinescu'], ['Analyst note added', 'Andrei Popa']])
  assert.match(log[3].detail, /→ Maria Enache <maria\.enache@conpet\.example\.ro> · simulated delivery: no email left Finra$/)
  let previous = '0'.repeat(64)
  for (const { hash, ...body } of log) {
    assert.equal(body.previousHash, previous)
    assert.equal(createHash('sha256').update(JSON.stringify(body)).digest('hex'), hash)
    previous = hash
  }
})

test('sending stays simulated: real email cannot be switched on from the workspace', async () => {
  assert.deepEqual(await legal.get('/settings'), { delivery: 'simulated', realEmail: false })
  const live = await legal.post<{ error: string }>('/settings', { delivery: 'live' })
  assert.deepEqual([live.status, live.body.error], [400, 'Real email is switched off in this workspace: sending is simulated.'])
  assert.equal((await legal.post('/settings', { delivery: 'everyone' })).status, 400)
  assert.deepEqual(await legal.get('/settings'), { delivery: 'simulated', realEmail: false })
})

test('Gmail sign-in goes to Google with PKCE and the send-only scope; an unknown sign-in is refused', async () => {
  const state = await legal.get('/gmail')
  assert.deepEqual([state.configured, state.connected], [true, null])
  const res = await fetch(engine.url + '/api/gmail/connect?user=u-legal-1&back=' + encodeURIComponent('/#/departments'), { redirect: 'manual' })
  assert.equal(res.status, 302)
  const to = new URL(res.headers.get('location')!)
  assert.equal(to.origin + to.pathname, 'https://accounts.google.com/o/oauth2/v2/auth')
  assert.equal(to.searchParams.get('client_id'), 'client-123.apps.googleusercontent.com')
  assert.equal(to.searchParams.get('redirect_uri'), engine.url + '/api/gmail/callback')
  assert.equal(to.searchParams.get('code_challenge_method'), 'S256')
  assert.ok(to.searchParams.get('scope')!.split(' ').includes('https://www.googleapis.com/auth/gmail.send'))
  const back = await fetch(engine.url + '/api/gmail/callback?state=unknown&code=x', { redirect: 'manual' })
  assert.equal(back.headers.get('location'), '/?gmail=expired')
})

test('Run all assesses every company, a few at a time, and keeps every run', async () => {
  const started = await finance.post('/runs/all', {})
  assert.equal(started.status, 202)
  assert.equal((await finance.post('/runs/all', {})).status, 409, 'one batch at a time')
  let status: any
  for (let i = 0; i < 600; i++) {
    status = await engine.get('/runs/all')
    assert.ok(status.running.length <= 6)
    if (!status.active) break
    await new Promise(r => setTimeout(r, 100))
  }
  assert.equal(status.total, 50)
  assert.equal(status.finished.filter((f: any) => f.status === 'completed').length, 50)
  const runs = await engine.get('/runs')
  assert.equal(runs.length, 51, 'the earlier run is kept alongside the 50 new ones')
  assert.ok(runs.filter((r: any) => r.runId !== runId).every((r: any) => r.startedBy === 'Andrei Popa'))
})
