/**
 * Finra assessment engine: HTTP API, live run streams (SSE) and
 * original-page rendering. In development Vite proxies /api here; in
 * production this process also serves the built workspace from dist/.
 */

import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http'
import { basename, extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { RunEvent } from '../src/assessment.ts'
import type { Policy, Portfolio } from '../src/types.ts'
import { type CodexConfig, codexStatus } from './engine/codex.ts'
import { Engine, parseSimulation, whatIf } from './engine/engine.ts'
import { answerQuestion } from './engine/ask.ts'
import { type StoredUpload, documentFile, effectiveCompany, inspectUpload } from './engine/dossier.ts'
import { REQUIRED_DOCUMENTS } from '../src/assessment.ts'
import type { DossierUpload, EventPayloads } from '../src/assessment.ts'
import type { Company } from '../src/types.ts'
import type { CreditLine } from '../src/monitoring.ts'
import { readPdf, renderPage } from './engine/pdf.ts'
import { readJson, send } from './http.ts'
import { Batch } from './engine/batch.ts'
import { DEFAULT_USER, Workspace } from './workspace.ts'
import { workspaceRoutes } from './workspace-api.ts'
import { Monitor } from './engine/monitor.ts'
import { Store } from './store.ts'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const port = Number(process.env.PORT ?? 8787)
const dataDir = resolve(process.env.CREDITDESK_DATA ?? join(root, '.data'))
const publicDir = join(root, 'public')
const distDir = join(root, 'dist')
const documentsDir = join(publicDir, 'documents')

const portfolio: Portfolio = JSON.parse(readFileSync(join(publicDir, 'data/portfolio.json'), 'utf8'))
// Credit clients: companies whose financing was approved (scripts/generate-clients.py). They can be assessed again and are monitored.
const clientsFile = join(publicDir, 'data/clients.json')
const clients: Company[] = existsSync(clientsFile) ? JSON.parse(readFileSync(clientsFile, 'utf8')).clients : []
const companies = new Map([...portfolio.companies, ...clients].map(c => [c.id, c]))
const store = new Store(join(dataDir, 'creditdesk.sqlite'))

const llm = (process.env.CREDITDESK_LLM ?? 'codex').toLowerCase()
const codexConfig: CodexConfig = {
  command: process.env.CODEX_COMMAND ?? 'codex',
  model: process.env.CODEX_MODEL ?? 'gpt-6.1-sol',
  effort: process.env.CODEX_EFFORT ?? 'medium',
  timeoutMs: Number(process.env.CODEX_TIMEOUT_MS ?? 180_000),
}
let providerDetail = 'model calls disabled (CREDITDESK_LLM=none)'
let providerChecked = false
const engine = new Engine(store, documentsDir, null)
const workspace = new Workspace(store.db)
/** An application whose contract was signed, as a credit client: its credit line, and the name it goes by in the news. */
const asClient = (app: Company, creditLine: CreditLine): Company => ({ ...app, creditLine, monitorTerms: [app.name.replace(/\s+(S\.?\s?A\.?|S\.?R\.?L\.?)$/i, '').trim()] })
for (const signed of workspace.signedClients()) {
  const app = companies.get(signed.companyId)
  if (!app || clients.some(c => c.id === app.id)) continue
  const client = asClient(app, signed.creditLine)
  clients.push(client)
  companies.set(client.id, client)
}
const actorOf = (req: IncomingMessage) => workspace.user(String(req.headers['x-user'] ?? '')) ?? workspace.user(DEFAULT_USER)!

async function refreshProvider(): Promise<void> {
  if (llm !== 'codex') { engine.codex = null; return }
  let status = await codexStatus(codexConfig.command)
  // One retry before dropping a model that was working: a single slow or failed status check should not switch Ask to the engine.
  if (!status.available && engine.codex) status = await codexStatus(codexConfig.command)
  if (providerChecked && Boolean(engine.codex) !== status.available) console.log('Model provider: ' + (status.available ? 'Codex ' + codexConfig.model + ' available' : 'Codex unavailable') + ' · ' + status.detail)
  providerChecked = true
  engine.codex = status.available ? codexConfig : null
  providerDetail = status.available ? status.detail : 'Codex unavailable: ' + status.detail
}


const POLICY_NUMBERS = ['dscr_min', 'lichiditate_min', 'datorie_ebitda_max', 'vechime_min_luni', 'aport_min_procente'] as const
function policyFrom(body: any): Policy {
  const candidate = body?.policy
  if (!candidate || typeof candidate !== 'object') return portfolio.policy
  for (const key of POLICY_NUMBERS) if (typeof candidate[key] !== 'number' || !Number.isFinite(candidate[key])) throw Object.assign(new Error('policy.' + key + ' must be a number'), { status: 400 })
  return { ...portfolio.policy, ...candidate }
}

function stream(req: IncomingMessage, res: ServerResponse, runId: string, after: number) {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' })
  let last = after
  let replaying = true
  const queued: RunEvent[] = []
  const write = (e: RunEvent) => {
    if (e.seq <= last) return
    last = e.seq
    res.write('id: ' + e.seq + '\nevent: run\ndata: ' + JSON.stringify(e) + '\n\n')
    if (e.type === 'run_completed' || e.type === 'run_failed' || e.type === 'run_cancelled') close()
  }
  const unsubscribe = engine.subscribe(runId, e => replaying ? queued.push(e) : write(e))
  const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 15_000)
  let closed = false
  function close() {
    if (closed) return
    closed = true
    clearInterval(heartbeat)
    unsubscribe()
    res.write('event: end\ndata: {}\n\n')
    res.end()
  }
  req.on('close', () => { closed = true; clearInterval(heartbeat); unsubscribe() })
  for (const e of store.events(runId, after)) write(e)
  replaying = false
  for (const e of queued) write(e)
  if (!closed && !engine.isActive(runId)) close()
}

