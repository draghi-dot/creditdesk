import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { AlertTriangle, ArrowRight, Bot, Check, ChevronDown, ChevronLeft, ChevronRight, ExternalLink, Globe2, Landmark, LoaderCircle, Newspaper, RefreshCw, Scale, Search, Send, ShieldCheck, X } from 'lucide-react'
import { PagePreview, RiskChip, SignalDialog, useClientRisks, useRisk } from './EarlyWarning'
import { riskStatus } from './workspace'
import type { Company } from './types'
import type { CheckResult, ClientStatus, MonitorActivity, MonitorEvent, MonitorWorker } from './monitoring'
import { compactSteps, sourceLabels, workerLabels } from './monitoring'
import type { DepartmentId } from './workspace'
import { DEPARTMENTS, departmentName } from './workspace'
import { money, ratio } from './analysis'
import { Button, Dialog } from './components'
import type { AssessmentSummary } from './assessment'
import { checkNow, openCase, researchClient, reviewEvent, useMonitoring } from './people'

// ─── Time ─────────────────────────────────────────────────────────────────────

/** The current time, ticking every second while the page is open. */
function useClock() {
  const [now, setNow] = useState(Date.now())
  useEffect(() => { const id = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(id) }, [])
  return now
}
const ago = (iso: string, now: number) => { const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000)); return s < 60 ? 'just now' : s < 3600 ? Math.round(s / 60) + ' min ago' : s < 86400 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' d ago' }
const countdown = (iso: string, now: number) => { const s = Math.max(0, Math.round((Date.parse(iso) - now) / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') }
const clockTime = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })

// ─── Small pieces ─────────────────────────────────────────────────────────────

const WORKERS: { id: MonitorWorker; icon: typeof Landmark; does: string }[] = [
  { id: 'anaf', icon: Landmark, does: 'Asks the public ANAF register for the company\'s status, VAT registration, name and address, and compares them with the previous reading.' },
  { id: 'news', icon: Newspaper, does: 'Reads nine business-news feeds, opens the articles that name the client where the site allows it, and quotes the sentence about the company.' },
  { id: 'covenants', icon: Scale, does: 'Compares DSCR, debt/EBITDA and liquidity from the latest assessment with the limits agreed in the credit line.' },
]
const statusText: Record<ClientStatus['status'], string> = { alert: 'Needs attention', watch: 'Something to look at', ok: 'All clear', unknown: 'First check pending' }
const share = (c: Company) => c.creditLine ? Math.round(c.creditLine.drawn / c.creditLine.limit * 100) : 0
const routine = (e: MonitorEvent) => e.severity === 'info' && e.source !== 'web'

export function MonitorStatus({ status }: { status?: ClientStatus }) {
  if (!status) return <span className="mon-pill mon-unknown">—</span>
  return <span className={'mon-pill mon-' + (status.checking ? 'checking' : status.status)}>{status.checking ? <><LoaderCircle size={11} className="spin" />Checking</> : statusText[status.status]}</span>
}

function SourceTile({ worker, result, active }: { worker: MonitorWorker; result?: CheckResult; active?: boolean }) {
  const Icon = WORKERS.find(w => w.id === worker)!.icon
  return <div className={'src-tile tone-' + (active ? 'working' : result?.tone ?? 'off')} title={result?.detail ?? 'Not checked yet'}>
    <Icon size={14} /><span>{workerLabels[worker]}</span><strong>{active ? 'Working…' : result?.label ?? '—'}</strong>
  </div>
}

function Usage({ company }: { company: Company }) {
  const line = company.creditLine!
  return <div className="usage"><div className="usage-bar"><i style={{ width: share(company) + '%' }} /></div><span><strong>{share(company)}%</strong> drawn · {money(line.drawn, true)} of {money(line.limit, true)}</span></div>
}

// ─── Finding clients: search, status and pages, for a book of any size ──────

type ClientFilter = 'all' | 'review' | 'clear' | 'pending'
const PAGE = 25
function useClientList(clients: Company[], statuses: ClientStatus[]) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<ClientFilter>('all')
  const [page, setPage] = useState(1)
  const statusOf = (c: Company) => statuses.find(x => x.companyId === c.id)
  const kind = (c: Company): ClientFilter => { const s = statusOf(c); return !s?.lastCheck ? 'pending' : s.open > 0 || s.status === 'alert' ? 'review' : 'clear' }
  const counts = { all: clients.length, review: 0, clear: 0, pending: 0 } as Record<ClientFilter, number>
  for (const c of clients) counts[kind(c)]++
  const q = query.trim().toLowerCase()
  const matching = clients.filter(c => (filter === 'all' || kind(c) === filter) && (!q || [c.name, c.cui, c.symbol, c.id, c.sector, c.creditLine?.facilityId].join(' ').toLowerCase().includes(q)))
  const pages = Math.max(1, Math.ceil(matching.length / PAGE))
  const current = Math.min(page, pages)
  useEffect(() => setPage(1), [query, filter])
  return { query, setQuery, filter, setFilter, counts, matching, shown: matching.slice((current - 1) * PAGE, current * PAGE), page: current, pages, setPage, statusOf }
}

