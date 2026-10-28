/**
 * The assistant's work for employees: requests to a company representative,
 * a suggested comment and requirement per problem, and case reports. Same
 * Codex runtime and isolation as the review workers; figures in what it
 * writes are checked against the facts it was given. Without a model the
 * engine writes plain drafts from the recorded findings.
 */

import type { Finding } from '../../src/assessment.ts'
import { money } from '../../src/analysis.ts'
import { docNames } from '../../src/documents.ts'
import type { Company } from '../../src/types.ts'
import type { Case, CaseEvent, CaseReport, CompanyRequest, Suggestion, User } from '../../src/workspace.ts'
import { departmentFor, departmentName } from '../../src/workspace.ts'
import type { CodexConfig } from './codex.ts'
import { askCodex } from './codex.ts'
import { unsupportedFigures } from './workers.ts'

export type Language = 'en' | 'ro'
interface Written<T> { value: T; author: string; unsupported: string[]; reason?: string }

const docName = (kind: string) => docNames[kind] ?? kind
const LANGUAGE: Record<Language, string> = { en: 'English', ro: 'Romanian (formal, using "dumneavoastră")' }

function findingFacts(f: Finding) {
  return {
    id: f.id, title: f.title, observed: f.observed, compared_against: f.comparedAgainst, why_it_matters: f.whyItMatters,
    missing_document: f.missingDocument ? docName(f.missingDocument) : null,
    located_in: f.evidence.map(e => docName(e.kind) + ', page ' + e.page),
  }
}

function requestFacts(company: Company) {
  const r = company.tables.solicitari[0]
  return { company: company.name, cui: company.cui, requested_amount: money(r.suma_solicitata), term: r.durata_luni + ' months', purpose: String(r.scop).replace(/^SIMULAT: /, '') }
}

/** What to ask of the company for one problem, when the model is not available. */
function plainRequirement(f: Finding): string {
  if (f.missingDocument) return 'Send the ' + docName(f.missingDocument).toLowerCase() + '.'
  if (f.worker === 'intake') return 'Send the original ' + (f.evidence[0] ? docName(f.evidence[0].kind).toLowerCase() : 'document') + ' again; the copy on file does not match its recorded fingerprint.'
  if (f.evidence.length) return 'Confirm or correct the ' + docName(f.evidence[0].kind).toLowerCase() + ': ' + f.observed.replace(/\.$/, '') + '.'
  return 'Provide information on: ' + f.title.toLowerCase() + '.'
}

async function write<T>(codex: CodexConfig | null, prompt: string, schema: object, facts: string, text: (v: T) => string, fallback: () => T, signal: AbortSignal): Promise<Written<T>> {
  if (!codex) return { value: fallback(), author: 'engine', unsupported: [] }
  const answer = await askCodex<T>(codex, prompt, schema, signal)
  if (!answer.ok || !answer.value) return { value: fallback(), author: 'engine (model unavailable: ' + answer.reason + ')', unsupported: [], reason: answer.reason }
  return { value: answer.value, author: 'Codex ' + codex.model + ' · ' + codex.effort, unsupported: unsupportedFigures(text(answer.value), facts) }
}

const DRAFT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['subject', 'body', 'requirements'],
  properties: { subject: { type: 'string' }, body: { type: 'string' }, requirements: { type: 'array', items: { type: 'string' } } },
}

/** A request to the company's representative about one or more problems, written for the employee to review and send. */
export async function draftRequest(opts: {
  company: Company; findings: Finding[]; contact: { name: string; role: string } | null; from: User; language: Language
  instructions?: string; caseRef?: string; codex: CodexConfig | null; signal: AbortSignal
}): Promise<Written<Pick<CompanyRequest, 'subject' | 'body' | 'requirements'>>> {
  const { company, findings, contact, from } = opts
  const greeting = contact ? contact.name : 'the company\'s representative'
  const facts = JSON.stringify({ ...requestFacts(company), problems: findings.map(findingFacts), case: opts.caseRef ?? null, writer: { name: from.name, title: from.title, department: departmentName(from.department) }, recipient: contact ?? { role: 'company representative' } })
  const prompt = [
    'Draft an email from ' + from.name + ' (' + from.title + ', ' + departmentName(from.department) + ' department, corporate lending at the bank) to ' + greeting + ' at ' + company.name + ' about its financing application.',
    'Ask for exactly what is needed to resolve the problems in FACTS: documents to send or correct, figures to confirm, clarifications. Name each document and copy each figure exactly as given; never compute new figures.',
    'Write like an experienced banker: polite, short, specific. Do not mention internal systems, automated checks, scores, policy thresholds or the credit decision. Do not invent deadlines, names or facts.',
    'requirements: one line per item the company must send or do. body: the full email text including greeting and sign-off with the writer\'s name, title and "Corporate Lending". subject: short and specific, with the company name' + (opts.caseRef ? ' and reference ' + opts.caseRef : '') + '.',
    'Language: ' + LANGUAGE[opts.language] + '.',
    opts.instructions ? 'The employee adds: ' + opts.instructions.slice(0, 1000) : '',
    'FACTS: ' + facts,
  ].filter(Boolean).join('\n')
  return write(opts.codex, prompt, DRAFT_SCHEMA, facts, v => [v.subject, v.body, ...v.requirements].join('\n'), () => {
    const requirements = [...new Set(findings.map(plainRequirement))]
    const subject = company.name + ': information needed for your financing application' + (opts.caseRef ? ' (' + opts.caseRef + ')' : '')
    const body = (opts.language === 'ro'
      ? ['Stimate/Stimată ' + (contact?.name ?? 'reprezentant') + ',', '', 'Vă mulțumim pentru cererea de finanțare. Pentru a continua analiza avem nevoie de următoarele:']
      : ['Dear ' + (contact?.name ?? 'Sir or Madam') + ',', '', 'Thank you for your financing application. To continue our review we need the following:'])
      .concat('', ...requirements.map((r, i) => (i + 1) + '. ' + r), '', opts.language === 'ro' ? 'Vă rugăm să ne răspundeți la acest mesaj cu documentele sau clarificările solicitate.' : 'Please reply to this email with the documents or clarifications.', '',
        opts.language === 'ro' ? 'Cu stimă,' : 'Kind regards,', from.name, from.title + ', Corporate Lending').join('\n')
    return { subject, body, requirements }
  }, opts.signal)
}

