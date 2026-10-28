/**
 * The ten assessment workers. Each one does its part of the review on the
 * original documents and the recorded data, and reports through its
 * WorkerContext as it goes. Numbers and the decision always come from code;
 * the model is used only to read free text and to draft the analyst memo,
 * and the host verifies what it returns before showing it.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { AgentId, AssessmentReport, Discrepancy, EvidenceRef, Finding, FindingImpact, NoteField, NotePoint, Observations } from '../../src/assessment.ts'
import { REQUIRED_DOCUMENTS, rankFindings } from '../../src/assessment.ts'
import { decisionLabels, evaluate, money, ratio, scenarioLabels } from '../../src/analysis.ts'
import { docNames } from '../../src/documents.ts'
import type { Analysis, AuditRule, Row, Scenario } from '../../src/types.ts'
import { lookupAnaf, sameCompanyName } from './anaf.ts'
import { askCodex } from './codex.ts'
import { pageText, readPdf } from './pdf.ts'
import { SOURCE_TABLES, compareDocument, ledgerIssues } from './reconcile.ts'
import type { Blackboard, Worker, WorkerContext } from './run.ts'
import { documentFile } from './dossier.ts'
import { mergeEvidence } from './run.ts'

export { REQUIRED_DOCUMENTS }

const MISSING_IMPACT: Record<string, string> = {
  cashflow: 'Without the cash-flow projection, repayment capacity (DSCR and the monthly coverage test) cannot be measured.',
  situatii_2024: 'Without comparable annual statements, liquidity and leverage cannot be calculated.',
  situatii_2025: 'Without the latest annual statements, liquidity and leverage cannot be calculated.',
  crc_demo: 'Without the credit bureau report, existing exposures and arrears cannot be confirmed. An absent report is not a clean report.',
}

const name = (kind: string) => docNames[kind] ?? kind.replaceAll('_', ' ')
/** Amounts quoted from documents, to the bani. */
const exact = (n: number) => 'RON ' + n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const plural = (n: number, word: string, many = word + 's') => n + ' ' + (n === 1 ? word : many)
const fmt = (v: unknown) => typeof v === 'number' ? v.toLocaleString('en-GB', { maximumFractionDigits: 2 }) : v === null ? 'empty' : typeof v === 'object' ? JSON.stringify(v) : String(v)

function effectText(impact: FindingImpact, ruleIds: string[]): string {
  const rules = ruleIds.length ? ' (' + ruleIds.join(', ') + ')' : ''
  switch (impact) {
    case 'data': return 'The assessment cannot conclude: the outcome is Incomplete until this is resolved' + rules + '.'
    case 'block': return 'Fails an eligibility criterion: the application is Not eligible under the active policy' + rules + '.'
    case 'condition': return 'Does not block on its own, but approval can only be Conditional until it is resolved' + rules + '.'
    case 'info': return 'Not one of the policy rules, so the decision does not change; the analyst should confirm it before approval.'
  }
}

export function observationsFrom(board: Blackboard): Observations {
  const discrepancies: Discrepancy[] = board.mismatches.map(m => ({
    field: SOURCE_TABLES[m.kind].label + '.' + m.field, documentId: m.documentId, printed: m.printed, recorded: m.recorded,
    description: name(m.kind) + ' prints ' + m.field + ' = ' + fmt(m.printed) + '; the recorded value is ' + fmt(m.recorded) + '.',
  }))
  return { missingDocuments: [...board.missing], discrepancies }
}

function rulesNow(ctx: WorkerContext): Analysis {
  return evaluate(ctx.company, ctx.env.policy, observationsFrom(ctx.board))
}

function reportRules(ctx: WorkerContext, analysis: Analysis, pick: (r: AuditRule) => boolean): AuditRule[] {
  const rules = analysis.rules.filter(pick)
  for (const r of rules) ctx.check({ id: r.id, title: r.title, state: r.state, observed: r.observed, expected: r.threshold })
  return rules
}

/** Raise a finding for each rule that failed or needs review, outlined in its source. */
async function ruleFindings(ctx: WorkerContext, analysis: Analysis, rules: AuditRule[], detail: Record<string, string> = {}): Promise<number> {
  let count = 0
  for (const rule of rules) {
    if (rule.state !== 'fail' && rule.state !== 'review') continue
    const evidence = await ruleEvidence(ctx, rule, analysis)
    ctx.finding({
      impact: rule.impact === 'none' ? 'info' : rule.impact,
      title: rule.title + (rule.state === 'fail' ? ' fails the policy' : ' needs review'),
      observed: rule.observed + (detail[rule.id] ? '. ' + detail[rule.id] : '') + (rule.formula ? ' Formula: ' + rule.formula + '.' : ''),
      comparedAgainst: rule.threshold + ' (policy ' + ctx.env.policy.politica_id + ', version ' + ctx.env.policy.versiune + ').',
      whyItMatters: rule.explanation,
      effect: effectText(rule.impact === 'none' ? 'info' : rule.impact, [rule.id]),
      ruleIds: [rule.id],
      evidence: mergeEvidence(evidence),
    })
    count++
  }
  return count
}