function ClientToolbar({ list, total }: { list: ReturnType<typeof useClientList>; total: number }) {
  const tabs: [ClientFilter, string][] = [['all', 'All'], ['review', 'To review'], ['clear', 'All clear'], ['pending', 'Not checked yet']]
  return <div className="mon-toolbar">
    <label className="search-input"><Search size={16} /><input placeholder={'Search ' + total + ' clients by name, CUI or facility…'} value={list.query} onChange={e => list.setQuery(e.target.value)} aria-label="Search credit clients" />{list.query && <button aria-label="Clear search" onClick={() => list.setQuery('')}><X size={13} /></button>}</label>
    <div className="seg" role="tablist" aria-label="Filter clients">{tabs.filter(([k]) => k === 'all' || list.counts[k] > 0).map(([k, label]) => <button key={k} role="tab" aria-selected={list.filter === k} className={(list.filter === k ? 'active ' : '') + 'seg-' + k} onClick={() => list.setFilter(k)}>{label}<span>{list.counts[k]}</span></button>)}</div>
  </div>
}

function Pages({ list }: { list: ReturnType<typeof useClientList> }) {
  if (list.matching.length <= PAGE) return <div className="mon-foot">{list.matching.length} of {list.counts.all} clients</div>
  return <div className="mon-foot"><span>{(list.page - 1) * PAGE + 1}–{Math.min(list.page * PAGE, list.matching.length)} of {list.matching.length}</span>
    <button className="pagination-arrow" disabled={list.page === 1} onClick={() => list.setPage(list.page - 1)} aria-label="Previous page"><ChevronLeft size={15} /></button>
    <button className="pagination-arrow" disabled={list.page === list.pages} onClick={() => list.setPage(list.page + 1)} aria-label="Next page"><ChevronRight size={15} /></button></div>
}

/** One worker's verdict in a table cell: an icon, a word or two, the detail on hover. */
function Verdict({ worker, result, active }: { worker: MonitorWorker; result?: CheckResult; active?: boolean }) {
  const Icon = WORKERS.find(w => w.id === worker)!.icon
  return <span className={'verdict-chip tone-' + (active ? 'working' : result?.tone ?? 'off')} title={workerLabels[worker] + ': ' + (result?.detail ?? 'not checked yet')}>
    {active ? <LoaderCircle size={12} className="spin" /> : result?.tone === 'ok' ? <Check size={12} strokeWidth={2.6} /> : <Icon size={12} />}{active ? 'Checking' : result ? result.label : 'Not yet'}</span>
}

// ─── Credit clients table (Companies → Credit clients) ───────────────────────

