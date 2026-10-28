import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { ArrowRight, ChevronLeft, ChevronRight, CircleAlert, FileText, LoaderCircle, Plus, Send, UserPlus, Users } from 'lucide-react'
import type { Company } from './types'
import type { Finding } from './assessment'
import type { Case, CaseEvent, CaseStatus, CompanyRequest, Contact, DepartmentId, User } from './workspace'
import { DEPARTMENTS, caseStatusLabels, departmentFor, departmentName } from './workspace'
import { Button, Dialog } from './components'
import { EvidenceViewer, ImpactTag, emphasize } from './AssessmentUI'
import { when } from './runs'
import type { Session } from './people'
import { addUser, commentCase, draftCaseRequest, getCase, openCase, updateCase, useCases, writeCaseReport } from './people'
import { ContactsCard, DraftRequestButton, RequestList, SendChecklist } from './Requests'

const STATUSES: CaseStatus[] = ['open', 'in_progress', 'waiting', 'resolved']

export function StatusChip({ status }: { status: CaseStatus }) {
  return <span className={'case-status case-' + status}>{caseStatusLabels[status]}</span>
}

/** Send a problem to a department; the department that usually handles it is chosen already. */
export function SendToDepartment({ companyId, runId, finding, existing, onSent, onOpen, small }: {
  companyId: string; runId: string; finding: Finding; existing?: Case | null; onSent: (c: Case) => void; onOpen: (c: Case) => void; small?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [department, setDepartment] = useState<DepartmentId>(departmentFor(finding))
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  if (existing) return <button className={'sent-to' + (small ? ' sent-to-small' : '')} onClick={() => onOpen(existing)} title="Open the case">{existing.ref} · {departmentName(existing.department)} · {caseStatusLabels[existing.status]}<ChevronRight size={12} /></button>
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError('')
    try { const { case: c } = await openCase({ companyId, runId, findingId: finding.id, department, note: note.trim() || undefined }); setOpen(false); onSent(c) }
    catch (err: any) { setError(err.message) } finally { setBusy(false) }
  }
  return <>
    <Button small={small} onClick={e => { e.stopPropagation(); setOpen(true) }}><Send size={13} />Send to {departmentName(departmentFor(finding))}</Button>
    {open && <Dialog title="Send this problem to a department" description={finding.title} onClose={() => !busy && setOpen(false)}>
      <form onSubmit={submit}><div className="form-content">
        <fieldset className="department-choice"><legend>Department</legend>{DEPARTMENTS.map(d => <label key={d.id} className={department === d.id ? 'checked' : ''}><input type="radio" name="department" value={d.id} checked={department === d.id} onChange={() => setDepartment(d.id)} /><strong>{d.name}{d.id === departmentFor(finding) && <em>usual for this problem</em>}</strong><span>{d.handles}</span></label>)}</fieldset>
        <label className="field-label">Note for the department (optional)<textarea rows={3} value={note} onChange={e => setNote(e.target.value)} placeholder="What should they look at first?" /></label>
        {error && <p className="form-error"><CircleAlert size={14} />{error}</p>}
      </div><div className="dialog-actions"><Button type="button" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button><Button variant="primary" type="submit" disabled={busy}>{busy ? 'Sending…' : 'Send to ' + departmentName(department)}</Button></div></form>
    </Dialog>}
  </>
}