async function ruleEvidence(ctx: WorkerContext, rule: AuditRule, a: Analysis): Promise<EvidenceRef[]> {
  const t = ctx.tables
  switch (rule.id) {
    case 'FIN-01':
    case 'FIN-02': {
      if (!a.monthly.length) return []
      const weakest = a.monthly.reduce((w, m) => m.cfads / m.service < w.cfads / w.service ? m : w)
      const cf = ctx.rowIndex('cashflow', r => r.luna === weakest.month && r.tip_istoric_sau_proiectie === 'proiectie')
      const debt = ctx.rowIndex('serviciu_datorie', r => r.luna === weakest.month && r.tip_existent_sau_nou === 'existent')
      return [
        ...await ctx.mark('cashflow', cf, ['incasari_operare', 'plati_operare_fara_dobanzi_impozite', 'impozite_platite', 'capex_mentenanta'], ['luna'],
          { luna: 'Weakest month ' + weakest.month + ': CFADS ' + money(weakest.cfads) + ' vs service ' + money(weakest.service) }),
        ...await ctx.mark('serviciu_datorie', debt, [], ['principal_scadent', 'dobanda_scadenta']),
      ]
    }
    case 'FIN-03': return [
      ...await ctx.mark('situatii_2025', ctx.rowIndex('situatii_2025', r => r.an === 2025 && r.cod_indicator === 'ACTIVE_CIRCULANTE'), ['valoare'], ['cod_indicator']),
      ...await ctx.mark('situatii_2025', ctx.rowIndex('situatii_2025', r => r.an === 2025 && r.cod_indicator === 'DATORII_CURENTE'), ['valoare'], ['cod_indicator']),
    ]
    case 'FIN-04': {
      const refs = await ctx.mark('situatii_2025', ctx.rowIndex('situatii_2025', r => r.an === 2025 && r.cod_indicator === 'EBITDA'), ['valoare'], ['cod_indicator'])
      for (let i = 0; i < t.credite_leasing.length; i++) refs.push(...await ctx.mark('credite_leasing', i, ['sold_utilizat'], ['facilitate_id']))
      return refs
    }
    case 'FIN-05': return ctx.mark('cerere_finantare', 0, ['aport_propriu'], ['buget_investitie'])
    case 'KYC-01': return ctx.mark('identificare_kyc_demo', 0, ['data_infiintare'])
    case 'CRD-01': return ctx.mark('crc_demo', ctx.rowIndex('crc_demo', r => r.tip_raport === 'CRC'), ['status'], ['data_raport'])
    case 'CRD-02': {
      const worst = t.credite_leasing.reduce((w, r, i) => (r.zile_intarziere || 0) > (t.credite_leasing[w].zile_intarziere || 0) ? i : w, 0)
      return ctx.mark('credite_leasing', worst, ['zile_intarziere', 'restanta_principal', 'restanta_dobanda'], ['facilitate_id', 'creditor'])
    }
    case 'CRD-03': return ctx.mark('situatie_fiscala', 0, ['obligatii_restante'], ['esalonari'])
    case 'COL-01': {
      const base = t.scenarii.find(s => s.tip_scenariu === 'baza')
      const refs: EvidenceRef[] = []
      for (const id of base?.garantie_ids ?? []) refs.push(...await ctx.mark('garantii', ctx.rowIndex('garantii', r => r.garantie_id === id),
        ['valoare_acceptata_banca', 'sarcini_anterioare', 'valoare_alocata_altor_credite'], ['garantie_id', 'executabilitate_verificata']))
      refs.push(...await ctx.mark('cerere_finantare', 0, [], ['suma_solicitata']))
      return refs
    }
  }
  if (rule.id.startsWith('LEG-')) {
    const index = Number(rule.id.slice(4)) - 1
    return ctx.mark('litigii_demo', index, ['rol_procesual', 'expunere_estimata', 'potrivire_entitate'], ['numar_dosar', 'nume_parte'])
  }
  return []
}

/** One model call, reported as events. Returns null when no model is configured. */
async function ask<T>(ctx: WorkerContext, purpose: string, prompt: string, schema: object): Promise<{ value: T | null; reason: string } | null> {
  const codex = ctx.env.codex
  if (!codex) return null
  ctx.checkpoint()
  ctx.env.emit('llm_started', ctx.id, { provider: 'codex', model: codex.model, effort: codex.effort, purpose })
  const answer = await askCodex<T>(codex, prompt, schema, ctx.signal)
  ctx.env.emit('llm_finished', ctx.id, { ok: answer.ok, durationMs: answer.durationMs, reason: answer.reason, usage: answer.usage })
  ctx.checkpoint()
  return { value: answer.ok ? answer.value : null, reason: answer.reason }
}

// ─── Case coordination & intake ───────────────────────────────────────────────

const intake: Worker = async ctx => {
  const inventory = ctx.tables.documente
  ctx.activity('Opening the dossier inventory: ' + plural(inventory.length, 'original PDF') + ' recorded')
  let verified = 0
  for (const kind of REQUIRED_DOCUMENTS) {
    const doc = inventory.find(d => d.tip_document === kind)
    if (!doc) continue
    const file = documentFile(ctx.env.documentsDir, ctx.company, doc)
    ctx.activity((doc.supplied ? 'Fingerprinting analyst-added ' : 'Fingerprinting ') + name(kind) + ' · ' + (doc.supplied?.originalName ?? basename(doc.fisier)), doc.document_id, 1)
    if (!existsSync(file)) continue
    const digest = createHash('sha256').update(readFileSync(file)).digest('hex')
    ctx.board.documents.set(kind, doc)
    if (digest === doc.sha256) { verified++; continue }
    ctx.finding({
      impact: 'data', title: name(kind) + ' does not match its recorded fingerprint',
      observed: 'SHA-256 of the file on disk is ' + digest.slice(0, 16) + '…',
      comparedAgainst: 'The inventory records ' + String(doc.sha256).slice(0, 16) + '… for this document.',
      whyItMatters: 'The file may have been replaced or altered after intake; nothing extracted from it can be trusted until the original is re-obtained.',
      effect: effectText('data', ['DATA-01']), ruleIds: ['DATA-01'], evidence: [],
    })
  }
  ctx.board.missing = REQUIRED_DOCUMENTS.filter(kind => !ctx.board.documents.has(kind))
  for (const kind of ctx.board.missing) {
    ctx.finding({
      impact: 'data', title: 'Required document missing: ' + name(kind),
      observed: 'The dossier has no ' + name(kind) + ' (' + (REQUIRED_DOCUMENTS.length - ctx.board.missing.length) + ' of ' + REQUIRED_DOCUMENTS.length + ' required documents are present).',
      comparedAgainst: 'The required document checklist for a term-loan application (' + REQUIRED_DOCUMENTS.length + ' documents).',
      whyItMatters: MISSING_IMPACT[kind] ?? 'Checks that depend on this document cannot run. Absence is kept as unknown, never treated as zero.',
      effect: effectText('data', ['DATA-01']), ruleIds: ['DATA-01'], evidence: [], missingDocument: kind,
    })
  }
  const supplied = inventory.filter(d => d.supplied)
  if (supplied.length) ctx.note({
    title: 'Documents added by the analyst', author: 'Case coordinator', verified: true, evidence: [],
    text: 'These documents were added after the original intake. Their fingerprints were recorded when they were added and checked again in this run. Confirm where they came from before relying on them.',
    fields: supplied.map(d => ({ label: name(d.tip_document), value: (d.supplied.replaces ? 'replaces the original · ' : 'was missing · ') + d.supplied.originalName + ' · ' + d.pagini + ' p. · added ' + String(d.supplied.at).slice(0, 16).replace('T', ' ') + ' by ' + d.supplied.by, tone: 'warn' as const })),
  })
  reportRules(ctx, rulesNow(ctx), r => r.id === 'DATA-01')
  return verified + '/' + ctx.board.documents.size + ' fingerprints verified · ' + (ctx.board.missing.length ? ctx.board.missing.length + ' missing: ' + ctx.board.missing.map(name).join(', ') : 'dossier complete')
}