export function ClientsTable({ clients, latest, onOpen }: { clients: Company[]; latest: Map<string, AssessmentSummary>; onOpen: (id: string) => void }) {
  const { state } = useMonitoring()
  const risks = useClientRisks()
  const now = useClock()
  const list = useClientList(clients, state?.clients ?? [])
  return <section className="portfolio-panel clients-panel">
    <ClientToolbar list={list} total={clients.length} />
    <div className="table-scroll"><table className="company-table clients-table"><thead><tr><th>Company</th><th>Credit line</th><th>Drawn</th><th>Maturity</th><th>Covenants</th><th>Status</th><th>Monitoring</th><th /></tr></thead><tbody>
      {list.shown.map(c => {
        const line = c.creditLine!
        const s = list.statusOf(c)
        const covenants = s?.checks.covenants
        return <tr key={c.id} onClick={() => onOpen(c.id)}>
          <td><div className="company-cell"><div><span className="company-name">{c.name}</span><span>{c.sector} · {line.facilityId}</span></div></div></td>
          <td><span className="table-amount">{money(line.limit)}</span><span className="cell-subtext">{line.product}</span></td>
          <td><Usage company={c} /></td>
          <td><span className="table-amount">{line.maturity}</span><span className="cell-subtext">review {line.nextReview}</span></td>
          <td>{covenants ? <span className={'mon-pill tone-pill-' + covenants.tone}>{covenants.label}</span> : latest.get(c.id) ? <span className="mon-pill mon-unknown">Waiting for check</span> : <span className="mon-pill mon-unknown">Not assessed</span>}</td>
          <td><RiskChip risk={risks.get(c.id) ?? null} /></td>
          <td><MonitorStatus status={s} /><span className="cell-subtext">{s?.lastCheck ? 'checked ' + ago(s.lastCheck, now) : ''}</span></td>
          <td><ChevronRight className="row-chevron" size={17} /></td>
        </tr>
      })}
    </tbody></table></div>
    {!list.matching.length && <div className="case-empty"><Search size={18} /><strong>No client matches.</strong></div>}
    <Pages list={list} />
  </section>
}

// ─── Live monitoring page ────────────────────────────────────────────────────

function SendEvent({ event, company, onSent }: { event: MonitorEvent; company: Company; onSent: (ref: string) => void }) {
  const usual: DepartmentId = event.source === 'anaf' ? 'compliance' : /Litigation|Investigation|Insolvency/.test(event.title) ? 'legal' : 'finance'
  const [open, setOpen] = useState(false)
  const [department, setDepartment] = useState<DepartmentId>(usual)
  const [busy, setBusy] = useState(false)
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true)
    try {
      const { case: c } = await openCase({ companyId: company.id, runId: null, department, title: event.title, note: event.detail + (event.data?.url ? '\nSource: ' + event.data.url : '') + '\n(' + sourceLabels[event.source] + ')' })
      setOpen(false); onSent(c.ref + ' · ' + departmentName(c.department))
    } finally { setBusy(false) }
  }
  return <>
    <button className="text-button" onClick={() => setOpen(true)}><Send size={12} />Send to {departmentName(usual)}</button>
    {open && <Dialog title="Send this to a department" description={company.name + ' · ' + event.title} onClose={() => !busy && setOpen(false)}>
      <form onSubmit={submit}><div className="form-content">
        <fieldset className="department-choice"><legend>Department</legend>{DEPARTMENTS.map(d => <label key={d.id} className={department === d.id ? 'checked' : ''}><input type="radio" name="department" checked={department === d.id} onChange={() => setDepartment(d.id)} /><strong>{d.name}{d.id === usual && <em>usual for this</em>}</strong><span>{d.handles}</span></label>)}</fieldset>
      </div><div className="dialog-actions"><Button type="button" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button><Button variant="primary" type="submit" disabled={busy}>{busy ? 'Sending…' : 'Send to ' + departmentName(department)}</Button></div></form>
    </Dialog>}
  </>
}

