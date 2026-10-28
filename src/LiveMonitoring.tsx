import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { ArrowRight, Check, ChevronDown, ChevronRight, ExternalLink, Globe2, Landmark, LoaderCircle, Newspaper, RefreshCw, Scale, Send, ShieldCheck } from 'lucide-react'
import type { Company } from './types'
import type { CheckResult, ClientStatus, MonitorActivity, MonitorEvent, MonitorWorker } from './monitoring'
import { sourceLabels, workerLabels } from './monitoring'
import type { DepartmentId } from './workspace'
import { DEPARTMENTS, departmentName } from './workspace'
import { money, ratio } from './analysis'
import { Button, CompanyMark, Dialog } from './components'
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

// ─── Credit clients table (Companies → Credit clients) ───────────────────────

export function ClientsTable({ clients, latest, onOpen }: { clients: Company[]; latest: Map<string, AssessmentSummary>; onOpen: (id: string) => void }) {
  const { state } = useMonitoring()
  const now = useClock()
  return <section className="portfolio-panel clients-panel">
    <div className="table-scroll"><table className="company-table clients-table"><thead><tr><th>Company</th><th>Credit line</th><th>Drawn</th><th>Maturity</th><th>Covenants</th><th>Monitoring</th><th /></tr></thead><tbody>
      {clients.map(c => {
        const line = c.creditLine!
        const s = state?.clients.find(x => x.companyId === c.id)
        const covenants = s?.checks.covenants
        return <tr key={c.id} onClick={() => onOpen(c.id)}>
          <td><div className="company-cell"><CompanyMark company={c} /><div><span className="company-name">{c.name}</span><span>{c.sector}</span></div></div></td>
          <td><span className="table-amount">{money(line.limit)}</span><span className="cell-subtext">{line.product}</span></td>
          <td><Usage company={c} /></td>
          <td><span className="table-amount">{line.maturity}</span><span className="cell-subtext">review {line.nextReview}</span></td>
          <td>{covenants ? <span className={'mon-pill tone-pill-' + covenants.tone}>{covenants.label}</span> : latest.get(c.id) ? <span className="mon-pill mon-unknown">Waiting for check</span> : <span className="mon-pill mon-unknown">Not assessed</span>}</td>
          <td><MonitorStatus status={s} /><span className="cell-subtext">{s?.lastCheck ? 'checked ' + ago(s.lastCheck, now) : ''}</span></td>
          <td><ChevronRight className="row-chevron" size={17} /></td>
        </tr>
      })}
    </tbody></table></div>
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
  const [open, setOpen] = useState(false)
  return <li className={'change sev-line-' + event.severity + (event.reviewedAt ? ' reviewed' : '')}>
    <button className="change-row" onClick={() => setOpen(o => !o)} aria-expanded={open}>
      <span className={'dot dot-' + event.severity} />
      <span className="change-title">{event.title}</span>
      {company && <span className="change-client">{company.name}</span>}
      <span className="change-time">{ago(event.ts, now)}</span>
      <ChevronDown size={14} className={open ? 'flip' : ''} />
    </button>
    {open && <div className="change-body">
      <p className={event.source === 'web' ? 'quote' : ''}>{event.detail}</p>
      <div className="change-foot">
        <span>{sourceLabels[event.source]}</span>
        {event.data?.url && <a href={event.data.url} target="_blank" rel="noreferrer"><ExternalLink size={11} />{event.data.site ?? 'source'}{event.data.published ? ' · ' + event.data.published : ''}</a>}
        {event.data?.sha256 && <span className="hash-chip" title={'SHA-256 of the page as read: ' + event.data.sha256}>{event.data.sha256.slice(0, 10)}</span>}
        {event.data?.note && <span>{event.data.note}</span>}
        <span className="feed-actions">
          {company && onOpen && <button className="text-button" onClick={() => onOpen(company.id)}>Open company<ArrowRight size={12} /></button>}
          {event.reviewedAt ? <span className="feed-reviewed"><Check size={11} />Reviewed by {event.reviewedBy}</span>
            : event.severity !== 'info' && <button className="text-button" onClick={async () => { await reviewEvent(event.id); onChange() }}>Mark reviewed</button>}
          {company && event.severity !== 'info' && <SendEvent event={event} company={company} onSent={ref => toast('Sent as case ' + ref)} />}
        </span>
      </div>
    </div>}
  </li>
}