// ─── Document extraction ─────────────────────────────────────────────────────

const extraction: Worker = async ctx => {
  let fields = 0, pages = 0
  for (const [kind, doc] of ctx.board.documents) {
    const pdf = await readPdf(ctx.file(kind)!)
    ctx.checkpoint()
    ctx.board.extracted.set(kind, pdf)
    const located = pdf.records.reduce((n, r) => n + Object.keys(r.fields).length, 0)
    fields += located
    pages += pdf.pages.length
    const lines = pdf.pages.reduce((n, p) => n + p.lines.length, 0)
    ctx.activity('Extracted ' + name(kind) + ': ' + plural(pdf.pages.length, 'page') + ', ' + (located ? plural(located, 'field') + ' with positions' : plural(lines, 'line') + ' of free text'), doc.document_id, 1)
  }
  return fields.toLocaleString('en-GB') + ' fields located on ' + plural(pages, 'page')
}

// ─── Financial reconciliation ────────────────────────────────────────────────

const ledger: Worker = async ctx => {
  let compared = 0
  for (const [kind, doc] of ctx.board.documents) {
    if (!SOURCE_TABLES[kind]) continue
    const pdf = ctx.board.extracted.get(kind)!
    ctx.activity(doc.supplied?.mode === 'ingested' ? name(kind) + ' was added by the analyst and had no recorded data: its printed fields become the recorded data'
      : (doc.supplied ? 'Comparing the analyst-added ' : 'Comparing ') + name(kind) + ' with the recorded ' + SOURCE_TABLES[kind].table + ' data', doc.document_id, 1)
    const result = compareDocument(ctx.tables, kind, doc.document_id, pdf)
    compared += result.compared
    for (const m of result.mismatches) {
      ctx.board.mismatches.push(m)
      if (kind === 'cerere_finantare' && m.field === 'suma_solicitata' && typeof m.printed === 'number' && typeof m.recorded === 'number') {
        const diff = m.printed - m.recorded
        const contract = await ctx.quote('contract_demo', 'Suma: ' + m.recorded.toFixed(2), 'Draft contract amount: ' + exact(m.recorded), 'reference')
        ctx.finding({
          impact: 'data', title: 'Requested amount conflicts with the recorded request',
          observed: 'The financing application prints a requested amount of ' + exact(m.printed) + ' (page ' + m.pdf.page + ').',
          comparedAgainst: 'The recorded request that every calculation uses holds ' + exact(m.recorded) + ': a difference of ' + exact(diff) + ' (' + (diff > 0 ? '+' : '') + (diff / m.recorded * 100).toFixed(1) + '%).' + (contract.length ? ' The draft contract also states ' + exact(m.recorded) + '.' : ''),
          whyItMatters: 'Debt service, DSCR, leverage and collateral coverage are all computed on the requested amount. With two different amounts on file, none of those figures can be relied on until the client confirms which amount they applied for.',
          effect: effectText('data', ['DATA-05']), ruleIds: ['DATA-05'],
          evidence: mergeEvidence([...await ctx.mark(kind, 0, ['suma_solicitata'], [], { suma_solicitata: 'Printed ' + exact(m.printed) + ' · recorded ' + exact(m.recorded) }), ...contract]),
        })
      } else {
        ctx.finding({
          impact: 'data', title: name(kind) + ': ' + m.field + ' differs from the recorded value',
          observed: name(kind) + ' prints ' + m.field + ' = ' + fmt(m.printed) + (m.position ? ' (position ' + m.position + ')' : '') + ' on page ' + m.pdf.page + '.',
          comparedAgainst: 'The recorded ' + m.table + ' value is ' + fmt(m.recorded) + '.',
          whyItMatters: 'Calculations use the recorded value; the original document says otherwise, so one of them is wrong.',
          effect: effectText('data', ['DATA-05']), ruleIds: ['DATA-05'],
          evidence: await ctx.mark(kind, m.rowIndex, [m.field]),
        })
      }
    }
  }
  const balance = ctx.tables.balanta
  if (ctx.board.documents.has('balanta')) {
    ctx.activity('Re-adding the trial balance: ' + plural(balance.filter(r => r.include_in_total).length, 'account') + ' included in totals', ctx.board.documents.get('balanta')!.document_id)
    const { issues, totals } = ledgerIssues(balance)
    ctx.board.ledger = issues
    const explained = issues.some(i => i.kind !== 'unbalanced_totals')
    const totalsLine = 'Closing totals: debit ' + exact(totals.sold_final_debit) + ' vs credit ' + exact(totals.sold_final_credit) + '.'
    for (const issue of issues) {
      const row = balance[issue.rows[0]]
      if (issue.kind === 'unbalanced_account') {
        const opening = row.sold_initial_debit - row.sold_initial_credit
        const expected = opening + row.rulaj_perioada_debit - row.rulaj_perioada_credit
        ctx.finding({
          impact: 'data', title: 'Account ' + row.cod_cont + ' does not reconcile',
          observed: 'Account ' + row.cod_cont + ' (' + row.denumire_cont + ') prints a closing balance of ' + exact(row.sold_final_debit - row.sold_final_credit) + '.',
          comparedAgainst: 'Opening ' + exact(opening) + ' + debit movements ' + exact(row.rulaj_perioada_debit) + ' − credit movements ' + exact(row.rulaj_perioada_credit) + ' = ' + exact(expected) + '. The difference is ' + exact(issue.amount!) + '. ' + totalsLine,
          whyItMatters: 'A trial balance that does not add up cannot be used as the basis for cash, liquidity or leverage figures. The ledger has to be re-extracted or corrected at source.',
          effect: effectText('data', ['DATA-02']), ruleIds: ['DATA-02'],
          evidence: await ctx.mark('balanta', issue.rows[0], ['sold_final_debit', 'sold_final_credit'], ['cod_cont', 'sold_initial_debit', 'sold_initial_credit', 'rulaj_perioada_debit', 'rulaj_perioada_credit'],
            { sold_final_debit: 'Printed closing debit ' + exact(row.sold_final_debit) + ' · expected ' + exact(Math.max(expected, 0)) }),
        })
      } else if (issue.kind === 'duplicate_account') {
        const refs: EvidenceRef[] = []
        for (const i of issue.rows) refs.push(...await ctx.mark('balanta', i, ['cod_cont', 'sold_final_debit', 'sold_final_credit'], ['denumire_cont'], { cod_cont: 'Account ' + issue.account + ' · position ' + (i + 1) }))
        const amount = issue.rows.slice(1).reduce((s, i) => s + balance[i].sold_final_debit - balance[i].sold_final_credit, 0)
        ctx.finding({
          impact: 'data', title: 'Account ' + issue.account + ' is counted twice',
          observed: issue.detail,
          comparedAgainst: 'Each leaf account may enter the totals once. The repeated row adds ' + exact(amount) + ' to the closing balances. ' + totalsLine,
          whyItMatters: 'Double-counted balances overstate assets (here, receivables), which flatters liquidity and hides the real position.',
          effect: effectText('data', ['DATA-03', 'DATA-02']), ruleIds: ['DATA-03', 'DATA-02'], evidence: mergeEvidence(refs),
        })
      } else if (issue.kind === 'mixed_units') {
        const reference = balance.findIndex((r, i) => r.include_in_total && !issue.rows.includes(i))
        const refs = [...await ctx.mark('balanta', issue.rows[0], ['unitate'], ['cod_cont', 'sold_final_debit', 'sold_final_credit'], { unitate: 'Unit ' + row.unitate + ' (thousands)' }),
          ...await ctx.mark('balanta', reference, [], ['unitate'], { unitate: 'Unit ' + balance[reference].unitate + ' on the other rows' })]
        ctx.finding({
          impact: 'data', title: 'Ledger mixes units of measure',
          observed: issue.detail + ' Account ' + row.cod_cont + ' prints ' + exact(row.sold_final_debit - row.sold_final_credit) + ' in unit ' + row.unitate + '.',
          comparedAgainst: 'The document header and the other rows declare unit ' + balance[reference].unitate + ' (individual RON).',
          whyItMatters: 'If the row is read in the declared unit its balance is wrong by a factor of ' + row.unitate + '. Normalising it silently would hide a source error, so it has to be confirmed.',
          effect: effectText('data', ['DATA-04']), ruleIds: ['DATA-04'], evidence: mergeEvidence(refs),
        })
      } else if (!explained) {
        ctx.finding({
          impact: 'data', title: 'Trial balance totals do not balance', observed: issue.detail, comparedAgainst: 'Debit and credit totals must agree within RON 0.02.',
          whyItMatters: 'An unbalanced ledger cannot support the financial analysis.', effect: effectText('data', ['DATA-02']), ruleIds: ['DATA-02'], evidence: [],
        })
      }
    }
  }
  reportRules(ctx, rulesNow(ctx), r => ['DATA-02', 'DATA-03', 'DATA-04', 'DATA-05'].includes(r.id))
  const problems = ctx.board.mismatches.length + ctx.board.ledger.length
  return compared.toLocaleString('en-GB') + ' fields compared · ' + (problems ? plural(problems, 'discrepancy', 'discrepancies') : 'no discrepancies')
}

