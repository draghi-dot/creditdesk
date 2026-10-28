import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { evaluate } from '../src/analysis.ts'
import { foldAll, rankFindings } from '../src/assessment.ts'
import type { EventPayloads } from '../src/assessment.ts'
import type { Portfolio, Scenario } from '../src/types.ts'
import { Engine, parseSimulation, whatIf } from '../server/engine/engine.ts'
import { answerQuestion } from '../server/engine/ask.ts'
import { unsupportedFigures } from '../server/engine/workers.ts'
import { Store } from '../server/store.ts'

process.env.CREDITDESK_ANAF = 'off'
const portfolio: Portfolio = JSON.parse(readFileSync(new URL('../public/data/portfolio.json', import.meta.url), 'utf8'))
const reference = JSON.parse(readFileSync(new URL('./fixtures/oracle.json', import.meta.url), 'utf8'))
const documents = new URL('../public/documents', import.meta.url).pathname

const dir = mkdtempSync(join(tmpdir(), 'creditdesk-test-'))
const store = new Store(join(dir, 'runs.sqlite'))
const engine = new Engine(store, documents, null)
const runs = new Map<string, string>()

async function finish(runId: string) {
  while (engine.isActive(runId)) await new Promise(r => setTimeout(r, 5))
  return foldAll(runId, store.events(runId))
}

test('the engine assesses all 50 dossiers from their original documents', async () => {
  for (const company of portfolio.companies) {
    const runId = engine.start(company, portfolio.policy)
    runs.set(company.id, runId)
    const view = await finish(runId)
    assert.equal(view.status, 'completed', company.id + ': ' + view.failure)
    assert.ok(Object.values(view.workers).every(w => w.state === 'done' || w.state === 'attention'), company.id)
    assert.deepEqual(store.verify(runId), { ok: true, events: store.events(runId).length, brokenAt: null })
  }
})

test('the scenario outcomes recorded by the engine match all 200 oracle decisions and metrics', () => {
  let count = 0
  for (const company of portfolio.companies) {
    const decision = store.events(runs.get(company.id)!).find(e => e.type === 'decision_reached')!.payload as EventPayloads['decision_reached']
    const expected = reference.find((r: any) => r.dosar_id === company.id)
    for (const scenario of expected.scenarii) {
      const result = decision.scenarios[scenario.tip_scenariu as Scenario]
      assert.equal(result.decision, scenario.rezultat_asteptat, company.id + ' / ' + scenario.tip_scenariu)
      assert.ok(Math.abs(result.metrics.coverage - scenario.acoperire_garantii) < 0.000001)
      count++
    }
    assert.equal(store.run(runs.get(company.id)!)!.digest!.decision, decision.scenarios.baza.decision)
    const base = decision.scenarios.baza
    for (const [actual, target] of [[base.metrics.dscr, expected.indicatori_calculati.dscr], [base.metrics.liquidity, expected.indicatori_calculati.lichiditate_curenta], [base.metrics.leverage, expected.indicatori_calculati.datorie_ebitda]]) {
      if (target === null) assert.equal(actual, null)
      else assert.ok(actual !== null && Math.abs(actual! - target) < 0.000001, company.id)
    }
  }
  assert.equal(count, 200)
})

test('engine findings match the documented anomalies, located on the original pages', () => {
  const findings = (id: string) => foldAll(runs.get(id)!, store.events(runs.get(id)!)).findings
  const amount = findings('TEST-DOS-018').find(f => f.title.startsWith('Requested amount'))!
  assert.ok(amount.observed.includes('3,327,500.00') && amount.comparedAgainst.includes('3,025,000.00'))
  assert.deepEqual(amount.evidence.map(e => [e.kind, e.page]), [['cerere_finantare', 1], ['contract_demo', 1]])
  const account = findings('TEST-DOS-015').find(f => f.title === 'Account 5121 does not reconcile')!
  assert.ok(account.comparedAgainst.includes('The difference is RON 500.00'))
  assert.equal(account.evidence[0].kind, 'balanta')
  assert.ok(account.evidence[0].marks.some(m => m.tone === 'issue'))
  assert.ok(findings('TEST-DOS-016').some(f => f.title === 'Account 4111 is counted twice'))
  assert.ok(findings('TEST-DOS-017').some(f => f.title === 'Ledger mixes units of measure'))
  assert.ok(findings('TEST-DOS-002').some(f => f.title.includes('Cash-flow history')))
  // A healthy dossier raises nothing.
  assert.equal(findings('TEST-DOS-001').length, 0)
})

test('what-if analysis is computed by the engine from the run\'s recorded facts', () => {
  const company = portfolio.companies[0]
  const run = store.run(runs.get(company.id)!)!
  const stressed = whatIf(company, run, parseSimulation({ cashflowChange: -70 }))
  assert.equal(stressed.baza.decision, 'NEELIGIBIL')
  assert.deepEqual(stressed.baza, evaluate(company, run.policy, run.observations!, 'baza', { cashflowChange: -70 }))
  assert.throws(() => parseSimulation({ amount: -5 }), /amount/)
})

test('every run ends with an assessment report and ranks problems most important first', () => {
  for (const id of ['TEST-DOS-001', 'TEST-DOS-002', 'TEST-DOS-018']) {
    const view = foldAll(runs.get(id)!, store.events(runs.get(id)!))
    assert.ok(view.report, id + ' has a report')
    assert.equal(view.report!.report.sections.length >= 4, true)
    const ranked = rankFindings(view.findings, view.decision)
    for (let i = 1; i < ranked.length; i++) assert.ok(['data', 'block', 'condition', 'info'].indexOf(ranked[i - 1].impact) <= ['data', 'block', 'condition', 'info'].indexOf(ranked[i].impact))
  }
  const report = foldAll(runs.get('TEST-DOS-018')!, store.events(runs.get('TEST-DOS-018')!)).report!.report
  assert.ok(report.sections.find(s => s.title === 'Problems found')!.findingIds.includes('ledger-1'))
})

test('without a model, asking for the biggest problem opens the top-ranked finding', async () => {
  const runId = runs.get('TEST-DOS-018')!
  const answer = await answerQuestion({ company: portfolio.companies.find(c => c.id === 'TEST-DOS-018')!, runId, events: store.events(runId), documentsDir: documents, codex: null, question: 'What is the biggest problem?', history: [], signal: new AbortController().signal })
  assert.equal(answer.findingId, 'ledger-1')
  assert.deepEqual(answer.evidence.map(e => e.kind), ['cerere_finantare', 'contract_demo'])
})

test('memo figures are checked against the facts the model was given', () => {
  const facts = JSON.stringify({ amount_ron: 3025000, dscr: 2.28, coverage: 140 })
  assert.deepEqual(unsupportedFigures('Requested 3,025,000 RON, DSCR 2.28, coverage 140%.', facts), [])
  assert.deepEqual(unsupportedFigures('Requested 3,327,500 RON.', facts), ['3327500'])
})

test('cancelling a run stops it and records who cancelled', async () => {
  const runId = engine.start(portfolio.companies[0], portfolio.policy)
  engine.cancel(runId, 'analyst')
  const view = await finish(runId)
  assert.equal(view.status, 'cancelled')
  rmSync(dir, { recursive: true, force: true })
})