/** For each problem: an internal comment for the department that handles it and what to ask of the company. */
export async function suggest(opts: { company: Company; findings: Finding[]; decision: string; codex: CodexConfig | null; signal: AbortSignal }): Promise<Written<Suggestion[]>> {
  const { company, findings } = opts
  if (!findings.length) return { value: [], author: opts.codex ? 'Codex ' + opts.codex.model + ' · ' + opts.codex.effort : 'engine', unsupported: [] }
  const ids = findings.map(f => f.id)
  const schema = {
    type: 'object', additionalProperties: false, required: ['items'],
    properties: { items: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['findingId', 'comment', 'requirement'], properties: {
      findingId: { type: 'string', enum: ids }, comment: { type: 'string' }, requirement: { type: 'string' },
    } } } },
  }
  const facts = JSON.stringify({ ...requestFacts(company), decision: opts.decision, problems: findings.map(f => ({ ...findingFacts(f), department: departmentName(departmentFor(f)), effect: f.effect })) })
  const prompt = [
    'You help the corporate lending team of a bank handle the problems found in the financing application of ' + company.name + '.',
    'For each problem in FACTS write: comment — a short internal note (at most 40 words) for the department that will handle it: what to check and what it affects; requirement — one sentence on what to ask of the company to resolve it, or "" when nothing can be asked of the company.',
    'Copy figures exactly as given; never compute new ones. Plain, specific language.',
    'FACTS: ' + facts,
  ].join('\n')
  const result = await write<{ items: { findingId: string; comment: string; requirement: string }[] }>(opts.codex, prompt, schema, facts,
    v => v.items.map(i => i.comment + '\n' + i.requirement).join('\n'),
    () => ({ items: findings.map(f => ({ findingId: f.id, comment: f.whyItMatters, requirement: plainRequirement(f) })) }), opts.signal)
  const byId = new Map(findings.map(f => [f.id, f]))
  const items = result.value.items.filter(i => byId.has(i.findingId)).map(i => ({ ...i, department: departmentFor(byId.get(i.findingId)!) }))
  return { ...result, value: items }
}

const REPORT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['title', 'paragraphs'],
  properties: { title: { type: 'string' }, paragraphs: { type: 'array', items: { type: 'string' } } },
}

/** A short written report on a case for its department: the problem, the evidence, what was done, what is outstanding. */
export async function caseReport(opts: { company: Company; case: Case; events: CaseEvent[]; requests: CompanyRequest[]; codex: CodexConfig | null; signal: AbortSignal }): Promise<Written<CaseReport>> {
  const c = opts.case
  const timeline = opts.events.filter(e => e.kind !== 'report').map(e => ({ when: e.ts.slice(0, 16).replace('T', ' '), who: e.author, what: e.kind, text: e.text, data: e.data }))
  const requests = opts.requests.map(r => ({ subject: r.subject, status: r.status, to: r.to.name || r.to.email, requirements: r.requirements, sent_at: r.sentAt }))
  const facts = JSON.stringify({ ...requestFacts(opts.company), case: { ref: c.ref, department: departmentName(c.department), status: c.status, assignee: c.assignee, opened_by: c.createdBy, opened_at: c.createdAt }, problem: c.finding ? findingFacts(c.finding) : { title: c.title }, timeline, requests })
  const prompt = [
    'Write a short case report for the ' + departmentName(c.department) + ' department of a bank about case ' + c.ref + ' for ' + opts.company.name + '.',
    'title: one line. paragraphs: 3-5 short paragraphs: the problem and where it is in the documents; why it matters; what has been done so far (who, when); what is outstanding and the recommended next step. At most 180 words in total.',
    'Use only FACTS. Copy figures exactly as given; never compute new ones. Plain language for a colleague taking over the case.',
    'FACTS: ' + facts,
  ].join('\n')
  return write<CaseReport>(opts.codex, prompt, REPORT_SCHEMA, facts, v => [v.title, ...v.paragraphs].join('\n'), () => ({
    title: c.ref + ' · ' + c.title,
    paragraphs: [
      c.finding ? c.finding.observed + ' Compared against: ' + c.finding.comparedAgainst : c.title,
      c.finding?.whyItMatters ?? '',
      'Opened by ' + c.createdBy + ' on ' + c.createdAt.slice(0, 10) + '; ' + opts.events.filter(e => e.kind === 'comment').length + ' comment(s); status ' + c.status.replace('_', ' ') + (c.assignee ? ', assigned to ' + c.assignee : ', not assigned') + '.',
      requests.length ? 'Requests to the company: ' + requests.map(r => r.subject + ' (' + r.status + ')').join('; ') + '.' : 'No request has been sent to the company yet.',
    ].filter(Boolean),
  }), opts.signal)
}
