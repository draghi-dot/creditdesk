/**
 * Early warning for credit clients: when monitoring finds something serious,
 * the assistant reads the signal against the credit line and the latest
 * assessment, says how material it is and what the bank usually does, answers
 * the employee's questions, and drafts the request for information the
 * facility agreement allows. It never acts: every action is the employee's.
 */

import { money, ratio } from '../../src/analysis.ts'
import type { AssessmentSummary } from '../../src/assessment.ts'
import type { Company } from '../../src/types.ts'
import type { ClientRisk, Contact, RiskAction, User } from '../../src/workspace.ts'
import type { CodexConfig } from './codex.ts'
import { DRAFT_SCHEMA, LANGUAGE, type Language, type Written, local, write } from './agent.ts'

/** What was found: a monitoring event or an article the crawler read. */
export interface Signal { title: string; detail: string; source: string; severity: string; url?: string; site?: string; published?: string | null; text?: string; reason?: string | null }

export interface RiskNote { severity: 'critical' | 'high' | 'medium' | 'low'; headline: string; summary: string; exposure: string; grade: 'red' | 'amber' | 'none'; actions: { kind: RiskAction; why: string }[] }

const ACTIONS: RiskAction[] = ['watchlist', 'information', 'freeze', 'reassess', 'legal']

/** The facts the assistant may use, and nothing else: the signal, the credit line, the latest assessment and the client's watch status. */
export function signalFacts(company: Company, signal: Signal, latest: AssessmentSummary | null, risk: ClientRisk | null, others: Signal[]) {
  const line = company.creditLine!
  const excerpt = signal.text ? (() => { const at = signal.text.indexOf(signal.detail.slice(0, 60)); const from = Math.max(0, (at >= 0 ? at : 0) - 900); return signal.text.slice(from, from + 2600) })() : null
  const months = Math.max(0, Math.round((Date.parse(line.maturity) - Date.now()) / (30.44 * 86_400_000)))
  return {
    company: company.name, cui: company.cui,
    credit_line: {
      facility: line.facilityId, product: line.product, limit: money(line.limit), drawn: money(line.drawn), undrawn: money(line.limit - line.drawn), drawn_share: Math.round(line.drawn / line.limit * 100) + '%',
      maturity: line.maturity, months_to_maturity: months, next_review: line.nextReview, covenants: { dscr_min: ratio(line.covenants.dscrMin), debt_to_ebitda_max: ratio(line.covenants.leverageMax), liquidity_min: ratio(line.covenants.liquidityMin) },
      collateral: line.collateral.map(c => c.type + ' ' + money(c.acceptedValue)), relationship_manager: line.relationshipManager,
    },
    latest_assessment: latest?.digest ? { decision: latest.decision, completed: local(latest.endedAt), dscr: ratio(latest.digest.metrics.dscr), liquidity: ratio(latest.digest.metrics.liquidity), debt_to_ebitda: ratio(latest.digest.metrics.leverage), collateral_coverage: (latest.digest.metrics.coverage * 100).toFixed(0) + '%' } : null,
    watch_status: risk?.watchlist ? 'watchlist ' + risk.watchlist.grade + ' since ' + local(risk.watchlist.since) : 'performing', drawdowns: risk?.freeze ? (risk.freeze.status === 'active' ? 'frozen' : 'freeze requested, waiting for a second approver') : 'open',
    signal: { title: signal.title, quoted_sentence: signal.detail, source: signal.site ?? signal.source, published: signal.published ?? null, monitoring_severity: signal.severity, why_flagged: signal.reason ?? null, article_excerpt: excerpt },
    other_open_signals: others.map(o => ({ title: o.title, severity: o.severity, published: o.published ?? null })),
  }
}

const NOTE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['severity', 'headline', 'summary', 'exposure', 'grade', 'actions'],
  properties: {
    severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] }, headline: { type: 'string' }, summary: { type: 'string' }, exposure: { type: 'string' },
    grade: { type: 'string', enum: ['red', 'amber', 'none'] },
    actions: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['kind', 'why'], properties: { kind: { type: 'string', enum: ACTIONS }, why: { type: 'string' } } } },
  },
}