/** The dossier as it is now: the dataset's documents plus the analyst's current uploads. */
const currentCompany = (id: string) => effectiveCompany(companies.get(id)!, store.uploads(id))

/** The dossier as a given run saw it. */
async function runCompany(runId: string): Promise<Company> {
  const created = store.events(runId).find(e => e.type === 'run_created')!.payload as EventPayloads['run_created']
  const used = new Set((created.uploads ?? []).map(u => u.id))
  return effectiveCompany(companies.get(created.companyId)!, store.uploads(created.companyId, true).filter(u => used.has(u.id)))
}

/** Any file of a company's dossier, including uploads that have since been removed (older runs show them). */
function dossierFile(companyId: string, file: string): { path: string; pages: number } | null {
  const company = companies.get(companyId)
  const doc = company?.tables.documente.find(d => basename(d.fisier) === file)
  if (company && doc) return { path: documentFile(documentsDir, company, doc), pages: doc.pagini }
  const upload = store.uploads(companyId, true).find(u => u.file === file)
  return upload ? { path: upload.path, pages: upload.pages } : null
}

const publicUpload = ({ path: _path, ...u }: StoredUpload): DossierUpload => u
/** Steps of questions being answered right now, by the id the browser gave the question. */
const asking = new Map<string, string[]>()