/** One change, one line; open it for the evidence and what to do. */
function Change({ event, company, onOpen, onChange, toast, now }: { event: MonitorEvent; company?: Company; onOpen?: (id: string) => void; onChange: () => void; toast: (s: string) => void; now: number }) {
  const [reviewing, setReviewing] = useState(false)
  // Something found a moment ago opens by itself, so how it was found is in view straight away.
  const fresh = now - Date.parse(event.ts) < 30_000
  const [open, setOpen] = useState(fresh && event.severity !== 'info')
  return <li className={'change sev-line-' + event.severity + (event.reviewedAt ? ' reviewed' : '') + (fresh ? ' fresh' : '')}>
    <button className="change-row" onClick={() => setOpen(o => !o)} aria-expanded={open}>
      <span className={'dot dot-' + event.severity} />
      <span className="change-title">{event.severity === 'alert' && !event.reviewedAt && <span className="critical-tag">Critical</span>}{event.data?.simulated && <span className="sim-tag">Simulated</span>}{event.title}</span>
      {company && <span className="change-client">{company.name}</span>}
      <span className="change-time">{ago(event.ts, now)}</span>
      <ChevronDown size={14} className={open ? 'flip' : ''} />
    </button>
    {open && <div className="change-body">
      <p className={event.source === 'web' ? 'quote' : ''}>{event.detail}</p>
      {!!event.data?.steps?.length && <ol className="found-steps" aria-label="How it was found">{compactSteps(event.data.steps).map((step, i, all) => <li key={i} className={i === all.length - 1 ? 'last' : ''}>{step}</li>)}</ol>}
      <div className="change-foot">
        <span>{sourceLabels[event.source]}</span>
        {event.data?.url && <a href={event.data.url} target="_blank" rel="noreferrer"><ExternalLink size={11} />{event.data.site ?? 'source'}{event.data.published ? ' · ' + event.data.published : ''}</a>}
        {event.data?.sha256 && <span className="hash-chip" title={'SHA-256 of the page as read: ' + event.data.sha256}>{event.data.sha256.slice(0, 10)}</span>}
        {event.data?.note && <span>{event.data.note}</span>}
        <span className="feed-actions">
          {company && event.severity !== 'info' && <button className="text-button strong" onClick={() => setReviewing(true)}><Bot size={12} />Review with the assistant</button>}
          {company && onOpen && <button className="text-button" onClick={() => onOpen(company.id)}>Open company<ArrowRight size={12} /></button>}
          {event.reviewedAt ? <span className="feed-reviewed"><Check size={11} />Reviewed by {event.reviewedBy}</span>
            : event.severity !== 'info' && <button className="text-button" onClick={async () => { await reviewEvent(event.id); onChange() }}>Mark reviewed</button>}
          {company && event.severity !== 'info' && <SendEvent event={event} company={company} onSent={ref => toast('Sent as case ' + ref)} />}
        </span>
      </div>
    </div>}
    {reviewing && company && <SignalDialog company={company} event={event} onClose={() => setReviewing(false)} toast={toast} />}
  </li>
}