// ─── Cash flow & repayment ───────────────────────────────────────────────────

const cashflow: Worker = async ctx => {
  const request = ctx.tables.solicitari[0]
  ctx.activity('Rebuilding 12 months of debt service: existing facilities plus ' + money(request.suma_solicitata) + ' over ' + request.durata_luni + ' months', ctx.board.documents.get('serviciu_datorie')?.document_id)
  const analysis = rulesNow(ctx)
  const m = analysis.metrics
  if (m.cfads === null) ctx.activity('Cash-flow projection not in the dossier: coverage cannot be computed')
  else {
    ctx.activity('CFADS ' + money(m.cfads) + ' against ' + money(m.debtService) + ' of debt service · DSCR ' + ratio(m.dscr), ctx.board.documents.get('cashflow')?.document_id)
    const weakest = analysis.monthly.reduce((w, x) => x.cfads / x.service < w.cfads / w.service ? x : w)
    ctx.activity('Weakest month ' + weakest.month + ': ' + ratio(weakest.cfads / weakest.service), ctx.board.documents.get('cashflow')?.document_id)
  }
  ctx.activity('Liquidity ' + ratio(m.liquidity) + ' · debt/EBITDA ' + ratio(m.leverage) + ' · own contribution ' + m.contribution.toFixed(1) + '%', ctx.board.documents.get('situatii_2025')?.document_id)
  const rules = reportRules(ctx, analysis, r => r.id.startsWith('FIN-'))
  const raised = await ruleFindings(ctx, analysis, rules, m.cfads !== null ? { 'FIN-01': money(m.cfads) + ' CFADS against ' + money(m.debtService) + ' debt service over 12 months' } : {})
  return (m.dscr === null ? 'DSCR not computable' : 'DSCR ' + ratio(m.dscr)) + ' · liquidity ' + ratio(m.liquidity) + (raised ? ' · ' + plural(raised, 'finding') : '')
}

