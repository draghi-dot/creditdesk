/**
 * Live monitoring of credit clients: companies whose financing was approved.
 * On a schedule (and on demand) each client is checked against:
 *
 * - the ANAF register, live: registration status, inactive flag, VAT, name
 *   and address, compared with what was recorded at the previous check;
 * - public news pages, the way the AgentResearchFinanciar crawler does it:
 *   search results are only used to discover URLs, each page is read
 *   itself (robots.txt respected, at least two seconds between requests to
 *   a host), kept by SHA-256, and only counted when it names the company;
 *   the passage that matched is quoted;
 * - its credit line: covenants against the latest completed assessment,
 *   and review dates.
 *
 * Each change becomes an event in the live feed. Nothing is inferred from a
 * headline alone, and a page that cannot be read is a gap, not a clean bill.
 */

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { Company } from '../../src/types.ts'
import type { AssessmentSummary } from '../../src/assessment.ts'
import { ratio } from '../../src/analysis.ts'
import type { CheckResult, ClientStatus, CrawlSource, CrawledPage, MonitorActivity, MonitorEvent, MonitorSeverity, MonitorSource, MonitorWorker, Simulation, SimulationKind } from '../../src/monitoring.ts'
import { SIMULATIONS } from '../../src/monitoring.ts'
import { lookupAnaf, nameWords } from './anaf.ts'
import { USER_AGENT, pageText } from './contacts.ts'
import type { CodexConfig } from './codex.ts'
import { askCodex } from './codex.ts'

type Listener = (e: MonitorEvent) => void
type Article = { title: string; link: string; description: string; date: string | null; site: string; source?: string; simulated?: boolean; body?: string }
const OPEN_PER_CHECK = Number(process.env.CREDITDESK_MONITOR_OPEN ?? 12)
/** Older news is kept for the record but raises nothing. */
const STALE_DAYS = 90

/** Text with its HTML character references written out. */
const entities = (t: string) => t.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')

/** A headline without the site's breadcrumbs some feeds put in front of it ("Acasă • Industrie • …"). */
export const cleanTitle = (t: string) => t.replace(/(^|: )(?:Acas[ăa]|Home|Prima pagin[ăa])\s*[•›»|>]\s*(?:[^•›»|>:]{1,40}?\s*[•›»|>]\s*)*/i, '$1').trim()