export default function Monitoring({ clients, onOpen, toast }: { clients: Company[]; onOpen: (id: string) => void; toast: (s: string) => void }) {
  const { state, refresh } = useMonitoring()
  const now = useClock()
  const risks = useClientRisks()
  const [showAll, setShowAll] = useState(false)
  const [researching, setResearching] = useState<string | null>(null)
  const byId = new Map(clients.map(c => [c.id, c]))
  const statuses = state?.clients ?? []
  const list = useClientList(clients, statuses)
  const checking = statuses.find(s => s.checking)
  const next = statuses.map(s => s.nextCheck).filter((x): x is string => !!x).sort()[0]
  const last = statuses.map(s => s.lastCheck).filter((x): x is string => !!x).sort().at(-1)
  const activity = state?.activity ?? []
  const lastStep = (worker: MonitorWorker): MonitorActivity | undefined => [...activity].reverse().find(a => a.worker === worker)
  const events = (state?.events ?? []).filter(e => e.title !== 'checked' && !routine(e))
  const toReview = events.filter(e => e.severity !== 'info' && !e.reviewedAt)
  const critical = toReview.filter(e => e.severity === 'alert')
  // What to look at, by client, the clients with the most first.
  const watching = [...toReview.filter(e => e.severity === 'watch').reduce((m, e) => m.set(e.companyId, [...(m.get(e.companyId) ?? []), e]), new Map<string, MonitorEvent[]>())].sort((a, b) => b[1].length - a[1].length)
  const bannerTop = critical.find(e => e.data?.snapshot) ?? critical[0] ?? watching[0]?.[1].find(e => e.data?.snapshot)
  const [reviewing, setReviewing] = useState<MonitorEvent | null>(null)
  const feed = showAll ? events : toReview
  // Long registered names give way to the name the company goes by (TAROM).
  const short = (id: string) => { const c = byId.get(id); return !c ? id : c.name.replace(/ S\.?A\.?$/, '').length > 22 && c.monitorTerms?.[0] ? c.monitorTerms[0].toUpperCase() : c.name.replace(/ S\.?A\.?$/, '') }
  return <div className="page-enter monitoring-page">
    <div className="page-heading"><div><h1>Live monitoring</h1><p>Every credit client, checked against the ANAF register, the news and its covenants.</p></div></div>

    {(critical.length > 0 || watching.length > 0) && <section className={'risk-banner compact ' + (critical.length ? 'critical' : 'watched')} role="alert"><span className="risk-banner-icon"><AlertTriangle size={20} /></span>
      <div className="risk-banner-main"><strong>{critical.length ? critical.length + ' critical ' + (critical.length === 1 ? 'signal needs' : 'signals need') + ' action' : 'Signals to look at'}</strong>
        <ul>{critical.slice(0, 3).map(e => <li key={e.id}><span className="critical-tag">Critical</span><button onClick={() => setReviewing(e)}>{short(e.companyId)}: {e.title}</button></li>)}
          {watching.slice(0, critical.length ? 2 : 4).map(([id, list]) => <li key={id}><button onClick={() => onOpen(id)}><b>{short(id)}</b> · {list.length} to look at: {[...new Set(list.map(e => e.title.split(':')[0]))].slice(0, 3).join(', ')}</button></li>)}</ul></div>
      {bannerTop?.data?.snapshot && bannerTop.data.sha256 && <PagePreview sha={bannerTop.data.sha256} title={bannerTop.title} onOpen={() => setReviewing(bannerTop)} />}
    </section>}
    {/* Outside the banner, so the banner's own text styles do not reach into the dialog. */}
    {reviewing && byId.get(reviewing.companyId) && <SignalDialog company={byId.get(reviewing.companyId)!} event={reviewing} onClose={() => setReviewing(null)} toast={toast} />}
    <section className={'mon-bar' + (checking ? ' is-checking' : '')}>
      <div className="mon-clock">
        <span className="live-badge"><i />Live</span>
        <div><span className="mon-clock-label">{checking ? 'Checking now' : next ? 'Next round in' : 'Starting'}</span>
          <strong>{checking ? short(checking.companyId) : next ? countdown(next, now) : '—'}</strong></div>
        <span className="mon-last">{checking ? statuses.filter(s => s.queued).length + ' more in line' : last ? 'Last round ' + clockTime(last) + ' · every ' + (state?.intervalMinutes ?? 60) + ' min' : 'First round running'}</span>
      </div>
      <div className="mon-workers">{WORKERS.map(w => {
        const busy = !!checking && state?.now?.worker === w.id
        const step = lastStep(w.id)
        return <div key={w.id} className={'mon-worker' + (busy ? ' busy' : '')} title={w.does}>
          <span className="mon-worker-icon">{busy ? <LoaderCircle size={15} className="spin" /> : <w.icon size={15} />}</span>
          <div><strong>{workerLabels[w.id]}</strong><span>{busy ? step?.text ?? 'Starting' : step ? short(step.companyId) + ' · ' + clockTime(step.ts) : 'Waiting'}</span></div>
        </div>
      })}</div>
      <Button onClick={async () => { await checkNow(); refresh(); toast('Checking every client now') }} disabled={!!checking}><RefreshCw size={14} />Check all now</Button>
    </section>

    <div className="mon-layout">
      <section className="panel mon-clients">
        <ClientToolbar list={list} total={clients.length} />
        <div className="table-scroll"><table className="mon-table"><thead><tr><th>Client</th><th>Drawn</th><th>Register</th><th>News</th><th>Covenants</th><th>Checked</th><th /></tr></thead><tbody>
          {list.shown.map(c => {
            const s = list.statusOf(c)
            return <tr key={c.id} className={s?.checking ? 'row-checking' : s?.status === 'alert' ? 'row-critical' : s && s.open > 0 ? 'row-review' : ''}>
              <td><button className="mon-name" onClick={() => onOpen(c.id)}>{c.name}</button><span className="cell-subtext">{c.sector}{!!s?.planted.length && <span className="sim-tag">Test signal planted</span>}{risks.get(c.id) && riskStatus(risks.get(c.id)!).tone !== 'ok' && <RiskChip risk={risks.get(c.id)!} />}</span></td>
              <td><span className="mini-usage"><i style={{ width: share(c) + '%' }} /></span><span className="cell-subtext">{share(c)}% of {money(c.creditLine!.limit, true)}</span></td>
              {WORKERS.map(w => <td key={w.id}><Verdict worker={w.id} result={s?.checks[w.id]} active={s?.working === w.id} /></td>)}
              <td><span className="mon-when">{s?.checking ? 'now' : s?.lastCheck ? ago(s.lastCheck, now) : s?.queued ? 'in line' : '—'}</span><span className="cell-subtext">{s?.nextCheck && !s.checking ? 'next ' + countdown(s.nextCheck, now) : ''}</span></td>
              <td className="mon-row-actions"><div>
                <button className="ws-icon" title="Check this client now" aria-label={'Check ' + c.name + ' now'} onClick={async () => { await checkNow(c.id); refresh() }} disabled={s?.checking || s?.queued}><RefreshCw size={13} /></button>
                <button className="ws-icon" title="Search the past year's news on the web" aria-label={'Search the web for ' + c.name} onClick={async () => { setResearching(c.id); try { toast((await researchClient(c.id)).result); refresh() } catch (e: any) { toast(e.message) } finally { setResearching(null) } }} disabled={researching === c.id}>{researching === c.id ? <LoaderCircle size={13} className="spin" /> : <Globe2 size={13} />}</button>
              </div></td>
            </tr>
          })}
        </tbody></table></div>
        {!list.matching.length && <div className="case-empty"><Search size={18} /><strong>No client matches.</strong></div>}
        <Pages list={list} />
      </section>

      <aside className="mon-side">
        <section className="panel changes">
          <div className="side-card-head"><h2>{showAll ? 'All changes' : 'To review'}</h2><span className={'mon-count' + (toReview.length ? ' has' : '')}>{toReview.length}</span>
            <button className="text-button" onClick={() => setShowAll(v => !v)}>{showAll ? 'Only to review' : 'Show all'}</button></div>
          {feed.length ? <ol>{feed.slice(0, 30).map(e => <Change key={e.id} event={e} company={byId.get(e.companyId)} onOpen={onOpen} onChange={refresh} toast={toast} now={now} />)}</ol>
            : <div className="case-empty"><ShieldCheck size={20} /><strong>Nothing to review.</strong></div>}
        </section>
        <section className="panel live-log">
          <div className="side-card-head"><h2>Live log</h2>{checking && <span className="live-badge small"><i />now</span>}</div>
          <ol>{activity.slice(-10).reverse().map((a, i) => <li key={a.ts + i} className={'log-' + a.state}><time>{new Date(a.ts).toLocaleTimeString('en-GB')}</time><div><span>{workerLabels[a.worker]} · {short(a.companyId)}</span>{a.text}</div></li>)}
            {!activity.length && <li className="log-empty">Fills in during the next round.</li>}</ol>
        </section>
      </aside>
    </div>
  </div>
}