export default function Monitoring({ clients, onOpen, toast }: { clients: Company[]; onOpen: (id: string) => void; toast: (s: string) => void }) {
  const { state, refresh } = useMonitoring()
  const now = useClock()
  const [showRoutine, setShowRoutine] = useState(false)
  const [researching, setResearching] = useState<string | null>(null)
  const byId = new Map(clients.map(c => [c.id, c]))
  const statuses = state?.clients ?? []
  const checking = statuses.find(s => s.checking)
  const next = statuses.map(s => s.nextCheck).filter((x): x is string => !!x).sort()[0]
  const last = statuses.map(s => s.lastCheck).filter((x): x is string => !!x).sort().at(-1)
  const activity = state?.activity ?? []
  const lastStep = (worker: MonitorWorker): MonitorActivity | undefined => [...activity].reverse().find(a => a.worker === worker)
  const events = (state?.events ?? []).filter(e => e.title !== 'checked')
  const changes = events.filter(e => !routine(e))
  const routineEvents = events.filter(routine)
  const open = changes.filter(e => e.severity !== 'info' && !e.reviewedAt).length
  const nowCompany = state?.now ? byId.get(state.now.companyId) : undefined
  return <div className="page-enter monitoring-page">
    {/* What is happening, and when it happens next */}
    <section className="live-hero">
      <div className="live-clock">
        <span className="live-badge"><i />Live</span>
        {checking ? <><h1>Checking now</h1><p>{byId.get(checking.companyId)?.name} · {statuses.filter(s => s.queued).length} more in line</p></>
          : next ? <><h1>Next check in {countdown(next, now)}</h1><p>Every client is checked every {state?.intervalMinutes ?? 60} minutes · last round {last ? clockTime(last) + ' (' + ago(last, now) + ')' : '—'}</p></>
          : <><h1>Starting the first round</h1><p>Each client is checked as soon as the engine starts.</p></>}
      </div>
      <div className="live-now">
        <span className="live-label">Right now</span>
        {checking && state?.now ? <><strong>{nowCompany?.name}</strong><span>{workerLabels[state.now.worker]}: {lastStep(state.now.worker)?.text ?? 'starting'}</span></>
          : <><strong>Waiting for the next round</strong><span>{statuses.length} clients · {open ? open + (open === 1 ? ' change' : ' changes') + ' to review' : 'nothing waiting for review'}</span></>}
        <Button small onClick={async () => { await checkNow(); refresh(); toast('Checking every client now') }} disabled={!!checking}><RefreshCw size={13} />Check all now</Button>
      </div>
    </section>

    {/* Who does the checking, and what they are doing */}
    <section className="workers">
      {WORKERS.map(w => {
        const step = lastStep(w.id)
        const busy = !!checking && state?.now?.worker === w.id
        return <article key={w.id} className={'worker-card' + (busy ? ' busy' : '')}>
          <header><span className="worker-icon"><w.icon size={17} /></span><h2>{workerLabels[w.id]}</h2><span className={'worker-state ' + (busy ? 'working' : step ? 'done' : 'idle')}>{busy ? <><LoaderCircle size={11} className="spin" />Working</> : step ? 'Done' : 'Waiting'}</span></header>
          <p>{w.does}</p>
          <div className="worker-last">{step ? <><span>{byId.get(step.companyId)?.name.replace(/ S\.?A\.?$/, '')} · {clockTime(step.ts)}</span>{step.text}</> : 'No step yet in this session.'}</div>
        </article>
      })}
    </section>
    <section className="live-log panel">
      <div className="side-card-head"><h2>Live log</h2><span className="side-card-count">every step, as it happens</span></div>
      <ol>{activity.slice(-9).reverse().map((a, i) => <li key={a.ts + i} className={'log-' + a.state}><time>{new Date(a.ts).toLocaleTimeString('en-GB')}</time><span className="log-worker">{workerLabels[a.worker]}</span><span className="log-client">{byId.get(a.companyId)?.name.replace(/ S\.?A\.?$/, '')}</span><span className="log-text">{a.text}</span></li>)}
        {!activity.length && <li className="log-empty">The log fills in during the next check. Press Check all now to watch one.</li>}</ol>
    </section>

    <div className="monitoring-layout">
      {/* Clients at a glance */}
      <section className="client-cards">
        {clients.map(c => {
          const s = statuses.find(x => x.companyId === c.id)
          return <article key={c.id} className={'client-card st-' + (s?.checking ? 'checking' : s?.status ?? 'unknown')}>
            <header><button className="link-button" onClick={() => onOpen(c.id)}>{c.name}</button><MonitorStatus status={s} /></header>
            <Usage company={c} />
            <div className="src-tiles">{WORKERS.map(w => <SourceTile key={w.id} worker={w.id} result={s?.checks[w.id]} active={s?.working === w.id} />)}</div>
            <footer><span>{s?.lastCheck ? 'Checked ' + ago(s.lastCheck, now) : s?.queued ? 'In line' : 'Not checked yet'}{s?.nextCheck && !s.checking ? ' · next in ' + countdown(s.nextCheck, now) : ''}</span>
              <button className="text-button" onClick={async () => { await checkNow(c.id); refresh() }} disabled={s?.checking || s?.queued}><RefreshCw size={12} />Check</button>
              <button className="text-button" onClick={async () => { setResearching(c.id); try { toast((await researchClient(c.id)).result); refresh() } catch (e: any) { toast(e.message) } finally { setResearching(null) } }} disabled={researching === c.id} title="The assistant searches the past year's news">{researching === c.id ? <LoaderCircle size={12} className="spin" /> : <Globe2 size={12} />}Web</button></footer>
          </article>
        })}
      </section>

      {/* What changed */}
      <section className="panel changes">
        <div className="side-card-head"><h2>What changed</h2><span className="side-card-count">{open ? open + ' to review' : 'all reviewed'}</span></div>
        {changes.length ? <ol>{changes.map(e => <Change key={e.id} event={e} company={byId.get(e.companyId)} onOpen={onOpen} onChange={refresh} toast={toast} now={now} />)}</ol>
          : <div className="case-empty"><ShieldCheck size={20} /><strong>No changes found.</strong><p>Register readings, news and covenants are as they were.</p></div>}
        <button className="routine-toggle" onClick={() => setShowRoutine(v => !v)}><Check size={13} />{routineEvents.length} routine {routineEvents.length === 1 ? 'check' : 'checks'} with nothing to report<ChevronDown size={13} className={showRoutine ? 'flip' : ''} /></button>
        {showRoutine && <ol className="routine">{routineEvents.map(e => <Change key={e.id} event={e} company={byId.get(e.companyId)} onOpen={onOpen} onChange={refresh} toast={toast} now={now} />)}</ol>}
      </section>
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
  const now = useClock()
  const [researching, setResearching] = useState(false)
  const line = company.creditLine!
  const s = state?.clients.find(c => c.companyId === company.id)
  const recent = (state?.events ?? []).filter(e => e.companyId === company.id && e.title !== 'checked' && !routine(e)).slice(0, 3)
  const m = latest?.digest?.metrics
  return <section className="panel client-panel">
    <div className="side-card-head"><h2>Credit line {line.facilityId}</h2><span className="side-card-count">{line.product} · approved {line.approvedAt} by {line.approvedBy} · {line.relationshipManager}</span><MonitorStatus status={s} /></div>
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
        <span>{s?.checking ? 'checking now' : s?.lastCheck ? 'checked ' + ago(s.lastCheck, now) : 'first check pending'}{s?.nextCheck && !s.checking ? ' · next in ' + countdown(s.nextCheck, now) : ''}</span>
        <button className="text-button" onClick={async () => { await checkNow(company.id); refresh() }} disabled={s?.checking || s?.queued}><RefreshCw size={12} />Check now</button>
        <button className="text-button" onClick={async () => { setResearching(true); try { toast((await researchClient(company.id)).result); refresh() } catch (e: any) { toast(e.message) } finally { setResearching(false) } }} disabled={researching}>{researching ? <LoaderCircle size={12} className="spin" /> : <Globe2 size={12} />}Search the web</button></div>
      <div className="src-tiles wide">{WORKERS.map(w => <SourceTile key={w.id} worker={w.id} result={s?.checks[w.id]} active={s?.working === w.id} />)}</div>
      {recent.length > 0 ? <ol className="cm-changes">{recent.map(e => <Change key={e.id} event={e} company={company} onChange={refresh} toast={toast} now={now} />)}</ol>
        : <p className="cm-quiet"><Check size={13} />No changes found. The register, the news and the covenants are as they were.</p>}
      <a className="text-button cm-all" href="#/monitoring">Open Live monitoring<ArrowRight size={12} /></a>
    </div>
  </section>
}