/** Each department's cases and people. */
export default function Departments({ department, session, onDepartment, onCase, onSessionChange, toast }: {
  department: DepartmentId; session: Session | null; onDepartment: (d: DepartmentId) => void; onCase: (id: string) => void; onSessionChange: () => void; toast: (s: string) => void
}) {
  const { cases: all, refresh } = useCases({})
  const [filter, setFilter] = useState<'active' | CaseStatus | 'all'>('active')
  const [mine, setMine] = useState(false)
  const [adding, setAdding] = useState(false)
  const me = session?.user
  const info = DEPARTMENTS.find(d => d.id === department)!
  const inDepartment = (all ?? []).filter(c => c.department === department)
  const shown = inDepartment.filter(c => (filter === 'all' || (filter === 'active' ? c.status !== 'resolved' : c.status === filter)) && (!mine || c.assignee === me?.name))
  const people = (session?.users ?? []).filter(u => u.department === department)
  useEffect(() => { refresh() }, [department])
  return <div className="page-enter departments-page">
    <div className="page-heading"><div><h1>Departments</h1><p className="page-subtitle">Problems sent from assessments, and the people who handle them.</p></div></div>
    <div className="department-tabs" role="tablist">{DEPARTMENTS.map(d => {
      const open = (all ?? []).filter(c => c.department === d.id && c.status !== 'resolved').length
      return <button key={d.id} role="tab" aria-selected={d.id === department} className={d.id === department ? 'active' : ''} onClick={() => onDepartment(d.id)}>{d.name}<span>{open}</span>{me?.department === d.id && <em>yours</em>}</button>
    })}</div>
    <div className="department-layout">
      <section className="panel">
        <div className="case-toolbar"><div className="segmented">{(['active', 'open', 'in_progress', 'waiting', 'resolved', 'all'] as const).map(s => <button key={s} className={filter === s ? 'active' : ''} onClick={() => setFilter(s)}>{s === 'active' ? 'Not resolved' : s === 'all' ? 'All' : caseStatusLabels[s]}</button>)}</div>
          <label className="check-toggle"><input type="checkbox" checked={mine} onChange={e => setMine(e.target.checked)} />Assigned to me</label></div>
        {all === null ? <div className="panel-loading"><LoaderCircle size={16} className="spin" />Loading cases…</div>
          : shown.length ? <table className="case-table"><thead><tr><th>Case</th><th>Problem</th><th>Status</th><th>Assigned</th><th>Updated</th><th /></tr></thead><tbody>{shown.map(c => <tr key={c.id} onClick={() => onCase(c.id)}>
            <td className="case-ref">{c.ref}</td><td><strong>{c.title}</strong><span>{c.companyName} · sent by {c.createdBy}</span></td><td><StatusChip status={c.status} /></td><td>{c.assignee ?? <span className="text-muted">Not assigned</span>}</td><td>{when(c.updatedAt)}</td><td><ChevronRight size={15} /></td></tr>)}</tbody></table>
          : <div className="case-empty"><FileText size={20} /><strong>{inDepartment.length ? 'No cases match this filter.' : 'No problems have been sent to ' + info.name + ' yet.'}</strong><p>Open an assessment and use <em>Send to {info.name}</em> on a problem.</p></div>}
      </section>
      <aside className="panel side-card department-people">
        <div className="side-card-head"><h2><Users size={15} />{info.name}</h2><button className="text-button" onClick={() => setAdding(true)}><UserPlus size={14} />Add employee</button></div>
        <p className="side-card-note">{info.handles}.</p>
        <ul className="people-list">{people.map(u => <li key={u.id}><span className="user-avatar">{u.initials}</span><div><strong>{u.name}{u.id === me?.id && <em>you</em>}</strong><span>{u.title}</span></div><span className="people-count">{inDepartment.filter(c => c.assignee === u.name && c.status !== 'resolved').length || ''}</span></li>)}</ul>
      </aside>
    </div>
    {adding && <AddEmployee department={department} onClose={() => setAdding(false)} onAdded={u => { setAdding(false); onSessionChange(); toast(u.name + ' added to ' + departmentName(u.department)) }} />}
  </div>
}

