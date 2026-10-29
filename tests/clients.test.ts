// Credit clients and their live monitoring. No model and no network: ANAF is
// off, and the news crawler runs against stubbed feeds and pages.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { EventPayloads } from '../src/assessment.ts'
import { foldAll } from '../src/assessment.ts'
import type { ClientStatus, MonitorEvent } from '../src/monitoring.ts'
import type { Company, Portfolio, Scenario } from '../src/types.ts'
import { Engine } from '../server/engine/engine.ts'
import { Monitor } from '../server/engine/monitor.ts'
import { Store } from '../server/store.ts'
import { type EngineProcess, readStream, startEngine } from './support/engine.ts'

process.env.CREDITDESK_ANAF = 'off'
const policy = (JSON.parse(readFileSync(new URL('../public/data/portfolio.json', import.meta.url), 'utf8')) as Portfolio).policy
const clients: Company[] = JSON.parse(readFileSync(new URL('../public/data/clients.json', import.meta.url), 'utf8')).clients
const oracle = JSON.parse(readFileSync(new URL('./fixtures/clients-oracle.json', import.meta.url), 'utf8'))

test('the eleven credit clients have approved credit lines and assess Eligible with no problems, as the generator expects', async () => {
  assert.equal(clients.length, 11)
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'clients-')), 'runs.sqlite'))
  const engine = new Engine(store, new URL('../public/documents', import.meta.url).pathname, null)
  for (const client of clients) {
    const line = client.creditLine!
    assert.ok(line.drawn > 0 && line.drawn <= line.limit && line.maturity > line.startDate, client.id)
    const runId = engine.start(client, policy)
    while (engine.isActive(runId)) await new Promise(r => setTimeout(r, 5))
    const view = foldAll(runId, store.events(runId))
    assert.equal(view.status, 'completed', client.id)
    assert.deepEqual(view.findings, [], client.id)
    const decision = store.events(runId).find(e => e.type === 'decision_reached')!.payload as EventPayloads['decision_reached']
    const expected = oracle.find((o: any) => o.dosar_id === client.id)
    for (const s of expected.scenarii) assert.equal(decision.scenarios[s.tip_scenariu as Scenario].decision, s.rezultat_asteptat, client.id + ' / ' + s.tip_scenariu)
  }
})

let engine: EngineProcess
before(async () => { engine = await startEngine({ CREDITDESK_LLM: 'none', CREDITDESK_ANAF: 'off', CREDITDESK_MONITOR_WEB: 'off' }) })
after(async () => { await engine?.stop() })
const waitFor = async <T>(read: () => Promise<T>, done: (v: T) => boolean) => { for (let i = 0; i < 400; i++) { const v = await read(); if (done(v)) return v; await new Promise(r => setTimeout(r, 50)) } throw new Error('timed out') }

test('a client is monitored: no assessment is a notice, its assessment checks the covenants and settles the notice', async () => {
  const status = await engine.get<{ clients: ClientStatus[]; intervalMinutes: number }>('/monitoring')
  assert.deepEqual(status.clients.map(c => c.companyId), clients.map(c => c.id))
  assert.ok(status.clients.every(c => c.status === 'unknown'))
  await engine.post('/monitoring/check', { companyId: 'TEST-DOS-051' })
  let state = await waitFor(() => engine.get<{ clients: ClientStatus[]; events: MonitorEvent[] }>('/monitoring'), s => !!s.clients[0].lastCheck)
  assert.deepEqual(state.clients[0].results, { anaf: 'ANAF not reached: ANAF lookup disabled (CREDITDESK_ANAF=off)', credit: 'not assessed', web: 'Public news check is off (CREDITDESK_MONITOR_WEB=off)' })
  assert.equal(state.clients[0].status, 'watch')
  assert.deepEqual(state.events.map(e => [e.source, e.severity, e.title]), [['covenants', 'watch', 'No assessment on file']])
  // Each worker's verdict for the tiles, and the steps it took for the live log.
  const first = state.clients[0] as ClientStatus
  assert.deepEqual([first.checks.anaf?.tone, first.checks.covenants?.label, first.checks.news?.tone], ['off', 'Not assessed', 'off'])
  const steps = (state as any).activity.map((a: any) => a.worker + ':' + a.state + ':' + a.text)
  assert.deepEqual(steps, ['anaf:working:Asking the ANAF register about CUI 13328043', 'anaf:failed:ANAF lookup disabled (CREDITDESK_ANAF=off)', 'covenants:working:Looking for a completed assessment', 'covenants:done:No completed assessment yet: nothing to compare'])

  // Assessing the client checks it again by itself.
  const runId = (await engine.post('/companies/TEST-DOS-051/runs')).runId
  await readStream(engine.url + '/api/runs/' + runId + '/stream?after=0')
  state = await waitFor(() => engine.get('/monitoring'), (s: any) => s.events.some((e: MonitorEvent) => e.title === 'Covenants met'))
  const met = state.events.find(e => e.title === 'Covenants met')!
  assert.match(met.detail, /^DSCR 2\.\d\d× \(min 1\.20×\), debt\/EBITDA .* \(max 4\.00×\), liquidity .* \(min 1\.00×\) · assessment/)
  assert.equal(met.data?.runId, runId)
  assert.equal(state.events.find(e => e.title === 'No assessment on file')!.reviewedBy, 'Monitoring (assessment ' + runId.slice(0, 8) + ' completed)')
  // What stays open is the annual review falling due within 30 days.
  assert.deepEqual(state.events.filter(e => e.severity !== 'info' && !e.reviewedAt).map(e => e.title), ['Annual review due soon'])
  assert.equal(state.clients[0].status, 'watch')
  assert.deepEqual((await engine.post('/monitoring/research', { companyId: 'TEST-DOS-051' })).result, 'no model available to search the web')
  await assert.rejects(engine.post('/monitoring/research', { companyId: 'TEST-DOS-001' }), /Only credit clients are monitored/)
})