const PLAYBOOK = 'The bank\'s early-warning practice: triage the signal; put the client on the watchlist (amber: needs closer watch; red: repayment at risk) with an owner and a review date; send the client a request for information under the facility agreement\'s information undertakings; stop further drawdowns of the undrawn amount when repayment is at risk (needs a second approver); run a new assessment on updated figures; involve Legal for insolvency, enforcement, investigations or litigation.'

/** How material the signal is for this credit line, and what to do, in the bank's terms. */
export function riskNote(codex: CodexConfig | null, facts: ReturnType<typeof signalFacts>, signal: Signal, signal2: AbortSignal): Promise<Written<RiskNote>> {
  const text = JSON.stringify(facts)
  const prompt = [
    'You are the credit-risk assistant of a bank. Monitoring found the signal below about a client with an approved credit line. Write a risk note for the employee.',
    'severity: critical (repayment or survival of the company at risk), high, medium or low. headline: one line. summary: at most 80 words on what happened and why it matters for this loan. exposure: at most 40 words naming the drawn and undrawn amounts, collateral and time to maturity from FACTS. grade: the watchlist grade you recommend (none if it is not needed).',
    'actions: the steps you recommend, most urgent first, each with a why of at most 25 words. Only steps from the playbook. Recommend freeze only when repayment is at risk and there is an undrawn amount.',
    PLAYBOOK,
    'Use only FACTS; copy figures exactly; do not invent facts about the company. Say so when the article is about the sector or another company rather than this one.',
    'FACTS: ' + text,
  ].join('\n')
  return write<RiskNote>(codex, prompt, NOTE_SCHEMA, text, v => [v.headline, v.summary, v.exposure, ...v.actions.map(a => a.why)].join('\n'), () => {
    const critical = signal.severity === 'alert'
    const legal = /insolven|faliment|enforcement|investigation|litig|court|instan/i.test(signal.title + ' ' + signal.detail)
    const undrawn = facts.credit_line.undrawn !== money(0)
    return {
      severity: critical ? 'critical' : signal.severity === 'watch' ? 'medium' : 'low',
      headline: signal.title,
      summary: 'Monitoring flagged this ' + (signal.site ? 'article on ' + signal.site : signal.source + ' signal') + ': "' + signal.detail.slice(0, 220) + '". It concerns the client\'s ability to keep operating and repaying; it has not been confirmed with the client.',
      exposure: 'Drawn ' + facts.credit_line.drawn + ', undrawn ' + facts.credit_line.undrawn + ' of ' + facts.credit_line.limit + '; ' + facts.credit_line.months_to_maturity + ' months to maturity.',
      grade: critical ? 'red' : signal.severity === 'watch' ? 'amber' : 'none',
      actions: [
        ...(critical || signal.severity === 'watch' ? [{ kind: 'watchlist' as const, why: critical ? 'Repayment may be at risk; the client needs a red watch with an owner and a review date.' : 'Needs closer watch until the client explains.' }] : []),
        { kind: 'information' as const, why: 'The facility agreement obliges the client to report material events; ask for an explanation and recent figures.' },
        ...(critical && undrawn ? [{ kind: 'freeze' as const, why: 'Stop further drawdowns of the undrawn ' + facts.credit_line.undrawn + ' until the situation is clear.' }] : []),
        ...(critical ? [{ kind: 'reassess' as const, why: 'Re-run the assessment on updated figures once the client answers.' }] : []),
        ...(legal ? [{ kind: 'legal' as const, why: 'Legal should review the insolvency, enforcement or litigation risk.' }] : []),
      ],
    }
  }, signal2)
}