// ─── Credit & fiscal ─────────────────────────────────────────────────────────

const credit: Worker = async ctx => {
  const t = ctx.tables
  const crc = t.verificari_credit.find(r => r.tip_raport === 'CRC')
  ctx.activity('Credit bureau report: ' + (ctx.board.documents.has('crc_demo') ? 'status ' + crc?.status + ', dated ' + crc?.data_raport : 'not in the dossier'), ctx.board.documents.get('crc_demo')?.document_id)
  const cip = t.verificari_credit.find(r => r.tip_raport !== 'CRC')
  if (cip) ctx.activity('Payment incident report: ' + plural((cip.incidente ?? []).length, 'incident'), ctx.board.documents.get('cip_demo')?.document_id)
  const worst = Math.max(0, ...t.credite_leasing.map(r => r.zile_intarziere || 0))
  ctx.activity(plural(t.credite_leasing.length, 'facility', 'facilities') + ' on file · longest arrears ' + worst + ' days', ctx.board.documents.get('credite_leasing')?.document_id)
  const fiscal = t.situatie_fiscala[0]
  ctx.activity('Tax position: ' + money(fiscal?.obligatii_restante ?? null) + ' outstanding, taxpayer status ' + (fiscal?.status_inactivitate ?? 'unknown'), ctx.board.documents.get('situatie_fiscala')?.document_id)
  const analysis = rulesNow(ctx)
  const rules = reportRules(ctx, analysis, r => r.id.startsWith('CRD-'))
  const raised = await ruleFindings(ctx, analysis, rules)
  return raised ? plural(raised, 'finding') + ' on credit or tax' : 'Credit, arrears and tax: pass'
}

// ─── Collateral ──────────────────────────────────────────────────────────────

const collateral: Worker = async ctx => {
  const t = ctx.tables
  const base = t.scenarii.find(s => s.tip_scenariu === 'baza')
  for (const id of base?.garantie_ids ?? []) {
    const g = t.garantii.find(r => r.garantie_id === id)
    if (g) ctx.activity('Collateral ' + id + ': ' + g.tip + ', accepted ' + money(g.valoare_acceptata_banca) + ', prior charges ' + money(g.sarcini_anterioare) + ', enforceability ' + (g.executabilitate_verificata ? 'verified' : 'not verified'), ctx.board.documents.get('garantii')?.document_id)
  }
  const analysis = rulesNow(ctx)
  ctx.activity('Accepted collateral ' + money(analysis.metrics.collateral) + ' covers ' + (analysis.metrics.coverage * 100).toFixed(0) + '% of ' + money(analysis.metrics.amount))
  const rules = reportRules(ctx, analysis, r => r.id === 'COL-01')
  const raised = await ruleFindings(ctx, analysis, rules)
  return (analysis.metrics.coverage * 100).toFixed(0) + '% coverage · ' + (raised ? 'below 110%' : 'meets policy')
}

// ─── Identity & public sources ───────────────────────────────────────────────

const research: Worker = async ctx => {
  const company = ctx.tables.companii[0]
  const cui = String(company?.cui ?? ctx.company.cui)
  ctx.activity('Querying the ANAF public taxpayer register for CUI ' + cui + ' (live)')
  const today = new Date().toISOString().slice(0, 10)
  const anaf = await lookupAnaf(cui, today, ctx.signal)
  ctx.checkpoint()
  const lines: string[] = []
  const fields: NoteField[] = []
  if (anaf.found) {
    const a = anaf.found
    ctx.activity('ANAF answered in ' + anaf.durationMs + ' ms: ' + a.name + ' · ' + a.registrationStatus)
    const sameName = sameCompanyName(a.name, ctx.company.name)
    const sameCui = String(a.cui) === cui
    const deregistered = /RADIER/i.test(a.registrationStatus)
    lines.push('Name: ' + a.name + (sameName ? ' (matches the dossier)' : ' (dossier: ' + ctx.company.name + ')'),
      'CUI ' + a.cui + ' · trade register ' + a.tradeRegister, 'Status: ' + a.registrationStatus + (a.inactive ? ' · flagged INACTIVE' : ''),
      'VAT payer: ' + (a.vatPayer ? 'yes' : 'no') + ' · CAEN ' + a.caen + ' · ' + a.legalForm, 'Address: ' + a.address)
    fields.push(
      { label: 'Registered name', value: a.name, tone: sameName ? 'ok' : 'warn' },
      { label: 'Dossier name', value: ctx.company.name + (sameName ? ' · matches' : ' · differs'), tone: sameName ? 'ok' : 'warn' },
      { label: 'CUI', value: String(a.cui) + (sameCui ? ' · matches' : ' · differs'), tone: sameCui ? 'ok' : 'warn' },
      { label: 'Status', value: a.registrationStatus + (a.inactive ? ' · INACTIVE taxpayer' : ''), tone: deregistered || a.inactive ? 'warn' : 'ok' },
      { label: 'Trade register', value: a.tradeRegister },
      { label: 'Legal form', value: a.legalForm },
      { label: 'VAT payer', value: a.vatPayer ? 'Yes' : 'No' },
      { label: 'CAEN (registry)', value: a.caen },
      { label: 'Address', value: a.address },
    )
    ctx.board.identity = fields.map(f => ({ label: f.label, value: f.value }))
    if (!sameName || !sameCui || deregistered || a.inactive) {
      ctx.finding({
        impact: 'info', title: !sameName || !sameCui ? 'Public register identity differs from the dossier' : 'Public register shows the company as ' + (a.inactive ? 'inactive' : 'deregistered'),
        observed: 'ANAF (queried ' + a.queriedAt.slice(0, 16).replace('T', ' ') + ' UTC) returns ' + a.name + ', CUI ' + a.cui + ', status "' + a.registrationStatus + '"' + (a.inactive ? ', inactive taxpayer' : '') + '.',
        comparedAgainst: 'The dossier identifies the applicant as ' + ctx.company.name + ', CUI ' + cui + '.',
        whyItMatters: 'Lending to an entity whose identity or legal status cannot be confirmed in the public register is a KYC failure.',
        effect: effectText('info', []), ruleIds: [], evidence: await ctx.mark('identificare_kyc_demo', 0, ['denumire', 'cui']),
      })
    }
  } else {
    ctx.activity(anaf.error ? anaf.error : 'ANAF has no taxpayer with CUI ' + cui)
    lines.push(anaf.error ?? 'No taxpayer found for CUI ' + cui + '.')
    fields.push({ label: 'Result', value: anaf.error ?? 'No taxpayer found for CUI ' + cui, tone: 'warn' })
    ctx.board.identity = [{ label: 'ANAF', value: anaf.error ?? 'no taxpayer found' }]
  }
  lines.push('Only the name, CUI, country and legal form in this dossier are real public identity fields; its incorporation date, address, CAEN and people are synthetic, so they are not compared with the register.')
  ctx.note({ title: 'ANAF public register', text: lines.join('\n'), author: anaf.found ? 'ANAF PlatitorTvaRest v9 · live, ' + anaf.durationMs + ' ms' : 'ANAF · not confirmed', verified: Boolean(anaf.found), evidence: [], fields })
  for (const source of ctx.tables.cercetare_web ?? []) ctx.activity('Captured source: ' + source.furnizor + ' · ' + source.categorie + ' (collected ' + String(source.colectat_la).slice(0, 10) + ', match ' + source.potrivire_entitate + ')')
  const analysis = rulesNow(ctx)
  const rules = reportRules(ctx, analysis, r => r.id === 'KYC-01')
  await ruleFindings(ctx, analysis, rules)
  return anaf.found ? 'ANAF: ' + anaf.found.name + (anaf.found.inactive || /RADIER/i.test(anaf.found.registrationStatus) ? ' · flagged' : ' · registered') : 'ANAF: identity not confirmed'
}

