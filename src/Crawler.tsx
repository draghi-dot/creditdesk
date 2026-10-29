import { useEffect, useState } from 'react'
import { Bot, ExternalLink, FileText, Globe2, LoaderCircle, Newspaper, Search, ShieldCheck, X } from 'lucide-react'
import { SignalAgent } from './EarlyWarning'
import type { Company } from './types'
import type { Crawl, CrawledPage } from './monitoring'
import { workerLabels } from './monitoring'
import { Dialog } from './components'
import { getCrawl, getCrawledPage, snapshotUrl, useMonitoring } from './people'

/**
 * What the news crawler reads for a credit client: the sources it searched,
 * every article it found about the company, and, for each one opened, the
 * page as it was read, the text and the sentence it quoted.
 */

type Filter = 'all' | 'attention' | 'read'
const day = (iso: string | null) => iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: new Date(iso).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' }) : 'undated'
const statusText: Record<CrawledPage['status'], string> = { listed: 'Found, opens at a later check', read: 'Read', blocked: 'Not opened: robots.txt', unreadable: 'Not readable, feed quoted', simulated: 'Simulated' }

export function CrawlerPanel({ company, toast }: { company: Company; toast: (s: string) => void }) {
  const { state } = useMonitoring()
  const [data, setData] = useState<Crawl | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [reading, setReading] = useState<CrawledPage | null>(null)
  const [more, setMore] = useState(false)
  const status = state?.clients.find(c => c.companyId === company.id)
  const checking = !!status?.checking
  const step = [...(state?.activity ?? [])].reverse().find(a => a.companyId === company.id && a.worker === 'news')
  const load = () => getCrawl(company.id).then(setData).catch(() => {})
  useEffect(() => { load() }, [company.id, status?.lastCheck])
  // While the crawler works, the list fills in as articles are read.
  useEffect(() => { if (!checking) return; const id = window.setInterval(load, 2500); return () => window.clearInterval(id) }, [checking])
  const pages = data?.pages ?? []
  const attention = (p: CrawledPage) => p.severity === 'alert' || p.severity === 'watch'
  const q = query.trim().toLowerCase()
  const shown = pages.filter(p => (filter === 'all' || (filter === 'attention' ? attention(p) : p.status === 'read')) && (!q || (p.title + ' ' + p.site + ' ' + (p.topic ?? '')).toLowerCase().includes(q)))
  const sources = data?.crawl?.sources ?? []
  const own = sources.filter(s => s.about === 'company')
  const headlines = sources.filter(s => s.about === 'headlines')
  return <section className="panel crawler">
    <div className="crawler-head">
      <span className="crawler-icon"><Newspaper size={17} /></span>
      <div><h2>News crawler</h2>
        <p className={checking ? 'crawler-live' : ''}>{checking ? <><LoaderCircle size={12} className="spin" />{step ? step.text : workerLabels.news + ' starting'}</>
          : data?.crawl ? 'Last read ' + new Date(data.crawl.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) + ' · ' + pages.length + ' articles about ' + (company.monitorTerms?.[0] ?? company.name) + ' · ' + pages.filter(p => p.status === 'read').length + ' read in full'
          : 'Reads the news at the next check of this client.'}</p></div>
      <div className="crawler-counts"><span><strong>{pages.filter(attention).length}</strong>to look at</span><span><strong>{pages.length}</strong>found</span></div>
    </div>
    {sources.length > 0 && <div className="crawler-sources">
      {own.map(s => <a key={s.url} href={s.url} target="_blank" rel="noreferrer" className={'src-chip' + (s.status === 'read' ? '' : ' off')} title={s.status === 'read' ? s.items + ' articles from ' + s.url : s.status}><Search size={11} />{s.name}<strong>{s.status === 'read' ? s.items : '—'}</strong></a>)}
      {headlines.length > 0 && <span className="src-chip" title={headlines.map(h => h.name + ': ' + (h.status === 'read' ? h.items : h.status)).join('\n')}><Globe2 size={11} />Headlines from {headlines.filter(h => h.status === 'read').length} news sites<strong>{headlines.reduce((n, h) => n + h.items, 0)}</strong></span>}
    </div>}
    <div className="crawler-tools">
      <div className="seg">{([['all', 'All'], ['attention', 'To look at'], ['read', 'Read in full']] as [Filter, string][]).map(([k, label]) => <button key={k} className={filter === k ? 'active' : ''} onClick={() => setFilter(k)}>{label}<span>{k === 'all' ? pages.length : k === 'attention' ? pages.filter(attention).length : pages.filter(p => p.status === 'read').length}</span></button>)}</div>
      <label className="search-input"><Search size={15} /><input placeholder="Search the articles…" value={query} onChange={e => setQuery(e.target.value)} aria-label="Search the articles" />{query && <button aria-label="Clear" onClick={() => setQuery('')}><X size={12} /></button>}</label>
    </div>
    {shown.length ? <ol className="crawl-list">{(more ? shown : shown.slice(0, 12)).map(p => <li key={p.url}><button className={'crawl-row sev-row-' + (p.severity ?? 'none') + (p.status === 'listed' ? ' pending' : '')} onClick={() => setReading(p)}>
      <time>{day(p.published)}</time>
      <div className="crawl-main">
        <strong>{p.title}</strong>
        <span>{p.site}{p.source !== p.site ? ' · via ' + p.source : ''}{p.status !== 'read' ? ' · ' + statusText[p.status] : ''}</span>
        {p.sentence && p.status !== 'listed' && <q>{p.sentence}</q>}
      </div>
      <span className="crawl-tags">{p.severity === 'alert' && <span className="critical-tag">Critical</span>}{p.topic ? <span className={'topic-chip sev-' + (p.severity ?? 'info')}>{p.topic}</span> : <span className="topic-chip sev-none">{p.status === 'listed' ? 'Not read yet' : 'Routine'}</span>}</span>
    </button></li>)}</ol>
      : <div className="case-empty"><Newspaper size={18} /><strong>{pages.length ? 'No article matches.' : checking ? 'Reading the news…' : 'No articles yet.'}</strong></div>}
    {shown.length > 12 && <button className="routine-toggle" onClick={() => setMore(v => !v)}>{more ? 'Show fewer' : 'Show all ' + shown.length + ' articles'}</button>}
    {reading && <Reader company={company} page={reading} onClose={() => setReading(null)} toast={toast} />}
  </section>
}

