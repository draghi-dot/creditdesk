import { useState } from 'react'
import type { FormEvent } from 'react'
import { Check, ChevronRight, CircleAlert, ExternalLink, Globe2, LoaderCircle, RefreshCw, Send, ShieldCheck } from 'lucide-react'
import type { Company } from './types'
import type { ClientStatus, MonitorEvent, MonitorSeverity } from './monitoring'
import { sourceLabels } from './monitoring'
import type { DepartmentId } from './workspace'
import { DEPARTMENTS, departmentName } from './workspace'
import { money, ratio } from './analysis'
import { Button, CompanyMark, Dialog } from './components'
import { when } from './runs'
import type { AssessmentSummary } from './assessment'
import { checkNow, openCase, researchClient, reviewEvent, useMonitoring } from './people'

const severityLabel: Record<MonitorSeverity, string> = { alert: 'Alert', watch: 'Watch', info: 'Info' }
const statusLabel: Record<ClientStatus['status'], string> = { alert: 'Alert', watch: 'Watch', ok: 'No issues', unknown: 'Not checked yet' }

export function SeverityChip({ severity }: { severity: MonitorSeverity }) {
  return <span className={'sev sev-' + severity}>{severityLabel[severity]}</span>
}
export function MonitorStatus({ status }: { status?: ClientStatus }) {
  if (!status) return <span className="text-muted">—</span>
  return <span className={'mon-status mon-' + status.status}>{status.checking ? <><LoaderCircle size={11} className="spin" />Checking</> : statusLabel[status.status]}{status.open > 0 && <em>{status.open} open</em>}</span>
}

const share = (c: Company) => c.creditLine ? Math.round(c.creditLine.drawn / c.creditLine.limit * 100) : 0

/** Companies with an approved credit line, with their facility and monitoring state. */
export function ClientsTable({ clients, latest, onOpen }: { clients: Company[]; latest: Map<string, AssessmentSummary>; onOpen: (id: string) => void }) {
  const { state } = useMonitoring()
  const statusOf = (id: string) => state?.clients.find(c => c.companyId === id)
  return <section className="portfolio-panel clients-panel">
    <div className="directory-heading"><h2>Credit clients<span>{clients.length} companies with approved credit</span></h2></div>
    <div className="table-scroll"><table className="company-table clients-table"><thead><tr><th>Company</th><th>Credit line</th><th>Drawn</th><th>Maturity</th><th>Covenants</th><th>Monitoring</th><th /></tr></thead><tbody>
      {clients.map(c => {
        const line = c.creditLine!
        const run = latest.get(c.id)
        const m = run?.digest?.metrics
        const breach = m && ((m.dscr !== null && m.dscr < line.covenants.dscrMin) || (m.leverage !== null && m.leverage > line.covenants.leverageMax) || (m.liquidity !== null && m.liquidity < line.covenants.liquidityMin))
        return <tr key={c.id} onClick={() => onOpen(c.id)}>
          <td><div className="company-cell"><CompanyMark company={c} /><div><span className="company-name">{c.name}</span><span>{c.sector} · {c.symbol}</span></div></div></td>
          <td><span className="table-amount">{money(line.limit)}</span><span className="cell-subtext">{line.product} · {line.facilityId}</span></td>
          <td><span className="table-amount">{share(c)}%</span><span className="cell-subtext">{money(line.drawn)}</span></td>
          <td><span className="table-amount">{line.maturity}</span><span className="cell-subtext">review {line.nextReview}</span></td>
          <td>{!m ? <span className="mon-status mon-unknown">Not assessed</span> : breach ? <span className="mon-status mon-alert">Breach</span> : <span className="mon-status mon-ok">Met · DSCR {ratio(m.dscr)}</span>}</td>
          <td><MonitorStatus status={statusOf(c.id)} /><span className="cell-subtext">{statusOf(c.id)?.lastCheck ? 'checked ' + when(statusOf(c.id)!.lastCheck!) : ''}</span></td>
          <td><ChevronRight className="row-chevron" size={17} /></td>
        </tr>
      })}
    </tbody></table></div>
    <div className="directory-footnote"><ShieldCheck size={14} /><span>Every client is checked against the ANAF register, business-news feeds and its covenants every {state?.intervalMinutes ?? 60} minutes. See Live monitoring for the feed.</span></div>
  </section>
}