// ─── Legal review ────────────────────────────────────────────────────────────

interface LegalReading { summary: string; points: { document: 'litigii_demo' | 'contract_demo'; page: number; quote: string; observation: string; severity: 'info' | 'review' }[] }
const LEGAL_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['summary', 'points'],
  properties: {
    summary: { type: 'string' },
    points: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['document', 'page', 'quote', 'observation', 'severity'], properties: {
      document: { type: 'string', enum: ['litigii_demo', 'contract_demo'] }, page: { type: 'integer' }, quote: { type: 'string' },
      observation: { type: 'string' }, severity: { type: 'string', enum: ['info', 'review'] },
    } } },
  },
}

const legal: Worker = async ctx => {
  const t = ctx.tables
  ctx.activity('Reading the litigation register: ' + plural(t.litigii.length, 'case'), ctx.board.documents.get('litigii_demo')?.document_id, 1)
  for (const lit of t.litigii) ctx.activity('Case ' + lit.numar_dosar + ': ' + (lit.rol_procesual === 'parat' ? 'defendant' : 'claimant') + ', exposure ' + money(lit.expunere_estimata) + ', identity ' + lit.potrivire_entitate, ctx.board.documents.get('litigii_demo')?.document_id, 1)
  const analysis = rulesNow(ctx)
  const rules = reportRules(ctx, analysis, r => r.id.startsWith('LEG-'))
  let raised = await ruleFindings(ctx, analysis, rules)

  const sources = (['litigii_demo', 'contract_demo'] as const).filter(k => ctx.board.extracted.has(k))
  const request = t.solicitari[0]
  const prompt = [
    'You are the legal review worker in a bank credit assessment for ' + ctx.company.name + ' (CUI ' + ctx.company.cui + ').',
    'Read the original documents below: the litigation register extract and the draft financing contract.',
    'Report what a credit analyst must know: cases where the company is defendant, unconfirmed identity matches, material exposure, and contract terms that differ from the application on file (amount, term, fees, rate).',
    'Quote text exactly as printed (one line or a short phrase, at most 160 characters) so it can be located on the page. Do not report the demo/simulation disclaimers. Do not invent facts. If nothing is notable, return an empty points list.',
    'Application on file: amount ' + request.suma_solicitata + ' RON, term ' + request.durata_luni + ' months, fees ' + request.comisioane + ' RON, annual rate assumption ' + request.dobanda_anuala_ipoteza + '.',
    ...sources.flatMap(kind => ctx.board.extracted.get(kind)!.pages.map(p => '\n=== ' + kind + ' · page ' + p.number + ' ===\n' + pageText(ctx.board.extracted.get(kind)!, p.number))),
  ].join('\n')
  const answer = await ask<LegalReading>(ctx, 'read litigation register and draft contract', prompt, LEGAL_SCHEMA)
  if (!answer) {
    ctx.note({ title: 'Legal reading', text: 'No model is configured, so the free-text reading of the contract was skipped. Litigation rules were applied to the recorded register.', author: 'engine', verified: true, evidence: [] })
  } else if (!answer.value) {
    ctx.note({ title: 'Legal reading', text: 'The model call failed (' + answer.reason + '). Litigation rules were applied to the recorded register; the contract text was not read.', author: 'engine', verified: false, evidence: [] })
  } else {
    const evidence: EvidenceRef[] = []
    const lines = [answer.value.summary]
    const points: NotePoint[] = []
    let unverified = 0
    for (const point of answer.value.points.slice(0, 6)) {
      const refs = sources.includes(point.document) ? await ctx.quote(point.document, point.quote, point.observation, point.severity === 'review' ? 'issue' : 'reference', point.page) : []
      if (!refs.length) unverified++
      lines.push((refs.length ? '✓ ' : '✗ not found in document · ') + point.observation + ' — "' + point.quote + '"')
      points.push({ text: point.observation, quote: point.quote, verified: refs.length > 0, review: point.severity === 'review' })
      evidence.push(...refs)
      if (refs.length && point.severity === 'review' && raised < 6) {
        ctx.finding({
          impact: 'info', title: 'Legal reading: ' + point.observation.replace(/\.$/, ''),
          observed: name(point.document) + ', page ' + refs[0].page + ': "' + point.quote + '"',
          comparedAgainst: 'Application on file: ' + money(request.suma_solicitata) + ', ' + request.durata_luni + ' months, fees ' + money(request.comisioane) + '.',
          whyItMatters: 'Raised by the model reading the original text; the quote was located on the page by the engine, the interpretation is the model\'s.',
          effect: effectText('info', []), ruleIds: [], evidence: refs,
        })
        raised++
      }
    }
    ctx.board.legalSummary = answer.value.summary
    ctx.note({ title: 'Legal reading', text: answer.value.summary, author: 'Codex ' + ctx.env.codex!.model + ' · ' + ctx.env.codex!.effort, verified: unverified === 0, evidence: mergeEvidence(evidence), points })
  }
  return (t.litigii.length ? plural(t.litigii.length, 'case') : 'No cases') + (answer?.value ? ' · contract read' : '') + (raised ? ' · ' + plural(raised, 'finding') : '')
}