const dossierOf = async (companyId: string) => {
  const uploads = store.uploads(companyId)
  return { company: await effectiveCompany(companies.get(companyId)!, uploads), uploads: uploads.map(publicUpload) }
}
const batch = new Batch(engine, dossierOf)
// The news is weighed by the lightest model Codex offers, at low effort: one short call per check.
const lightModel = () => engine.codex ? { ...engine.codex, model: process.env.CREDITDESK_CRAWL_MODEL ?? 'gpt-6-luna', effort: 'low' } : null
const monitor = new Monitor(store.db, clients, id => store.runs(id).find(r => r.status === 'completed') ?? null, Number(process.env.CREDITDESK_MONITOR_MINUTES) || 60, join(dataDir, 'pages', 'web'), lightModel)
// A client's new assessment is checked against its covenants straight away.
engine.onSettled((_runId, companyId) => { if (clients.some(c => c.id === companyId)) monitor.enqueue(companyId) })
const workspaceRoute = workspaceRoutes({ workspace, store, engine, batch, companies, applications: portfolio.companies.map(c => c.id).filter(id => !clients.some(c => c.id === id)), monitor, dataDir, policyFrom, refreshProvider,
  // A signed application becomes a credit client at once: monitored from now on, and no longer in Run all.
  makeClient: (app, creditLine) => {
    const client = asClient(app, creditLine)
    if (!clients.some(c => c.id === client.id)) clients.push(client)
    companies.set(client.id, client)
    monitor.addClient(client)
    return client
  },
  clients: () => clients })

async function addDocument(req: IncomingMessage, res: ServerResponse, companyId: string, kind: string, originalName: string) {
  const company = await currentCompany(companyId)
  if (!REQUIRED_DOCUMENTS.includes(kind)) return send(res, 400, { error: 'Unknown document type' })
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 15 * 1024 * 1024) return send(res, 413, { error: 'The file is larger than 15 MB.' })
    chunks.push(chunk)
  }
  const body = Buffer.concat(chunks)
  if (body.subarray(0, 5).toString() !== '%PDF-') return send(res, 422, { error: 'The file is not a PDF.' })
  const id = randomUUID()
  const file = kind + '-' + id.slice(0, 8) + '.pdf'
  const folder = join(dataDir, 'uploads', companyId)
  mkdirSync(folder, { recursive: true })
  const path = join(folder, file)
  writeFileSync(path, body)
  const check = await inspectUpload(company, kind, path)
  if (!check.ok) { rmSync(path, { force: true }); return send(res, 422, { error: check.reason }) }
  const upload: DossierUpload = {
    id, companyId, kind, file, originalName: basename(originalName || file).slice(0, 160), sha256: createHash('sha256').update(body).digest('hex'),
    pages: check.pdf.pages.length, fields: check.fields, uploadedAt: new Date().toISOString(), uploadedBy: 'Demo analyst', removedAt: null,
    replaces: company.tables.documente.some(d => d.tip_document === kind),
  }
  store.saveUpload(upload, path)
  send(res, 201, upload)
}