/** One article: the page as the crawler captured it, the text it read, and what it made of it. */
function Reader({ company, page: listed, onClose, toast }: { company: Company; page: CrawledPage; onClose: () => void; toast: (s: string) => void }) {
  const [page, setPage] = useState<CrawledPage>(listed)
  // The page as it was read comes first; the text only when no snapshot was kept.
  const [tab, setTab] = useState<'page' | 'text'>(listed.status === 'listed' || listed.snapshot ? 'page' : 'text')
  const serious = listed.severity === 'alert' || listed.severity === 'watch'
  const [agent, setAgent] = useState(serious)
  useEffect(() => { getCrawledPage(company.id, listed.url).then(p => { setPage(p); setTab(p.snapshot ? 'page' : 'text') }).catch(() => {}) }, [listed.url])
  const parts = page.text && page.sentence ? page.text.split(page.sentence) : null
  return <Dialog wide title={page.title} description={page.site + ' · ' + day(page.published) + ' · ' + statusText[page.status]} onClose={onClose}>
    <div className="reader">
      <div className="reader-main">
        <div className="reader-tabs">
          <button className={tab === 'page' ? 'active' : ''} disabled={!page.snapshot} onClick={() => setTab('page')} title={page.snapshot ? '' : 'No snapshot kept for this page'}><Globe2 size={13} />Page as read</button>
          <button className={tab === 'text' ? 'active' : ''} disabled={!page.text} onClick={() => setTab('text')}><FileText size={13} />Text as read</button>
          <a className="reader-original" href={page.url} target="_blank" rel="noreferrer"><ExternalLink size={13} />Open the original</a>
        </div>
        {tab === 'page' && page.snapshot && page.sha256 ? <iframe className="reader-frame" sandbox="" src={snapshotUrl(page.sha256)} title={'Snapshot of ' + page.title} />
          : page.text ? <article className="reader-text">{parts && parts.length > 1 ? <>{parts[0]}<mark>{page.sentence}</mark>{parts.slice(1).join(page.sentence!)}</> : page.text}</article>
          : <div className="case-empty"><FileText size={18} /><strong>{page.status === 'listed' ? 'Not opened yet' : 'No text was read'}</strong><p>{page.status === 'listed' ? 'The crawler found this article in ' + page.source + '. It opens the newest articles first, a few at every check.' : page.note ?? 'The page could not be read.'}</p></div>}
      </div>
      <aside className="reader-side">
        <div className={'reader-verdict sev-' + (page.severity ?? 'none')}>
          <span className="reader-verdict-label">{page.severity === 'alert' ? 'Critical' : page.severity === 'watch' ? 'To look at' : 'For the record'}{page.topic ? ' · ' + page.topic : ''}</span>
          {page.reason && <p>{page.reason}</p>}
          {page.judgedBy && <small>Judged by {page.judgedBy}</small>}
        </div>
        {page.sentence && <q>{page.sentence}</q>}
        {page.status !== 'listed' && (agent ? <SignalAgent company={company} signal={{ companyId: company.id, url: page.url }} toast={toast} compact />
          : <button className="reader-ask" onClick={() => setAgent(true)}><Bot size={15} />Talk to the risk assistant about this article</button>)}
        <details className="reader-facts"><summary>Where it came from</summary>
        <dl>
          <div><dt>Found in</dt><dd>{page.source}</dd></div>
          <div><dt>Published</dt><dd>{day(page.published)}</dd></div>
          {page.readAt && <div><dt>Read</dt><dd>{new Date(page.readAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</dd></div>}
          {page.sha256 && <div><dt>SHA-256 of the page</dt><dd><code>{page.sha256.slice(0, 16)}…</code></dd></div>}
          {page.note && <div><dt>Note</dt><dd>{page.note}</dd></div>}
        </dl></details>
        <p className="reader-foot"><ShieldCheck size={12} />Shown as captured, with its scripts switched off. Images and styles load from {page.site}.</p>
      </aside>
    </div>
  </Dialog>
}