test('reviewing a monitoring event records who did it', async () => {
  const { events } = await engine.get<{ events: MonitorEvent[] }>('/monitoring')
  const reviewed = await engine.post<MonitorEvent>('/monitoring/events/' + events[0].id + '/review')
  assert.equal(reviewed.reviewedBy, 'Ioana Marinescu')
  const log = await engine.get('/activity?company=TEST-DOS-051')
  assert.equal(log.at(-1).action, 'Monitoring event reviewed')
})

test('a planted test signal is found by the next check through the real steps, marked simulated, and clearing it puts things back', async () => {
  const id = 'TEST-DOS-053'
  const raised = async (title: RegExp) => (await waitFor(() => engine.get<{ events: MonitorEvent[] }>('/monitoring'), s => s.events.some(e => e.companyId === id && title.test(e.title)))).events.find(e => e.companyId === id && title.test(e.title))!
  for (const kind of ['news-insolvency', 'register-vat', 'covenant-dscr']) await engine.post('/monitoring/simulate', { companyId: id, kind })
  let state = await engine.get<{ clients: ClientStatus[] }>('/monitoring')
  assert.deepEqual(state.clients.find(c => c.companyId === id)!.planted.sort(), ['covenant-dscr', 'news-insolvency', 'register-vat'])
  await engine.post('/monitoring/check', { companyId: id })
  const news = await raised(/^Insolvency: Cemacon a cerut/)
  assert.deepEqual([news.severity, news.data?.simulated, news.data?.url], ['alert', true, undefined])
  assert.match(news.detail, /Cemacon a depus la tribunal cererea de deschidere a procedurii de insolvență/)
  assert.ok(news.data!.steps!.some(t => t.startsWith('Test signal planted by Ioana Marinescu')) && /: Insolvency → critical, needs action$/.test(news.data!.steps!.at(-1)!), news.data!.steps!.join(' | '))
  const vat = await raised(/^VAT registration cancelled$/)
  assert.deepEqual([vat.severity, vat.detail, vat.data?.simulated], ['watch', 'VAT: true → false', true])
  assert.ok(vat.data!.steps!.some(t => /ANAF is not asked/.test(t)))
  const breach = await raised(/^Covenant breach$/)
  assert.match(breach.detail, /^DSCR 1\.05× below 1\.20× · simulated quarterly figures$/)
  state = await engine.get('/monitoring')
  assert.equal(state.clients.find(c => c.companyId === id)!.status, 'alert')
  // Checking again raises nothing new; clearing removes the signals and records who did what.
  const count = (await engine.get<{ events: MonitorEvent[] }>('/monitoring')).events.filter(e => e.companyId === id).length
  await engine.post('/monitoring/check', { companyId: id })
  await waitFor(() => engine.get<{ clients: ClientStatus[] }>('/monitoring'), s => !s.clients.find(c => c.companyId === id)!.checking && !s.clients.find(c => c.companyId === id)!.queued)
  await new Promise(r => setTimeout(r, 300))
  assert.equal((await engine.get<{ events: MonitorEvent[] }>('/monitoring')).events.filter(e => e.companyId === id).length, count)
  for (const kind of ['news-insolvency', 'register-vat', 'covenant-dscr']) await engine.post('/monitoring/simulate', { companyId: id, kind, clear: true })
  assert.deepEqual((await engine.get<{ clients: ClientStatus[] }>('/monitoring')).clients.find(c => c.companyId === id)!.planted, [])
  assert.deepEqual((await engine.get('/activity?company=' + id)).map((a: any) => a.action).filter((a: string) => a.startsWith('Test signal')), ['Test signal planted', 'Test signal planted', 'Test signal planted', 'Test signal cleared', 'Test signal cleared', 'Test signal cleared'])
})