async function page(res: ServerResponse, companyId: string, file: string, n: number) {
  const found = dossierFile(companyId, file)
  if (!found || !Number.isInteger(n) || n < 1 || n > found.pages) return send(res, 404, { error: 'No such page' })
  const pdfPath = found.path
  const pdf = await readPdf(pdfPath)
  const png = await renderPage(pdfPath, pdf.sha256, n, join(dataDir, 'pages'))
  res.writeHead(200, { 'content-type': 'image/png', 'content-length': statSync(png).size, 'cache-control': 'public, max-age=31536000, immutable' })
  createReadStream(png).pipe(res)
}

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.png': 'image/png', '.woff2': 'font/woff2' }
function serveStatic(req: IncomingMessage, res: ServerResponse, path: string) {
  if (!existsSync(distDir)) return send(res, 404, { error: 'Run `npm run build` first, or use `npm run dev`.' })
  let target = normalize(join(distDir, decodeURIComponent(path)))
  if (!target.startsWith(distDir)) return send(res, 403, { error: 'forbidden' })
  if (!existsSync(target) || statSync(target).isDirectory()) target = join(distDir, 'index.html')
  const hashed = target.includes(join(distDir, 'assets'))
  res.writeHead(200, { 'content-type': MIME[extname(target)] ?? 'application/octet-stream', 'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache' })
  createReadStream(target).pipe(res)
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts[0] !== 'api') return serveStatic(req, res, url.pathname)
  if (await workspaceRoute(req, res, url, parts)) return
  // Every company's dossier in one answer: the required documents still missing once the employee's uploads count.
  if (req.method === 'GET' && parts[1] === 'dossiers' && parts.length === 2) {
    return send(res, 200, Object.fromEntries([...companies.values()].map(c => {
      const added = store.uploads(c.id).map(u => u.kind)
      return [c.id, { missing: REQUIRED_DOCUMENTS.filter(k => !added.includes(k) && !c.tables.documente.some(d => d.tip_document === k)), added }]
    })))
  }
  if (parts[1] === 'companies' && companies.has(parts[2]) && parts[3] === 'documents') {
    const companyId = parts[2]
    if (req.method === 'GET' && parts.length === 4) {
      const now = await currentCompany(companyId)
      return send(res, 200, {
        documents: now.tables.documente.map(d => ({ kind: d.tip_document, documentId: d.document_id, file: basename(d.fisier), pages: d.pagini, sha256: d.sha256, supplied: d.supplied ?? null })),
        missing: REQUIRED_DOCUMENTS.filter(k => !now.tables.documente.some(d => d.tip_document === k)),
        uploads: store.uploads(companyId).map(publicUpload),
      })
    }
    if (req.method === 'POST' && parts.length === 4) return addDocument(req, res, companyId, url.searchParams.get('kind') ?? '', url.searchParams.get('name') ?? '')
    if (req.method === 'DELETE' && parts.length === 5) return send(res, store.removeUpload(companyId, parts[4]) ? 200 : 404, {})
  }
  if (req.method === 'GET' && parts[1] === 'documents' && parts.length === 4 && companies.has(parts[2])) {
    const found = dossierFile(parts[2], decodeURIComponent(parts[3]))
    if (!found) return send(res, 404, { error: 'No such document' })
    res.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': 'inline; filename="' + parts[3].replace(/"/g, '') + '"' })
    return createReadStream(found.path).pipe(res)
  }
  const route = req.method + ' /' + parts.slice(1).map(p => companies.has(p) ? ':company' : /^[0-9a-f-]{36}$/.test(p) ? ':run' : p).join('/')
  const company = parts.find(p => companies.has(p))
  const runId = parts.find(p => /^[0-9a-f-]{36}$/.test(p))

  switch (route) {
    case 'GET /health':
      await refreshProvider()
      return send(res, 200, { provider: engine.provider, providerDetail, anaf: 'https://webservicesp.anaf.ro/api/PlatitorTvaRest/v9/tva' })
    case 'GET /runs':
      return send(res, 200, store.runs())
    case 'GET /companies/:company/runs':
      return send(res, 200, { runs: store.runs(company), active: engine.activeRun(company!) })
    case 'POST /companies/:company/runs': {
      const body = await readJson(req)
      await refreshProvider()
      try {
        const uploads = store.uploads(company!)
        return send(res, 201, { runId: engine.start(await effectiveCompany(companies.get(company!)!, uploads), policyFrom(body), uploads.map(publicUpload), actorOf(req).name) })
      } catch (err: any) {
        return send(res, err.status ?? 500, { error: err.message, runId: err.runId })
      }
    }
    case 'GET /runs/:run': {
      const summary = store.run(runId!)
      return summary ? send(res, 200, { summary, events: store.events(runId!), active: engine.isActive(runId!) }) : send(res, 404, { error: 'No such run' })
    }
    case 'GET /runs/:run/stream':
      if (!store.run(runId!)) return send(res, 404, { error: 'No such run' })
      return stream(req, res, runId!, Number(url.searchParams.get('after') ?? req.headers['last-event-id'] ?? 0) || 0)
    case 'POST /runs/:run/cancel':
      return send(res, engine.cancel(runId!, 'analyst') ? 202 : 409, { cancelled: engine.isActive(runId!) })
    case 'POST /runs/:run/what-if': {
      const run = store.run(runId!)
      if (!run) return send(res, 404, { error: 'No such run' })
      try {
        return send(res, 200, whatIf(await runCompany(run.runId), run, parseSimulation((await readJson(req)).settings)))
      } catch (err: any) {
        return send(res, err.status ?? 500, { error: err.message })
      }
    }
    case 'GET /runs/:run/questions':
      return send(res, 200, store.questions(runId!))
    case 'GET /runs/:run/ask/:run':
      return send(res, 200, { steps: asking.get(parts[4]) ?? [] })
    case 'POST /runs/:run/ask': {
      const run = store.run(runId!)
      if (!run) return send(res, 404, { error: 'No such run' })
      const body = await readJson(req)
      const question = String(body.question ?? '').trim().slice(0, 600)
      if (!question) return send(res, 400, { error: 'Ask a question' })
      await refreshProvider()
      const controller = new AbortController()
      res.on('close', () => { if (!res.writableEnded) controller.abort(new Error('analyst left')) })
      const asked = await runCompany(run.runId)
      // The steps taken so far, for the analyst's screen to follow while the answer is worked out.
      const askId = typeof body.askId === 'string' && /^[0-9a-f-]{36}$/.test(body.askId) ? body.askId : null
      if (askId) { asking.set(askId, []); setTimeout(() => asking.delete(askId), 10 * 60_000).unref() }
      const answer = await answerQuestion({ onStep: text => { if (askId) asking.get(askId)?.push(text) }, company: asked, runId: run.runId, events: store.events(run.runId), documentsDir, codex: engine.codex, question, history: store.questions(run.runId), signal: controller.signal, about: typeof body.findingId === 'string' ? body.findingId : null,
        contacts: workspace.contacts(asked), cases: workspace.cases({ companyId: asked.id }), askedBy: actorOf(req).name,
        monitoring: asked.creditLine ? monitor.events({ companyId: asked.id, limit: 200 }).filter(e => e.severity !== 'info' && !e.reviewedAt).slice(0, 25)
          .map(e => ({ when: e.data?.published ?? e.ts.slice(0, 10), source: e.source === 'web' ? 'news · ' + (e.data?.site ?? '') : e.source, severity: e.severity, title: e.title, detail: e.detail, ...(e.data?.url ? { url: e.data.url } : {}) })) : undefined })
      if (!controller.signal.aborted) store.saveQuestion(answer)
      return send(res, 200, answer)
    }
    case 'GET /runs/:run/verify':
      return send(res, 200, store.verify(runId!))
  }
  if (req.method === 'GET' && parts[1] === 'documents' && company && parts[3] && parts[4] === 'pages' && parts[5]?.endsWith('.png'))
    return page(res, company, parts[3], Number(parts[5].slice(0, -4)))
  send(res, 404, { error: 'Unknown route ' + route })
}