// ─── Policy evaluation ───────────────────────────────────────────────────────

const policy: Worker = async ctx => {
  const p = ctx.env.policy
  const observations = observationsFrom(ctx.board)
  ctx.board.observations = observations
  const analysis = evaluate(ctx.company, p, observations)
  ctx.activity('Applying ' + p.politica_id + ' version ' + p.versiune + ' to ' + plural(analysis.rules.length, 'rule result') + ': DSCR ≥ ' + p.dscr_min + ', liquidity ≥ ' + p.lichiditate_min + ', debt/EBITDA ≤ ' + p.datorie_ebitda_max)
  const failing = analysis.rules.filter(r => r.state !== 'pass' && r.state !== 'info')
  ctx.activity(failing.length ? plural(failing.length, 'rule') + ' not met: ' + failing.map(r => r.id).join(', ') : 'Every rule is met')
  const scenarios = Object.fromEntries((Object.keys(scenarioLabels) as Scenario[]).map(s => [s, s === 'baza' ? analysis : evaluate(ctx.company, p, observations, s)])) as Record<Scenario, Analysis>
  ctx.activity('Scenario outcomes: ' + (Object.keys(scenarios) as Scenario[]).map(s => scenarioLabels[s] + ' → ' + decisionLabels[scenarios[s].decision]).join(' · '))
  ctx.env.emit('decision_reached', ctx.id, { decision: analysis.decision, reasons: analysis.reasons.map(r => r.id + ' · ' + r.title + ': ' + r.observed), observations, scenarios })
  return decisionLabels[analysis.decision] + (analysis.reasons.length ? ' · ' + analysis.reasons.map(r => r.id).join(', ') : '')
}

// ─── Analyst handoff ─────────────────────────────────────────────────────────

const REPORT_SECTIONS = ['Decision', 'Problems found', 'Repayment capacity', 'Credit, tax and legal', 'Collateral and alternatives', 'Identity and sources', 'Data quality and limitations']
const REPORT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['headline', 'summary', 'sections', 'nextSteps'],
  properties: {
    headline: { type: 'string' }, summary: { type: 'string' },
    sections: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['title', 'paragraphs', 'findingIds'], properties: {
      title: { type: 'string', enum: REPORT_SECTIONS }, paragraphs: { type: 'array', items: { type: 'string' } }, findingIds: { type: 'array', items: { type: 'string' } },
    } } },
    nextSteps: { type: 'array', items: { type: 'string' } },
  },
}

/** Numbers in the memo that do not occur in the facts it was given. */
export function unsupportedFigures(text: string, facts: string): string[] {
  const numbers = (s: string) => (s.match(/\d[\d,]*(\.\d+)?/g) ?? []).map(n => Number(n.replace(/,/g, ''))).filter(n => Number.isFinite(n))
  const known = numbers(facts)
  const near = (n: number) => known.some(k => Math.abs(k - n) <= Math.max(0.006, Math.abs(k) * 0.001) || Math.abs(k * 100 - n) < 0.6)
  return [...new Set(numbers(text).filter(n => n > 12 && !near(n)).map(String))]
}

const pct = (n: number) => n.toFixed(1) + '%'

/** Everything the report may say, with figures already formatted the way they must be quoted. */
function reportFacts(ctx: WorkerContext, analysis: Analysis, scenarios: Record<Scenario, Analysis> | null) {
  const p = ctx.env.policy
  const m = analysis.metrics
  const request = ctx.tables.solicitari[0]
  const ranked = rankFindings(ctx.board.findings.map((f, i) => ({ ...f, seq: i, ts: '' })), { decision: analysis.decision, reasons: analysis.reasons.map(r => r.id), observations: ctx.board.observations!, scenarios: scenarios! })
  return {
    company: ctx.company.name, cui: ctx.company.cui, sector: ctx.company.sector,
    request: { amount: money(request.suma_solicitata), term: request.durata_luni + ' months', purpose: String(request.scop).replace(/^SIMULAT: /, ''), own_contribution: money(request.aport_propriu), investment_budget: money(request.buget_investitie) },
    decision: decisionLabels[analysis.decision], policy: p.politica_id + ' ' + p.versiune,
    decisive_rules: analysis.reasons.map(r => ({ rule: r.id, title: r.title, observed: r.observed, required: r.threshold })),
    findings_most_important_first: ranked.map(f => ({ id: f.id, severity: f.impact, title: f.title, observed: f.observed, compared_against: f.comparedAgainst, effect: f.effect })),
    checks: ctx.board.checks.map(c => ({ rule: c.id, title: c.title, result: c.state, observed: c.observed, required: c.expected })),
    metrics: {
      dscr: ratio(m.dscr), dscr_minimum: ratio(p.dscr_min), lowest_month_coverage: ratio(m.monthlyDscr), cfads_12_months: money(m.cfads), debt_service_12_months: money(m.debtService),
      liquidity: ratio(m.liquidity), liquidity_minimum: ratio(p.lichiditate_min), debt_to_ebitda: ratio(m.leverage), debt_to_ebitda_maximum: ratio(p.datorie_ebitda_max),
      collateral_accepted: money(m.collateral), collateral_coverage: (m.coverage * 100).toFixed(0) + '%', own_contribution: pct(m.contribution), operating_history_months: m.ageMonths,
    },
    scenarios: scenarios ? Object.fromEntries((Object.keys(scenarios) as Scenario[]).map(s => [scenarioLabels[s], decisionLabels[scenarios[s].decision]])) : {},
    missing_documents: ctx.board.missing.map(name),
    identity_anaf_live: ctx.board.identity,
    legal_reading: ctx.board.legalSummary,
    data_scope: 'Company name and CUI are real public identities; all financial, legal and banking data in the dossier is synthetic demonstration data.',
  }
}