// ─── Client panel on the company page ───────────────────────────────────────

function Timeline({ company, now }: { company: Company; now: number }) {
  const line = company.creditLine!
  const start = Date.parse(line.startDate), end = Date.parse(line.maturity)
  const at = (iso: string | number) => Math.min(100, Math.max(0, ((typeof iso === 'number' ? iso : Date.parse(iso)) - start) / (end - start) * 100))
  return <div className="timeline-bar">
    <div className="tl-track"><i style={{ width: at(now) + '%' }} /><b className="tl-today" style={{ left: at(now) + '%' }} title="Today" /><b className="tl-review" style={{ left: at(line.nextReview) + '%' }} title={'Review ' + line.nextReview} /></div>
    <div className="tl-labels"><span>{line.startDate}</span><span>review {line.nextReview}</span><span>{line.maturity}</span></div>
  </div>
}

function Headroom({ label, value, limit, max }: { label: string; value: number | null | undefined; limit: number; max?: boolean }) {
  if (value == null) return <div className="headroom"><span>{label}</span><strong>—</strong></div>
  const ok = max ? value <= limit : value >= limit
  // Bar: the covenant limit sits at 40% of the track; the value is placed against it.
  const scale = Math.min(100, value / limit * 40)
  return <div className={'headroom ' + (ok ? 'ok' : 'breach')}>
    <span>{label}</span><strong>{ratio(value)}</strong>
    <div className="hr-track"><i style={{ width: scale + '%' }} /><b style={{ left: '40%' }} /></div>
    <small>{max ? 'limit ' : 'minimum '}{ratio(limit)} · {ok ? (max ? (limit / value).toFixed(1) + '× headroom' : (value / limit).toFixed(1) + '× the minimum') : 'breached'}</small>
  </div>
}