const server = createServer((req, res) => {
  handle(req, res).catch(err => {
    if (!res.headersSent) send(res, err.status ?? 500, { error: err instanceof Error ? err.message : String(err) })
    else res.end()
  })
})

await refreshProvider()
if (process.env.CREDITDESK_MONITOR !== 'off') monitor.start()
// Credit clients were assessed when their credit was approved. A client without a completed
// assessment (a new data folder, say) gets one now, a few at a time like Run all; monitoring
// then checks its covenants as each one finishes.
const unassessed = clients.filter(c => !engine.activeRun(c.id) && !store.runs(c.id).some(r => r.status === 'completed')).map(c => c.id)
if (unassessed.length && process.env.CREDITDESK_ONBOARD !== 'off') {
  new Batch(engine, dossierOf).start(unassessed, portfolio.policy, Number(process.env.CREDITDESK_BATCH_CONCURRENCY) || (engine.codex ? 2 : 6), 'Credit committee')
  console.log('Assessing ' + unassessed.length + ' credit clients that have no completed assessment yet')
}
server.listen(port, '127.0.0.1', () => {
  console.log('Finra engine on http://127.0.0.1:' + port + ' · data ' + dataDir)
  console.log('Model provider: ' + (engine.codex ? 'Codex ' + engine.codex.model + ' (' + engine.codex.effort + ')' : 'none') + ' · ' + providerDetail)
})