/** The report the engine writes itself when no model is available. */
export function engineReport(facts: ReturnType<typeof reportFacts>, findings: Finding[]): AssessmentReport {
  const top = facts.findings_most_important_first
  const m = facts.metrics
  return {
    headline: facts.company + ': ' + facts.decision + (top.length ? ' · ' + top[0].title : ''),
    summary: facts.company + ' requests ' + facts.request.amount + ' over ' + facts.request.term + '. Under ' + facts.policy + ' the outcome is ' + facts.decision + '. ' +
      (facts.decisive_rules.length ? 'Decisive: ' + facts.decisive_rules.map(r => r.title + ' (' + r.observed + ')').join('; ') + '.' : 'Every policy rule is met.'),
    sections: [
      { title: 'Decision', paragraphs: [facts.decision + ' under ' + facts.policy + '.' + (facts.decisive_rules.length ? ' ' + facts.decisive_rules.map(r => r.rule + ' ' + r.title + ': ' + r.observed + ' (required: ' + r.required + ').').join(' ') : '')], findingIds: [] },
      { title: 'Problems found', paragraphs: top.length ? top.map((f, i) => (i + 1) + '. ' + f.title + ': ' + f.observed) : ['No worker raised a finding.'], findingIds: top.map(f => f.id) },
      { title: 'Repayment capacity', paragraphs: ['DSCR ' + m.dscr + ' against a minimum of ' + m.dscr_minimum + '; lowest monthly coverage ' + m.lowest_month_coverage + '. Liquidity ' + m.liquidity + ' (minimum ' + m.liquidity_minimum + '), debt/EBITDA ' + m.debt_to_ebitda + ' (maximum ' + m.debt_to_ebitda_maximum + ').'], findingIds: findings.filter(f => f.worker === 'cashflow').map(f => f.id) },
      { title: 'Collateral and alternatives', paragraphs: ['Accepted collateral ' + m.collateral_accepted + ', ' + m.collateral_coverage + ' of the request. Scenarios: ' + Object.entries(facts.scenarios).map(([k, v]) => k + ' → ' + v).join(', ') + '.'], findingIds: findings.filter(f => f.worker === 'collateral').map(f => f.id) },
      { title: 'Data quality and limitations', paragraphs: [facts.data_scope], findingIds: [] },
    ],
    nextSteps: top.length ? top.slice(0, 4).map(f => 'Resolve: ' + f.title) : ['Review the evidence and record an analyst recommendation.'],
  }
}

const handoff: Worker = async ctx => {
  const analysis = evaluate(ctx.company, ctx.env.policy, ctx.board.observations!)
  const scenarios = Object.fromEntries((Object.keys(scenarioLabels) as Scenario[]).map(s => [s, evaluate(ctx.company, ctx.env.policy, ctx.board.observations!, s)])) as Record<Scenario, Analysis>
  const facts = reportFacts(ctx, analysis, scenarios)
  const factsText = JSON.stringify(facts)
  const ids = new Set(ctx.board.findings.map(f => f.id))
  ctx.activity('Writing the assessment report: ' + decisionLabels[analysis.decision] + ', ' + plural(ctx.board.findings.length, 'finding') + ', ' + plural(ctx.board.checks.length, 'check'))
  const answer = await ask<AssessmentReport>(ctx, 'write the assessment report', [
    'You are the analyst handoff worker in a bank credit assessment. Write the assessment report a credit analyst will read before taking over this case.',
    'Use only the FACTS below. Copy every figure exactly as it appears in the facts (they are already formatted); never compute or round new figures.',
    'Write for a busy credit analyst: plain, specific, no filler. headline: one line with the outcome and the main reason. summary: 2-3 sentences.',
    'sections: use these titles in this order: ' + REPORT_SECTIONS.join(', ') + '. Each section has 1-2 short paragraphs (70 words at most in total) and lists, in findingIds, the ids of the findings it discusses (only ids from the facts). "Problems found" covers the findings most important first; if there are none, say so.',
    'nextSteps: 2-5 concrete actions for the analyst, most important first.',
    'FACTS: ' + factsText,
  ].join('\n'), REPORT_SCHEMA)
  if (answer?.value) {
    const report: AssessmentReport = { ...answer.value, sections: answer.value.sections.map(sec => ({ ...sec, findingIds: sec.findingIds.filter(id => ids.has(id)) })) }
    const text = [report.headline, report.summary, ...report.sections.flatMap(sec => sec.paragraphs), ...report.nextSteps].join('\n')
    const unsupported = unsupportedFigures(text, factsText)
    ctx.env.emit('report_written', ctx.id, { report, author: 'Codex ' + ctx.env.codex!.model + ' · ' + ctx.env.codex!.effort, verified: unsupported.length === 0, unsupported })
    return 'Report written · ' + (unsupported.length ? plural(unsupported.length, 'figure') + ' unverified' : 'figures verified')
  }
  ctx.env.emit('report_written', ctx.id, { report: engineReport(facts, ctx.board.findings), author: answer ? 'engine (model failed: ' + answer.reason + ')' : 'engine', verified: true, unsupported: [] })
  return 'Report written by the engine'
}

export const WORKERS: Record<AgentId, Worker> = { intake, research, extraction, ledger, credit, legal, cashflow, collateral, policy, handoff }
