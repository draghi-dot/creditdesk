// The engine as the workspace uses it: over HTTP, with the live run stream,
// rendered original pages and questions. No model and no network here; the
// live paths are covered by tests/live (npm run test:live).
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { AskAnswer, EventPayloads, RunEvent } from '../src/assessment.ts'
import { ROLES } from '../src/assessment.ts'
import { type Arrival, type EngineProcess, pngSize, readStream, startEngine } from './support/engine.ts'

const COMPANY = 'TEST-DOS-018' // CONPET: the application prints a different requested amount than the one recorded
let engine: EngineProcess
let runId = ''
let arrivals: Arrival[] = []
let connectedAt = 0

before(async () => { engine = await startEngine({ CREDITDESK_LLM: 'none', CREDITDESK_ANAF: 'off' }) })
after(async () => { await engine?.stop() })

const events = () => arrivals.map(a => a.event)
const findings = () => events().filter((e): e is RunEvent<'finding_raised'> => e.type === 'finding_raised').map(e => e.payload.finding)

test('nothing runs until an assessment is started, then the stream delivers the run as it executes', async () => {
  assert.equal((await engine.get('/health')).provider.id, 'none')
  assert.deepEqual(await engine.get('/companies/' + COMPANY + '/runs'), { runs: [], active: null })

  runId = (await engine.post('/companies/' + COMPANY + '/runs')).runId
  ;({ arrivals, connectedAt } = await readStream(engine.url + '/api/runs/' + runId + '/stream?after=0'))
  const list = events()
  assert.equal(list[0].type, 'run_created')
  assert.equal(list.at(-1)!.type, 'run_completed')
  assert.deepEqual(list.map(e => e.seq), list.map((_, i) => i + 1), 'every event exactly once, in order')
  // Delivered as the engine produced it, not replayed at the end: most events were written after the stream connected.
  const live = list.filter(e => Date.parse(e.ts) >= connectedAt)
  assert.ok(live.length > list.length / 2, live.length + ' of ' + list.length + ' events were emitted after the stream connected')
  assert.ok(arrivals.at(-1)!.at > arrivals[0].at, 'events arrived over time')

  // A worker is dispatched only after every dependency completed, and is shown waiting before that.
  const at = (type: string, worker: string) => list.findIndex(e => e.type === type && e.worker === worker)
  for (const role of ROLES) {
    const dispatched = at('worker_dispatched', role.id)
    assert.ok(dispatched > 0, role.id + ' dispatched')
    for (const dep of role.dependsOn) assert.ok(at('worker_completed', dep) < dispatched, role.id + ' waits for ' + dep)
    if (role.dependsOn.length) assert.ok(at('worker_waiting', role.id) < dispatched, role.id + ' shown waiting first')
  }
  assert.deepEqual(await engine.get('/runs/' + runId + '/verify'), { ok: true, events: list.length, brokenAt: null })
  const history = await engine.get('/companies/' + COMPANY + '/runs')
  assert.deepEqual(history.runs.map((r: any) => [r.runId, r.status]), [[runId, 'completed']])
})

test('a finding carries located evidence and its page renders at the proportions the boxes refer to', async () => {
  const amount = findings().find(f => f.title.startsWith('Requested amount'))
  assert.ok(amount, 'requested-amount finding raised')
  const [application, contract] = amount.evidence
  assert.equal(application.kind, 'cerere_finantare')
  assert.ok(application.marks.some(m => m.tone === 'issue'), 'problem outlined (red)')
  assert.ok(amount.evidence.some(e => e.marks.some(m => m.tone === 'reference')), 'comparison outlined (blue)')
  assert.equal(contract.kind, 'contract_demo')
  for (const ref of amount.evidence) {
    for (const m of ref.marks) assert.ok(m.box.x0 >= 0 && m.box.y0 >= 0 && m.box.x1 <= ref.pageWidth && m.box.y1 <= ref.pageHeight && m.box.x1 > m.box.x0 && m.box.y1 > m.box.y0, 'box inside the page')
    const res = await fetch(engine.url + '/api/documents/' + COMPANY + '/' + encodeURIComponent(ref.file) + '/pages/' + ref.page + '.png')
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'image/png')
    const { width, height } = pngSize(new Uint8Array(await res.arrayBuffer()))
    assert.ok(Math.abs(width / height - ref.pageWidth / ref.pageHeight) < 0.01, 'rendered page has the PDF page proportions')
  }
  const missing = await fetch(engine.url + '/api/documents/' + COMPANY + '/' + encodeURIComponent(application.file) + '/pages/99.png')
  assert.equal(missing.status, 404)
})

test('without a model, Ask answers from the recorded finding and does not repeat itself', async () => {
  const decision = events().find(e => e.type === 'decision_reached')!.payload as EventPayloads['decision_reached']
  assert.ok(decision)
  const finding = findings().find(f => f.title.startsWith('Requested amount'))!
  const ask = (question: string) => engine.post<AskAnswer>('/runs/' + runId + '/ask', { question, findingId: finding.id })
  const first = await ask('Explain this problem in plain words')
  assert.equal(first.author, 'engine · no model')
  assert.equal(first.findingId, finding.id)
  assert.deepEqual(first.evidence, finding.evidence)
  assert.ok(first.answer.includes(finding.whyItMatters))
  const second = await ask('tell me more')
  assert.notEqual(second.answer, first.answer)
  assert.ok(second.answer.includes(finding.comparedAgainst))
  const third = await ask('tell me more')
  assert.match(third.answer, /^Located in the financing application, page 1/)
  const fourth = await ask('tell me more')
  assert.match(fourth.answer, /everything this run recorded/)
  assert.equal(new Set([first, second, third, fourth].map(a => a.answer)).size, 4)
  const stored = await engine.get<AskAnswer[]>('/runs/' + runId + '/questions')
  assert.equal(stored.length, 4)
})
