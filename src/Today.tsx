import { useEffect, useMemo, useState } from 'react'
import { Activity, AlertTriangle, ArrowRight, CalendarClock, Check, ChevronRight, CircleAlert, FileWarning, Gavel, Inbox, Mail, Play, Scale, UserCheck } from 'lucide-react'
import type { Company, Decision } from './types'
import type { AssessmentDigest, AssessmentSummary } from './assessment'
import type { ActivityEvent, CompanyRequest, DepartmentId, User } from './workspace'
import { caseStatusLabels, departmentName } from './workspace'
import { decisionLabels, money, ratio } from './analysis'
import { docNames } from './documents'
import { sourceLabels } from './monitoring'
import { listAllRequests, useCases, useMonitoring } from './people'

/**
 * The employee's day: what is theirs to do, ranked, then where the
 * applications and the credit book stand, and what changed since yesterday.
 * Everything here comes from records the engine keeps; nothing is estimated.
 */

type Tone = 'red' | 'amber' | 'blue' | 'green' | 'gray'
interface Task { id: string; rank: number; tone: Tone; icon: typeof Inbox; tag: string; title: string; company?: string; why: string; action: string; route: string }

const DAY = 86_400_000
const ago = (iso: string) => { const d = Math.floor((Date.now() - Date.parse(iso)) / DAY); return d <= 0 ? 'today' : d === 1 ? 'yesterday' : d + ' days ago' }
const daysUntil = (iso: string) => Math.ceil((Date.parse(iso) - Date.now()) / DAY)
const short = (name: string) => name.replace(/ S\.?A\.?$/, '')
/** The department a policy rule's problem belongs to, from the rule's area. */
const ruleDepartment = (id: string): DepartmentId => id.startsWith('LEG') ? 'legal' : id.startsWith('KYC') ? 'compliance' : id === 'DATA-01' ? 'credit' : 'finance'
const STAGES: { status: Decision | 'NONE'; label: string }[] = [
  { status: 'NONE', label: 'Not assessed' }, { status: 'DATE_INSUFICIENTE', label: 'Incomplete' }, { status: 'CONDITIONAT', label: 'Conditional' },
  { status: 'NEELIGIBIL', label: 'Not eligible' }, { status: 'ELIGIBIL', label: 'Eligible' },
]