/** The employee's question about the signal, answered from the same facts. */
export function discuss(codex: CodexConfig | null, facts: ReturnType<typeof signalFacts>, question: string, history: { question: string; answer: string }[], signal: AbortSignal): Promise<Written<{ answer: string; actions: RiskAction[] }>> {
  const text = JSON.stringify(facts)
  const prompt = [
    'You are the credit-risk assistant of a bank, talking with an employee about a monitoring signal on a client with an approved credit line.',
    'Answer the question in at most 110 words, plainly. actions: the playbook steps that fit the answer (may be empty).',
    PLAYBOOK,
    'Use only FACTS; copy figures exactly; say when FACTS do not answer it.',
    history.length ? 'EARLIER IN THIS CONVERSATION:\n' + history.slice(-4).map(h => 'Q: ' + h.question + '\nA: ' + h.answer).join('\n') : '',
    'FACTS: ' + text,
    'QUESTION: ' + question,
  ].filter(Boolean).join('\n')
  const schema = { type: 'object', additionalProperties: false, required: ['answer', 'actions'], properties: { answer: { type: 'string' }, actions: { type: 'array', items: { type: 'string', enum: ACTIONS } } } }
  return write(codex, prompt, schema, text, v => v.answer, () => ({
    answer: 'No model is connected, so here is what monitoring recorded: ' + facts.signal.title + ' (' + (facts.signal.source) + (facts.signal.published ? ', ' + facts.signal.published : '') + '). Drawn ' + facts.credit_line.drawn + ' of ' + facts.credit_line.limit + ', ' + facts.credit_line.months_to_maturity + ' months to maturity. The client is ' + facts.watch_status + ' and drawdowns are ' + facts.drawdowns + '.',
    actions: [],
  }), signal)
}

/** The request for information the facility agreement allows, for the employee to review and send. */
export function informationRequest(codex: CodexConfig | null, facts: ReturnType<typeof signalFacts>, from: User, contact: Contact | null, language: Language, signal: AbortSignal): Promise<Written<{ subject: string; body: string; requirements: string[] }>> {
  const text = JSON.stringify({ ...facts, writer: { name: from.name, title: from.title }, recipient: contact ? contact.name + ', ' + contact.role : 'the company\'s representative' })
  const prompt = [
    'Write a formal request for information from a bank to a corporate client, in ' + LANGUAGE[language] + ', about the signal in FACTS. The bank refers to the information undertakings of the facility agreement (facility ' + facts.credit_line.facility + ').',
    'subject: one line naming the facility. body: polite and firm, at most 220 words: what the bank read (source and date), that it asks the client to confirm and explain it, the requirements as a numbered list, a reply within 5 business days, signed by the writer. requirements: 3 to 5 items (explanation of the event and its expected impact on operations and repayment, latest management accounts, measures planned, anything else FACTS make relevant).',
    'Do not accuse the client; the bank asks to understand. Use only FACTS.',
    'FACTS: ' + text,
  ].join('\n')
  return write(codex, prompt, DRAFT_SCHEMA, text, v => v.subject + '\n' + v.body, () => {
    const requirements = ['An explanation of the event reported and its expected impact on your operations and on the repayment of the facility.', 'Your latest management accounts (balance sheet, profit and loss, cash flow).', 'The measures you plan and their timetable.']
    const greeting = contact ? 'Dear ' + contact.name + ',' : 'Dear Sir or Madam,'
    return {
      subject: facts.company + ': request for information under facility ' + facts.credit_line.facility,
      body: [greeting, '', 'We read ' + (facts.signal.source ? 'on ' + facts.signal.source : '') + (facts.signal.published ? ' (' + facts.signal.published + ')' : '') + ' that: "' + facts.signal.quoted_sentence.slice(0, 260) + '"', '', 'Under the information undertakings of facility ' + facts.credit_line.facility + ', we kindly ask you to send us within 5 business days:', ...requirements.map((r, i) => (i + 1) + '. ' + r), '', 'We would welcome a call to discuss it.', '', 'Kind regards,', from.name, from.title].join('\n'),
      requirements,
    }
  }, signal)
}
