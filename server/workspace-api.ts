/**
 * HTTP routes for the people side of the workspace: who is acting, cases
 * and departments, contacts, requests to companies (drafted by the
 * assistant, sent by an employee through their Gmail), the company activity
 * log, and assessments for all companies at once.
 */

import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Finding } from '../src/assessment.ts'
import { foldAll } from '../src/assessment.ts'
import { decisionLabels } from '../src/analysis.ts'
import type { Company, Policy } from '../src/types.ts'
import type { CompanyRequest, GmailState, User } from '../src/workspace.ts'
import { DEPARTMENTS, undeliverable } from '../src/workspace.ts'
import { type Language, caseReport, draftRequest, suggest } from './engine/agent.ts'
import type { Batch } from './engine/batch.ts'
import type { Engine } from './engine/engine.ts'
import * as gmail from './gmail.ts'
import { readJson, send } from './http.ts'
import type { Store } from './store.ts'
import { DEFAULT_USER, type Workspace } from './workspace.ts'

export interface WorkspaceContext {
  workspace: Workspace
  store: Store
  engine: Engine
  batch: Batch
  companies: Map<string, Company>
  dataDir: string
  policyFrom: (body: any) => Policy
  refreshProvider: () => Promise<void>
}

const fail = (status: number, message: string) => Object.assign(new Error(message), { status })
const language = (v: unknown): Language => v === 'ro' ? 'ro' : 'en'

