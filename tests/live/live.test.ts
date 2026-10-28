// The live paths, end to end through the engine's HTTP API: the real ANAF
// register and real Codex model calls (legal reading, report, Ask). Needs
// network access and a signed-in Codex CLI (`codex login`).
//
//   npm run test:live
//
// Writes what the model returned to test-results/live-summary.json.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import type { AskAnswer, EventPayloads, NoteView, RunEvent } from '../../src/assessment.ts'
import { foldAll, rankFindings } from '../../src/assessment.ts'
import { lookupAnaf } from '../../server/engine/anaf.ts'
import { codexStatus } from '../../server/engine/codex.ts'
import { type EngineProcess, readStream, startEngine } from '../support/engine.ts'

const COMPANY = 'TEST-DOS-018' // CONPET SA, CUI 1350020
const MODEL = process.env.CODEX_MODEL ?? 'gpt-6.1-sol'
const AUTHOR = 'Codex ' + MODEL + ' · ' + (process.env.CODEX_EFFORT ?? 'medium')
const summary: Record<string, unknown> = { company: COMPANY, model: AUTHOR, startedAt: new Date().toISOString() }
const timings: Record<string, number> = {}
let engine: EngineProcess
let runId = ''
let list: RunEvent[] = []

before(async () => {
  const status = await codexStatus(process.env.CODEX_COMMAND ?? 'codex')
  assert.ok(status.available, 'Codex CLI must be installed and signed in (codex login): ' + status.detail)
  engine = await startEngine({ CREDITDESK_LLM: 'codex', CREDITDESK_ANAF: 'on' })
})

after(async () => {
  await engine?.stop()
  summary.timingsMs = timings
  mkdirSync(new URL('../../test-results', import.meta.url), { recursive: true })
  writeFileSync(new URL('../../test-results/live-summary.json', import.meta.url), JSON.stringify(summary, null, 2))
  console.log('Timings (ms): ' + JSON.stringify(timings))
})

test('ANAF PlatitorTvaRest v9 answers live for a real CUI and reports an unknown one as not found', async () => {
  const today = new Date().toISOString().slice(0, 10)
  const started = Date.now()
  const hit = await lookupAnaf('1350020', today, AbortSignal.timeout(30_000), 20_000)
  timings.anafLookup = Date.now() - started
  assert.equal(hit.error, null)
  assert.equal(hit.found?.name, 'CONPET SA')
  assert.equal(hit.found?.cui, 1350020)
  assert.match(hit.found!.registrationStatus, /INREGISTRAT/)
  assert.equal(hit.found!.tradeRegister.startsWith('J'), true)
  const miss = await lookupAnaf('99999999', today, AbortSignal.timeout(30_000), 20_000)
  assert.deepEqual([miss.found, miss.error], [null, null])
  summary.anaf = { found: hit.found, unknownCui: '99999999 → not found' }
})

test('a full assessment with the model: live ANAF identity, Codex legal reading and report, quotes located', async () => {
  const started = Date.now()
  runId = (await engine.post('/companies/' + COMPANY + '/runs')).runId
  list = (await readStream(engine.url + '/api/runs/' + runId + '/stream?after=0')).arrivals.map(a => a.event)
  timings.assessment = Date.now() - started
  const view = foldAll(runId, list)
  assert.equal(view.status, 'completed', 'run ended ' + view.status + ': ' + view.failure)
  assert.deepEqual(await engine.get('/runs/' + runId + '/verify'), { ok: true, events: list.length, brokenAt: null })

  const anaf = view.notes.find(n => n.title === 'ANAF public register') as NoteView
  assert.ok(anaf.verified, anaf.text)
  assert.match(anaf.author, /^ANAF PlatitorTvaRest v9 · live, \d+ ms$/)
  assert.equal(anaf.fields?.find(f => f.label === 'Registered name')?.value, 'CONPET SA')

  // Every model call the engine made finished with a schema-valid answer.
  const calls = list.filter((e): e is RunEvent<'llm_started'> => e.type === 'llm_started')
  assert.deepEqual(calls.map(e => e.worker), ['legal', 'handoff'])
  for (const call of calls) {
    const done = list.find((e): e is RunEvent<'llm_finished'> => e.type === 'llm_finished' && e.worker === call.worker && e.seq > call.seq)
    assert.ok(done, call.worker + ' model call finished')
    assert.equal(done.payload.ok, true, call.worker + ': ' + done.payload.reason)
    timings['model:' + call.worker] = done.payload.durationMs
  }

  const legal = view.notes.find(n => n.title === 'Legal reading') as NoteView
  assert.equal(legal.author, AUTHOR)
  const points = legal.points ?? []
  const located = points.filter(p => p.verified)
  assert.equal(located.length > 0, legal.evidence.length > 0, 'located quotes come with evidence on the page')
  for (const ref of legal.evidence) assert.ok(ref.marks.length > 0 && ref.page >= 1 && ref.page <= ref.pageCount)

  const report = list.find((e): e is RunEvent<'report_written'> => e.type === 'report_written')!.payload
  assert.equal(report.author, AUTHOR)
  assert.ok(report.report.headline.length > 0 && report.report.sections.length > 0)
  const ids = new Set(view.findings.map(f => f.id))
  for (const section of report.report.sections) for (const id of section.findingIds) assert.ok(ids.has(id), 'report cites only real findings')

  summary.assessment = {
    runId, decision: (list.find(e => e.type === 'decision_reached')!.payload as EventPayloads['decision_reached']).decision,
    findings: view.findings.map(f => f.title),
    legalReading: { summary: legal.text, points: points.length, located: located.length, details: points },
    report: { headline: report.report.headline, figuresVerified: report.verified, unsupported: report.unsupported },
  }
})