test('the news check reads feeds, opens matching articles only where robots.txt allows, and quotes the sentence naming the client', async () => {
  delete process.env.CREDITDESK_MONITOR_WEB
  const client = clients.find(c => c.symbol === 'CEON')!
  const feed = `<?xml version="1.0"?><rss><channel>
    <item><title>Cemacon intră în insolvență</title><link>https://news.example-press.ro/cemacon-insolventa</link><description>Producătorul de materiale Cemacon a cerut deschiderea procedurii.</description><pubDate>Tue, 27 Oct 2026 10:00:00 GMT</pubDate></item>
    <item><title>Cemacon, contract nou</title><link>https://blocked.example-press.ro/cemacon-contract</link><description>Cemacon a semnat un contract.</description></item>
    <item><title>Altă firmă raportează profit</title><link>https://news.example-press.ro/alta</link><description>Nimic despre client.</description></item>
  </channel></rss>`
  const article = '<html><head><meta property="article:published_time" content="2026-10-27T10:00:00Z"></head><body><nav>Acasă Economie Bursă</nav><p>Producătorul de cărămizi Cemacon a depus la tribunal cererea de deschidere a procedurii de insolvență, potrivit unui raport transmis bursei. Alte detalii nu au fost făcute publice.</p></body></html>'
  const requested: string[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: any) => {
    const url = String(input)
    requested.push(url)
    if (url.endsWith('/robots.txt')) return new Response(url.includes('blocked.') ? 'User-agent: *\nDisallow: /' : 'User-agent: *\nAllow: /', { status: 200 })
    if (/\/rss|\/feed/.test(url)) return new Response(url.includes('zf.ro') ? feed : '<rss><channel></channel></rss>', { status: 200, headers: { 'content-type': 'application/rss+xml' } })
    if (url === 'https://news.example-press.ro/cemacon-insolventa') return new Response(article, { status: 200, headers: { 'content-type': 'text/html' } })
    return new Response('not here', { status: 404 })
  }) as typeof fetch
  try {
    const db = new DatabaseSync(join(mkdtempSync(join(tmpdir(), 'monitor-')), 'm.sqlite'))
    const monitor = new Monitor(db, [client], () => null, 60)
    await monitor.check(client)
    const news = monitor.events().filter(e => e.source === 'web')
    assert.equal(news.length, 1, 'only news that needs attention is raised; the rest is listed by the crawler')
    const insolvency = news.find(e => e.data?.url?.includes('insolventa'))!
    assert.deepEqual([insolvency.severity, insolvency.title], ['alert', 'Insolvency: Cemacon intră în insolvență'])
    assert.match(insolvency.detail, /Cemacon a cerut deschiderea procedurii|Cemacon a depus la tribunal cererea de deschidere a procedurii de insolvență/)
    assert.equal(insolvency.data?.published, '2026-10-27')
    assert.match(insolvency.data?.sha256 ?? '', /^[0-9a-f]{64}$/)
    const { pages, crawl } = monitor.crawl(client.id)
    assert.deepEqual(pages.map(p => [p.status, p.topic, p.severity]).sort(), [['blocked', 'Contracts and investment', 'info'], ['read', 'Insolvency', 'alert']])
    const blocked = pages.find(p => p.url.includes('blocked'))!
    assert.equal(blocked.note, 'blocked.example-press.ro robots.txt disallows /cemacon-contract')
    assert.equal(crawl!.found, 2)
    assert.ok(crawl!.sources.some(x => x.name === 'Bing News search' && x.about === 'company'), 'the company is searched for by name')
    assert.match(monitor.crawledPage(client.id, 'https://news.example-press.ro/cemacon-insolventa')!.text!, /cererea de deschidere a procedurii de insolvență/)
    assert.ok(!requested.includes('https://blocked.example-press.ro/cemacon-contract'), 'a page robots.txt forbids is never fetched')
    assert.ok(!requested.includes('https://news.example-press.ro/alta'), 'articles that do not name the client are not opened')
    // The same articles are not reported twice.
    await monitor.check(client)
    assert.equal(monitor.events().filter(e => e.source === 'web').length, 1)
    assert.equal(monitor.status()[0].status, 'alert')
  } finally {
    globalThis.fetch = realFetch
    process.env.CREDITDESK_MONITOR_WEB = 'off'
  }
})

test('a new data folder assesses every credit client by itself, so each one starts with an assessment on file', async () => {
  const fresh = await startEngine({ CREDITDESK_LLM: 'none', CREDITDESK_ANAF: 'off', CREDITDESK_MONITOR_WEB: 'off', CREDITDESK_ONBOARD: 'on' })
  try {
    const runs = await waitFor(() => fresh.get<{ companyId: string; status: string; startedBy: string }[]>('/runs'), r => clients.every(c => r.some(x => x.companyId === c.id && x.status === 'completed')))
    assert.ok(runs.filter(r => clients.some(c => c.id === r.companyId)).every(r => r.startedBy === 'Credit committee'))
    assert.ok(!runs.some(r => !clients.some(c => c.id === r.companyId)), 'applications are left for the employee to start')
  } finally { await fresh.stop() }
})