export function workspaceRoutes(ctx: WorkspaceContext) {
  const { workspace, store, engine, companies } = ctx
  /** Gmail sign-ins in progress: state → who asked, the PKCE verifier and where to return. */
  const pending = new Map<string, { userId: string; verifier: string; redirectUri: string; back: string; at: number }>()

  const actorOf = (req: IncomingMessage): User => workspace.user(String(req.headers['x-user'] ?? '')) ?? workspace.user(DEFAULT_USER)!
  const companyOf = (id: unknown): Company => { const c = companies.get(String(id)); if (!c) throw fail(404, 'No such company'); return c }
  const findingsOf = (runId: string | null): Finding[] => runId && store.run(runId) ? foldAll(runId, store.events(runId)).findings : []
  const latestRun = (companyId: string) => store.runs(companyId).find(r => r.status === 'completed') ?? null
  const origin = (req: IncomingMessage) => 'http://' + (req.headers.host ?? '127.0.0.1')
  const contactFor = (company: Company, contactId: unknown) => {
    const contacts = workspace.contacts(company)
    return contacts.find(c => c.id === contactId) ?? contacts.find(c => !c.placeholder) ?? null
  }
  const newRequest = (company: Company, caseId: string | null, contact: ReturnType<typeof contactFor>, draft: Pick<CompanyRequest, 'subject' | 'body' | 'requirements'>, draftedBy: string): CompanyRequest => workspace.saveRequest({
    id: randomUUID(), companyId: company.id, caseId, to: { name: contact && !contact.placeholder ? contact.name : '', email: contact?.email ?? '' },
    ...draft, status: 'draft', draftedBy, createdAt: new Date().toISOString(), sentBy: null, sentAt: null, sentFrom: null, error: null,
  })
  const gmailState = (req: IncomingMessage, user: User): GmailState => {
    const connected = workspace.gmail(user.id)
    return { configured: Boolean(gmail.loadClient(ctx.dataDir)), connected: connected ? { email: connected.email, connectedAt: connected.connectedAt } : null, redirectUri: origin(req) + '/api/gmail/callback' }
  }

  return async function route(req: IncomingMessage, res: ServerResponse, url: URL, parts: string[]): Promise<boolean> {
    const [, area, id, sub, subId] = parts
    const method = req.method ?? 'GET'
    const is = (m: string, a: string, length: number) => method === m && area === a && parts.length === length
    const reply = (status: number, body: unknown) => { send(res, status, body); return true }
    try {
      // ─── Who is acting ───────────────────────────────────────────────────
      if (is('GET', 'me', 2)) return reply(200, { user: actorOf(req), users: workspace.users(), departments: DEPARTMENTS, gmail: gmailState(req, actorOf(req)) })
      if (is('GET', 'users', 2)) return reply(200, workspace.users())
      if (is('POST', 'users', 2)) return reply(201, workspace.addUser(await readJson(req)))

      // ─── Cases ───────────────────────────────────────────────────────────
      if (is('GET', 'cases', 2)) {
        const q = url.searchParams
        return reply(200, workspace.cases({ department: q.get('department') ?? undefined, companyId: q.get('company') ?? undefined, status: q.get('status') ?? undefined }))
      }
      if (is('POST', 'cases', 2)) {
        const body = await readJson(req)
        const company = companyOf(body.companyId)
        const runId = typeof body.runId === 'string' && store.run(body.runId)?.companyId === company.id ? body.runId : null
        const finding = typeof body.findingId === 'string' ? findingsOf(runId).find(f => f.id === body.findingId) ?? null : null
        if (body.findingId && !finding) throw fail(400, 'That problem is not in the assessment')
        const opened = workspace.openCase({ company, runId, finding, department: body.department, title: body.title, note: body.note }, actorOf(req))
        return reply(opened.created ? 201 : 200, opened)
      }
      if (area === 'cases' && id) {
        const found = workspace.case(id)
        if (!found) throw fail(404, 'No such case')
        const actor = actorOf(req)
        if (method === 'GET' && parts.length === 3) return reply(200, { case: found, events: workspace.events(id), requests: workspace.requests({ caseId: id }) })
        if (method === 'POST' && parts.length === 3) return reply(200, workspace.updateCase(id, await readJson(req), actor))
        if (method === 'POST' && sub === 'comments') {
          const text = String((await readJson(req)).text ?? '').trim().slice(0, 4000)
          if (!text) throw fail(400, 'Write a comment')
          return reply(201, workspace.addEvent(id, 'comment', text, actor))
        }
        if (method === 'POST' && (sub === 'report' || sub === 'request')) {
          const body = await readJson(req)
          const company = companyOf(found.companyId)
          await ctx.refreshProvider()
          const controller = new AbortController()
          res.on('close', () => { if (!res.writableEnded) controller.abort(new Error('employee left')) })
          if (sub === 'report') {
            const written = await caseReport({ company, case: found, events: workspace.events(id), requests: workspace.requests({ caseId: id }), codex: engine.codex, signal: controller.signal })
            const event = workspace.addEvent(id, 'report', written.value.title, actor, { report: written.value, author: written.author, unsupported: written.unsupported })
            return reply(201, event)
          }
          const contact = contactFor(company, body.contactId)
          const written = await draftRequest({ company, findings: found.finding ? [found.finding] : [], contact, from: actor, language: language(body.language), instructions: body.instructions, caseRef: found.ref, codex: engine.codex, signal: controller.signal })
          const request = newRequest(company, id, contact, written.value, written.author)
          workspace.addEvent(id, 'request', request.subject, actor, { requestId: request.id, author: written.author, unsupported: written.unsupported })
          return reply(201, { request, author: written.author, unsupported: written.unsupported })
        }
      }

      // ─── Company contacts, requests and suggestions ──────────────────────
      if (area === 'companies' && companies.has(id ?? '') && (sub === 'contacts' || sub === 'requests' || sub === 'suggestions')) {
        const company = companyOf(id)
        const actor = actorOf(req)
        if (sub === 'contacts') {
          if (method === 'GET' && parts.length === 4) return reply(200, workspace.contacts(company))
          if (method === 'POST' && parts.length === 4) {
            const contactId = workspace.saveContact(company.id, await readJson(req), actor)
            workspace.appendActivity(company.id, 'Contact saved', workspace.contacts(company).find(c => c.id === contactId)!.name, actor.name)
            return reply(201, workspace.contacts(company))
          }
          if (method === 'DELETE' && parts.length === 5) return reply(workspace.removeContact(company.id, subId!) ? 200 : 404, workspace.contacts(company))
        }
        if (sub === 'requests') {
          if (method === 'GET') return reply(200, workspace.requests({ companyId: company.id }))
          if (method === 'POST') {
            const body = await readJson(req)
            const run = latestRun(company.id)
            const all = findingsOf(run?.runId ?? null)
            const findings = Array.isArray(body.findingIds) ? all.filter(f => body.findingIds.includes(f.id)) : all
            await ctx.refreshProvider()
            const contact = contactFor(company, body.contactId)
            const written = await draftRequest({ company, findings, contact, from: actor, language: language(body.language), instructions: body.instructions, codex: engine.codex, signal: new AbortController().signal })
            return reply(201, { request: newRequest(company, null, contact, written.value, written.author), author: written.author, unsupported: written.unsupported })
          }
        }
        if (sub === 'suggestions') {
          const run = latestRun(company.id)
          if (method === 'GET') return reply(200, run ? workspace.suggestions(run.runId) : null)
          if (method === 'POST') {
            if (!run) throw fail(409, 'Run an assessment first')
            await ctx.refreshProvider()
            const written = await suggest({ company, findings: findingsOf(run.runId), decision: run.decision ? decisionLabels[run.decision] : 'not reached', codex: engine.codex, signal: new AbortController().signal })
            return reply(201, workspace.saveSuggestions(run.runId, company.id, { items: written.value, author: written.author, unsupported: written.unsupported, createdAt: new Date().toISOString(), runId: run.runId }))
          }
        }
      }
      if (area === 'requests' && id) {
        const request = workspace.request(id)
        if (!request) throw fail(404, 'No such request')
        const actor = actorOf(req)
        if (method === 'POST' && parts.length === 3) {
          if (request.status === 'sent') throw fail(409, 'This request was already sent')
          const body = await readJson(req)
          const text = (v: unknown, max: number, fallback: string) => typeof v === 'string' ? v.slice(0, max) : fallback
          return reply(200, workspace.saveRequest({
            ...request, subject: text(body.subject, 300, request.subject), body: text(body.body, 20_000, request.body),
            requirements: Array.isArray(body.requirements) ? body.requirements.map(String).slice(0, 30) : request.requirements,
            to: body.to ? { name: text(body.to.name, 120, request.to.name), email: text(body.to.email, 200, request.to.email).trim() } : request.to,
          }))
        }
        if (method === 'POST' && sub === 'send') {
          if (request.status === 'sent') throw fail(409, 'This request was already sent')
          if (!request.to.email || undeliverable(request.to.email)) throw fail(400, 'Add the representative\'s email address before sending')
          const client = gmail.loadClient(ctx.dataDir)
          if (!client) throw fail(400, 'Gmail is not set up for this workspace yet')
          const mailbox = workspace.gmail(actor.id)
          if (!mailbox) throw fail(400, 'Connect your Gmail account first (your name, top right)')
          try {
            const sent = await gmail.send(client, mailbox.refreshToken, gmail.message({ fromName: actor.name, from: mailbox.email, toName: request.to.name, to: request.to.email, subject: request.subject, body: request.body }))
            const done = workspace.saveRequest({ ...request, status: 'sent', sentBy: actor.name, sentAt: new Date().toISOString(), sentFrom: mailbox.email, error: null })
            if (request.caseId) workspace.addEvent(request.caseId, 'email', request.subject, actor, { requestId: request.id, to: request.to, from: mailbox.email, gmailId: sent.id })
            workspace.appendActivity(request.companyId, 'Request sent to the company', request.subject + ' → ' + (request.to.name ? request.to.name + ' ' : '') + '<' + request.to.email + '>', actor.name, { requestId: request.id, gmailId: sent.id })
            return reply(200, done)
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            workspace.saveRequest({ ...request, status: 'failed', error: message })
            throw fail(502, message)
          }
        }
      }

      // ─── Activity log ────────────────────────────────────────────────────
      if (is('GET', 'activity', 2)) return reply(200, workspace.activity(url.searchParams.get('company') ?? undefined))
      if (is('POST', 'activity', 2)) {
        const body = await readJson(req)
        const company = companyOf(body.companyId)
        const action = String(body.action ?? '').trim()
        if (!action) throw fail(400, 'Missing action')
        return reply(201, workspace.appendActivity(company.id, action, String(body.detail ?? ''), actorOf(req).name, body.payload))
      }

      // ─── Gmail ───────────────────────────────────────────────────────────
      if (is('GET', 'gmail', 2)) return reply(200, gmailState(req, actorOf(req)))
      if (is('GET', 'gmail', 3) && id === 'connect') {
        const client = gmail.loadClient(ctx.dataDir)
        if (!client) throw fail(400, 'Gmail is not set up for this workspace yet')
        const user = workspace.user(url.searchParams.get('user')) ?? workspace.user(DEFAULT_USER)!
        const state = randomUUID()
        const { verifier, challenge } = gmail.pkce()
        const redirectUri = origin(req) + '/api/gmail/callback'
        for (const [key, value] of pending) if (Date.now() - value.at > 15 * 60_000) pending.delete(key)
        pending.set(state, { userId: user.id, verifier, redirectUri, back: url.searchParams.get('back') ?? '/', at: Date.now() })
        res.writeHead(302, { location: gmail.authUrl(client, redirectUri, state, challenge) })
        res.end()
        return true
      }
      if (is('GET', 'gmail', 3) && id === 'callback') {
        const started = pending.get(url.searchParams.get('state') ?? '')
        const back = (result: string) => { res.writeHead(302, { location: (started?.back ?? '/') + (started?.back.includes('?') ? '&' : '?') + 'gmail=' + encodeURIComponent(result) }); res.end() }
        if (!started) { back('expired'); return true }
        pending.delete(url.searchParams.get('state')!)
        if (url.searchParams.get('error')) { back(url.searchParams.get('error')!); return true }
        try {
          const { refreshToken, email } = await gmail.exchangeCode(gmail.loadClient(ctx.dataDir)!, url.searchParams.get('code') ?? '', started.redirectUri, started.verifier)
          workspace.saveGmail(started.userId, email, refreshToken)
          back('connected')
        } catch (err) { back(err instanceof Error ? err.message : 'failed') }
        return true
      }
      if (is('POST', 'gmail', 3) && id === 'disconnect') {
        const actor = actorOf(req)
        const mailbox = workspace.gmail(actor.id)
        if (mailbox) { workspace.removeGmail(actor.id); await gmail.revoke(mailbox.refreshToken) }
        return reply(200, gmailState(req, actor))
      }

      // ─── Assessments for every company ───────────────────────────────────
      if (method === 'GET' && area === 'runs' && id === 'all' && parts.length === 3) return reply(200, ctx.batch.status())
      if (method === 'POST' && area === 'runs' && id === 'all' && parts.length === 3) {
        const body = await readJson(req)
        await ctx.refreshProvider()
        return reply(202, ctx.batch.start([...companies.keys()], ctx.policyFrom(body), engine.codex ? 3 : 6, actorOf(req).name))
      }
      if (method === 'POST' && area === 'runs' && id === 'all' && sub === 'stop') return reply(200, ctx.batch.stop())
    } catch (err: any) {
      send(res, err.status ?? 500, { error: err instanceof Error ? err.message : String(err) })
      return true
    }
    return false
  }
}