function AddEmployee({ department, onClose, onAdded }: { department: DepartmentId; onClose: () => void; onAdded: (u: User) => void }) {
  const [form, setForm] = useState({ name: '', title: '', department })
  const [error, setError] = useState('')
  const submit = async (e: FormEvent) => { e.preventDefault(); try { onAdded(await addUser(form)) } catch (err: any) { setError(err.message) } }
  return <Dialog title="Add an employee" onClose={onClose}><form onSubmit={submit}><div className="form-content form-grid">
    <label className="field-label">Name<input required minLength={2} autoFocus value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></label>
    <label className="field-label">Job title<input value={form.title} placeholder="e.g. Legal advisor" onChange={e => setForm({ ...form, title: e.target.value })} /></label>
    <label className="field-label">Department<select value={form.department} onChange={e => setForm({ ...form, department: e.target.value as DepartmentId })}>{DEPARTMENTS.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
    {error && <p className="form-error"><CircleAlert size={14} />{error}</p>}
  </div><div className="dialog-actions"><Button type="button" onClick={onClose}>Cancel</Button><Button variant="primary" type="submit"><Plus size={14} />Add employee</Button></div></form></Dialog>
}

const eventText = (e: CaseEvent): string => {
  switch (e.kind) {
    case 'opened': return 'sent this problem to ' + departmentName(e.data?.department)
    case 'status': return 'changed the status to ' + caseStatusLabels[e.data.to as CaseStatus]
    case 'assigned': return e.data.to ? 'assigned the case to ' + e.data.to : 'removed the assignee'
    case 'moved': return 'moved the case from ' + departmentName(e.data.from) + ' to ' + departmentName(e.data.to)
    case 'contact': return 'looked up the company contact'
    case 'request': return e.author === 'Assistant' ? 'suggested an email to the company' : 'drafted a request to the company' + (String(e.data?.author ?? '').startsWith('Codex') ? ' with the assistant' : '')
    case 'email': return e.data?.test ? 'sent a test copy of the request to ' + e.data.deliveredTo : 'sent the request to ' + (e.data?.to?.name || e.data?.to?.email)
    case 'report': return 'wrote a case report' + (String(e.data?.author ?? '').startsWith('Codex') ? ' with the assistant' : '')
    default: return 'commented'
  }
}

/** One case: the problem with its evidence, the timeline, and requests to the company. */
export function CasePage({ caseId, companies, session, onCompany, onDepartment, toast, onChange }: {
  caseId: string; companies: Company[]; session: Session | null; onCompany: (id: string) => void; onDepartment: (d: DepartmentId) => void; toast: (s: string) => void; onChange: () => void
}) {
  const [data, setData] = useState<{ case: Case; events: CaseEvent[]; requests: CompanyRequest[]; assistant: string | null } | null>(null)
  const [error, setError] = useState('')
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [contacts, setContacts] = useState<Contact[]>([])
  const load = () => getCase(caseId).then(setData).catch(e => setError(e.message))
  useEffect(() => { load() }, [caseId])
  // While the assistant finds the contact and writes the email, follow it.
  useEffect(() => { if (!data?.assistant) return; const id = window.setInterval(load, 2500); return () => window.clearInterval(id) }, [data?.assistant])
  const company = useMemo(() => companies.find(c => c.id === data?.case.companyId), [data?.case.companyId, companies])
  if (error) return <div className="empty-state"><h2>Case not found</h2><p>{error}</p></div>
  if (!data || !company) return <div className="run-loading"><LoaderCircle size={20} className="spin" />Loading the case…</div>
  const c = data.case
  const f = c.finding
  const members = (session?.users ?? []).filter(u => u.department === c.department)
  const change = async (patch: Parameters<typeof updateCase>[1]) => { await updateCase(c.id, patch); await load(); onChange() }
  const act = async (name: string, run: () => Promise<unknown>) => { setBusy(name); try { await run(); await load(); onChange() } catch (e: any) { toast(e.message) } finally { setBusy(null) } }
  const report = [...data.events].reverse().find(e => e.kind === 'report')
  return <div className="page-enter case-page">
    <div className="dossier-breadcrumb"><button onClick={() => onDepartment(c.department)}><ChevronLeft size={14} />{departmentName(c.department)}</button><ChevronRight size={12} /><span>Case {c.ref}</span></div>
    <header className="case-header">
      <div><h1><span className="case-ref">{c.ref}</span>{c.title}</h1>
        <p><button className="link-button" onClick={() => onCompany(company.id)}>{company.name}</button> · sent by {c.createdBy} · {when(c.createdAt)}{f && <> · <ImpactTag impact={f.impact} /></>}</p></div>
      <div className="case-controls">
        <label>Status<select value={c.status} onChange={e => change({ status: e.target.value as CaseStatus })}>{STATUSES.map(s => <option key={s} value={s}>{caseStatusLabels[s]}</option>)}</select></label>
        <label>Assigned to<select value={members.find(u => u.name === c.assignee)?.id ?? ''} onChange={e => change({ assignee: e.target.value || null })}><option value="">Not assigned</option>{members.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
        <label>Department<select value={c.department} onChange={e => change({ department: e.target.value as DepartmentId })}>{DEPARTMENTS.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
        {session && c.assignee !== session.user.name && session.user.department === c.department && <Button small onClick={() => change({ assignee: session.user.id, ...(c.status === 'open' ? { status: 'in_progress' } : {}) })}>Take this case</Button>}
      </div>
    </header>
    <div className="case-layout">
      <div className="case-main">
        {f && <section className="panel case-problem">
          <dl className="finding-facts"><div><dt>Observed</dt><dd>{emphasize(f.observed)}</dd></div><div><dt>Compared against</dt><dd>{emphasize(f.comparedAgainst)}</dd></div><div><dt>Why it matters</dt><dd>{f.whyItMatters}</dd></div><div><dt>Effect</dt><dd>{f.effect}</dd></div></dl>
          {f.evidence.length > 0 && <div className="case-evidence"><EvidenceViewer companyId={company.id} evidence={f.evidence} title={f.title} /></div>}
          {c.runId && <button className="text-button" onClick={() => { window.location.hash = '/companies/' + company.id + '/assessment/' + c.runId }}>Open the assessment<ArrowRight size={14} /></button>}
        </section>}
        <section className="panel case-timeline">
          <div className="side-card-head"><h2>Timeline</h2><Button small onClick={() => act('report', () => writeCaseReport(c.id))} disabled={!!busy}>{busy === 'report' ? 'Writing…' : 'Write case report'}</Button></div>
          {report && <article className="case-report"><h3>{report.data.report.title}</h3>{report.data.report.paragraphs.map((p: string, i: number) => <p key={i}>{emphasize(p)}</p>)}<footer>{report.author} · {when(report.ts)}{report.data.unsupported?.length ? <span className="note-flag"><CircleAlert size={11} />Check figures: {report.data.unsupported.join(', ')}</span> : null}</footer></article>}
          <ol className="timeline">{data.events.map(e => <li key={e.id} className={'tl-' + e.kind}><span className="tl-dot" /><div><p><strong>{e.author}</strong> {eventText(e)}<time>{when(e.ts)}</time></p>{e.text && e.kind !== 'status' && e.kind !== 'assigned' && e.kind !== 'report' && <blockquote>{e.text}</blockquote>}</div></li>)}</ol>
          <form className="comment-form" onSubmit={e => { e.preventDefault(); if (comment.trim()) act('comment', async () => { await commentCase(c.id, comment.trim()); setComment('') }) }}>
            <textarea rows={2} value={comment} onChange={e => setComment(e.target.value)} placeholder={'Comment as ' + (session?.user.name ?? 'you') + '…'} aria-label="Comment" />
            <Button small variant="primary" type="submit" disabled={!comment.trim() || !!busy}>Comment</Button>
          </form>
        </section>
      </div>
      <aside className="case-side">
        <ContactsCard company={company} onChange={setContacts} reloadKey={data.events.filter(e => e.kind === 'contact').length} />
        <section className="panel side-card">
          <div className="side-card-head"><h2>Requests to the company</h2><DraftRequestButton small label={data.requests.length ? 'Write another' : 'Draft request'} contacts={contacts} draft={o => draftCaseRequest(c.id, o)} onDrafted={() => { load(); onChange() }} /></div>
          {data.assistant && <p className="assistant-working"><LoaderCircle size={13} className="spin" />{data.assistant}…</p>}
          <SendChecklist contacts={contacts} gmail={session?.gmail ?? null} requests={data.requests} assistant={data.assistant} />
          <RequestList key={data.requests.map(r => r.id + r.status).join()} requests={data.requests} gmail={session?.gmail ?? null} onChange={() => load()} toast={toast} />
        </section>
      </aside>
    </div>
  </div>
}
