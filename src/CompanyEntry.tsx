import { ArrowRight, ChevronLeft, ChevronRight, CircleAlert, FileSearch, FileText, History, LoaderCircle, PlayCircle, Radio, Sparkles } from 'lucide-react'
import type { AssessmentSummary } from './assessment'
import { ROLES } from './assessment'
import type { Company } from './types'
import { decisionLabels, money } from './analysis'
import { Badge, Button, CompanyMark } from './components'
import type { EngineHealth } from './runs'
import { duration, when } from './runs'
import { DossierDocuments } from './DossierDocuments'
import './assessment.css'

const statusLabel: Record<AssessmentSummary['status'], string> = { created: 'Starting', running: 'In progress', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled' }

export default function CompanyEntry({ company, runs, health, offline, starting, onBack, onView, onLive, onRun }: {
  company: Company; runs: AssessmentSummary[]; health: EngineHealth | null; offline: boolean; starting: boolean
  onBack: () => void; onView: (runId: string) => void; onLive: (runId: string) => void; onRun: () => void
}) {
  const request = company.tables.solicitari[0]
  const latest = runs.find(r => r.status === 'completed') ?? null
  const active = runs.find(r => r.status === 'running' || r.status === 'created') ?? null
  const documents = company.tables.documente.length
  const model = health?.provider.id === 'codex' ? 'Codex ' + health.provider.model + ' (' + health.provider.effort + ')' : null
  return <div className="company-page entry-page page-enter">
    <div className="dossier-breadcrumb"><button onClick={onBack}><ChevronLeft size={14} />Company dossiers</button><ChevronRight size={12} /><span>{company.id}</span></div>
    <div className="entry-header">
      <CompanyMark company={company} large />
      <div className="entry-identity"><div className="company-title-line"><h1>{company.name}</h1><span className="ticker-tag">{company.symbol}</span></div>
        <p>{company.sector}<span className="inline-dot">·</span>CUI {company.cui}<span className="inline-dot">·</span>{company.city || 'Romania'}</p></div>
      <dl className="entry-request">
        <div><dt>Requested</dt><dd>{money(request.suma_solicitata)}</dd></div>
        <div><dt>Term</dt><dd>{request.durata_luni} months</dd></div>
        <div><dt>Facility</dt><dd>{String(request.tip_facilitate).replaceAll('_', ' ').replace(/^./, c => c.toUpperCase())}</dd></div>
        <div><dt>Dossier</dt><dd>{documents} original PDFs</dd></div>
      </dl>
    </div>

    {offline && <div className="entry-offline"><CircleAlert size={16} /><div><strong>The assessment engine is not running.</strong><span>Start the workspace with <code>npm run dev</code> (or <code>npm start</code> after a build) to view or run assessments.</span></div></div>}

    <div className="entry-actions">
      <section className={'entry-choice' + (latest ? '' : ' entry-choice-empty')}>
        <div className="entry-choice-icon"><FileSearch size={20} /></div>
        <h2>View assessment</h2>
        {latest ? <>
          <p>The latest completed assessment, with its findings, the original documents, the explanation of every rule and the full audit trail.</p>
          <div className="entry-latest"><Badge decision={latest.decision!} /><span>{when(latest.endedAt!)}</span><span>{latest.findings} {latest.findings === 1 ? 'finding' : 'findings'}</span><span>{latest.provider.id === 'codex' ? 'Codex ' + latest.provider.model : 'No model'}</span></div>
          <Button variant="dark" onClick={() => onView(latest.runId)}>View assessment<ArrowRight size={15} /></Button>
        </> : <>
          <p><strong>No completed assessment.</strong> Nothing has been assessed for this company yet{runs.length ? ': earlier runs did not complete' : ''}. Run a new assessment to review its documents.</p>
          <Button disabled>View assessment</Button>
        </>}
      </section>
      <section className="entry-choice entry-choice-primary">
        <div className="entry-choice-icon"><PlayCircle size={20} /></div>
        <h2>Run new assessment</h2>
        <p>Dispatches {ROLES.length} review workers on the {documents} original documents. Workers appear as they are dispatched, and every finding opens its source page.</p>
        <ul className="entry-run-facts">
          <li><Sparkles size={12} />{model ? model + ' reads the contract and drafts the memo' : 'No model available: deterministic workers only'}</li>
          <li><Radio size={12} />Live ANAF public-register lookup for CUI {company.cui}</li>
        </ul>
        {active ? <Button variant="primary" onClick={() => onLive(active.runId)}><LoaderCircle size={15} className="spin" />Assessment in progress · open live view</Button>
          : <Button variant="primary" onClick={onRun} disabled={starting || offline}>{starting ? 'Starting…' : 'Run new assessment'}<ArrowRight size={15} /></Button>}
      </section>
    </div>

    {!offline && <DossierDocuments company={company} onRunNew={onRun} since={latest?.createdAt ?? null} />}

    <section className="panel entry-history">
      <div className="entry-history-heading"><History size={15} /><h2>Assessment history</h2><span>{runs.length ? runs.length + ' runs recorded by the engine' : 'No runs recorded'}</span></div>
      {runs.length ? <table className="entry-history-table"><thead><tr><th>Started</th><th>Status</th><th>Outcome</th><th>Findings</th><th>Duration</th><th>Model</th><th /></tr></thead><tbody>
        {runs.map(r => <tr key={r.runId} onClick={() => r.status === 'completed' ? onView(r.runId) : onLive(r.runId)}>
          <td>{when(r.createdAt)}</td><td><span className={'run-status-chip status-' + r.status}>{statusLabel[r.status]}</span></td>
          <td>{r.decision && r.status === 'completed' ? <Badge decision={r.decision} small /> : <span className="text-muted">—</span>}</td><td>{r.findings}</td>
          <td>{r.endedAt ? duration(r.createdAt, r.endedAt) : '—'}</td><td>{r.provider.id === 'codex' ? r.provider.model + ' · ' + r.provider.effort : 'none'}</td><td><ChevronRight size={15} /></td></tr>)}
      </tbody></table> : <p className="entry-history-empty"><FileText size={15} />Assessments appear here once they have actually been run. No history is generated.</p>}
    </section>
  </div>
}

