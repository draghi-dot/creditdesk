/**
 * Questions about one assessment run. The model answers from the run's
 * recorded facts and the text of the relevant original pages, and may point
 * at a finding or quote a passage; the engine resolves that to a located
 * place in the document before the workspace opens it. Figures in the answer
 * are checked against what the model was given.
 */

import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import type { AskAnswer, EvidenceRef, RunEvent } from '../../src/assessment.ts'
import { foldAll, rankFindings } from '../../src/assessment.ts'
import { decisionLabels, money, ratio } from '../../src/analysis.ts'
import { docNames } from '../../src/documents.ts'
import type { Company } from '../../src/types.ts'
import type { CodexConfig } from './codex.ts'
import { askCodex } from './codex.ts'
import { findQuote, pageText, readPdf } from './pdf.ts'
import { unsupportedFigures } from './workers.ts'
import { documentFile } from './dossier.ts'

/** Short documents are given whole; longer ones only on the pages findings point to. */
const WHOLE = new Set(['cerere_finantare', 'identificare_kyc_demo', 'litigii_demo', 'contract_demo', 'crc_demo', 'cip_demo', 'situatie_fiscala', 'garanti', 'credite_leasing', 'garantii'])

interface ModelAnswer { answer: string; findingId: string; document: string; page: number; quote: string }

function schema(kinds: string[]) {
  return {
    type: 'object', additionalProperties: false, required: ['answer', 'findingId', 'document', 'page', 'quote'],
    properties: {
      answer: { type: 'string' }, findingId: { type: 'string' },
      document: { type: 'string', enum: ['', ...kinds] }, page: { type: 'integer' }, quote: { type: 'string' },
    },
  }
}

export async function locate(company: Company, documentsDir: string, kind: string, quote: string, page: number | null, label: string): Promise<EvidenceRef[]> {
  const doc = company.tables.documente.find(d => d.tip_document === kind)
  if (!doc) return []
  const pdf = await readPdf(documentFile(documentsDir, company, doc))
  const hit = quote.trim() ? findQuote(pdf, quote, page ?? undefined) ?? findQuote(pdf, quote) : null
  const at = hit?.page ?? page
  if (!at || at < 1 || at > pdf.pages.length) return []
  return [{
    documentId: doc.document_id, kind, file: basename(doc.fisier), sha256: doc.sha256, page: at, pageCount: pdf.pages.length,
    pageWidth: pdf.pages[at - 1].width, pageHeight: pdf.pages[at - 1].height,
    marks: hit ? [{ box: hit.box, tone: 'issue', label }] : [],
  }]
}