test('Ask with the model: answers from the run, points at the top finding, and a quoted line is located', async () => {
  assert.ok(runId, 'needs the assessment above')
  const view = foldAll(runId, list)
  const top = rankFindings(view.findings, view.decision)[0]
  const ask = async (question: string, label: string) => {
    const started = Date.now()
    const answer = await engine.post<AskAnswer>('/runs/' + runId + '/ask', { question })
    timings[label] = Date.now() - started
    assert.equal(answer.ok, true, answer.answer)
    assert.equal(answer.author, AUTHOR)
    assert.ok(answer.answer.trim().length > 0)
    return answer
  }
  const biggest = await ask('What is the biggest problem?', 'ask:biggest')
  assert.equal(biggest.findingId, top.id, 'the biggest problem is the top-ranked finding')
  assert.ok(biggest.evidence.length > 0)
  const quoted = await ask('Show me the line in the financing application where the requested amount is printed.', 'ask:quote')
  assert.equal(quoted.evidence[0]?.kind, 'cerere_finantare')
  assert.ok(quoted.evidence[0].marks.length > 0, 'the quoted line was located on the page')
  const stored = await engine.get<AskAnswer[]>('/runs/' + runId + '/questions')
  assert.equal(stored.length, 2)
  summary.ask = [biggest, quoted].map(a => ({ question: a.question, answer: a.answer, findingId: a.findingId, located: a.evidence.map(e => e.kind + ' p.' + e.page + ' · ' + e.marks.length + ' mark(s)'), unsupported: a.unsupported, durationMs: a.durationMs }))
})

test('the assistant drafts a request, suggests next steps and writes a case report with the model', async () => {
  assert.ok(runId, 'needs the assessment above')
  const view = foldAll(runId, list)
  const finding = rankFindings(view.findings, view.decision)[0]
  await engine.post('/companies/' + COMPANY + '/contacts', { name: 'Maria Enache', role: 'Chief financial officer', email: 'maria.enache@conpet.example.ro' })
  const opened = await engine.post('/cases', { companyId: COMPANY, runId, findingId: finding.id, department: 'finance', note: 'Confirm the requested amount.' })
  let started = Date.now()
  const drafted = await engine.post('/cases/' + opened.case.id + '/request', { language: 'en' })
  timings['model:request'] = Date.now() - started
  assert.equal(drafted.author, AUTHOR)
  assert.equal(drafted.request.to.email, 'maria.enache@conpet.example.ro')
  assert.ok(drafted.request.requirements.length > 0 && drafted.request.body.length > 100)
  started = Date.now()
  const suggestions = await engine.post('/companies/' + COMPANY + '/suggestions')
  timings['model:suggest'] = Date.now() - started
  assert.equal(suggestions.author, AUTHOR)
  assert.deepEqual(suggestions.items.map((i: any) => i.findingId), view.findings.map(f => f.id).filter(id => suggestions.items.some((i: any) => i.findingId === id)))
  assert.ok(suggestions.items.length > 0)
  started = Date.now()
  const report = await engine.post('/cases/' + opened.case.id + '/report')
  timings['model:report'] = Date.now() - started
  assert.equal(report.data.author, AUTHOR)
  assert.ok(report.data.report.paragraphs.length >= 2)
  summary.assistant = {
    request: { subject: drafted.request.subject, requirements: drafted.request.requirements, body: drafted.request.body, unsupported: drafted.unsupported },
    suggestions: suggestions.items, report: report.data.report, reportUnsupported: report.data.unsupported,
  }
})