/** The items of an RSS feed; links from news search are resolved to the publisher's own address. */
function parseFeed(raw: string, source: string): Article[] {
  const items: Article[] = []
  for (const m of raw.matchAll(/<item[\s\S]*?<\/item>/g)) {
    const field = (name: string) => entities(entities(new RegExp('<' + name + '[^>]*>([\\s\\S]*?)<\\/' + name + '>').exec(m[0])?.[1] ?? '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
    let link = field('link') || (/<guid[^>]*>(https?:[^<]+)<\/guid>/.exec(m[0])?.[1] ?? '')
    try { const u = new URL(link); if (u.hostname.endsWith('bing.com') && u.searchParams.get('url')) link = u.searchParams.get('url')! } catch { continue }
    if (!/^https?:\/\//.test(link)) continue
    const date = field('pubDate')
    const parsed = date ? new Date(date) : null
    items.push({ title: cleanTitle(field('title')), link, description: field('description').slice(0, 600), date: parsed && !isNaN(+parsed) ? parsed.toISOString().slice(0, 10) : null, site: new URL(link).hostname.replace(/^www\./, ''), source })
  }
  return items
}
type Reading = { name: string; status: string; inactive: boolean; vatPayer: boolean; eInvoice: boolean; address: string }
const workerOf: Record<MonitorSource, MonitorWorker | null> = { anaf: 'anaf', web: 'news', covenants: 'covenants', engine: null }
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
type ActivityListener = (a: MonitorActivity) => void

/** Register status in a word or two. */
const shortStatus = (status: string) => /RADIER/i.test(status) ? 'Deregistered' : /DIZOLVARE|LICHIDARE/i.test(status) ? 'Dissolving' : /INSOLVEN|FALIMENT/i.test(status) ? 'Insolvent' : 'Registered'

/** Words that make a news passage relevant to a lender, by how much attention they need. */
const TOPICS: { topic: string; severity: MonitorSeverity; words: RegExp }[] = [
  { topic: 'Insolvency', severity: 'alert', words: /insolven|faliment|reorganizare judiciar|administrator judiciar|lichidator|insolvency|bankruptcy/i },
  { topic: 'Enforcement or tax debt', severity: 'alert', words: /executare silit|poprire|sechestru|datorii (la|catre) (stat|ANAF|buget)|restan[tț]e (la|fiscale)|tax arrears/i },
  { topic: 'Investigation', severity: 'alert', words: /\bDNA\b|DIICOT|dosar penal|perchezi[tț]i|anchet[aă] penal|fraud/i },
  { topic: 'Litigation', severity: 'watch', words: /litigi|proces(ul)? (civil|penal|comercial|împotriva|impotriva|intentat)|instan[tț][aăei]|tribunal|sentin[tț]|dat[aă]? în judecat|lawsuit|court ruling/i },
  { topic: 'Strike or disruption', severity: 'watch', words: /grev[aăei]|protest|blocad|zboruri (anulate|suspendate)|anul[aă]ri|strike|walkout/i },
  { topic: 'State aid or restructuring', severity: 'watch', words: /ajutor(ul)? de stat|restructur|plan de redresare|majorare de capital|recapitaliz|state aid|restructuring|bailout/i },
  { topic: 'Management change', severity: 'watch', words: /demisi|revocat|noul (director|CEO|pre[sș]edinte)|numit (director|CEO)|resign|appointed/i },
  { topic: 'Losses or job cuts', severity: 'watch', words: /pierderi? (net|de)|scădere a profitului|concedier|disponibiliz|losses|layoffs/i },
  { topic: 'Financial results', severity: 'info', words: /profit(ul)? net|cifr[aă] de afaceri|rezultate financiare|dividend|revenue|net profit/i },
  { topic: 'Contracts and investment', severity: 'info', words: /contract|investi[tț]i|achizi[tț]i|acquisition|investment/i },
]
const STATUS_ALERT = /RADIER|DIZOLVARE|LICHIDARE|INSOLVEN|FALIMENT/i
/** Business-news feeds that publish RSS for automated reading. */
const FEEDS = ['https://www.zf.ro/rss', 'https://www.profit.ro/rss', 'https://www.economica.net/rss', 'https://financialintelligence.ro/feed/', 'https://www.news.ro/rss', 'https://www.digi24.ro/rss', 'https://www.mediafax.ro/rss', 'https://www.g4media.ro/feed', 'https://www.startupcafe.ro/rss']

export class Monitor {
  private readonly db: DatabaseSync
  private readonly clients: Company[]
  private readonly latestRun: (companyId: string) => AssessmentSummary | null
  private readonly listeners = new Set<Listener>()
  private readonly activityListeners = new Set<ActivityListener>()
  /** The last steps taken, for a page that opens mid-check. */
  private readonly recent: MonitorActivity[] = []
  private working: { companyId: string; worker: MonitorWorker } | null = null
  private readonly lastHit = new Map<string, number>()
  private readonly robots = new Map<string, { at: number; rules: { allow: boolean; path: RegExp; length: number }[] }>()
  private readonly queue: string[] = []
  private current: string | null = null
  private timer: NodeJS.Timeout | null = null
  private feeds: { at: number; items: Article[]; read: number; sources: CrawlSource[] } | null = null
  private readonly companyFeedCache = new Map<string, { at: number; items: Article[]; sources: CrawlSource[] }>()
  private readonly snapshotDir: string | null
  /** The light model that weighs the news (one short call per check), when a model is connected. */
  private readonly lightModel: () => CodexConfig | null
  /** The steps each worker took in the check under way, kept with what it raises. */
  private readonly trail = new Map<string, string[]>()
  readonly intervalMinutes: number

  constructor(db: DatabaseSync, clients: Company[], latestRun: (companyId: string) => AssessmentSummary | null, intervalMinutes = 60, snapshotDir?: string, lightModel: () => CodexConfig | null = () => null) {
    this.db = db
    this.lightModel = lightModel
    this.snapshotDir = snapshotDir ?? null
    if (this.snapshotDir) mkdirSync(this.snapshotDir, { recursive: true })
    this.clients = clients
    this.latestRun = latestRun
    this.intervalMinutes = intervalMinutes
    db.exec(`
      CREATE TABLE IF NOT EXISTS monitor_events (id TEXT PRIMARY KEY, company_id TEXT NOT NULL, ts TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS monitor_events_company ON monitor_events (company_id, ts);
      CREATE TABLE IF NOT EXISTS monitor_state (company_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (company_id, kind));
      CREATE TABLE IF NOT EXISTS monitor_seen (company_id TEXT NOT NULL, url TEXT NOT NULL, ts TEXT NOT NULL, PRIMARY KEY (company_id, url));
      CREATE TABLE IF NOT EXISTS monitor_pages (company_id TEXT NOT NULL, url TEXT NOT NULL, found_at TEXT NOT NULL, payload TEXT NOT NULL, text TEXT, PRIMARY KEY (company_id, url));
      CREATE TABLE IF NOT EXISTS monitor_simulations (company_id TEXT NOT NULL, kind TEXT NOT NULL, created_at TEXT NOT NULL, created_by TEXT NOT NULL, prior TEXT, PRIMARY KEY (company_id, kind));
    `)
  }

  // ─── Schedule ──────────────────────────────────────────────────────────────

  /** Check every client on a schedule, one at a time; clients never checked go first. */
  start(): void {
    const tick = () => {
      const due = this.clients.filter(c => {
        const last = this.state<{ at: string }>(c.id, 'checked')?.at
        return !last || Date.now() - Date.parse(last) >= this.intervalMinutes * 60_000
      })
      for (const c of due) this.enqueue(c.id)
    }
    tick()
    this.timer = setInterval(tick, 60_000)
    this.timer.unref()
  }

  stop(): void { if (this.timer) clearInterval(this.timer) }

  /** A company that just became a credit client: monitored from now on, first check straight away. */
  addClient(company: Company): void {
    const at = this.clients.findIndex(c => c.id === company.id)
    if (at >= 0) this.clients[at] = company
    else this.clients.push(company)
    this.enqueue(company.id)
  }

  enqueue(companyId: string): void {
    if (this.current === companyId || this.queue.includes(companyId) || !this.clients.some(c => c.id === companyId)) return
    this.queue.push(companyId)
    void this.pump()
  }

  private async pump(): Promise<void> {
    if (this.current) return
    const next = this.queue.shift()
    if (!next) return
    this.current = next
    try { await this.check(this.clients.find(c => c.id === next)!) }
    catch (err) { this.emit(next, 'engine', 'watch', 'Monitoring check failed', err instanceof Error ? err.message : String(err)) }
    finally { this.current = null; void this.pump() }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  subscribeActivity(listener: ActivityListener): () => void {
    this.activityListeners.add(listener)
    return () => { this.activityListeners.delete(listener) }
  }

  activity(): MonitorActivity[] { return [...this.recent] }
  now(): { companyId: string; worker: MonitorWorker } | null { return this.working }

  /** Report what a worker is doing, live. */
  private step(companyId: string, worker: MonitorWorker, state: MonitorActivity['state'], text: string): void {
    this.working = state === 'working' ? { companyId, worker } : this.working
    const a: MonitorActivity = { companyId, worker, state, text, ts: new Date().toISOString() }
    this.trail.get(companyId + ':' + worker)?.push(text)
    this.recent.push(a)
    if (this.recent.length > 80) this.recent.shift()
    for (const listener of this.activityListeners) listener(a)
  }

  // ─── Checks ────────────────────────────────────────────────────────────────

  async check(company: Company): Promise<void> {
    const checks: Partial<Record<MonitorWorker, CheckResult>> = {}
    for (const w of ['anaf', 'covenants', 'news'] as const) this.trail.set(company.id + ':' + w, [])
    checks.anaf = await this.checkRegister(company)
    checks.covenants = this.checkCreditLine(company)
    const webOff = process.env.CREDITDESK_MONITOR_WEB === 'off'
    checks.news = webOff && !this.planted(company.id, 'news').length ? { tone: 'off', label: 'Off', detail: 'Public news check is off (CREDITDESK_MONITOR_WEB=off)' } : await this.checkNews(company, webOff)
    for (const w of ['anaf', 'covenants', 'news'] as const) this.trail.delete(company.id + ':' + w)
    this.working = null
    const results = { anaf: checks.anaf.detail, credit: checks.covenants.detail, web: checks.news.detail }
    this.setState(company.id, 'checked', { at: new Date().toISOString(), results, checks })
    for (const listener of this.listeners) listener({ id: '', companyId: company.id, ts: new Date().toISOString(), source: 'engine', severity: 'info', title: 'checked', detail: '' })
  }

  /** The ANAF register, compared with what the previous check recorded. */
  private async checkRegister(company: Company): Promise<CheckResult> {
    let before = this.state<Reading>(company.id, 'anaf')
    let now: Reading
    let endpoint: string | undefined
    let answered: string
    const test = this.planted(company.id, 'anaf')[0]
    if (test) {
      // A planted test signal stands in for ANAF's answer; the comparison that follows is the real one.
      this.step(company.id, 'anaf', 'working', 'Test signal planted by ' + test.createdBy + ': the register answer is simulated, ANAF is not asked')
      const base: Reading = before ?? { name: company.name, status: 'INREGISTRAT', inactive: false, vatPayer: true, eInvoice: true, address: company.city }
      before = base
      now = { ...base, ...(test.kind === 'register-vat' ? { vatPayer: false } : { inactive: true }) }
      answered = 'Simulated register answer'
    } else {
      this.step(company.id, 'anaf', 'working', 'Asking the ANAF register about CUI ' + company.cui)
      const anaf = await lookupAnaf(company.cui, new Date().toISOString().slice(0, 10), new AbortController().signal, 20_000)
      if (!anaf.found) {
        if (anaf.error) { this.step(company.id, 'anaf', 'failed', anaf.error); return { tone: 'off', label: 'Not reached', detail: 'ANAF not reached: ' + anaf.error } }
        this.step(company.id, 'anaf', 'done', 'ANAF has no taxpayer with CUI ' + company.cui)
        this.emit(company.id, 'anaf', 'alert', 'Not found in the ANAF register', 'ANAF has no taxpayer with CUI ' + company.cui + '.')
        return { tone: 'alert', label: 'Not found', detail: 'ANAF has no taxpayer with CUI ' + company.cui }
      }
      now = { name: anaf.found.name, status: anaf.found.registrationStatus, inactive: anaf.found.inactive, vatPayer: anaf.found.vatPayer, eInvoice: anaf.found.eInvoice, address: anaf.found.address }
      endpoint = anaf.found.endpoint
      answered = 'ANAF answered in ' + anaf.durationMs + ' ms'
    }
    this.setState(company.id, 'anaf', now)
    if (!before) {
      const bad = STATUS_ALERT.test(now.status) || now.inactive
      this.emit(company.id, 'anaf', bad ? 'alert' : 'info', 'Register baseline recorded',
        now.name + ' · ' + now.status + (now.inactive ? ' · INACTIVE taxpayer' : '') + ' · VAT ' + (now.vatPayer ? 'registered' : 'not registered'), { url: endpoint })
      this.step(company.id, 'anaf', 'done', answered + ' · ' + shortStatus(now.status).toLowerCase() + ' · first reading kept to compare with')
      return { tone: bad ? 'alert' : 'ok', label: shortStatus(now.status), detail: 'First reading recorded · ' + now.status }
    }
    this.step(company.id, 'anaf', 'working', 'Comparing status, inactive flag, VAT, name and address with the reading of ' + (this.state<{ at: string }>(company.id, 'checked') ? new Date(this.state<{ at: string }>(company.id, 'checked')!.at).toTimeString().slice(0, 5) : 'the last check'))
    const changes: [MonitorSeverity, string, string][] = []
    if (now.status !== before.status) changes.push([STATUS_ALERT.test(now.status) ? 'alert' : 'watch', 'Registration status changed', before.status + ' → ' + now.status])
    if (now.inactive !== before.inactive) changes.push([now.inactive ? 'alert' : 'info', now.inactive ? 'Declared an inactive taxpayer' : 'No longer an inactive taxpayer', 'ANAF inactive flag: ' + before.inactive + ' → ' + now.inactive])
    if (now.vatPayer !== before.vatPayer) changes.push(['watch', now.vatPayer ? 'Registered for VAT' : 'VAT registration cancelled', 'VAT: ' + before.vatPayer + ' → ' + now.vatPayer])
    if (now.name !== before.name) changes.push(['watch', 'Registered name changed', before.name + ' → ' + now.name])
    if (now.address !== before.address) changes.push(['watch', 'Registered office moved', before.address + ' → ' + now.address])
    for (const [severity, title, detail] of changes) {
      this.step(company.id, 'anaf', 'working', title + ' (' + detail + ') → ' + (severity === 'alert' ? 'needs attention' : severity === 'watch' ? 'something to look at' : 'for information'))
      this.emit(company.id, 'anaf', severity, title, detail, { url: endpoint, ...(test ? { simulated: true, note: 'Simulated register answer; ANAF was not asked' } : {}) })
    }
    this.step(company.id, 'anaf', 'done', answered + ' · ' + (changes.length ? changes.map(c => c[1].toLowerCase()).join(', ') : 'nothing changed since the last check'))
    const worst: CheckResult['tone'] = changes.some(c => c[0] === 'alert') ? 'alert' : changes.length ? 'watch' : 'ok'
    return { tone: worst, label: changes.length ? changes.length + (changes.length === 1 ? ' change' : ' changes') : shortStatus(now.status), detail: changes.length ? changes.map(c => c[1]).join('; ') : 'No change since the last check · ' + now.status }
  }

  /** Covenants against the latest completed assessment, and the review date. */
  private checkCreditLine(company: Company): CheckResult {
    const line = company.creditLine
    if (!line) return { tone: 'off', label: 'No credit line', detail: 'no credit line' }
    const run = this.latestRun(company.id)
    const notes: string[] = []
    const test = this.planted(company.id, 'covenants')[0]
    const key = (run ? run.runId : 'none') + (test ? ':test:' + test.createdAt : '')
    const before = this.state<{ run: string; breaches: string[] }>(company.id, 'covenants')
    this.step(company.id, 'covenants', 'working', test ? 'Test signal planted by ' + test.createdBy + ': using simulated quarterly figures (DSCR 1.05×) instead of the assessment' : run ? 'Comparing the covenants with assessment ' + run.runId.slice(0, 8) : 'Looking for a completed assessment')
    if (!run?.digest && !test) {
      if (before?.run !== key) this.emit(company.id, 'covenants', 'watch', 'No assessment on file', 'Covenants cannot be checked until the client is assessed. Run an assessment from the company page.')
      this.setState(company.id, 'covenants', { run: key, breaches: [] })
      this.step(company.id, 'covenants', 'done', 'No completed assessment yet: nothing to compare')
      return { tone: 'watch', label: 'Not assessed', detail: 'not assessed' }
    }
    // An assessment now exists: the earlier "no assessment" notice is settled by it.
    if (before?.run === 'none' && run) for (const e of this.events({ companyId: company.id, limit: 500 })) if (e.title === 'No assessment on file' && !e.reviewedAt) this.review(e.id, 'Monitoring (assessment ' + run.runId.slice(0, 8) + ' completed)')
    const m = test ? { leverage: null, liquidity: null, ...run?.digest?.metrics, dscr: 1.05 } : run!.digest!.metrics
    const breaches: string[] = []
    if (m.dscr !== null && m.dscr < line.covenants.dscrMin) breaches.push('DSCR ' + ratio(m.dscr) + ' below ' + ratio(line.covenants.dscrMin))
    if (m.leverage !== null && m.leverage > line.covenants.leverageMax) breaches.push('debt/EBITDA ' + ratio(m.leverage) + ' above ' + ratio(line.covenants.leverageMax))
    if (m.liquidity !== null && m.liquidity < line.covenants.liquidityMin) breaches.push('liquidity ' + ratio(m.liquidity) + ' below ' + ratio(line.covenants.liquidityMin))
    if (before?.run !== key) {
      const met = 'DSCR ' + ratio(m.dscr) + ' (min ' + ratio(line.covenants.dscrMin) + '), debt/EBITDA ' + ratio(m.leverage) + ' (max ' + ratio(line.covenants.leverageMax) + '), liquidity ' + ratio(m.liquidity) + ' (min ' + ratio(line.covenants.liquidityMin) + ')'
      if (breaches.length) this.step(company.id, 'covenants', 'working', breaches.join('; ') + ' → needs attention')
      this.emit(company.id, 'covenants', breaches.length ? 'alert' : 'info', breaches.length ? 'Covenant breach' : 'Covenants met', (breaches.length ? breaches.join('; ') : met) + (test ? ' · simulated quarterly figures' : ' · assessment ' + run!.runId.slice(0, 8) + ' of ' + (run!.endedAt ?? run!.createdAt).slice(0, 10)),
        test ? { simulated: true, note: 'Simulated quarterly figures; not from an assessment' } : { runId: run!.runId })
    }
    this.setState(company.id, 'covenants', { run: key, breaches })
    notes.push(breaches.length ? breaches.length + ' breach(es)' : 'covenants met')
    this.step(company.id, 'covenants', 'done', breaches.length ? breaches.join('; ') : 'DSCR ' + ratio(m.dscr) + ' ≥ ' + ratio(line.covenants.dscrMin) + ' · debt/EBITDA ' + ratio(m.leverage) + ' ≤ ' + ratio(line.covenants.leverageMax) + ' · liquidity ' + ratio(m.liquidity) + ' ≥ ' + ratio(line.covenants.liquidityMin))
    const days = Math.round((Date.parse(line.nextReview) - Date.now()) / 86_400_000)
    if (days <= 30 && !this.state(company.id, 'review-' + line.nextReview)) {
      this.setState(company.id, 'review-' + line.nextReview, { notified: true })
      this.trail.set(company.id + ':covenants', [])
      this.step(company.id, 'covenants', 'working', 'The credit line\'s annual review is on ' + line.nextReview + (days < 0 ? ', ' + -days + ' days ago' : ', in ' + days + ' days') + ' (flagged from 30 days before) → something to look at')
      this.emit(company.id, 'covenants', 'watch', days < 0 ? 'Annual review overdue' : 'Annual review due soon', 'Review date ' + line.nextReview + (days < 0 ? ' (' + -days + ' days ago)' : ' (in ' + days + ' days)') + '.')
    }
    return { tone: breaches.length ? 'alert' : 'ok', label: breaches.length ? breaches.length + (breaches.length === 1 ? ' breach' : ' breaches') : 'Met', detail: notes.join(', ') }
  }

  /** Recent articles from business-news feeds, shared by all clients for a quarter of an hour. */
  private async feedItems(companyId: string): Promise<{ items: Article[]; read: number; sources: CrawlSource[] }> {
    if (this.feeds && Date.now() - this.feeds.at < 15 * 60_000) {
      this.step(companyId, 'news', 'working', 'Using the ' + this.feeds.items.length + ' headlines read from ' + this.feeds.read + ' news feeds at ' + new Date(this.feeds.at).toTimeString().slice(0, 5))
      return this.feeds
    }
    const items: Article[] = []
    const sources: CrawlSource[] = []
    for (const feed of FEEDS) {
      const name = feed.replace(/^https:\/\/(www\.)?/, '')
      this.step(companyId, 'news', 'working', 'Reading ' + name)
      const page = await this.politeText(feed, true)
      const found = page.raw ? parseFeed(page.raw, name.split('/')[0]) : []
      sources.push({ name: name.split('/')[0], url: feed, items: found.length, status: page.raw ? 'read' : page.blocked ?? 'not available', about: 'headlines' })
      if (!page.raw) { this.step(companyId, 'news', 'working', name + ': ' + (page.blocked ?? 'not available')); continue }
      items.push(...found)
    }
    this.feeds = { at: Date.now(), items, read: sources.filter(x => x.status === 'read').length, sources }
    return this.feeds
  }

  /**
   * News about this client in particular: a news search for its name, and the
   * pages business sites keep for it (their tag feeds). Each is read only where
   * the site's robots.txt allows it; kept for a quarter of an hour.
   */
  private async companyFeeds(company: Company): Promise<{ items: Article[]; sources: CrawlSource[] }> {
    const cached = this.companyFeedCache.get(company.id)
    if (cached && Date.now() - cached.at < 15 * 60_000) return cached
    const term = company.monitorTerms?.[0] ?? [...nameWords(company.name)].find(w => w.length > 4) ?? company.name
    const slug = term.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    const feeds = [
      { name: 'Bing News search', url: 'https://www.bing.com/news/search?q=' + encodeURIComponent('"' + term + '"') + '&format=rss' },
      { name: 'G4Media', url: 'https://www.g4media.ro/tag/' + slug + '/feed' },
      { name: 'Financial Intelligence', url: 'https://financialintelligence.ro/tag/' + slug + '/feed/' },
      { name: 'Economica', url: 'https://www.economica.net/tag/' + slug + '/feed' },
      { name: 'Economica search', url: 'https://www.economica.net/?s=' + encodeURIComponent(term) + '&feed=rss2' },
    ]
    const items: Article[] = []
    const sources: CrawlSource[] = []
    for (const feed of feeds) {
      this.step(company.id, 'news', 'working', 'Searching ' + feed.name + ' for “' + term + '”')
      const page = await this.politeText(feed.url, true)
      const found = page.raw && /<rss|<feed/i.test(page.raw) ? parseFeed(page.raw, feed.name) : []
      sources.push({ name: feed.name, url: feed.url, items: found.length, status: page.blocked ?? (page.raw ? 'read' : 'not available'), about: 'company' })
      if (page.blocked) this.step(company.id, 'news', 'working', feed.name + ': ' + page.blocked)
      items.push(...found)
    }
    const result = { at: Date.now(), items, sources }
    this.companyFeedCache.set(company.id, result)
    return result
  }

  /**
   * Articles about the client: from the news searched for its name, the
   * sites' pages about it and today's headlines that name it. Every one found
   * is listed; the newest are opened (robots.txt permitting), kept by hash with
   * a snapshot of the page, and the sentence naming the company is quoted.
   * Risk words in that sentence decide whether it needs attention.
   */
  private async checkNews(company: Company, webOff = false): Promise<CheckResult> {
    const terms = (company.monitorTerms?.length ? company.monitorTerms : [...nameWords(company.name)].filter(w => w.length > 4)).map(t => t.toLowerCase())
    const names = (text: string) => { const plain = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''); return terms.some(t => new RegExp('(^|[^a-z0-9])' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^a-z0-9]|$)').test(plain)) }
    const general = webOff ? { items: [] as Article[], read: 0, sources: [] as CrawlSource[] } : await this.feedItems(company.id)
    const own = webOff ? { items: [] as Article[], sources: [] as CrawlSource[] } : await this.companyFeeds(company)
    const tests = this.testArticles(company)
    if (!general.read && !own.sources.some(x => x.status === 'read') && !tests.length) { this.step(company.id, 'news', 'failed', 'No news source could be read'); return { tone: 'off', label: 'Unavailable', detail: 'news sources unavailable' } }
    if (tests.length) this.step(company.id, 'news', 'working', 'Test signal planted by ' + this.planted(company.id, 'news')[0].createdBy + ': ' + tests.length + ' simulated article' + (tests.length === 1 ? '' : 's') + ' added to the real ones')
    const headlines = general.items.filter(i => names(i.title + ' ' + i.description))
    const unique = new Map<string, Article>()
    for (const item of [...tests, ...own.items, ...headlines]) if (!unique.has(item.link)) unique.set(item.link, item)
    const found = [...unique.values()].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
    this.step(company.id, 'news', 'working', 'Found ' + found.length + ' articles about the company: ' + own.items.length + ' from searches and pages about it, ' + headlines.length + ' of ' + general.items.length + ' headlines naming it')
    const now = new Date().toISOString()
    for (const item of found) {
      const listed: CrawledPage = { url: item.link, title: item.title, site: item.site, source: item.source ?? item.site, published: item.date, foundAt: now, status: 'listed', readAt: null, sha256: null, topic: null, severity: null, sentence: null, note: null, snapshot: false }
      this.db.prepare('INSERT OR IGNORE INTO monitor_pages (company_id, url, found_at, payload) VALUES (?, ?, ?, ?)').run(company.id, item.link, now, JSON.stringify(listed))
    }
    const opened = (url: string) => !!this.db.prepare('SELECT 1 FROM monitor_seen WHERE company_id = ? AND url = ?').get(company.id, url)
    const fresh = found.filter(i => !opened(i.link)).slice(0, OPEN_PER_CHECK)
    let worst: 'alert' | 'watch' | null = null
    let gaps = 0
    const read: { item: Article; page: { text: string; sha256: string; published: string | null; blocked: string | null }; sentences: string[]; snapshot: boolean }[] = []
    for (const item of fresh) {
      this.db.prepare('INSERT OR IGNORE INTO monitor_seen (company_id, url, ts) VALUES (?, ?, ?)').run(company.id, item.link, new Date().toISOString())
      if (!item.simulated) this.step(company.id, 'news', 'working', 'Opening ' + item.site + ': “' + item.title.slice(0, 90) + '” (robots.txt checked first)')
      const page = item.simulated ? { text: item.body!, raw: '', sha256: sha256(item.body!), published: item.date, blocked: null } : await this.politeText(item.link)
      this.step(company.id, 'news', 'working', item.simulated ? 'Reading the simulated article (it is not fetched from the web) · SHA-256 ' + page.sha256.slice(0, 10) : page.text ? 'Read ' + item.site + ' · ' + page.text.split(/\s+/).length + ' words · SHA-256 ' + page.sha256.slice(0, 10) : item.site + ': ' + (page.blocked ?? 'page not readable') + ' · quoting the feed instead')
      if (!page.text) gaps++
      const snapshot = !!(this.snapshotDir && page.raw && page.sha256)
      if (snapshot) writeFileSync(join(this.snapshotDir!, page.sha256 + '.html'), page.raw.slice(0, 3_000_000))
      // The feed's own summary first, then the article's sentences of ordinary length (menus and footers are not sentences).
      const sentences = [item.description, page.text].join(' ').split(/(?<=[.!?])\s+/).filter(t => t.length >= 30 && t.length <= 350).filter(names)
      read.push({ item, page, sentences, snapshot })
    }
    const judged = await this.weigh(company, read.map(r => ({ title: r.item.title, date: r.page.published ?? r.item.date, sentences: r.sentences })))
    read.forEach((r, i) => {
      const { item, page, sentences, snapshot } = r
      const keyword = TOPICS.find(t => sentences.some(x => t.words.test(x))) ?? TOPICS.find(t => t.words.test(item.title))
      const model = judged?.[i]
      const topic = model ? model.topic : keyword?.topic ?? null
      const sentence = (keyword && !model ? sentences.find(x => keyword.words.test(x)) : sentences[0]) ?? item.title
      const published = page.published ?? item.date
      const stale = !!published && Date.now() - Date.parse(published) > STALE_DAYS * 86_400_000
      const judgedSeverity: MonitorSeverity = model ? model.severity : keyword?.severity ?? 'info'
      const severity: MonitorSeverity = stale ? 'info' : judgedSeverity
      if (severity === 'alert' || (severity === 'watch' && worst !== 'alert')) worst = severity as 'alert' | 'watch'
      const note = item.simulated ? 'Simulated article; it was not published anywhere' : page.text ? null : page.blocked ?? 'article not readable; quoted from the feed'
      const reason = model?.reason ?? (keyword ? 'Risk words next to the company name: ' + keyword.topic.toLowerCase() : 'No risk words next to the company name')
      const judgedBy = model ? (this.lightModel()?.model ?? 'model') : 'keyword rules'
      const page2: CrawledPage = { url: item.link, title: item.title, site: item.site, source: item.source ?? item.site, published, foundAt: now, status: item.simulated ? 'simulated' : page.blocked ? 'blocked' : page.text ? 'read' : 'unreadable', readAt: new Date().toISOString(), sha256: page.sha256 || null, topic, severity, sentence: sentence.slice(0, 400), note, snapshot, reason, judgedBy }
      this.db.prepare('INSERT INTO monitor_pages (company_id, url, found_at, payload, text) VALUES (?, ?, ?, ?, ?) ON CONFLICT(company_id, url) DO UPDATE SET payload = excluded.payload, text = excluded.text').run(company.id, item.link, now, JSON.stringify(page2), page.text ? page.text.slice(0, 40_000) : null)
      this.step(company.id, 'news', 'working', '“' + item.title.slice(0, 70) + '”: ' + (topic ?? 'routine') + ' → ' + (stale ? 'published ' + published + ', older than ' + STALE_DAYS + ' days: kept for the record' : severity === 'alert' ? 'critical, needs action' : severity === 'watch' ? 'something to look at' : 'for the record'))
      if (severity === 'alert' || severity === 'watch') this.emit(company.id, 'web', severity, (topic ?? 'In the news') + ': ' + item.title, sentence.slice(0, 400), {
        url: item.simulated ? undefined : item.link, sha256: page.sha256 || undefined, published, site: item.site, ...(note ? { note } : {}), ...(item.simulated ? { simulated: true } : {}), foundBy: judgedBy + (reason ? ': ' + reason : ''),
      }, step => !/^(Opening |Read |Reading the simulated|“)/.test(step) || step.includes(item.title.slice(0, 50)) || (step.startsWith('Read ' + item.site + ' ') && !read.some(o => o !== r && o.item.site === item.site)))
    })
    this.setState(company.id, 'crawl', { at: new Date().toISOString(), sources: [...own.sources, ...general.sources], found: found.length, opened: fresh.length })
    const detail = own.sources.filter(x => x.status === 'read').length + general.read + ' sources, ' + found.length + ' articles about the company' + (fresh.length ? ', ' + fresh.length + ' opened this time' : '') + (gaps ? ' (' + gaps + ' not readable)' : '')
    this.step(company.id, 'news', 'done', fresh.length ? fresh.length + ' new article' + (fresh.length === 1 ? '' : 's') + ' read and kept · ' + found.length + ' about the company in all' : found.length ? 'Nothing new about the company · ' + found.length + ' articles already read' : 'The company is not in the news')
    return { tone: worst ?? 'ok', label: found.length ? found.length + (found.length === 1 ? ' article' : ' articles') : 'No mentions', detail }
  }

  /**
   * The light model reads what the crawler opened (titles and the sentences
   * naming the company, nothing more) in one call, and says for each article
   * whether it is about the company, its risk topic and how serious it is.
   * Without a model, or if it does not answer, the keyword rules decide.
   */
  private async weigh(company: Company, articles: { title: string; date: string | null; sentences: string[] }[]): Promise<{ topic: string; severity: MonitorSeverity; reason: string }[] | null> {
    const model = this.lightModel()
    if (!model || !articles.length) return null
    const items = articles.map((a, i) => ({ id: 'a' + (i + 1), title: a.title, date: a.date, sentences: a.sentences.slice(0, 3).map(x => x.slice(0, 300)) }))
    const words = JSON.stringify(items).split(/\s+/).length
    this.step(company.id, 'news', 'working', 'Asking ' + model.model + ' (' + model.effort + ' effort) to weigh ' + articles.length + (articles.length === 1 ? ' article' : ' articles') + ': titles and quoted sentences only, about ' + words.toLocaleString('en-GB') + ' words')
    const topics = [...TOPICS.map(t => t.topic), 'Other']
    const line = company.creditLine
    const prompt = [
      'You screen news for a bank that lent to ' + company.name + (line ? ' (' + line.product.toLowerCase() + ', RON ' + line.limit.toLocaleString('en-GB') + ', ' + Math.round(line.drawn / line.limit * 100) + '% drawn, maturity ' + line.maturity + ')' : '') + '.',
      'For each article decide: about_company (is it about this company itself, not another one?), topic (one of the list), severity and a reason of at most 20 words in English.',
      'severity: critical = threatens repayment or the company\'s survival: insolvency or bankruptcy of this company, including reports, warnings or speculation that it could go bankrupt or insolvent even if the company denies it; an obligation or decision to repay state aid; enforcement; criminal investigation; default; loss of licence; forced closure. A bank acts on these at once. watch = needs a look (litigation, strike, restructuring, privatization, management change, losses, rating action); info = routine.',
      'An article about another company\'s trouble that only mentions this company in passing is not critical for this company; but a warning that the same trouble could hit this company is.',
      'ARTICLES: ' + JSON.stringify(items),
    ].join('\n')
    const schema = { type: 'object', additionalProperties: false, required: ['articles'], properties: { articles: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'about_company', 'topic', 'severity', 'reason'],
      properties: { id: { type: 'string' }, about_company: { type: 'boolean' }, topic: { type: 'string', enum: topics }, severity: { type: 'string', enum: ['critical', 'watch', 'info'] }, reason: { type: 'string' } } } } } }
    const answer = await askCodex<{ articles: { id: string; about_company: boolean; topic: string; severity: 'critical' | 'watch' | 'info'; reason: string }[] }>(model, prompt, schema, AbortSignal.timeout(90_000))
    if (!answer.ok || !answer.value) { this.step(company.id, 'news', 'working', model.model + ' did not answer (' + answer.reason + '): the keyword rules decide'); return null }
    const byId = new Map(answer.value.articles.map(a => [a.id, a]))
    const out = items.map(it => {
      const a = byId.get(it.id)
      if (!a) return { topic: 'Other', severity: 'info' as MonitorSeverity, reason: 'Not weighed by the model' }
      const severity: MonitorSeverity = !a.about_company ? 'info' : a.severity === 'critical' ? 'alert' : a.severity
      return { topic: a.topic === 'Other' ? (a.about_company ? 'In the news' : 'Mentions the company') : a.topic, severity, reason: (a.about_company ? '' : 'Not about the company itself. ') + a.reason.slice(0, 200) }
    })
    const n = (sev: MonitorSeverity) => out.filter(o => o.severity === sev).length
    this.step(company.id, 'news', 'working', model.model + ' answered in ' + (answer.durationMs / 1000).toFixed(1) + ' s: ' + n('alert') + ' critical, ' + n('watch') + ' to look at, ' + n('info') + ' routine')
    return out
  }

  /** What the crawler read for a client at its last check, and every article about it, newest first. */
  crawl(companyId: string): { crawl: { at: string; sources: CrawlSource[]; found: number; opened: number } | null; pages: CrawledPage[] } {
    const rows = this.db.prepare('SELECT payload FROM monitor_pages WHERE company_id = ?').all(companyId) as { payload: string }[]
    const pages = rows.map(r => JSON.parse(r.payload) as CrawledPage).map(p => ({ ...p, title: cleanTitle(entities(p.title)), sentence: p.sentence && entities(p.sentence) })).sort((a, b) => (b.published ?? '').localeCompare(a.published ?? '') || b.foundAt.localeCompare(a.foundAt))
    return { crawl: this.state(companyId, 'crawl'), pages }
  }

  /** One article as read: its text, and whether a snapshot of the page is kept. */
  crawledPage(companyId: string, url: string): CrawledPage | null {
    const row = this.db.prepare('SELECT payload, text FROM monitor_pages WHERE company_id = ? AND url = ?').get(companyId, url) as { payload: string; text: string | null } | undefined
    return row ? { ...JSON.parse(row.payload), text: row.text ?? undefined } : null
  }

  /** The page exactly as it was read, for viewing inside Finra. */
  snapshot(sha: string): { html: string; url: string } | null {
    if (!this.snapshotDir || !/^[0-9a-f]{64}$/.test(sha)) return null
    const file = join(this.snapshotDir, sha + '.html')
    if (!existsSync(file)) return null
    const row = (this.db.prepare('SELECT payload FROM monitor_pages').all() as { payload: string }[]).map(r => JSON.parse(r.payload) as CrawledPage).find(p => p.sha256 === sha)
    return { html: readFileSync(file, 'utf8'), url: row?.url ?? '' }
  }

  /**
   * A deeper look on request: the assistant searches the public web for the
   * past year's news about the client; each article it names is opened by the
   * engine and only kept when the quoted sentence is really on the page.
   */
  async research(company: Company, codex: CodexConfig | null): Promise<string> {
    if (!codex) return 'no model available to search the web'
    const schema = { type: 'object', additionalProperties: false, required: ['articles'], properties: { articles: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['url', 'title', 'date', 'quote'], properties: { url: { type: 'string' }, title: { type: 'string' }, date: { type: 'string' }, quote: { type: 'string' } } } } } }
    const prompt = 'Search the web for news from the past 12 months about ' + company.name + ' (Romania, CUI ' + company.cui + ') that a bank lending to it should know: insolvency, enforcement or tax debts, investigations, litigation, management changes, losses or job cuts, financial results, major contracts or investments. Return up to 6 articles from reputable sources, each with its URL, title, publication date (YYYY-MM-DD or "") and one sentence copied exactly from the article that names the company. Do not include the company\'s own marketing pages.'
    const answer = await askCodex<{ articles: { url: string; title: string; date: string; quote: string }[] }>(codex, prompt, schema, new AbortController().signal, { webSearch: true })
    if (!answer.ok || !answer.value) return 'the search did not finish: ' + answer.reason
    let kept = 0, unconfirmed = 0
    for (const a of answer.value.articles.slice(0, 6)) {
      if (!/^https?:\/\//.test(a.url) || this.db.prepare('SELECT 1 FROM monitor_seen WHERE company_id = ? AND url = ?').get(company.id, a.url)) continue
      const page = await this.politeText(a.url)
      const flat = (t: string) => t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
      if (!page.text || !flat(page.text).includes(flat(a.quote).slice(0, 120))) { unconfirmed++; continue }
      this.db.prepare('INSERT OR IGNORE INTO monitor_seen (company_id, url, ts) VALUES (?, ?, ?)').run(company.id, a.url, new Date().toISOString())
      const topic = TOPICS.find(t => t.words.test(a.quote) || t.words.test(a.title))
      kept++
      this.emit(company.id, 'web', topic?.severity ?? 'info', (topic?.topic ?? 'In the news') + ': ' + a.title, a.quote.slice(0, 400), { url: a.url, sha256: page.sha256, published: a.date || page.published, site: new URL(a.url).hostname.replace(/^www\./, ''), foundBy: 'Codex ' + codex.model + ' web search' })
    }
    const summary = kept + ' article(s) confirmed on their pages' + (unconfirmed ? ', ' + unconfirmed + ' dropped (quote not found on the page or page not readable)' : '')
    this.emit(company.id, 'engine', 'info', 'Web research by the assistant', summary)
    return summary
  }

  // ─── Polite fetching ───────────────────────────────────────────────────────

  private async allowed(url: URL): Promise<string | null> {
    let entry = this.robots.get(url.host)
    if (!entry || Date.now() - entry.at > 86_400_000) {
      const rules: { allow: boolean; path: RegExp; length: number }[] = []
      try {
        const res = await fetch(url.origin + '/robots.txt', { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(10_000) })
        if (res.ok) {
          let applies = false
          for (const line of (await res.text()).split(/\r?\n/)) {
            const [field, ...rest] = line.replace(/#.*/, '').split(':')
            const value = rest.join(':').trim()
            const key = field.trim().toLowerCase()
            if (key === 'user-agent') applies = value === '*' || /creditdesk/i.test(value)
            else if (applies && (key === 'disallow' || key === 'allow') && value) {
              rules.push({ allow: key === 'allow', length: value.length, path: new RegExp('^' + value.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$')) })
            }
          }
        }
      } catch { /* no robots.txt reachable: treat as no rules */ }
      entry = { at: Date.now(), rules }
      this.robots.set(url.host, entry)
    }
    const path = url.pathname + url.search
    const match = entry.rules.filter(r => r.path.test(path)).sort((a, b) => b.length - a.length)[0]
    return match && !match.allow ? url.host + ' robots.txt disallows ' + url.pathname : null
  }

  private async politeText(href: string, raw = false): Promise<{ text: string; raw: string; sha256: string; published: string | null; blocked: string | null }> {
    const url = new URL(href)
    const blocked = await this.allowed(url)
    if (blocked) return { text: '', raw: '', sha256: '', published: null, blocked }
    const wait = (this.lastHit.get(url.host) ?? 0) + 2000 - Date.now()
    if (wait > 0) await new Promise(r => setTimeout(r, wait))
    this.lastHit.set(url.host, Date.now())
    if (raw) {
      try {
        const res = await fetch(href, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(20_000) })
        const body = await res.text()
        return { text: '', raw: res.ok ? body : '', sha256: createHash('sha256').update(body).digest('hex'), published: null, blocked: null }
      } catch { return { text: '', raw: '', sha256: '', published: null, blocked: null } }
    }
    const page = await pageText(href)
    const html = page.bytes && !page.type.includes('pdf') ? page.bytes.toString('utf8') : ''
    const published = /(?:article:published_time|datePublished)["']?\s*(?:content=|:)\s*["']([0-9]{4}-[0-9]{2}-[0-9]{2})/i.exec(html)?.[1] ?? null
    return { text: page.text, raw: html, sha256: page.bytes ? createHash('sha256').update(page.bytes).digest('hex') : '', published, blocked: null }
  }

  // ─── Events and state ──────────────────────────────────────────────────────

  private emit(companyId: string, source: MonitorSource, severity: MonitorSeverity, title: string, detail: string, data?: MonitorEvent['data'], relevant: (step: string) => boolean = () => true): MonitorEvent {
    const steps = workerOf[source] ? this.trail.get(companyId + ':' + workerOf[source])?.filter(relevant) : undefined
    const withSteps = steps?.length ? { ...data, steps: [...steps] } : data
    const event: MonitorEvent = { id: randomUUID(), companyId, ts: new Date().toISOString(), source, severity, title, detail, ...(withSteps ? { data: withSteps } : {}) }
    this.db.prepare('INSERT INTO monitor_events (id, company_id, ts, payload) VALUES (?, ?, ?, ?)').run(event.id, companyId, event.ts, JSON.stringify(event))
    for (const listener of this.listeners) listener(event)
    return event
  }

  events(filter: { companyId?: string; limit?: number } = {}): MonitorEvent[] {
    const rows = (filter.companyId
      ? this.db.prepare('SELECT payload FROM monitor_events WHERE company_id = ? ORDER BY ts DESC LIMIT ?').all(filter.companyId, filter.limit ?? 200)
      : this.db.prepare('SELECT payload FROM monitor_events ORDER BY ts DESC LIMIT ?').all(filter.limit ?? 200)) as { payload: string }[]
    return rows.map(r => JSON.parse(r.payload) as MonitorEvent).map(e => e.source === 'web' ? { ...e, title: cleanTitle(e.title) } : e).map(e => e.data?.sha256 && this.snapshotDir && existsSync(join(this.snapshotDir, e.data.sha256 + '.html')) ? { ...e, data: { ...e.data, snapshot: true } } : e)
  }

  review(id: string, by: string): MonitorEvent | null {
    const row = this.db.prepare('SELECT payload FROM monitor_events WHERE id = ?').get(id) as { payload: string } | undefined
    if (!row) return null
    const event: MonitorEvent = { ...JSON.parse(row.payload), reviewedBy: by, reviewedAt: new Date().toISOString() }
    this.db.prepare('UPDATE monitor_events SET payload = ? WHERE id = ?').run(JSON.stringify(event), id)
    return event
  }

  status(): ClientStatus[] {
    return this.clients.map(c => {
      const checked = this.state<{ at: string; results: Record<string, string>; checks?: Partial<Record<MonitorWorker, CheckResult>> }>(c.id, 'checked')
      const open = (this.db.prepare('SELECT payload FROM monitor_events WHERE company_id = ?').all(c.id) as { payload: string }[]).map(r => JSON.parse(r.payload) as MonitorEvent)
        .filter(e => !e.reviewedAt && e.severity !== 'info')
      return {
        companyId: c.id, lastCheck: checked?.at ?? null, results: checked?.results ?? {},
        nextCheck: checked ? new Date(Date.parse(checked.at) + this.intervalMinutes * 60_000).toISOString() : null,
        checking: this.current === c.id, queued: this.queue.includes(c.id), checks: checked?.checks ?? {}, working: this.current === c.id && this.working?.companyId === c.id ? this.working.worker : null,
        status: open.some(e => e.severity === 'alert') ? 'alert' : open.length ? 'watch' : checked ? 'ok' : 'unknown', open: open.length,
        planted: this.planted(c.id).map(t => t.kind),
      }
    })
  }

  // ─── Test signals ──────────────────────────────────────────────────────────

  /** Test signals planted and not cleared, for one client (optionally one worker) or all. */
  planted(companyId?: string, worker?: MonitorWorker): Simulation[] {
    const rows = (companyId ? this.db.prepare('SELECT * FROM monitor_simulations WHERE company_id = ?').all(companyId) : this.db.prepare('SELECT * FROM monitor_simulations').all()) as Record<string, string>[]
    return rows.map(r => ({ companyId: r.company_id, kind: r.kind as SimulationKind, createdAt: r.created_at, createdBy: r.created_by }))
      .filter(t => !worker || SIMULATIONS.find(x => x.kind === t.kind)?.worker === worker)
  }

  /**
   * Plants a test signal: the next check of the client finds it through the
   * same steps as a real one, and everything it raises is marked simulated.
   * One signal per worker at a time; what the worker had recorded before is
   * kept so clearing the signal puts it back.
   */
  simulate(companyId: string, kind: SimulationKind, by: string): Simulation {
    const spec = SIMULATIONS.find(x => x.kind === kind)
    if (!spec || !this.clients.some(c => c.id === companyId)) throw Object.assign(new Error('Unknown client or test signal'), { status: 400 })
    for (const t of this.planted(companyId, spec.worker)) this.clear(companyId, t.kind)
    const prior = spec.worker === 'anaf' ? this.state(companyId, 'anaf') : spec.worker === 'covenants' ? this.state(companyId, 'covenants') : null
    const t: Simulation = { companyId, kind, createdAt: new Date().toISOString(), createdBy: by }
    this.db.prepare('INSERT INTO monitor_simulations (company_id, kind, created_at, created_by, prior) VALUES (?, ?, ?, ?, ?)').run(companyId, kind, t.createdAt, by, JSON.stringify(prior))
    return t
  }

  /** Removes a test signal and puts back what its worker had recorded before it. */
  clear(companyId: string, kind: SimulationKind): void {
    const row = this.db.prepare('SELECT prior FROM monitor_simulations WHERE company_id = ? AND kind = ?').get(companyId, kind) as { prior: string } | undefined
    if (!row) return
    const worker = SIMULATIONS.find(x => x.kind === kind)?.worker
    const prior = JSON.parse(row.prior ?? 'null')
    if (worker === 'anaf' || worker === 'covenants') {
      if (prior) this.setState(companyId, worker, prior)
      else this.db.prepare('DELETE FROM monitor_state WHERE company_id = ? AND kind = ?').run(companyId, worker)
    }
    this.db.prepare('DELETE FROM monitor_simulations WHERE company_id = ? AND kind = ?').run(companyId, kind)
  }

  /** The planted news signals as articles, in the same shape as the feeds' (in Romanian, like them), saying plainly they are tests. */
  private testArticles(company: Company): Article[] {
    const name = company.monitorTerms?.[0] ?? company.name
    const day = new Date().toISOString().slice(0, 10)
    return this.planted(company.id, 'news').map(t => {
      const lead = 'Articol de test Finra, nu este o știre reală.'
      const [title, description, more] = t.kind === 'news-insolvency'
        ? [name + ' a cerut deschiderea procedurii de insolvență (articol de test)', name + ' a depus la tribunal cererea de deschidere a procedurii de insolvență, potrivit unui raport transmis bursei.', 'Creditorii au la dispoziție 45 de zile pentru a-și înscrie creanțele.']
        : [name + ', chemată în instanță de un furnizor (articol de test)', 'Un furnizor a deschis un proces împotriva ' + name + ' la Tribunalul București, cerând plata a 12 milioane de lei.', 'Primul termen în instanță este stabilit pentru luna viitoare.']
      return { title, link: 'https://creditdesk.invalid/test/' + company.id + '/' + t.kind + '/' + Date.parse(t.createdAt), description: lead + ' ' + description, date: day, site: 'Simulated article', simulated: true, body: lead + ' ' + description + ' ' + more }
    })
  }

  private state<T>(companyId: string, kind: string): T | null {
    const row = this.db.prepare('SELECT payload FROM monitor_state WHERE company_id = ? AND kind = ?').get(companyId, kind) as { payload: string } | undefined
    return row ? JSON.parse(row.payload) : null
  }

  private setState(companyId: string, kind: string, value: unknown): void {
    this.db.prepare('INSERT INTO monitor_state (company_id, kind, payload) VALUES (?, ?, ?) ON CONFLICT(company_id, kind) DO UPDATE SET payload = excluded.payload').run(companyId, kind, JSON.stringify(value))
  }
}