export function ClientPanel({ company, latest, toast }: { company: Company; latest: AssessmentSummary | null; toast: (s: string) => void }) {
  const { state, refresh } = useMonitoring()
  const { risk } = useRisk(company.id)
  const now = useClock()
  const [researching, setResearching] = useState(false)
  const line = company.creditLine!
  const s = state?.clients.find(c => c.companyId === company.id)
  const recent = (state?.events ?? []).filter(e => e.companyId === company.id && e.title !== 'checked' && !routine(e)).slice(0, 3)
  const m = latest?.digest?.metrics
  return <section className="panel client-panel">
    <div className="side-card-head"><h2>Credit line {line.facilityId}</h2><span className="side-card-count">{line.product} · approved {line.approvedAt} by {line.approvedBy} · {line.relationshipManager}</span><RiskChip risk={risk} /><MonitorStatus status={s} /></div>
    <div className="client-visuals">
      <div className="cv-block"><h3>Drawn</h3><div className="cv-big">{share(company)}%</div><Usage company={company} /></div>
      <div className="cv-block"><h3>Term</h3><div className="cv-big">{Math.max(0, Math.round((Date.parse(line.maturity) - now) / (30.44 * 86_400_000)))}<small> months left</small></div><Timeline company={company} now={now} /></div>
      <div className="cv-block cv-covenants"><h3>Covenants {latest ? '' : '· not assessed yet'}</h3>
        <Headroom label="DSCR" value={m?.dscr} limit={line.covenants.dscrMin} />
        <Headroom label="Debt / EBITDA" value={m?.leverage} limit={line.covenants.leverageMax} max />
        <Headroom label="Liquidity" value={m?.liquidity} limit={line.covenants.liquidityMin} />
      </div>
    </div>
    <div className="client-monitor">
      <div className="cm-head"><span className="live-badge small"><i />Live monitoring</span>
        <span className={s?.checking ? 'cm-live' : ''}>{s?.checking ? (() => { const a = [...(state?.activity ?? [])].reverse().find(x => x.companyId === company.id); return 'Checking now' + (a ? ' · ' + workerLabels[a.worker] + ': ' + a.text : '') })() : s?.lastCheck ? 'checked ' + ago(s.lastCheck, now) : 'first check pending'}{s?.nextCheck && !s.checking ? ' · next in ' + countdown(s.nextCheck, now) : ''}</span>
        <button className="text-button" onClick={async () => { await checkNow(company.id); refresh() }} disabled={s?.checking || s?.queued}><RefreshCw size={12} />Check now</button>
        <button className="text-button" onClick={async () => { setResearching(true); try { toast((await researchClient(company.id)).result); refresh() } catch (e: any) { toast(e.message) } finally { setResearching(false) } }} disabled={researching}>{researching ? <LoaderCircle size={12} className="spin" /> : <Globe2 size={12} />}Search the web</button></div>
      <div className="src-tiles wide">{WORKERS.map(w => <SourceTile key={w.id} worker={w.id} result={s?.checks[w.id]} active={s?.working === w.id} />)}</div>
      {recent.length > 0 ? <ol className="cm-changes">{recent.map(e => <Change key={e.id} event={e} company={company} onChange={refresh} toast={toast} now={now} />)}</ol>
        : <p className="cm-quiet"><Check size={13} />No changes found. The register, the news and the covenants are as they were.</p>}
      <a className="text-button cm-all" href="#/monitoring">Open Live monitoring<ArrowRight size={12} /></a>
    </div>
  </section>
}