/** Send a monitoring event to a department as a case. */
function SendEvent({ event, company, onSent }: { event: MonitorEvent; company: Company; onSent: (ref: string) => void }) {
  const usual: DepartmentId = event.source === 'anaf' ? 'compliance' : /Litigation|Investigation|Insolvency/.test(event.title) ? 'legal' : 'finance'
  const [open, setOpen] = useState(false)
  const [department, setDepartment] = useState<DepartmentId>(usual)
  const [busy, setBusy] = useState(false)
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true)
    try {
      const { case: c } = await openCase({ companyId: company.id, runId: null, department, title: event.title, note: event.detail + (event.data?.url ? '\nSource: ' + event.data.url : '') + '\n(' + sourceLabels[event.source] + ', ' + when(event.ts) + ')' })
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

function EventRow({ event, company, onOpen, onChange, toast }: { event: MonitorEvent; company?: Company; onOpen?: (id: string) => void; onChange: () => void; toast: (s: string) => void }) {
  return <li className={'feed-item feed-' + event.severity + (event.reviewedAt ? ' reviewed' : '')}>
    <div className="feed-meta"><SeverityChip severity={event.severity} /><span>{sourceLabels[event.source]}</span>{company && onOpen && <button className="link-button" onClick={() => onOpen(company.id)}>{company.name}</button>}<time>{when(event.ts)}</time></div>
    <strong>{event.title}</strong>
    <p className={event.source === 'web' ? 'feed-quote' : ''}>{event.detail}</p>
    <div className="feed-foot">
      {event.data?.url && <a href={event.data.url} target="_blank" rel="noreferrer"><ExternalLink size={11} />{event.data.site ?? 'source'}{event.data.published ? ' · ' + event.data.published : ''}</a>}
      {event.data?.sha256 && <span className="hash-chip" title={'SHA-256 of the page as read: ' + event.data.sha256}>{event.data.sha256.slice(0, 10)}</span>}
      {event.data?.foundBy && <span>found by {event.data.foundBy}</span>}
      {event.data?.note && <span>{event.data.note}</span>}
      <span className="feed-actions">
        {event.reviewedAt ? <span className="feed-reviewed"><Check size={11} />Reviewed by {event.reviewedBy}</span>
          : event.severity !== 'info' && <button className="text-button" onClick={async () => { await reviewEvent(event.id); onChange() }}>Mark reviewed</button>}
        {company && event.severity !== 'info' && <SendEvent event={event} company={company} onSent={ref => toast('Sent as case ' + ref)} />}
      </span>
    </div>
  </li>
}

/** The live feed of monitoring checks for every credit client. */
export default function Monitoring({ clients, onOpen, toast }: { clients: Company[]; onOpen: (id: string) => void; toast: (s: string) => void }) {
  const { state, refresh } = useMonitoring()
  const [filter, setFilter] = useState<'all' | 'open' | 'alert'>('all')
  const [client, setClient] = useState('')
  const [researching, setResearching] = useState<string | null>(null)
  const byId = new Map(clients.map(c => [c.id, c]))
  const events = (state?.events ?? []).filter(e => e.title !== 'checked' && (!client || e.companyId === client) &&
    (filter === 'all' || (filter === 'alert' ? e.severity === 'alert' && !e.reviewedAt : e.severity !== 'info' && !e.reviewedAt)))
  const open = (state?.clients ?? []).reduce((n, c) => n + c.open, 0)
  const alerts = (state?.events ?? []).filter(e => e.severity === 'alert' && !e.reviewedAt).length
  const last = (state?.clients ?? []).map(c => c.lastCheck).filter(Boolean).sort().at(-1)
  const research = async (id: string) => {
    setResearching(id)
    try { toast((await researchClient(id)).result); refresh() } catch (e: any) { toast(e.message) } finally { setResearching(null) }
  }
  return <div className="page-enter monitoring-page">
    <div className="page-heading"><div><h1>Live monitoring</h1><p>Credit clients are checked every {state?.intervalMinutes ?? 60} minutes against the ANAF register, business-news feeds and their covenants. Changes appear here as they are found.</p></div>
      <div className="page-actions"><Button onClick={async () => { await checkNow(); refresh(); toast('Checking every client now') }}><RefreshCw size={15} />Check all now</Button></div></div>
    <div className="audit-summary mon-tiles"><div><ShieldCheck size={20} /><span><strong>{clients.length}</strong> clients monitored</span></div><div><CircleAlert size={20} /><span><strong>{alerts}</strong> alerts to review</span></div><div><CircleAlert size={20} /><span><strong>{open}</strong> items open</span></div><div><RefreshCw size={20} /><span>{last ? <>Last check <strong>{when(last)}</strong></> : 'Not checked yet'}</span></div></div>
    <div className="monitoring-layout">
      <section className="panel">
        <div className="case-toolbar"><div className="segmented">{(['all', 'open', 'alert'] as const).map(f => <button key={f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>{f === 'all' ? 'Everything' : f === 'open' ? 'Needs review' : 'Alerts'}</button>)}</div>
          <label className="select-wrap mon-client-filter"><select value={client} onChange={e => setClient(e.target.value)} aria-label="Client"><option value="">All clients</option>{clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label></div>
        {!state ? <div className="panel-loading"><LoaderCircle size={16} className="spin" />Loading the feed…</div>
          : events.length ? <ol className="feed">{events.map(e => <EventRow key={e.id} event={e} company={byId.get(e.companyId)} onOpen={onOpen} onChange={refresh} toast={toast} />)}</ol>
          : <div className="case-empty"><ShieldCheck size={20} /><strong>Nothing here.</strong><p>{filter === 'all' ? 'The first checks are running.' : 'Everything that needed attention has been reviewed.'}</p></div>}
      </section>
      <aside className="panel side-card">
        <div className="side-card-head"><h2>Clients</h2></div>
        <ul className="mon-clients">{clients.map(c => {
          const s = state?.clients.find(x => x.companyId === c.id)
          return <li key={c.id}>
            <button className="mon-client-name" onClick={() => onOpen(c.id)}><strong>{c.name}</strong><span>{money(c.creditLine!.limit)} · {share(c)}% drawn</span></button>
            <MonitorStatus status={s} />
            <span className="cell-subtext">{s?.lastCheck ? 'Checked ' + when(s.lastCheck) + (s.nextCheck ? ' · next ' + when(s.nextCheck).split(', ')[1] : '') : s?.queued ? 'Queued' : 'Waiting for the first check'}</span>
            {s?.results && Object.keys(s.results).length > 0 && <ul className="mon-results">{Object.entries(s.results).map(([k, v]) => <li key={k}><span>{k === 'anaf' ? 'ANAF' : k === 'web' ? 'News' : 'Credit line'}</span>{v}</li>)}</ul>}
            <div className="mon-client-actions"><button className="text-button" onClick={async () => { await checkNow(c.id); refresh() }} disabled={s?.checking || s?.queued}><RefreshCw size={12} />Check now</button>
              <button className="text-button" onClick={() => research(c.id)} disabled={researching === c.id}>{researching === c.id ? <><LoaderCircle size={12} className="spin" />Searching…</> : <><Globe2 size={12} />Search the web</>}</button></div>
          </li>
        })}</ul>
      </aside>
    </div>
  </div>
}

/** On a client's company page: the credit line and what monitoring found. */
export function ClientPanel({ company, latest, toast }: { company: Company; latest: AssessmentSummary | null; toast: (s: string) => void }) {
  const { state, refresh } = useMonitoring()
  const [researching, setResearching] = useState(false)
  const line = company.creditLine!
  const status = state?.clients.find(c => c.companyId === company.id)
  const events = (state?.events ?? []).filter(e => e.companyId === company.id && e.title !== 'checked').slice(0, 6)
  const m = latest?.digest?.metrics
  const covenant = (label: string, value: number | null | undefined, limit: number, max = false) =>
    <div className={value == null ? '' : (max ? value > limit : value < limit) ? 'breach' : 'met'}><dt>{label}</dt><dd>{value == null ? '—' : ratio(value)}<small>{max ? 'max ' : 'min '}{ratio(limit)}</small></dd></div>
  return <section className="panel client-panel">
    <div className="side-card-head"><h2>Credit line {line.facilityId}</h2><MonitorStatus status={status} /></div>
    <div className="client-facts">
      <dl><div><dt>Approved</dt><dd>{money(line.limit)}<small>{line.approvedAt} · {line.approvedBy}</small></dd></div><div><dt>Drawn</dt><dd>{money(line.drawn)}<small>{share(company)}% of the limit</small></dd></div>
        <div><dt>Term</dt><dd>{line.startDate} → {line.maturity}<small>{line.termMonths} months · {(line.rate * 100).toFixed(2)}%</small></dd></div><div><dt>Relationship manager</dt><dd>{line.relationshipManager}<small>review {line.nextReview}</small></dd></div></dl>
      <dl className="client-covenants">{covenant('DSCR', m?.dscr, line.covenants.dscrMin)}{covenant('Debt / EBITDA', m?.leverage, line.covenants.leverageMax, true)}{covenant('Liquidity', m?.liquidity, line.covenants.liquidityMin)}</dl>
      {!latest && <p className="side-card-warn"><CircleAlert size={14} />Not assessed yet: covenants are checked against the latest assessment. Run one above.</p>}
    </div>
    <div className="client-feed-head"><h3>Live monitoring</h3><span>{status?.lastCheck ? 'checked ' + when(status.lastCheck) : 'first check pending'}</span>
      <button className="text-button" onClick={async () => { await checkNow(company.id); refresh() }}><RefreshCw size={12} />Check now</button>
      <button className="text-button" onClick={async () => { setResearching(true); try { toast((await researchClient(company.id)).result); refresh() } catch (e: any) { toast(e.message) } finally { setResearching(false) } }} disabled={researching}>{researching ? <><LoaderCircle size={12} className="spin" />Searching…</> : <><Globe2 size={12} />Search the web</>}</button></div>
    {events.length ? <ol className="feed feed-compact">{events.map(e => <EventRow key={e.id} event={e} company={company} onChange={refresh} toast={toast} />)}</ol> : <p className="side-card-empty">No monitoring events yet.</p>}
  </section>
}