export async function answerQuestion(opts: {
  company: Company; runId: string; events: RunEvent[]; documentsDir: string; codex: CodexConfig | null
  question: string; history: AskAnswer[]; signal: AbortSignal; about?: string | null
}): Promise<AskAnswer> {
  const { company, runId, events, documentsDir, codex, question, history } = opts
  const view = foldAll(runId, events)
  const ranked = rankFindings(view.findings, view.decision)
  const base = view.decision?.scenarios.baza
  const started = Date.now()
  const about = opts.about ? view.findings.find(f => f.id === opts.about) ?? null : null
  const reply = (fields: Partial<AskAnswer>): AskAnswer => ({
    id: randomUUID(), runId, ts: new Date().toISOString(), question, about: about?.id ?? null, ok: true, answer: '', findingId: null, evidence: [],
    author: 'engine', durationMs: Date.now() - started, unsupported: [], ...fields,
  })

  if (!codex) {
    const top = about ?? ranked[0]
    return reply({
      answer: top ? 'No model is configured, so the engine can only restate the finding. ' + top.title + ': ' + top.observed + ' Compared against: ' + top.comparedAgainst
        : 'No model is configured. This run raised no findings.',
      findingId: top?.id ?? null, evidence: top?.evidence ?? [],
    })
  }

  const request = company.tables.solicitari[0]
  const facts = {
    company: company.name, cui: company.cui, run_status: view.status,
    request: { amount: money(request.suma_solicitata), term: request.durata_luni + ' months', purpose: String(request.scop).replace(/^SIMULAT: /, '') },
    decision: view.decision ? decisionLabels[view.decision.decision] : 'not reached yet',
    decisive_rules: view.decision?.reasons ?? [],
    findings_most_important_first: ranked.map((f, i) => ({
      id: f.id, rank: i + 1, severity: f.impact, worker: view.workers[f.worker]?.role.name, title: f.title, observed: f.observed,
      compared_against: f.comparedAgainst, why_it_matters: f.whyItMatters, effect: f.effect,
      located_in: f.evidence.map(e => (docNames[e.kind] ?? e.kind) + ' page ' + e.page),
    })),
    checks: Object.values(view.workers).flatMap(w => w.checks.map(c => ({ rule: c.id, title: c.title, result: c.state, observed: c.observed, required: c.expected, worker: w.role.name }))),
    metrics: base ? { dscr: ratio(base.metrics.dscr), lowest_month: ratio(base.metrics.monthlyDscr), liquidity: ratio(base.metrics.liquidity), debt_to_ebitda: ratio(base.metrics.leverage), collateral_coverage: (base.metrics.coverage * 100).toFixed(0) + '%', own_contribution: base.metrics.contribution.toFixed(1) + '%' } : null,
    scenarios: view.decision ? Object.fromEntries(Object.entries(view.decision.scenarios).map(([k, a]) => [k, decisionLabels[a.decision]])) : null,
    notes: view.notes.map(n => ({ title: n.title, by: n.author, text: n.text, fields: n.fields, points: n.points })),
    report_headline: view.report?.report.headline ?? null,
    workers: Object.values(view.workers).filter(w => w.state !== 'hidden').map(w => ({ name: w.role.name, state: w.state, summary: w.summary })),
  }
  const pages = new Map<string, Set<number>>()
  for (const d of company.tables.documente) if (WHOLE.has(d.tip_document)) pages.set(d.tip_document, new Set(Array.from({ length: d.pagini }, (_, i) => i + 1)))
  for (const f of ranked) for (const e of f.evidence) (pages.get(e.kind) ?? pages.set(e.kind, new Set()).get(e.kind)!).add(e.page)
  const texts: string[] = []
  for (const [kind, set] of pages) {
    const doc = company.tables.documente.find(d => d.tip_document === kind)
    if (!doc) continue
    const pdf = await readPdf(documentFile(documentsDir, company, doc))
    for (const n of [...set].sort((a, b) => a - b)) texts.push('=== ' + kind + ' (' + (docNames[kind] ?? kind) + ') · page ' + n + ' of ' + pdf.pages.length + ' ===\n' + pageText(pdf, n))
  }
  const factsText = JSON.stringify(facts)
  const prompt = [
    'You are the assistant inside CreditDesk, a bank credit-assessment workspace. A credit analyst asks about one assessment run of ' + company.name + '.',
    'Answer only from FACTS and DOCUMENT TEXT below. Be direct and specific, 120 words at most, plain sentences (no markdown headings). Copy figures exactly as they appear; never compute new ones. If the facts do not answer the question, say what is missing.',
    '"Biggest" or "most important" problem means rank 1 in findings_most_important_first.',
    'Pointing: if the answer is about a finding, set findingId to its id (else ""). To show a place in a document, set document to its key, page to its page number and quote to an exact line copied from DOCUMENT TEXT (at most 120 characters); otherwise document "", page 0, quote "". The app opens that place and outlines it.',
    'All company data is synthetic demonstration data.',
    about ? 'The analyst asked this from finding ' + about.id + ' (rank ' + (ranked.indexOf(about) + 1) + '): "' + about.title + '". Unless the question clearly asks about something else, answer about this finding and set findingId to ' + about.id + '. Explain in plain words, for someone who has not read the documents.' : '',
    history.length ? 'EARLIER QUESTIONS IN THIS CONVERSATION:\n' + history.slice(-4).map(h => 'Q: ' + h.question + '\nA: ' + h.answer).join('\n') : '',
    'FACTS: ' + factsText,
    'DOCUMENT TEXT:\n' + texts.join('\n\n'),
    'QUESTION: ' + question,
  ].filter(Boolean).join('\n\n')
  const result = await askCodex<ModelAnswer>(codex, prompt, schema([...pages.keys()]), opts.signal)
  const author = 'Codex ' + codex.model + ' · ' + codex.effort
  if (!result.ok || !result.value) return reply({ ok: false, answer: 'The model could not answer: ' + result.reason, author, durationMs: result.durationMs })
  const v = result.value
  const finding = view.findings.find(f => f.id === v.findingId) ?? null
  let evidence: EvidenceRef[] = []
  if (v.document) evidence = await locate(company, documentsDir, v.document, v.quote, v.page || null, 'From the answer')
  if (finding && (!evidence.length || !evidence[0].marks.length)) evidence = finding.evidence
  return reply({
    answer: v.answer, findingId: finding?.id ?? null, evidence, author, durationMs: result.durationMs,
    unsupported: unsupportedFigures(v.answer, factsText + texts.join('\n')),
  })
}
