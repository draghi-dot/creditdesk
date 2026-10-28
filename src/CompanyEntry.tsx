import { useEffect, useState } from 'react'
import { ArrowRight, ChevronLeft, ChevronRight, CircleAlert, FileSearch, FileText, History, Lightbulb, LoaderCircle, PlayCircle, Radio } from 'lucide-react'
import type { AssessmentSummary, FindingView } from './assessment'
import { REQUIRED_DOCUMENTS, ROLES, foldAll, rankFindings } from './assessment'
import type { Company } from './types'
import type { Case, CompanyRequest, Contact, GmailState, SuggestionSet } from './workspace'
import { caseStatusLabels, departmentName } from './workspace'
import { money } from './analysis'
import { Badge, Button, CompanyMark } from './components'
import { ImpactTag } from './AssessmentUI'
import type { EngineHealth } from './runs'
import { duration, getRun, when } from './runs'
import { DossierDocuments, MissingDocuments, useDossier } from './DossierDocuments'
import { draftCompanyRequest, getSuggestions, listRequests, makeSuggestions, useCases } from './people'
import { ContactsCard, DraftRequestButton, RequestList } from './Requests'
import { SendToDepartment, StatusChip } from './Departments'
import './assessment.css'

const statusLabel: Record<AssessmentSummary['status'], string> = { created: 'Starting', running: 'In progress', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled' }

/**
 * A company's page: its documents (missing ones first), the two assessment
 * actions, the problems of the latest assessment with what to do about each,
 * and the people side: contacts, cases and requests to the company.
 */
export default function CompanyEntry({ company, runs, health, offline, starting, onBack, onView, onLive, onRun, onCase, toast, gmail }: {
  company: Company; runs: AssessmentSummary[]; health: EngineHealth | null; offline: boolean; starting: boolean
  onBack: () => void; onView: (runId: string) => void; onLive: (runId: string) => void; onRun: () => void; onCase: (id: string) => void; toast: (s: string) => void; gmail: GmailState | null
}) {
  const request = company.tables.solicitari[0]
  const latest = runs.find(r => r.status === 'completed') ?? null
  const active = runs.find(r => r.status === 'running' || r.status === 'created') ?? null
  const dossier = useDossier(company.id)
  const { cases, refresh: refreshCases } = useCases({ company: company.id })
  const [problems, setProblems] = useState<FindingView[] | null>(null)
  const [contacts, setContacts] = useState<Contact[]>([])
  const [requests, setRequests] = useState<CompanyRequest[]>([])
  const loadRequests = () => listRequests(company.id).then(setRequests).catch(() => {})
  useEffect(() => { loadRequests() }, [company.id])
  useEffect(() => {
    if (!latest) { setProblems([]); return }
    getRun(latest.runId).then(r => { const view = foldAll(latest.runId, r.events); setProblems(rankFindings(view.findings, view.decision)) }).catch(() => setProblems([]))
  }, [latest?.runId])
  const model = health?.provider.id === 'codex' ? 'Codex ' + health.provider.model : null
  const open = (cases ?? []).filter(c => c.status !== 'resolved')
  return <div className="company-page entry-page page-enter">
    <div className="dossier-breadcrumb"><button onClick={onBack}><ChevronLeft size={14} />Companies</button><ChevronRight size={12} /><span>{company.id}</span></div>
    <div className="entry-header">
      <CompanyMark company={company} large />
      <div className="entry-identity"><div className="company-title-line"><h1>{company.name}</h1><span className="ticker-tag">{company.symbol}</span></div>
        <p>{company.sector}<span className="inline-dot">·</span>CUI {company.cui}<span className="inline-dot">·</span>{company.city || 'Romania'}</p></div>
      <dl className="entry-request">
        <div><dt>Requested</dt><dd>{money(request.suma_solicitata)}</dd></div>
        <div><dt>Term</dt><dd>{request.durata_luni} months</dd></div>
        <div><dt>Facility</dt><dd>{String(request.tip_facilitate).replaceAll('_', ' ').replace(/^./, c => c.toUpperCase())}</dd></div>
        <div><dt>Documents</dt><dd className={dossier.state?.missing.length ? 'text-red' : ''}>{dossier.state ? (REQUIRED_DOCUMENTS.length - dossier.state.missing.length) + ' of ' + REQUIRED_DOCUMENTS.length : company.tables.documente.length + ' PDFs'}</dd></div>
      </dl>
    </div>

    {offline && <div className="entry-offline"><CircleAlert size={16} /><div><strong>The assessment engine is not running.</strong><span>Start the workspace with <code>npm run dev</code> (or <code>npm start</code> after a build) to view or run assessments.</span></div></div>}
    {!offline && dossier.state && <MissingDocuments company={company} state={dossier.state} onAdded={dossier.reload} onRunNew={onRun} />}

    <div className="entry-actions">
      <section className={'entry-choice' + (latest ? '' : ' entry-choice-empty')}>
        <div className="entry-choice-icon"><FileSearch size={20} /></div>
        <h2>View assessment</h2>
        {latest ? <>
          <p>The latest completed assessment: problems, the original pages they are on, every policy check and the report.</p>
          <div className="entry-latest"><Badge decision={latest.decision!} /><span>{when(latest.endedAt!)}</span><span>{latest.findings} {latest.findings === 1 ? 'problem' : 'problems'}</span>{latest.startedBy && <span>run by {latest.startedBy}</span>}</div>
          <Button variant="dark" onClick={() => onView(latest.runId)}>View assessment<ArrowRight size={15} /></Button>
        </> : <>
          <p><strong>Not assessed yet.</strong> {runs.length ? 'Earlier runs did not complete.' : 'No assessment has been run for this company.'} Run one to review its documents.</p>
          <Button disabled>View assessment</Button>
        </>}
      </section>
      <section className="entry-choice entry-choice-primary">
        <div className="entry-choice-icon"><PlayCircle size={20} /></div>
        <h2>Run new assessment</h2>
        <p>{ROLES.length} checks read the {company.tables.documente.length} original documents. Results and problems appear as they come in.</p>
        <ul className="entry-run-facts">
          <li><FileText size={12} />{model ? model + ' reads the contract and writes the report' : 'Without a model: the checks run, the engine writes the report'}</li>
          <li><Radio size={12} />ANAF public register lookup for CUI {company.cui}</li>
        </ul>
        {active ? <Button variant="primary" onClick={() => onLive(active.runId)}><LoaderCircle size={15} className="spin" />Assessment in progress · open it</Button>
          : <Button variant="primary" onClick={onRun} disabled={starting || offline}>{starting ? 'Starting…' : 'Run new assessment'}<ArrowRight size={15} /></Button>}
      </section>
    </div>

    <div className="entry-layout">
      <div className="entry-main">
        {latest && problems && <ProblemsPanel company={company} runId={latest.runId} problems={problems} cases={cases ?? []} onCase={onCase} onCasesChange={refreshCases} onView={() => onView(latest.runId)} contacts={contacts} onDrafted={() => { loadRequests(); toast('Draft ready under Requests to the company') }} toast={toast} />}
        {!offline && <DossierDocuments company={company} state={dossier.state} reload={dossier.reload} onRunNew={onRun} since={latest?.createdAt ?? null} />}
        <section className="panel entry-history">
          <div className="entry-history-heading"><History size={15} /><h2>Assessment history</h2><span>{runs.length ? runs.length + (runs.length === 1 ? ' run' : ' runs') + ', all kept' : 'No runs yet'}</span></div>
          {runs.length ? <table className="entry-history-table"><thead><tr><th>Started</th><th>By</th><th>Status</th><th>Outcome</th><th>Problems</th><th>Duration</th><th>Model</th><th /></tr></thead><tbody>
            {runs.map(r => <tr key={r.runId} onClick={() => r.status === 'completed' ? onView(r.runId) : onLive(r.runId)}>
              <td>{when(r.createdAt)}</td><td>{r.startedBy ?? '—'}</td><td><span className={'run-status-chip status-' + r.status}>{statusLabel[r.status]}</span></td>
              <td>{r.decision && r.status === 'completed' ? <Badge decision={r.decision} small /> : <span className="text-muted">—</span>}</td><td>{r.findings}</td>
              <td>{r.endedAt ? duration(r.createdAt, r.endedAt) : '—'}</td><td>{r.provider.id === 'codex' ? r.provider.model : 'none'}</td><td><ChevronRight size={15} /></td></tr>)}
          </tbody></table> : <p className="entry-history-empty"><FileText size={15} />Every assessment run for this company is listed here and kept.</p>}
        </section>
      </div>
      <aside className="entry-side">
        <ContactsCard company={company} onChange={setContacts} />
        <section className="panel side-card">
          <div className="side-card-head"><h2>Cases</h2><span className="side-card-count">{open.length} open</span></div>
          {(cases ?? []).length ? <ul className="case-mini">{(cases ?? []).map(c => <li key={c.id}><button onClick={() => onCase(c.id)}><span className="case-ref">{c.ref}</span><div><strong>{c.title}</strong><span>{departmentName(c.department)}{c.assignee ? ' · ' + c.assignee : ''}</span></div><StatusChip status={c.status} /></button></li>)}</ul>
            : <p className="side-card-empty">No problem has been sent to a department.</p>}
        </section>
        <section className="panel side-card">
          <div className="side-card-head"><h2>Requests to the company</h2></div>
          <RequestList key={requests.map(r => r.id + r.status).join()} requests={requests} gmail={gmail} onChange={() => loadRequests()} toast={toast} />
        </section>
      </aside>
    </div>
  </div>
}

/** The latest assessment's problems with what to do about each: the department to send it to and what to ask of the company. */
function ProblemsPanel({ company, runId, problems, cases, onCase, onCasesChange, onView, contacts, onDrafted, toast }: {
  company: Company; runId: string; problems: FindingView[]; cases: Case[]; onCase: (id: string) => void; onCasesChange: () => void; onView: () => void
  contacts: Contact[]; onDrafted: () => void; toast: (s: string) => void
}) {
  const [suggestions, setSuggestions] = useState<SuggestionSet | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => { getSuggestions(company.id).then(s => setSuggestions(s && s.runId === runId ? s : null)).catch(() => {}) }, [company.id, runId])
  const suggest = async () => { setBusy(true); try { setSuggestions(await makeSuggestions(company.id)) } catch (e: any) { toast(e.message) } finally { setBusy(false) } }
  const caseFor = (f: FindingView) => cases.find(c => c.status !== 'resolved' && c.finding?.id === f.id && c.finding?.title === f.title) ?? null
  if (!problems.length) return <section className="panel problems-panel"><div className="side-card-head"><h2>Problems in the latest assessment</h2></div><p className="side-card-empty">None. Every document reconciled and every policy check passed.</p></section>
  return <section className="panel problems-panel">
    <div className="side-card-head"><h2>Problems in the latest assessment</h2>
      <div className="side-card-actions"><Button small onClick={suggest} disabled={busy}><Lightbulb size={13} />{busy ? 'Thinking…' : suggestions ? 'Suggest again' : 'Suggest next steps'}</Button>
        <DraftRequestButton small label="Draft request for all" contacts={contacts} draft={o => draftCompanyRequest(company.id, o)} onDrafted={onDrafted} /></div></div>
    {suggestions && <p className="problems-note">Suggestions by {suggestions.author.startsWith('Codex') ? 'the assistant (' + suggestions.author + ')' : 'the engine, from the recorded findings'} · {when(suggestions.createdAt)}{suggestions.unsupported.length ? ' · check figures: ' + suggestions.unsupported.join(', ') : ''}</p>}
    <ol className="problems-mini">{problems.map((f, i) => {
      const s = suggestions?.items.find(x => x.findingId === f.id)
      const existing = caseFor(f)
      return <li key={f.id}>
        <span className="problem-rank">{i + 1}</span>
        <div className="problem-mini-body">
          <div className="problem-top"><ImpactTag impact={f.impact} /><strong>{f.title}</strong></div>
          {s ? <dl className="suggestion"><div><dt>Note for {departmentName(s.department)}</dt><dd>{s.comment}</dd></div>{s.requirement && <div><dt>Ask the company</dt><dd>{s.requirement}</dd></div>}</dl> : <p>{f.observed}</p>}
          {existing && <span className="problem-case">Case {existing.ref} · {caseStatusLabels[existing.status]}{existing.assignee ? ' · ' + existing.assignee : ''}</span>}
        </div>
        <div className="problem-actions"><SendToDepartment small companyId={company.id} runId={runId} finding={f} existing={existing} onSent={c => { onCasesChange(); toast('Sent to ' + departmentName(c.department) + ' as case ' + c.ref) }} onOpen={c => onCase(c.id)} /><button className="problem-open" onClick={onView}>Open<ArrowRight size={13} /></button></div>
      </li>
    })}</ol>
  </section>
}

