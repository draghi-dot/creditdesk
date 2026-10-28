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
import type { DatabaseSync } from 'node:sqlite'
import type { Company } from '../../src/types.ts'
import type { AssessmentSummary } from '../../src/assessment.ts'
import { ratio } from '../../src/analysis.ts'
import type { CheckResult, ClientStatus, MonitorActivity, MonitorEvent, MonitorSeverity, MonitorSource, MonitorWorker } from '../../src/monitoring.ts'
import { lookupAnaf, nameWords } from './anaf.ts'
import { USER_AGENT, pageText } from './contacts.ts'
import type { CodexConfig } from './codex.ts'
import { askCodex } from './codex.ts'

type Listener = (e: MonitorEvent) => void
type ActivityListener = (a: MonitorActivity) => void

/** Register status in a word or two. */
const shortStatus = (status: string) => /RADIER/i.test(status) ? 'Deregistered' : /DIZOLVARE|LICHIDARE/i.test(status) ? 'Dissolving' : /INSOLVEN|FALIMENT/i.test(status) ? 'Insolvent' : 'Registered'

/** Words that make a news passage relevant to a lender, by how much attention they need. */
const TOPICS: { topic: string; severity: MonitorSeverity; words: RegExp }[] = [
  { topic: 'Insolvency', severity: 'alert', words: /insolven|faliment|reorganizare judiciar|administrator judiciar|lichidator|insolvency|bankruptcy/i },
  { topic: 'Enforcement or tax debt', severity: 'alert', words: /executare silit|poprire|sechestru|datorii (la|catre) (stat|ANAF|buget)|restan[tț]e (la|fiscale)|tax arrears/i },
  { topic: 'Investigation', severity: 'alert', words: /\bDNA\b|DIICOT|dosar penal|perchezi[tț]i|anchet[aă] penal|fraud/i },
  { topic: 'Litigation', severity: 'watch', words: /litigiu|proces(ul)? |instan[tț]|sentin[tț]|lawsuit|court ruling/i },
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
  private feeds: { at: number; items: { title: string; link: string; description: string; date: string | null; site: string }[]; read: number } | null = null
  readonly intervalMinutes: number

  constructor(db: DatabaseSync, clients: Company[], latestRun: (companyId: string) => AssessmentSummary | null, intervalMinutes = 60) {
    this.db = db
    this.clients = clients
    this.latestRun = latestRun
    this.intervalMinutes = intervalMinutes
    db.exec(`
      CREATE TABLE IF NOT EXISTS monitor_events (id TEXT PRIMARY KEY, company_id TEXT NOT NULL, ts TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS monitor_events_company ON monitor_events (company_id, ts);
      CREATE TABLE IF NOT EXISTS monitor_state (company_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (company_id, kind));
      CREATE TABLE IF NOT EXISTS monitor_seen (company_id TEXT NOT NULL, url TEXT NOT NULL, ts TEXT NOT NULL, PRIMARY KEY (company_id, url));
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
    this.recent.push(a)
    if (this.recent.length > 80) this.recent.shift()
    for (const listener of this.activityListeners) listener(a)
  }

  // ─── Checks ────────────────────────────────────────────────────────────────

  async check(company: Company): Promise<void> {
    const checks: Partial<Record<MonitorWorker, CheckResult>> = {}
    checks.anaf = await this.checkRegister(company)
    checks.covenants = this.checkCreditLine(company)
    checks.news = process.env.CREDITDESK_MONITOR_WEB === 'off' ? { tone: 'off', label: 'Off', detail: 'Public news check is off (CREDITDESK_MONITOR_WEB=off)' } : await this.checkNews(company)
    this.working = null
    const results = { anaf: checks.anaf.detail, credit: checks.covenants.detail, web: checks.news.detail }
    this.setState(company.id, 'checked', { at: new Date().toISOString(), results, checks })
    for (const listener of this.listeners) listener({ id: '', companyId: company.id, ts: new Date().toISOString(), source: 'engine', severity: 'info', title: 'checked', detail: '' })
  }

  /** The ANAF register, compared with what the previous check recorded. */
  private async checkRegister(company: Company): Promise<CheckResult> {
    this.step(company.id, 'anaf', 'working', 'Asking the ANAF register about CUI ' + company.cui)
    const anaf = await lookupAnaf(company.cui, new Date().toISOString().slice(0, 10), new AbortController().signal, 20_000)
    if (!anaf.found) {
      if (anaf.error) { this.step(company.id, 'anaf', 'failed', anaf.error); return { tone: 'off', label: 'Not reached', detail: 'ANAF not reached: ' + anaf.error } }
      this.step(company.id, 'anaf', 'done', 'ANAF has no taxpayer with CUI ' + company.cui)
      this.emit(company.id, 'anaf', 'alert', 'Not found in the ANAF register', 'ANAF has no taxpayer with CUI ' + company.cui + '.')
      return { tone: 'alert', label: 'Not found', detail: 'ANAF has no taxpayer with CUI ' + company.cui }
    }
    const now = { name: anaf.found.name, status: anaf.found.registrationStatus, inactive: anaf.found.inactive, vatPayer: anaf.found.vatPayer, eInvoice: anaf.found.eInvoice, address: anaf.found.address }
    const before = this.state<typeof now>(company.id, 'anaf')
    this.setState(company.id, 'anaf', now)
    if (!before) {
      const bad = STATUS_ALERT.test(now.status) || now.inactive
      this.emit(company.id, 'anaf', bad ? 'alert' : 'info', 'Register baseline recorded',
        now.name + ' · ' + now.status + (now.inactive ? ' · INACTIVE taxpayer' : '') + ' · VAT ' + (now.vatPayer ? 'registered' : 'not registered'), { url: anaf.found.endpoint })
      this.step(company.id, 'anaf', 'done', 'ANAF answered in ' + anaf.durationMs + ' ms · ' + shortStatus(now.status).toLowerCase() + ' · first reading kept to compare with')
      return { tone: bad ? 'alert' : 'ok', label: shortStatus(now.status), detail: 'First reading recorded · ' + now.status }
    }
    const changes: [MonitorSeverity, string, string][] = []
    if (now.status !== before.status) changes.push([STATUS_ALERT.test(now.status) ? 'alert' : 'watch', 'Registration status changed', before.status + ' → ' + now.status])
    if (now.inactive !== before.inactive) changes.push([now.inactive ? 'alert' : 'info', now.inactive ? 'Declared an inactive taxpayer' : 'No longer an inactive taxpayer', 'ANAF inactive flag: ' + before.inactive + ' → ' + now.inactive])
    if (now.vatPayer !== before.vatPayer) changes.push(['watch', now.vatPayer ? 'Registered for VAT' : 'VAT registration cancelled', 'VAT: ' + before.vatPayer + ' → ' + now.vatPayer])
    if (now.name !== before.name) changes.push(['watch', 'Registered name changed', before.name + ' → ' + now.name])
    if (now.address !== before.address) changes.push(['watch', 'Registered office moved', before.address + ' → ' + now.address])
    for (const [severity, title, detail] of changes) this.emit(company.id, 'anaf', severity, title, detail, { url: anaf.found.endpoint })
    this.step(company.id, 'anaf', 'done', 'ANAF answered in ' + anaf.durationMs + ' ms · ' + (changes.length ? changes.map(c => c[1].toLowerCase()).join(', ') : 'nothing changed since the last check'))
    const worst: CheckResult['tone'] = changes.some(c => c[0] === 'alert') ? 'alert' : changes.length ? 'watch' : 'ok'
    return { tone: worst, label: changes.length ? changes.length + (changes.length === 1 ? ' change' : ' changes') : shortStatus(now.status), detail: changes.length ? changes.map(c => c[1]).join('; ') : 'No change since the last check · ' + now.status }
  }

  /** Covenants against the latest completed assessment, and the review date. */
  private checkCreditLine(company: Company): CheckResult {
    const line = company.creditLine
    if (!line) return { tone: 'off', label: 'No credit line', detail: 'no credit line' }
    const run = this.latestRun(company.id)
    const notes: string[] = []
    const key = run ? run.runId : 'none'
    const before = this.state<{ run: string; breaches: string[] }>(company.id, 'covenants')
    this.step(company.id, 'covenants', 'working', run ? 'Comparing the covenants with assessment ' + run.runId.slice(0, 8) : 'Looking for a completed assessment')
    if (!run?.digest) {
      if (before?.run !== key) this.emit(company.id, 'covenants', 'watch', 'No assessment on file', 'Covenants cannot be checked until the client is assessed. Run an assessment from the company page.')
      this.setState(company.id, 'covenants', { run: key, breaches: [] })
      this.step(company.id, 'covenants', 'done', 'No completed assessment yet: nothing to compare')
      return { tone: 'watch', label: 'Not assessed', detail: 'not assessed' }
    }
    // An assessment now exists: the earlier "no assessment" notice is settled by it.
    if (before?.run === 'none') for (const e of this.events({ companyId: company.id, limit: 500 })) if (e.title === 'No assessment on file' && !e.reviewedAt) this.review(e.id, 'Monitoring (assessment ' + run.runId.slice(0, 8) + ' completed)')
    const m = run.digest.metrics
    const breaches: string[] = []
    if (m.dscr !== null && m.dscr < line.covenants.dscrMin) breaches.push('DSCR ' + ratio(m.dscr) + ' below ' + ratio(line.covenants.dscrMin))
    if (m.leverage !== null && m.leverage > line.covenants.leverageMax) breaches.push('debt/EBITDA ' + ratio(m.leverage) + ' above ' + ratio(line.covenants.leverageMax))
    if (m.liquidity !== null && m.liquidity < line.covenants.liquidityMin) breaches.push('liquidity ' + ratio(m.liquidity) + ' below ' + ratio(line.covenants.liquidityMin))
    if (before?.run !== key) {
      const met = 'DSCR ' + ratio(m.dscr) + ' (min ' + ratio(line.covenants.dscrMin) + '), debt/EBITDA ' + ratio(m.leverage) + ' (max ' + ratio(line.covenants.leverageMax) + '), liquidity ' + ratio(m.liquidity) + ' (min ' + ratio(line.covenants.liquidityMin) + ')'
      this.emit(company.id, 'covenants', breaches.length ? 'alert' : 'info', breaches.length ? 'Covenant breach' : 'Covenants met', (breaches.length ? breaches.join('; ') : met) + ' · assessment ' + run.runId.slice(0, 8) + ' of ' + (run.endedAt ?? run.createdAt).slice(0, 10), { runId: run.runId })
    }
    this.setState(company.id, 'covenants', { run: key, breaches })
    notes.push(breaches.length ? breaches.length + ' breach(es)' : 'covenants met')
    this.step(company.id, 'covenants', 'done', breaches.length ? breaches.join('; ') : 'DSCR ' + ratio(m.dscr) + ' ≥ ' + ratio(line.covenants.dscrMin) + ' · debt/EBITDA ' + ratio(m.leverage) + ' ≤ ' + ratio(line.covenants.leverageMax) + ' · liquidity ' + ratio(m.liquidity) + ' ≥ ' + ratio(line.covenants.liquidityMin))
    const days = Math.round((Date.parse(line.nextReview) - Date.now()) / 86_400_000)
    if (days <= 30 && !this.state(company.id, 'review-' + line.nextReview)) {
      this.setState(company.id, 'review-' + line.nextReview, { notified: true })
      this.emit(company.id, 'covenants', 'watch', days < 0 ? 'Annual review overdue' : 'Annual review due soon', 'Review date ' + line.nextReview + (days < 0 ? ' (' + -days + ' days ago)' : ' (in ' + days + ' days)') + '.')
    }
    return { tone: breaches.length ? 'alert' : 'ok', label: breaches.length ? breaches.length + (breaches.length === 1 ? ' breach' : ' breaches') : 'Met', detail: notes.join(', ') }
  }

  /** Recent articles from business-news feeds, shared by all clients for a quarter of an hour. */
  private async feedItems(companyId: string): Promise<{ items: { title: string; link: string; description: string; date: string | null; site: string }[]; read: number }> {
    if (this.feeds && Date.now() - this.feeds.at < 15 * 60_000) {
      this.step(companyId, 'news', 'working', 'Using the ' + this.feeds.items.length + ' articles read from ' + this.feeds.read + ' news feeds at ' + new Date(this.feeds.at).toTimeString().slice(0, 5))
      return this.feeds
    }
    const items: { title: string; link: string; description: string; date: string | null; site: string }[] = []
    let read = 0
    for (const feed of FEEDS) {
      this.step(companyId, 'news', 'working', 'Reading ' + feed.replace(/^https:\/\/(www\.)?/, ''))
      const page = await this.politeText(feed, true)
      if (!page.raw) { this.step(companyId, 'news', 'working', feed.replace(/^https:\/\/(www\.)?/, '') + ': ' + (page.blocked ?? 'not available')); continue }
      read++
      for (const m of page.raw.matchAll(/<item[\s\S]*?<\/item>/g)) {
        const field = (name: string) => (new RegExp('<' + name + '[^>]*>([\\s\\S]*?)<\\/' + name + '>').exec(m[0])?.[1] ?? '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#8217;|&#039;/g, "'").replace(/\s+/g, ' ').trim()
        const link = field('link') || (/<guid[^>]*>(https?:[^<]+)<\/guid>/.exec(m[0])?.[1] ?? '')
        if (!/^https:\/\//.test(link)) continue
        const date = field('pubDate')
        items.push({ title: field('title'), link, description: field('description').slice(0, 600), date: date ? new Date(date).toISOString().slice(0, 10) : null, site: new URL(link).hostname.replace(/^www\./, '') })
      }
    }
    this.feeds = { at: Date.now(), items, read }
    return this.feeds
  }

  /** Articles that name the client: each is opened (robots.txt permitting), kept by hash, and the sentence naming the company quoted. */
  private async checkNews(company: Company): Promise<CheckResult> {
    const terms = (company.monitorTerms?.length ? company.monitorTerms : [...nameWords(company.name)].filter(w => w.length > 4)).map(t => t.toLowerCase())
    const names = (text: string) => { const plain = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''); return terms.some(t => new RegExp('(^|[^a-z0-9])' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^a-z0-9]|$)').test(plain)) }
    const { items, read } = await this.feedItems(company.id)
    if (!read) { this.step(company.id, 'news', 'failed', 'No news feed could be read'); return { tone: 'off', label: 'Unavailable', detail: 'news feeds unavailable' } }
    const mentions = items.filter(i => names(i.title + ' ' + i.description))
    this.step(company.id, 'news', 'working', 'Looking for “' + terms.join('” or “') + '” in ' + items.length + ' articles: ' + mentions.length + (mentions.length === 1 ? ' match' : ' matches'))
    let worst: 'alert' | 'watch' | null = null
    let kept = 0, gaps = 0
    for (const item of mentions.slice(0, 6)) {
      if (this.db.prepare('SELECT 1 FROM monitor_seen WHERE company_id = ? AND url = ?').get(company.id, item.link)) continue
      this.db.prepare('INSERT OR IGNORE INTO monitor_seen (company_id, url, ts) VALUES (?, ?, ?)').run(company.id, item.link, new Date().toISOString())
      this.step(company.id, 'news', 'working', 'Opening ' + item.site + ' (checking its robots.txt first)')
      const page = await this.politeText(item.link)
      this.step(company.id, 'news', 'working', page.text ? 'Read ' + item.site + ' · SHA-256 ' + page.sha256.slice(0, 10) : item.site + ': ' + (page.blocked ?? 'page not readable') + ' · quoting the feed instead')
      // The feed's own summary first, then the article's sentences of ordinary length (menus and footers are not sentences).
      const sentences = [item.description, page.text].join(' ').split(/(?<=[.!?])\s+/).filter(t => t.length >= 30 && t.length <= 350).filter(names)
      if (!page.text) gaps++
      const topic = TOPICS.find(t => sentences.some(s => t.words.test(s)))
      const sentence = (topic ? sentences.find(s => topic.words.test(s)) : sentences[0]) ?? item.title
      kept++
      const severity = topic?.severity ?? 'info'
      if (severity === 'alert' || (severity === 'watch' && worst !== 'alert')) worst = severity as 'alert' | 'watch'
      this.emit(company.id, 'web', severity, (topic?.topic ?? 'In the news') + ': ' + item.title, sentence.slice(0, 400), {
        url: item.link, sha256: page.sha256 || undefined, published: page.published ?? item.date, site: item.site, ...(page.text ? {} : { note: page.blocked ?? 'article not readable; quoted from the feed' }),
      })
    }
    const detail = read + ' news feed(s), ' + items.length + ' recent articles, ' + mentions.length + ' naming the company' + (kept ? ', ' + kept + ' new' : '') + (gaps ? ' (' + gaps + ' not readable)' : '')
    this.step(company.id, 'news', 'done', kept ? kept + ' new article(s) about the company kept' : mentions.length ? 'Nothing new about the company' : 'The company is not in today\'s news')
    return { tone: worst ?? 'ok', label: mentions.length ? mentions.length + (mentions.length === 1 ? ' mention' : ' mentions') : 'No mentions', detail }
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

  private emit(companyId: string, source: MonitorSource, severity: MonitorSeverity, title: string, detail: string, data?: MonitorEvent['data']): MonitorEvent {
    const event: MonitorEvent = { id: randomUUID(), companyId, ts: new Date().toISOString(), source, severity, title, detail, ...(data ? { data } : {}) }
    this.db.prepare('INSERT INTO monitor_events (id, company_id, ts, payload) VALUES (?, ?, ?, ?)').run(event.id, companyId, event.ts, JSON.stringify(event))
    for (const listener of this.listeners) listener(event)
    return event
  }

  events(filter: { companyId?: string; limit?: number } = {}): MonitorEvent[] {
    const rows = (filter.companyId
      ? this.db.prepare('SELECT payload FROM monitor_events WHERE company_id = ? ORDER BY ts DESC LIMIT ?').all(filter.companyId, filter.limit ?? 200)
      : this.db.prepare('SELECT payload FROM monitor_events ORDER BY ts DESC LIMIT ?').all(filter.limit ?? 200)) as { payload: string }[]
    return rows.map(r => JSON.parse(r.payload))
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
      }
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
