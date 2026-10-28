import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { evaluate } from '../src/analysis.ts'
import type { Observations } from '../src/assessment.ts'
import type { Portfolio } from '../src/types.ts'

const portfolio: Portfolio = JSON.parse(readFileSync(new URL('../public/data/portfolio.json', import.meta.url), 'utf8'))
const clean: Observations = { missingDocuments: [], discrepancies: [] }

test('what-if changes recompute repayment capacity, without altering source records', () => {
  const company = portfolio.companies[0]
  const snapshot = JSON.stringify(company)
  const base = evaluate(company, portfolio.policy, clean)
  const stress = evaluate(company, portfolio.policy, clean, 'baza', { cashflowChange: -70 })
  assert.ok(stress.metrics.dscr! < base.metrics.dscr!)
  assert.equal(stress.decision, 'NEELIGIBIL')
  assert.equal(JSON.stringify(company), snapshot)
})

test('unverified cash never counts until a clearly explicit what-if assumption is enabled', () => {
  const company = portfolio.companies[5]
  assert.equal(evaluate(company, portfolio.policy, clean, 'cash_colateral').decision, 'CONDITIONAT')
  assert.equal(evaluate(company, portfolio.policy, clean, 'cash_colateral', { assumeCashVerified: true }).decision, 'ELIGIBIL')
  assert.equal(evaluate(company, portfolio.policy, clean, 'cash_colateral').decision, 'CONDITIONAT')
})

test('observed discrepancies and missing documents block a conclusion', () => {
  const company = portfolio.companies[0]
  assert.equal(evaluate(company, portfolio.policy, { missingDocuments: ['cashflow'], discrepancies: [] }).decision, 'DATE_INSUFICIENTE')
  const conflict = { field: 'solicitare.suma_solicitata', documentId: 'X', printed: 1, recorded: 2, description: 'differs' }
  assert.equal(evaluate(company, portfolio.policy, { missingDocuments: [], discrepancies: [conflict] }).decision, 'DATE_INSUFICIENTE')
})