export default function Today({ me, companies, clients, assessments, latest, runs, events, nav }: {
  me: User | null; companies: Company[]; clients: Company[]; assessments: Map<string, AssessmentDigest>; latest: Map<string, AssessmentSummary>
  runs: AssessmentSummary[]; events: ActivityEvent[]; nav: (route: string) => void
}) {
  const { cases } = useCases({})
  const { state: monitoring } = useMonitoring()
  const [requests, setRequests] = useState<CompanyRequest[]>([])
  const [showAll, setShowAll] = useState(false)
  useEffect(() => { listAllRequests().then(setRequests).catch(() => {}) }, [])
  const everyone = useMemo(() => new Map([...companies, ...clients].map(c => [c.id, c])), [companies, clients])
  const nameOf = (id: string) => everyone.get(id)?.name ?? id
  const dept = me?.department ?? 'credit'
  const open = (cases ?? []).filter(c => c.status !== 'resolved')
  const requested = (c: Company) => c.tables.solicitari[0].suma_solicitata

  const tasks = useMemo(() => {
    const list: Task[] = []
    // Credit clients first: a change found by monitoring is about money already lent.
    for (const e of monitoring?.events ?? []) {
      if (e.severity === 'info' || e.reviewedAt) continue
      list.push({ id: 'mon-' + e.id, rank: e.severity === 'alert' ? 10 : 20, tone: e.severity === 'alert' ? 'red' : 'amber', icon: e.severity === 'alert' ? AlertTriangle : Activity, tag: (e.severity === 'alert' ? 'Critical · ' : '') + (e.data?.simulated ? 'simulated · credit client' : 'credit client'), title: e.title, company: nameOf(e.companyId), why: sourceLabels[e.source], action: 'Review', route: '/companies/' + e.companyId })
    }
    for (const c of open) {
      if (c.assignee === me?.name && c.status !== 'waiting') list.push({ id: 'case-' + c.id, rank: 30, tone: 'blue', icon: UserCheck, tag: c.ref, title: c.title, company: c.companyName, why: 'Assigned to you · ' + caseStatusLabels[c.status] + ' · opened ' + ago(c.createdAt), action: 'Open case', route: '/cases/' + c.id })
      else if (c.department === dept && !c.assignee) list.push({ id: 'pick-' + c.id, rank: 50, tone: 'gray', icon: Inbox, tag: c.ref, title: c.title, company: c.companyName, why: 'Not assigned · ' + departmentName(c.department) + ' · opened ' + ago(c.createdAt), action: 'Pick up', route: '/cases/' + c.id })
      else if (c.department === dept && c.status === 'waiting' && Date.now() - Date.parse(c.updatedAt) > 3 * DAY) list.push({ id: 'wait-' + c.id, rank: 60, tone: 'amber', icon: CalendarClock, tag: c.ref, title: 'Follow up: ' + c.title, company: c.companyName, why: 'Waiting on the company since ' + ago(c.updatedAt), action: 'Follow up', route: '/cases/' + c.id })
    }
    // Emails the assistant drafted for this department, not sent yet.
    for (const r of requests) {
      if (r.status === 'sent') continue
      const owner = r.caseId ? (cases ?? []).find(c => c.id === r.caseId) : null
      if (r.draftedBy !== me?.name && (owner ? owner.department !== dept : dept !== 'credit')) continue
      list.push({ id: 'mail-' + r.id, rank: 40, tone: r.status === 'failed' ? 'red' : 'blue', icon: Mail, tag: r.status === 'failed' ? 'Not sent' : 'Draft', title: 'Email ' + short(nameOf(r.companyId)) + ': ' + r.subject, company: nameOf(r.companyId), why: r.status === 'failed' ? r.error ?? 'Sending failed' : 'Drafted by ' + r.draftedBy + ' · ' + ago(r.createdAt), action: 'Review & send', route: owner ? '/cases/' + owner.id : '/companies/' + r.companyId })
    }
    // Problems from the latest assessments that belong to this department and are not with anyone yet.
    for (const c of companies) {
      const digest = assessments.get(c.id)
      const run = latest.get(c.id)
      if (!digest || !run) continue
      const taken = open.some(x => x.companyId === c.id && x.department === dept)
      if (dept === 'credit') for (const kind of run.observations?.missingDocuments ?? []) list.push({ id: 'doc-' + c.id + kind, rank: 64, tone: 'red', icon: FileWarning, tag: 'Missing document', title: 'Ask for the ' + (docNames[kind] ?? kind).toLowerCase(), company: c.name, why: decisionLabels[digest.decision] + ' until it is in the dossier · ' + money(requested(c), true), action: 'Upload or request', route: '/companies/' + c.id })
      if (!taken) for (const r of digest.reasons.filter(r => ruleDepartment(r.id) === dept && r.id !== 'DATA-01').slice(0, 1)) list.push({ id: 'rule-' + c.id + r.id, rank: r.impact === 'data' ? 66 : r.impact === 'block' ? 68 : 70, tone: r.impact === 'condition' ? 'amber' : 'red', icon: dept === 'legal' ? Gavel : Scale, tag: decisionLabels[digest.decision], title: r.title, company: c.name, why: r.observed, action: 'Open', route: '/companies/' + c.id })
      if (dept === 'credit' && digest.decision === 'ELIGIBIL' && !events.some(e => e.companyId === c.id && e.action === 'Review recorded')) list.push({ id: 'decide-' + c.id, rank: 75, tone: 'green', icon: Check, tag: 'Eligible', title: 'Record a decision', company: c.name, why: 'Meets the policy · ' + money(requested(c), true) + ' · DSCR ' + ratio(digest.metrics.dscr), action: 'Open assessment', route: '/companies/' + c.id + '/assessment/' + run.runId })
    }
    const notAssessed = companies.filter(c => !assessments.has(c.id)).length
    if (notAssessed) list.push({ id: 'assess', rank: 90, tone: 'gray', icon: Play, tag: 'Applications', title: 'Assess ' + notAssessed + (notAssessed === 1 ? ' application' : ' applications'), why: 'No completed assessment yet · ' + money(companies.filter(c => !assessments.has(c.id)).reduce((n, c) => n + requested(c), 0), true) + ' requested', action: 'Open list', route: '/companies?status=NONE' })
    return list.sort((a, b) => a.rank - b.rank)
  }, [monitoring?.events, cases, requests, assessments, latest, events, me?.name, dept])

  // The applications by outcome, and the credit book.
  const stage = (s: Decision | 'NONE') => companies.filter(c => (assessments.get(c.id)?.decision ?? 'NONE') === s)
  const book = clients.map(c => c.creditLine!).filter(Boolean)
  const limit = book.reduce((n, l) => n + l.limit, 0), drawn = book.reduce((n, l) => n + l.drawn, 0)
  const statuses = monitoring?.clients ?? []
  const clientsToReview = statuses.filter(s => s.open > 0 || s.status === 'alert').length
  const lastRound = statuses.map(s => s.lastCheck).filter((x): x is string => !!x).sort().at(-1)
  const dates = clients.flatMap(c => [
    { company: c, label: 'Annual review', date: c.creditLine!.nextReview, days: daysUntil(c.creditLine!.nextReview) },
    { company: c, label: 'Matures', date: c.creditLine!.maturity, days: daysUntil(c.creditLine!.maturity) },
  ]).filter(d => d.days >= 0 && d.days <= (d.label === 'Matures' ? 365 : 60)).sort((a, b) => a.days - b.days).slice(0, 4)
  const tightest = clients.map(c => ({ c, dscr: latest.get(c.id)?.digest?.metrics.dscr ?? null, min: c.creditLine!.covenants.dscrMin })).filter(x => x.dscr != null).sort((a, b) => a.dscr! / a.min - b.dscr! / b.min).slice(0, 3)

  // What changed in the last day: employee actions, completed assessments, monitoring changes.
  const since = Date.now() - DAY
  const changes = [
    ...events.filter(e => Date.parse(e.time) > since && e.companyId !== 'workspace').map(e => ({ time: e.time, who: e.actor, text: e.action, company: e.companyId })),
    ...runs.filter(r => r.status === 'completed' && r.endedAt && Date.parse(r.endedAt) > since).map(r => ({ time: r.endedAt!, who: r.startedBy ?? 'Engine', text: 'Assessment completed · ' + (r.decision ? decisionLabels[r.decision] : ''), company: r.companyId })),
    ...(monitoring?.events ?? []).filter(e => e.severity !== 'info' && Date.parse(e.ts) > since).map(e => ({ time: e.ts, who: 'Monitoring', text: e.title, company: e.companyId })),
  ].sort((a, b) => b.time.localeCompare(a.time))

  const criticalSignals = (monitoring?.events ?? []).filter(e => e.severity === 'alert' && !e.reviewedAt)
  const hour = new Date().getHours()
  const mine = tasks.filter(t => t.rank < 90).length
  const shown = showAll ? tasks : tasks.slice(0, 8)
  return <div className="page-enter today">
    <header className="today-head">
      <div>
        <span className="today-date">{new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}</span>
        <h1>{hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'}{me ? ', ' + me.name.split(' ')[0] : ''}</h1>
        <p>{mine ? mine + (mine === 1 ? ' thing needs you' : ' things need you') : 'Nothing is waiting for you'} in {departmentName(dept)} today · {companies.length} applications and {clients.length} credit clients on the books.</p>
      </div>
    </header>

    {criticalSignals.length > 0 && <section className="risk-banner critical compact today-critical" role="alert"><span className="risk-banner-icon"><AlertTriangle size={20} /></span>
      <div className="risk-banner-main"><strong>{criticalSignals.length} critical {criticalSignals.length === 1 ? 'signal' : 'signals'} on credit clients</strong>
        <ul>{criticalSignals.slice(0, 3).map(e => <li key={e.id}><button onClick={() => nav('/companies/' + e.companyId)}>{short(nameOf(e.companyId))}: {e.title}</button></li>)}</ul></div>
      <div className="risk-banner-actions"><button className="button button-dark" onClick={() => nav('/companies/' + criticalSignals[0].companyId)}>Review the first<ArrowRight size={14} /></button></div></section>}

    <section className="today-kpis">
      <button onClick={() => nav('/companies')}><span>Applications</span><strong>{money(companies.reduce((n, c) => n + requested(c), 0), true)}</strong><small>{companies.length} requests · {stage('NONE').length} not assessed</small></button>
      <button onClick={() => nav('/companies?status=ELIGIBIL')}><span>Ready for a decision</span><strong>{stage('ELIGIBIL').length}</strong><small>{money(stage('ELIGIBIL').reduce((n, c) => n + requested(c), 0), true)} eligible</small></button>
      <button onClick={() => nav('/clients')}><span>Credit book drawn</span><strong>{money(drawn, true)}</strong><span className="kpi-bar"><i style={{ width: (limit ? drawn / limit * 100 : 0) + '%' }} /></span><small>{limit ? Math.round(drawn / limit * 100) : 0}% of {money(limit, true)} · {clients.length} clients</small></button>
      <button onClick={() => nav('/monitoring')} className={clientsToReview ? 'kpi-warn' : ''}><span>Credit clients to review</span><strong>{clientsToReview}</strong><small>{lastRound ? 'Monitoring checked ' + new Date(lastRound).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : 'Monitoring starting'}</small></button>
    </section>

    <section className="pipeline" aria-label="Applications by outcome">
      {STAGES.map(s => { const list = stage(s.status); return <button key={s.status} className={'pipe pipe-' + s.status} style={{ flexGrow: Math.max(list.length, 1) }} onClick={() => nav('/companies?status=' + s.status)} title={'Show ' + s.label.toLowerCase()}>
        <strong>{list.length}</strong><span>{s.label}</span><small>{money(list.reduce((n, c) => n + requested(c), 0), true)}</small></button> })}
    </section>

    <div className="today-layout">
      <section className="panel agenda">
        <div className="side-card-head"><h2>Your agenda</h2><span className="side-card-count">{departmentName(dept)} · most urgent first</span></div>
        {shown.length ? <ol>{shown.map(t => <li key={t.id} className={'task tone-' + t.tone}>
          <button onClick={() => nav(t.route)}>
            <span className="task-icon"><t.icon size={16} /></span>
            <div className="task-body"><div className="task-top"><span className="task-tag">{t.tag}</span>{t.company && <span className="task-company">{t.company}</span>}</div><strong>{t.title}</strong><p>{t.why}</p></div>
            <span className="task-action">{t.action}<ArrowRight size={13} /></span>
          </button>
        </li>)}</ol> : <div className="case-empty"><Check size={20} /><strong>Nothing waiting for you.</strong></div>}
        {tasks.length > 8 && <button className="routine-toggle" onClick={() => setShowAll(v => !v)}>{showAll ? 'Show fewer' : 'Show all ' + tasks.length}</button>}
      </section>

      <aside className="today-side">
        <section className="panel side-card">
          <div className="side-card-head"><h2>Credit book</h2><button className="text-button" onClick={() => nav('/clients')}>All clients<ChevronRight size={13} /></button></div>
          {dates.length ? <ul className="due-list">{dates.map(d => <li key={d.company.id + d.label}><button onClick={() => nav('/companies/' + d.company.id)}>
            <span className={'due-days' + (d.days <= 30 ? ' soon' : '')}><strong>{d.days}</strong>days</span>
            <div><strong>{short(d.company.name)}</strong><span>{d.label} · {d.date}</span></div><ChevronRight size={14} /></button></li>)}</ul>
            : <p className="side-card-empty">No review or maturity in the next 60 days.</p>}
          {tightest.length > 0 && <><h3 className="side-sub">Least covenant headroom</h3><ul className="headroom-list">{tightest.map(x => <li key={x.c.id}><span>{short(x.c.name)}</span><span className="hr-mini"><i style={{ width: Math.min(100, x.min / x.dscr! * 100) + '%' }} /></span><strong>DSCR {ratio(x.dscr)}</strong></li>)}</ul></>}
        </section>
        <section className="panel side-card">
          <div className="side-card-head"><h2>Since yesterday</h2><span className="side-card-count">{changes.length}</span></div>
          {changes.length ? <ul className="since-list">{changes.slice(0, 7).map((c, i) => <li key={i}><time>{new Date(c.time).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</time><div><strong>{c.text}</strong><span>{short(nameOf(c.company))} · {c.who}</span></div></li>)}</ul>
            : <p className="side-card-empty">Nothing changed in the last 24 hours.</p>}
          {changes.length > 7 && <button className="text-button side-more" onClick={() => nav('/audit')}>{changes.length - 7} more in the audit trail<ChevronRight size={13} /></button>}
        </section>
        {open.filter(c => c.department === dept).length > 0 && <section className="panel side-card">
          <div className="side-card-head"><h2>{departmentName(dept)} cases</h2><button className="text-button" onClick={() => nav('/departments/' + dept)}>Open<ChevronRight size={13} /></button></div>
          <div className="dept-counts">{(['open', 'in_progress', 'waiting'] as const).map(s => <div key={s}><strong>{open.filter(c => c.department === dept && c.status === s).length}</strong><span>{caseStatusLabels[s]}</span></div>)}</div>
        </section>}
        {!me && <p className="side-card-empty"><CircleAlert size={13} />Signed-in employee unknown: showing the Credit agenda.</p>}
      </aside>
    </div>
  </div>
}
