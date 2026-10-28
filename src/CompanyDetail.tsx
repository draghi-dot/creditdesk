import { useEffect, useState } from 'react'
import { ArrowDownToLine, ArrowRight, ArrowUpRight, Check, CheckCheck, ChevronDown, ChevronLeft, ChevronRight, CircleAlert, Clock3, FileCheck2, FileText, Fingerprint, FolderClosed, Landmark, LoaderCircle, LockKeyhole, MessageSquarePlus, Play, PlayCircle, RotateCcw, Search, ShieldCheck, SlidersHorizontal } from 'lucide-react'
import type { Analysis, AuditEvent, Company, Policy, Scenario, Simulation } from './types'
import type { Observations, RunEvent, RunView } from './assessment'
import { decisionLabels, documentUrl, money, ratio, scenarioDescriptions, scenarioLabels } from './analysis'
import { AuditIntegrity, Badge, Button, CompanyMark, Dialog, Empty, RuleList, SectionHeading } from './components'
import { downloadFile } from './storage'
import { docNames } from './documents'
import AssessmentWorkspace from './AssessmentWorkspace'
import { clock, duration, runWhatIf, useRunStream, verifyRunLocally, verifyRunOnServer, when } from './runs'
import './assessment.css'

type Tab = 'findings' | 'financials' | 'documents' | 'scenarios' | 'audit' | 'contract'
const tabs: { id: Tab; label: string }[] = [{ id: 'findings', label: 'Assessment' }, { id: 'financials', label: 'Financials' }, { id: 'documents', label: 'Documents' }, { id: 'scenarios', label: 'Scenarios' }, { id: 'audit', label: 'Activity & checks' }, { id: 'contract', label: 'Decision' }]

const descriptions = {
  ELIGIBIL: 'The application meets the credit policy.',
  CONDITIONAT: 'The application can progress once its conditions are resolved.',
  NEELIGIBIL: 'The application does not meet the credit policy.',
  DATE_INSUFICIENTE: 'More reliable evidence is needed before a decision can be made.',
}
const time = (value: string) => new Date(value).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })

/** A completed assessment run: its findings, documents, rule explanations and audit. */
export default function CompanyDetail({ company, runId, workspacePolicy, events, onBack, onRunNew, showEvidence, record, toast }: {
  company: Company; runId: string; workspacePolicy: Policy; events: AuditEvent[]; onBack: () => void; onRunNew: () => void; showEvidence: (id?: string) => void;
  record: (companyId: string, action: string, detail: string, payload?: unknown) => Promise<boolean>; toast: (s: string) => void;
}) {
  const { view, events: runEvents, connection } = useRunStream(runId)
  if (!view || connection === 'connecting' || (connection === 'live' && view.status !== 'completed')) return <div className="run-loading"><LoaderCircle size={20} className="spin" />Loading the assessment…</div>
  if (view.status !== 'completed' || !view.decision || !view.policy) return <div className="empty-state"><h2>This run did not complete</h2><p>{view.failure ?? 'No decision was reached, so there is no assessment to show.'}</p><Button onClick={onBack}>Back to {company.name}</Button></div>
  return <AssessmentView company={company} view={view} runEvents={runEvents} observed={view.decision.observations} policy={view.policy} workspacePolicy={workspacePolicy} events={events} onBack={onBack} onRunNew={onRunNew} showEvidence={showEvidence} record={record} toast={toast} />
}

function AssessmentView({ company, view, runEvents, observed, policy, workspacePolicy, events, onBack, onRunNew, showEvidence, record, toast }: {
  company: Company; view: RunView; runEvents: RunEvent[]; observed: Observations; policy: Policy; workspacePolicy: Policy; events: AuditEvent[]; onBack: () => void; onRunNew: () => void; showEvidence: (id?: string) => void;
  record: (companyId: string, action: string, detail: string, payload?: unknown) => Promise<boolean>; toast: (s: string) => void;
}) {
  const [tab, setTab] = useState<Tab>('findings')
  const [scenario, setScenario] = useState<Scenario>('baza')
  const [applied, setAppliedState] = useState<Simulation>({})
  const [whatIfResults, setWhatIfResults] = useState<Record<Scenario, Analysis> | null>(null)
  const setApplied = (next: Simulation) => { setAppliedState(next); if (!Object.keys(next).length) setWhatIfResults(null) }
  // Recorded by the engine at the end of the run; what-if results also come from the engine.
  const recorded = view.decision!.scenarios
  const results = Object.keys(applied).length && whatIfResults ? whatIfResults : recorded
  const [note, setNote] = useState<'note' | 'review' | 'signing' | null>(null)
  const [noteText, setNoteText] = useState('')
  const [recommendation, setRecommendation] = useState('clarification')
  const [saving, setSaving] = useState(false)
  const t = company.tables
  const request = t.solicitari[0]
  const analysis = results[scenario]
  const isWhatIf = Object.keys(applied).length > 0
  const contract = t.documente.find(r => r.tip_document === 'contract_demo')!
  const approved = events.some(e => e.action === 'Review recorded' && e.payload?.recommendation === 'approval' && e.payload?.sourceHash === contract.sha256 && e.payload?.scenario === scenario && JSON.stringify(e.payload?.policy) === JSON.stringify(policy))
  const signed = events.some(e => e.action === 'Contract signature recorded' && e.payload?.sourceHash === contract.sha256)
  const canApprove = analysis.decision === 'ELIGIBIL' && !isWhatIf
  const openNote = (type: 'note' | 'review' | 'signing') => { setNoteText(''); setRecommendation(canApprove ? 'approval' : 'clarification'); setNote(type) }
  const exportAudit = () => {
    downloadFile(company.id + '-complete-audit.json', JSON.stringify({
      companyId: company.id, companyName: company.name, exportedAt: new Date().toISOString(),
      run: { runId: view.runId, provider: view.provider, startedAt: view.createdAt, completedAt: view.endedAt, observations: observed, findings: view.findings, notes: view.notes, events: runEvents },
      scenario, whatIf: applied, policy, assessment: analysis, analystEvents: events, sourceTables: company.tables,
    }, null, 2))
    toast('Complete dossier audit exported')
  }
  const submitNote = async (e: React.FormEvent) => {
    e.preventDefault(); setSaving(true)
    const payload = { recommendation: note === 'review' ? recommendation : undefined, scenario, simulation: applied, decision: analysis.decision, metrics: analysis.metrics, policy, sourceHash: contract.sha256 }
    const action = note === 'review' ? 'Review recorded' : note === 'signing' ? 'Contract signature recorded' : 'Note added'
    const detail = note === 'signing' ? 'Both parties signed the contract; recorded against its SHA-256 fingerprint.' : noteText.trim()
    const success = await record(company.id, action, detail, payload)
    setSaving(false)
    if (success) { setNote(null); toast(note === 'review' ? 'Review recorded in the activity log' : note === 'signing' ? 'Signature recorded in the activity log' : 'Note added to the activity log') }
  }
  return <div className="company-page page-enter">
    <div className="dossier-breadcrumb"><button onClick={onBack}><ChevronLeft size={14} />{company.name}</button><ChevronRight size={12} /><span>Assessment {view.runId.slice(0, 8)}</span><span className="dossier-access"><LockKeyhole size={12} />Internal assessment</span></div>
    <div className="dossier-heading"><CompanyMark company={company} large /><div><div className="company-title-line"><h1>{company.name}</h1><span className="ticker-tag">{company.symbol}</span></div><p><span>{company.sector}</span><span className="inline-dot">·</span>CUI {company.cui}<span className="inline-dot">·</span>Romania</p></div><div className="dossier-actions"><Button small onClick={() => openNote('note')}><MessageSquarePlus size={15} />Add note</Button><Button small onClick={exportAudit}><ArrowDownToLine size={15} />Export audit</Button><Button small onClick={onRunNew}><PlayCircle size={15} />Run new assessment</Button><Button small variant="dark" onClick={() => openNote('review')}>Record review<ArrowRight size={14} /></Button></div></div>
    <div className="dossier-statusline"><span><span className="status-dot" />Assessment completed {when(view.endedAt!)}</span><span>Run {view.runId.slice(0, 8)} · {duration(view.createdAt, view.endedAt)}</span><span>{view.findings.length} {view.findings.length === 1 ? 'problem' : 'problems'}</span><span>{view.provider?.id === 'codex' ? 'Codex ' + view.provider.model + ' · ' + view.provider.effort : 'No model'}</span><span>{policy.politica_id} {policy.versiune}</span>{JSON.stringify(policy) !== JSON.stringify({ ...policy, ...workspacePolicy }) && <span className="whatif-pill">Run under a different policy than the current one</span>}{isWhatIf && <span className="whatif-pill">What-if assumptions active</span>}</div>
    <div className="dossier-tabs" role="tablist" aria-label="Dossier sections">{tabs.map(item => <button key={item.id} role="tab" aria-selected={tab === item.id} className={tab === item.id ? 'active' : ''} onClick={() => setTab(item.id)}>{item.label}{item.id === 'findings' && <span className={view.findings.length ? 'tab-count-alert' : ''}>{view.findings.length}</span>}{item.id === 'documents' && <span>{t.documente.length}</span>}{item.id === 'audit' && events.length > 0 && <span>{events.length}</span>}{item.id === 'scenarios' && <span>4</span>}</button>)}</div>
    {tab === 'findings' && <div className="tab-content ws-tab"><AssessmentWorkspace company={company} view={view} events={runEvents} live={false} onRunNew={onRunNew} /></div>}
    {tab === 'financials' && <Financials company={company} analysis={analysis} showEvidence={showEvidence} />}
    {tab === 'documents' && <Documents company={company} view={view} observed={observed} showEvidence={showEvidence} requestMissing={() => openNote('review')} />}
    {tab === 'scenarios' && <Scenarios company={company} results={results} scenario={scenario} setScenario={setScenario} applied={applied} setApplied={setApplied} analysis={analysis} showEvidence={showEvidence} onRun={async (next) => {
      let computed: Record<Scenario, Analysis>
      try { computed = Object.keys(next).length ? await runWhatIf(view.runId, next) : recorded } catch (e: any) { toast(e.message || 'The engine could not compute this scenario.'); return }
      const a = computed[scenario]
      const success = await record(company.id, 'Scenario analysis recorded', scenarioLabels[scenario] + ' returned ' + decisionLabels[a.decision] + '.', { scenario, assumptions: next, assessment: a, policy })
      if (success) { setWhatIfResults(Object.keys(next).length ? computed : null); setAppliedState(next); toast('Scenario recalculated by the engine and recorded in the audit') }
    }} />}
    {tab === 'audit' && <CompanyAudit company={company} analysis={analysis} events={events} view={view} runEvents={runEvents} showEvidence={showEvidence} onNote={() => openNote('note')} exportAudit={exportAudit} />}
    {tab === 'contract' && <div className="contract-layout"><section className="panel contract-preview"><div className="contract-preview-icon"><FileCheck2 size={40} strokeWidth={1.3} /></div><h2>Draft financing agreement</h2><p>The draft reflects the application on file. Review the terms, record your recommendation, then record the signature once both parties have signed.</p><div className="contract-key-values"><div><span>Applicant</span><strong>{company.name}</strong></div><div><span>Financing</span><strong>{money(request.suma_solicitata)}</strong></div><div><span>Term</span><strong>{request.durata_luni} months</strong></div><div><span>Annual interest assumption</span><strong>{(request.dobanda_anuala_ipoteza * 100).toFixed(2)}%</strong></div></div><div className="contract-buttons"><Button onClick={() => showEvidence(contract.document_id)}><FileText size={16} />Review draft PDF</Button><a className="button button-primary" download href={documentUrl(company, contract)}><ArrowDownToLine size={16} />Download draft</a></div><div className="subtle-note"><ShieldCheck size={14} />Signing happens outside CreditDesk. Recording it adds an entry to the company's activity log, bound to the contract's fingerprint.</div></section>
      <section className="panel contract-steps"><SectionHeading title="Review & signing readiness" subtitle={signed ? 'The signature has been recorded.' : 'Each step is recorded against the contract document.'} /><div className="contract-step"><span className={analysis.decision === 'ELIGIBIL' ? 'step-complete' : ''}>{analysis.decision === 'ELIGIBIL' ? <Check size={16} /> : '1'}</span><div><h3>Policy assessment</h3><p>{decisionLabels[analysis.decision]} under {scenarioLabels[scenario].toLowerCase()}.</p><Badge decision={analysis.decision} small /></div></div><div className="contract-step"><span className={approved ? 'step-complete' : ''}>{approved ? <Check size={16} /> : '2'}</span><div><h3>Analyst recommendation</h3><p>{approved ? 'An approval recommendation has been recorded.' : 'An analyst must review the evidence and record a recommendation.'}</p><button className="text-button" onClick={() => openNote('review')}>{approved ? 'Add another review' : 'Record review'}<ArrowRight size={13} /></button></div></div><div className="contract-step"><span className="step-complete"><Check size={16} /></span><div><h3>Document integrity</h3><p>The contract's SHA-256 fingerprint is on record; CreditDesk never changes the document.</p><code className="short-hash">{contract.sha256.slice(0, 24)}…</code></div></div><div className="contract-step"><span className={signed ? 'step-complete' : ''}>{signed ? <Check size={16} /> : '4'}</span><div><h3>{signed ? 'Signature recorded' : 'Record the signature'}</h3><p>{signed ? 'Recorded in the activity log against the contract fingerprint.' : 'Available after an eligible assessment and a recorded approval recommendation.'}</p></div></div>
        {isWhatIf && <div className="info-box">What-if assumptions are active. Reset them before recording an approval or signing against the original contract.</div>}
        <Button variant="primary" disabled={!approved || !canApprove || signed} onClick={() => openNote('signing')} className="full-width">{signed ? <CheckCheck size={16} /> : <Play size={16} />}{signed ? 'Signature recorded' : 'Record signature'}</Button></section></div>}
    {note && <Dialog title={note === 'note' ? 'Add a note' : note === 'review' ? 'Record your review' : 'Record the contract signature'} description={company.name + ' · ' + company.id} onClose={() => !saving && setNote(null)}>
      <form onSubmit={submitNote}><div className="form-content">
        {note === 'review' && <><div className="review-current"><span>Current policy assessment</span><Badge decision={analysis.decision} /></div><fieldset className="review-options"><legend>Analyst recommendation</legend><label><input type="radio" name="recommendation" value="approval" checked={recommendation === 'approval'} disabled={!canApprove} onChange={e => setRecommendation(e.target.value)} /><span><strong>Recommend approval</strong><small>{canApprove ? 'The current source-backed scenario meets the demo policy.' : 'Available only for eligible scenarios without what-if assumptions.'}</small></span></label><label><input type="radio" name="recommendation" value="clarification" checked={recommendation === 'clarification'} onChange={e => setRecommendation(e.target.value)} /><span><strong>Return for clarification</strong><small>Record the documents, conditions or explanation required.</small></span></label><label><input type="radio" name="recommendation" value="decline" checked={recommendation === 'decline'} onChange={e => setRecommendation(e.target.value)} /><span><strong>Recommend decline</strong><small>Leave a detailed rationale for the case record.</small></span></label></fieldset></>}
        {note === 'signing' ? <><div className="signing-confirm"><ShieldCheck size={30} /><h3>Record that the contract was signed</h3><p>Use this once both parties have signed. The entry is bound to the contract's SHA-256 fingerprint and saved in the company's activity log under your name.</p></div><div className="review-current"><span>Document reference</span><code>{contract.document_id}</code></div></> :
          <label className="field-label">{note === 'review' ? 'Review rationale' : 'Your note'}<textarea autoFocus rows={5} minLength={note === 'review' ? 15 : 3} required placeholder={note === 'review' ? 'Explain your recommendation and reference the evidence you reviewed…' : 'Add observations, evidence references or the next action…'} value={noteText} onChange={e => setNoteText(e.target.value)} /></label>}
        <p className="field-help">Saved to the company's activity log under your name.</p>
      </div><div className="dialog-actions"><Button type="button" onClick={() => setNote(null)} disabled={saving}>Cancel</Button><Button variant="primary" type="submit" disabled={saving || (note === 'review' && recommendation === 'approval' && !canApprove)}>{saving ? 'Saving…' : note === 'signing' ? 'Record signature' : note === 'review' ? 'Save review' : 'Save note'}<Check size={15} /></Button></div></form>
    </Dialog>}
  </div>
}

function CashChart({ analysis }: { analysis: Analysis }) {
  if (!analysis.monthly.length) return <Empty title="Cash-flow evidence is missing">The repayment schedule is available, but cash available for repayment remains unknown.</Empty>
  const max = Math.max(...analysis.monthly.flatMap(r => [r.cfads, r.service])) * 1.15
  const height = 180
  return <div className="cash-chart"><svg viewBox="0 0 980 260" role="img" aria-label="12-month projected cash available versus debt service">{[0, .25, .5, .75, 1].map(t => <g key={t}><line x1="70" x2="965" y1={220 - t * height} y2={220 - t * height} stroke="#ebedf0" strokeDasharray={t === 0 ? undefined : '3 5'} /><text x="58" y={224 - t * height} textAnchor="end" fill="#8b929d" fontSize="10">{money(max * t, true).replace('RON', '')}</text></g>)}{analysis.monthly.map((r, i) => {
    const x = 83 + i * 73
    return <g key={r.month}><rect x={x} y={220 - r.cfads / max * height} width="23" height={r.cfads / max * height} rx="3" fill="#eddb35"><title>{r.month}: CFADS {money(r.cfads)}</title></rect><rect x={x + 27} y={220 - r.service / max * height} width="23" height={r.service / max * height} rx="3" fill="#48514e"><title>Debt service {money(r.service)}</title></rect><text x={x + 24} y="243" textAnchor="middle" fill="#7b8491" fontSize="10">{new Date(r.month + '-01T12:00:00').toLocaleDateString('en-GB', { month: 'short' })}</text></g>
  })}</svg></div>
}

function Financials({ company, analysis, showEvidence }: { company: Company; analysis: Analysis; showEvidence: (id?: string) => void }) {
  const [fullSchedule, setFullSchedule] = useState(false)
  const [facility, setFacility] = useState(company.tables.credite_leasing[1].facilitate_id)
  const [cashHistory, setCashHistory] = useState(false)
  const t = company.tables
  const fs = (year: number) => Object.fromEntries(t.situatii_financiare.filter(r => r.an === year).map(r => [r.cod_indicator, r.valoare]))
  const f24 = fs(2024), f25 = fs(2025)
  const indicators = [
    ['CA_NET', 'Net revenue'], ['EBITDA', 'EBITDA'], ['PROFIT_NET', 'Net profit'], ['ACTIVE_TOTAL', 'Total assets'],
    ['NUMERAR', 'Available cash'], ['CREANTE', 'Trade receivables'], ['STOCURI', 'Inventory'], ['DATORII_FINANCIARE', 'Financial debt'],
    ['DATORII_CURENTE', 'Current liabilities'], ['DATORII_TERMEN_LUNG', 'Long-term liabilities'], ['CAPITALURI_PROPRII', 'Equity'],
  ]
  const schedule = t.serviciu_datorie.filter(r => r.facilitate_id === facility).sort((a, b) => a.luna.localeCompare(b.luna))
  const sourceRows = t.cashflow.filter(r => r.tip_istoric_sau_proiectie === (cashHistory ? 'istoric' : 'proiectie'))
  return <div className="tab-content"><div className="content-heading"><div><h2>The financial picture</h2><p>Trace every ratio back to the underlying statements and cash movements.</p></div><span className="subtle-chip">RON · unit 1</span></div>
    <section className="panel"><SectionHeading title="Cash available vs. debt service" subtitle="Projected monthly repayment capacity · Oct 2026–Sep 2027" action={<div className="chart-legend"><span><i />Cash available</span><span><i />Debt service</span></div>} /><div className="chart-headline"><div><span>12-month cash available</span><strong>{money(analysis.metrics.cfads)}</strong></div><div><span>Total debt service</span><strong>{money(analysis.metrics.debtService)}</strong></div><div><span>Coverage ratio</span><strong>{ratio(analysis.metrics.dscr)}</strong></div></div><CashChart analysis={analysis} /><div className="chart-explanation">CFADS excludes new financing and own contributions. Debt service includes existing and proposed principal, interest and fees.</div></section>
    <section className="panel"><SectionHeading title="Financial statements" subtitle="Comparable annual figures from the submitted statements" action={<Button small onClick={() => showEvidence(t.documente.find(d => d.tip_document === 'situatii_2025')?.document_id)}><FileText size={14} />View 2025 source<ArrowUpRight size={13} /></Button>} />{!Object.keys(f25).length ? <Empty title="Annual statements are missing">Request the source statements before assessing liquidity or leverage.</Empty> :
      <div className="table-scroll"><table className="data-table financial-statement-table"><thead><tr><th>Financial indicator</th><th>2024</th><th>2025</th><th>Change</th></tr></thead><tbody>{indicators.map(([key, label]) => <tr key={key}><td>{label}</td><td>{money(f24[key])}</td><td>{money(f25[key])}</td><td>{f24[key] ? <span className={(f25[key] - f24[key]) / f24[key] >= 0 ? 'financial-positive' : 'financial-negative'}>{f25[key] >= f24[key] ? '+' : ''}{((f25[key] - f24[key]) / f24[key] * 100).toFixed(1)}%</span> : '—'}</td></tr>)}</tbody></table></div>}</section>
    <section className="panel"><SectionHeading title="Credit facilities" subtitle="Existing drawn debt and the proposed financing are kept distinct" /><div className="facility-grid">{t.credite_leasing.map(f => <div className="facility-card" key={f.facilitate_id}><div><span className="facility-icon"><Landmark size={18} /></span><strong>{f.facilitate_id.includes('NOU') ? 'Proposed investment loan' : 'Existing investment loan'}</strong><span className="subtle-chip">{f.facilitate_id.includes('NOU') ? 'Proposed' : 'Drawn'}</span></div><strong className="facility-amount">{money(f.facilitate_id.includes('NOU') ? f.plafon : f.sold_utilizat)}</strong><dl><div><dt>Annual rate</dt><dd>{(f.rata_dobanda_anuala * 100).toFixed(2)}%</dd></div><div><dt>Final maturity</dt><dd>{f.scadenta_finala}</dd></div><div><dt>Overdue days</dt><dd className={f.zile_intarziere ? 'text-red' : ''}>{f.zile_intarziere}</dd></div></dl></div>)}</div></section>
    <section className="panel"><SectionHeading title="Source repayment schedule" subtitle="Original application schedule · source values are not overwritten by what-if controls" action={<label className="select-wrap"><select aria-label="Select repayment facility" value={facility} onChange={e => { setFacility(e.target.value); setFullSchedule(false) }}>{t.credite_leasing.map(f => <option key={f.facilitate_id} value={f.facilitate_id}>{f.facilitate_id.includes('NOU') ? 'Proposed loan' : 'Existing loan'}</option>)}</select></label>} /><div className="table-scroll"><table className="data-table"><thead><tr><th>Month</th><th>Principal</th><th>Interest</th><th>Fees</th><th>Total payment</th></tr></thead><tbody>{schedule.slice(0, fullSchedule ? undefined : 12).map(r => <tr key={r.record_id}><td>{r.luna}</td><td>{money(r.principal_scadent)}</td><td>{money(r.dobanda_scadenta)}</td><td>{money(r.comisioane_scadente)}</td><td><strong>{money(r.principal_scadent + r.dobanda_scadenta + r.comisioane_scadente)}</strong></td></tr>)}</tbody></table></div><div className="panel-bottom-link"><button onClick={() => setFullSchedule(s => !s)}>{fullSchedule ? 'Show first 12 months' : 'Show full ' + schedule.length + '-month schedule'}<ChevronDown size={14} /></button></div></section>
    <details className="panel raw-data-panel"><summary><div><h2>Source cash-flow ledger</h2><p>All cash movements, including financing and capital expenditure.</p></div><ChevronDown size={18} /></summary><div className="raw-data-controls"><Button small variant={cashHistory ? 'secondary' : 'dark'} onClick={() => setCashHistory(false)}>Projection</Button><Button small variant={cashHistory ? 'dark' : 'secondary'} onClick={() => setCashHistory(true)}>History</Button></div><div className="table-scroll"><table className="data-table"><thead><tr><th>Month</th><th>Opening cash</th><th>Operating receipts</th><th>Operating payments</th><th>Tax</th><th>Maintenance</th><th>CFADS</th></tr></thead><tbody>{sourceRows.map(r => <tr key={r.record_id}><td>{r.luna}</td><td>{money(r.sold_initial_numerar)}</td><td>{money(r.incasari_operare)}</td><td>{money(r.plati_operare_fara_dobanzi_impozite)}</td><td>{money(r.impozite_platite)}</td><td>{money(r.capex_mentenanta)}</td><td>{money(r.incasari_operare - r.plati_operare_fara_dobanzi_impozite - r.impozite_platite - r.capex_mentenanta)}</td></tr>)}</tbody></table></div></details>
    <details className="panel raw-data-panel"><summary><div><h2>Trial balance accounts</h2><p>Original leaf-account records, including any source anomalies.</p></div><ChevronDown size={18} /></summary><div className="table-scroll"><table className="data-table"><thead><tr><th>Account</th><th>Source description</th><th>Unit</th><th>Opening debit</th><th>Opening credit</th><th>Closing debit</th><th>Closing credit</th></tr></thead><tbody>{t.balanta.map(r => <tr key={r.record_id}><td><code>{r.cod_cont}</code></td><td>{r.denumire_cont}</td><td>{r.unitate}</td><td>{money(r.sold_initial_debit)}</td><td>{money(r.sold_initial_credit)}</td><td>{money(r.sold_final_debit)}</td><td>{money(r.sold_final_credit)}</td></tr>)}</tbody></table></div></details>
  </div>
}

function Documents({ company, view, observed, showEvidence, requestMissing }: { company: Company; view: RunView; observed: Observations; showEvidence: (id?: string) => void; requestMissing: () => void }) {
  const [query, setQuery] = useState('')
  const [group, setGroup] = useState('all')
  const t = company.tables
  const category = (kind: string) => ['contract_demo'].includes(kind) ? 'contract' : ['crc_demo', 'cip_demo', 'situatie_fiscala'].includes(kind) ? 'checks' :
    ['identificare_kyc_demo', 'litigii_demo', 'garantii', 'garanti'].includes(kind) ? 'legal' : 'financial'
  const documents = t.documente.filter(d => (group === 'all' || category(d.tip_document) === group) && [d.tip_document, docNames[d.tip_document], d.document_id].join(' ').toLowerCase().includes(query.toLowerCase()))
  const inventory = () => downloadFile(company.id + '-document-inventory.json', JSON.stringify(t.documente.map(d => ({ ...d, previewUrl: documentUrl(company, d) })), null, 2))
  return <div className="tab-content"><div className="content-heading"><div><h2>Documents</h2><p>Every source, its extraction status and its recorded digital fingerprint.</p></div><Button onClick={inventory}><ArrowDownToLine size={15} />Export inventory</Button></div>
    {!!observed.missingDocuments.length && <section className="missing-files"><span className="missing-files-icon"><FolderClosed size={24} /></span><div><h3>{observed.missingDocuments.length} required {observed.missingDocuments.length === 1 ? 'document is' : 'documents are'} missing</h3><p>{observed.missingDocuments.map((s: string) => docNames[s] || s).join(' · ')}</p></div><Button small onClick={requestMissing}>Record document request<ArrowRight size={14} /></Button></section>}
    <section className="panel"><div className="document-toolbar"><label className="search-input"><Search size={17} /><input aria-label="Search dossier documents" placeholder="Search source documents…" value={query} onChange={e => setQuery(e.target.value)} /></label><label className="select-wrap"><FolderClosed size={15} /><select aria-label="Filter document category" value={group} onChange={e => setGroup(e.target.value)}><option value="all">All documents</option><option value="financial">Financial & application</option><option value="checks">Credit & fiscal checks</option><option value="legal">Legal & collateral</option><option value="contract">Contract draft</option></select></label></div>
    {!documents.length ? <Empty title="No matching documents">Try another file name or category.</Empty> : <div className="table-scroll"><table className="data-table document-table"><thead><tr><th>Source document</th><th>Issued</th><th>Pages</th><th>In this assessment</th><th>Integrity</th><th /></tr></thead><tbody>{documents.map(d => <tr key={d.document_id}><td><button className="document-name" onClick={() => showEvidence(d.document_id)}><span className="pdf-icon"><FileText size={20} /><small>PDF</small></span><span><strong>{docNames[d.tip_document] || d.tip_document}</strong><small>{d.document_id}</small></span></button></td><td>{new Date(d.data_emitere + 'T12:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}</td><td>{d.pagini}</td><td>{(() => { const n = view.findings.filter(f => f.evidence.some(e => e.documentId === d.document_id && e.marks.some(m => m.tone === 'issue'))).length; return <span className={'extraction-state' + (n ? ' extraction-partial' : '')}><span />{n ? n + (n === 1 ? ' finding' : ' findings') : 'No findings'}</span> })()}</td><td><span className="hash-status" title={d.sha256}><Fingerprint size={14} />Fingerprint verified</span></td><td><button className="icon-button" aria-label={'View ' + (docNames[d.tip_document] || d.tip_document)} onClick={() => showEvidence(d.document_id)}><ArrowUpRight size={16} /></button></td></tr>)}</tbody></table></div>}
    <div className="documents-footer"><ShieldCheck size={15} /><span>The case coordinator recomputed every SHA-256 fingerprint during this run and compared it with the inventory. No real electronic signatures are verified.</span><strong>{documents.length} files</strong></div></section>
    <div className="source-registry"><SectionHeading title="External source register" subtitle="Public sources consulted for the company's identity." /><div className="source-register-grid">{t.cercetare_web.filter(r => r.url).map(r => <div key={r.record_id}><span className="source-type">Public reference</span><h3>{r.furnizor}</h3><p>{r.rezumat_factual}</p><div><span>Collected {String(r.colectat_la).slice(0, 10)}</span><a href={r.url} target="_blank" rel="noreferrer">View source<ArrowUpRight size={13} /></a></div></div>)}</div></div>
  </div>
}

function Scenarios({ company, results, scenario, setScenario, applied, setApplied, analysis, showEvidence, onRun }: {
  company: Company; results: Record<Scenario, Analysis>; scenario: Scenario; setScenario: (s: Scenario) => void; applied: Simulation; setApplied: (s: Simulation) => void;
  analysis: Analysis; showEvidence: (id?: string) => void; onRun: (settings: Simulation) => Promise<void>;
}) {
  const request = company.tables.solicitari[0]
  const [amount, setAmount] = useState(applied.amount ?? request.suma_solicitata)
  const [months, setMonths] = useState(applied.months ?? request.durata_luni)
  const [cashflow, setCashflow] = useState(applied.cashflowChange ?? 0)
  const [cashVerified, setCashVerified] = useState(applied.assumeCashVerified ?? false)
  const [running, setRunning] = useState(false)
  const [compare, setCompare] = useState(true)
  const settings = (): Simulation => ({
    ...(amount !== request.suma_solicitata ? { amount } : {}),
    ...(months !== request.durata_luni ? { months } : {}),
    ...(cashflow !== 0 ? { cashflowChange: cashflow } : {}),
    ...(scenario === 'cash_colateral' && cashVerified ? { assumeCashVerified: true } : {}),
  })
  const changed = JSON.stringify(settings()) !== JSON.stringify(applied)
  const reset = () => { setAmount(request.suma_solicitata); setMonths(request.durata_luni); setCashflow(0); setCashVerified(false); setApplied({}) }
  return <div className="tab-content"><div className="content-heading"><div><h2>A decision you can challenge</h2><p>Compare the available remedies, then test the assumptions that matter.</p></div><span className="subtle-chip"><SlidersHorizontal size={13} />Source data stays unchanged</span></div>
    <div className="scenario-selector">{(Object.keys(scenarioLabels) as Scenario[]).map((s, i) => {
      const a = results[s]
      return <button key={s} className={'scenario-option' + (scenario === s ? ' scenario-option-active' : '')} onClick={() => setScenario(s)}><span className="scenario-option-top"><span>SCENARIO {String(i + 1).padStart(2, '0')}</span><span className="scenario-radio">{scenario === s && <span />}</span></span><h3>{scenarioLabels[s]}</h3><p>{scenarioDescriptions[s]}</p><Badge decision={a.decision} small /></button>
    })}</div>
    <div className="simulation-layout"><section className="panel simulator-controls"><SectionHeading title="What-if assumptions" subtitle="Change the assumptions, then run to record the result." /><label className="field-label">Financing amount<span className="input-unit-wrap"><input aria-label="Simulation financing amount" type="number" min="10000" max="100000000" step="10000" value={amount} onChange={e => setAmount(Number(e.target.value))} /><span>RON</span></span></label><label className="field-label">Repayment term<select aria-label="Simulation repayment term" value={months} onChange={e => setMonths(Number(e.target.value))}><option value="24">24 months</option><option value="36">36 months</option><option value="48">48 months</option><option value="60">60 months</option><option value="72">72 months</option></select></label><div className="slider-field"><label htmlFor="cashflow-change">Operating cash-flow adjustment<strong className={cashflow < 0 ? 'text-red' : ''}>{cashflow > 0 ? '+' : ''}{cashflow}%</strong></label><input id="cashflow-change" type="range" min="-70" max="40" step="5" value={cashflow} onChange={e => setCashflow(Number(e.target.value))} /><div><span>−70% stress</span><span>+40% growth</span></div></div>
      {scenario === 'cash_colateral' && <label className="checkbox-label cash-assumption"><input type="checkbox" checked={cashVerified} onChange={e => setCashVerified(e.target.checked)} /><span><strong>Assume cash evidence is verified</strong><small>What-if only. Does not change source documents or establish real proof.</small></span></label>}
      <div className="simulator-buttons"><Button className="full-width" variant="primary" disabled={running || amount < 10000 || amount > 100000000 || !Number.isFinite(amount)} onClick={async () => { setRunning(true); await onRun(settings()); setRunning(false) }}><Play size={15} />{running ? 'Recording analysis…' : 'Run simulation'}</Button><Button variant="ghost" className="full-width" onClick={reset}><RotateCcw size={14} />Reset assumptions</Button></div>{changed && <div className="unapplied-note"><Clock3 size={13} />New assumptions are not applied yet.</div>}
      <div className="subtle-note">Financing and cash-flow changes recalculate debt service, DSCR and leverage. What-if results never replace missing evidence or change the original files.</div></section>
      <div className="simulation-result"><section className="panel"><div className="simulation-result-header"><span className="eyebrow">CURRENT SCENARIO RESULT</span><Badge decision={analysis.decision} /></div><h2>{scenarioLabels[scenario]}</h2><p>{descriptions[analysis.decision]}</p><div className="scenario-result-numbers"><div><span>Financing</span><strong>{money(analysis.metrics.amount)}</strong></div><div><span>Debt coverage</span><strong>{ratio(analysis.metrics.dscr)}</strong></div><div><span>Collateral</span><strong>{(analysis.metrics.coverage * 100).toFixed(0)}%</strong></div></div><RuleList rules={analysis.reasons.length ? analysis.reasons : analysis.rules.filter(r => ['FIN-01', 'COL-01'].includes(r.id))} onEvidence={showEvidence} expanded /></section>
      <section className="panel"><SectionHeading title="Repayment headroom" subtitle="The current applied assumptions, month by month" /><CashChart analysis={analysis} /></section></div></div>
    <section className="panel scenario-comparison"><SectionHeading title="Side-by-side comparison" subtitle="Same financial evidence, four alternative paths" action={<button className="text-button" onClick={() => setCompare(v => !v)}>{compare ? 'Collapse' : 'Expand'}<ChevronDown size={15} /></button>} />{compare && <div className="table-scroll"><table className="data-table"><thead><tr><th>Assessment</th>{(Object.keys(scenarioLabels) as Scenario[]).map(s => <th key={s}>{scenarioLabels[s]}</th>)}</tr></thead><tbody>{['Decision', 'DSCR', 'Accepted collateral', 'Collateral coverage', 'Open conditions'].map((label, i) => <tr key={label}><td>{label}</td>{(Object.keys(scenarioLabels) as Scenario[]).map(s => {
      const a = results[s]
      return <td key={s}>{i === 0 ? <Badge decision={a.decision} small /> : i === 1 ? ratio(a.metrics.dscr) : i === 2 ? money(a.metrics.collateral) : i === 3 ? (a.metrics.coverage * 100).toFixed(0) + '%' : a.reasons.length}</td>
    })}</tr>)}</tbody></table></div>}</section>
  </div>
}

function CompanyAudit({ company, analysis, events, view, runEvents, showEvidence, onNote, exportAudit }: { company: Company; analysis: Analysis; events: AuditEvent[]; view: RunView; runEvents: RunEvent[]; showEvidence: (id?: string) => void; onNote: () => void; exportAudit: () => void }) {
  const [filter, setFilter] = useState('all')
  const [area, setArea] = useState('')
  const [expanded, setExpanded] = useState(true)
  const [section, setSection] = useState<'run' | 'checks' | 'activity'>('run')
  const areas = [...new Set(analysis.rules.map(r => r.area))]
  const rules = analysis.rules.filter(r => (!area || r.area === area) && (filter === 'all' || filter === 'pass' ? filter === 'all' || r.state === 'pass' : ['fail', 'review', 'missing'].includes(r.state)))
  const pass = analysis.rules.filter(r => r.state === 'pass').length
  const failed = analysis.rules.filter(r => ['fail', 'missing', 'review'].includes(r.state)).length
  return <div className="tab-content"><div className="content-heading"><div><h2>Activity and checks</h2><p>The run's event log, every policy check with its calculation, and what employees recorded.</p></div><Button onClick={exportAudit}><ArrowDownToLine size={15} />Export complete audit</Button></div>
    <div className="case-audit-summary"><div><ShieldCheck size={20} /><span><strong>{analysis.rules.length}</strong> assessment checks</span></div><div><Check size={20} /><span><strong>{pass}</strong> passed</span></div><div><CircleAlert size={20} /><span><strong>{failed}</strong> need attention</span></div><div><MessageSquarePlus size={20} /><span><strong>{events.length}</strong> employee actions</span></div></div>
    <div className="audit-subtabs"><button className={section === 'run' ? 'active' : ''} onClick={() => setSection('run')}>Run event log<span>{runEvents.length}</span></button><button className={section === 'checks' ? 'active' : ''} onClick={() => setSection('checks')}>Assessment checks</button><button className={section === 'activity' ? 'active' : ''} onClick={() => setSection('activity')}>Employee activity<span>{events.length}</span></button></div>
    {section === 'run' && <RunLog view={view} runEvents={runEvents} />}
    {section === 'checks' && <section className="panel"><div className="audit-rule-toolbar"><label className="select-wrap"><SlidersHorizontal size={15} /><select aria-label="Filter assessment rule status" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">All checks</option><option value="attention">Needs attention</option><option value="pass">Passed checks</option></select></label><label className="select-wrap"><select aria-label="Filter assessment area" value={area} onChange={e => setArea(e.target.value)}><option value="">All assessment areas</option>{areas.map(a => <option key={a}>{a}</option>)}</select></label><button className="text-button" onClick={() => setExpanded(v => !v)}>{expanded ? 'Collapse all' : 'Expand all'}<ChevronDown size={14} /></button></div>
      {rules.length ? <RuleList key={expanded ? 'expanded' : 'collapsed'} rules={rules} expanded={expanded} onEvidence={showEvidence} /> : <Empty title="No checks in this view">Choose another rule status or assessment area.</Empty>}
      <div className="documents-footer"><ShieldCheck size={14} /><span>Outcome precedence: evidence gaps → blocking criteria → review conditions → eligible. Thresholds come from the credit policy the run used.</span></div></section>}
    {section === 'activity' && <section className="panel"><SectionHeading title="Employee activity" subtitle="Who did what, each entry chained to the previous one with SHA-256" action={<Button small onClick={onNote}><MessageSquarePlus size={14} />Add note</Button>} /><div className="integrity-row"><AuditIntegrity events={events} /></div>{events.length ? <div className="case-activity-list">{[...events].reverse().map(e => <details className="case-activity" key={e.id} open><summary><span className="timeline-marker marker-yellow"><ShieldCheck size={15} /></span><div><strong>{e.action}</strong><span>{time(e.time)} · {e.actor}</span></div><ChevronDown size={15} /></summary><div><p>{e.detail}</p>{e.payload?.decision && <Badge decision={e.payload.decision} small />}<dl className="event-hashes"><div><dt>Event hash</dt><dd>{e.hash}</dd></div><div><dt>Previous event</dt><dd>{e.previousHash}</dd></div>{e.payload?.sourceHash && <div><dt>Contract source hash</dt><dd>{e.payload.sourceHash}</dd></div>}</dl></div></details>)}</div> : <Empty title="Nothing recorded yet">Notes, reviews, scenario checks and problems sent to departments appear here.</Empty>}<div className="documents-footer"><Fingerprint size={15} /><span>Stored by the engine. Each entry is chained to the previous one, so any change after the fact is detected when the chain is verified.</span></div></section>}
  </div>
}

function RunLog({ view, runEvents }: { view: RunView; runEvents: RunEvent[] }) {
  const [local, setLocal] = useState<{ ok: boolean; brokenAt: number | null } | null>(null)
  const [server, setServer] = useState<{ ok: boolean; brokenAt: number | null } | null>(null)
  const [type, setType] = useState('')
  useEffect(() => { verifyRunLocally(runEvents).then(setLocal); verifyRunOnServer(view.runId).then(setServer).catch(() => setServer(null)) }, [view.runId, runEvents.length])
  const types = [...new Set(runEvents.map(e => e.type))]
  const shown = runEvents.filter(e => !type || e.type === type)
  const summary = (e: RunEvent) => { const p = e.payload as any; return p.text ?? p.summary ?? p.finding?.title ?? (p.check ? p.check.id + ' · ' + p.check.state : undefined) ?? p.title ?? p.reason ?? p.inputs ?? (p.waitingFor && 'waiting for ' + p.waitingFor.join(', ')) ?? p.decision ?? p.purpose ?? '' }
  return <section className="panel run-log">
    <SectionHeading title="Run event log" subtitle={'Every step the engine recorded, in order · ' + when(view.createdAt!) + ' → ' + clock(view.endedAt!)} action={<Button small onClick={() => downloadFile(view.companyId + '-run-' + view.runId.slice(0, 8) + '.json', JSON.stringify(runEvents, null, 2))}><ArrowDownToLine size={14} />Export run log</Button>} />
    <div className="chain-status">
      <span className={local?.ok ? 'chain-ok' : local ? 'chain-bad' : ''}><ShieldCheck size={14} />{local ? local.ok ? 'Hash chain verified in this browser' : 'Chain broken at event #' + local.brokenAt : 'Verifying in browser…'}</span>
      <span className={server?.ok ? 'chain-ok' : server ? 'chain-bad' : ''}><Fingerprint size={14} />{server ? server.ok ? 'Verified by the engine from storage' : 'Engine: chain broken at #' + server.brokenAt : 'Engine verification unavailable'}</span>
      <code title={runEvents.at(-1)?.hash}>head {runEvents.at(-1)?.hash.slice(0, 16)}…</code>
      <label className="select-wrap"><select value={type} onChange={e => setType(e.target.value)} aria-label="Filter run events"><option value="">All {runEvents.length} events</option>{types.map(t => <option key={t} value={t}>{t}</option>)}</select></label>
    </div>
    <div className="table-scroll"><table className="data-table run-log-table"><thead><tr><th>#</th><th>Time</th><th>Step</th><th>Event</th><th>Detail</th><th>Hash</th></tr></thead><tbody>
      {shown.map(e => <tr key={e.seq}><td>{e.seq}</td><td>{clock(e.ts)}</td><td>{e.worker ? view.workers[e.worker]?.role.name : 'Engine'}</td><td><code>{e.type}</code></td><td className="run-log-detail">{String(summary(e))}</td><td><code title={e.hash}>{e.hash.slice(0, 10)}</code></td></tr>)}
    </tbody></table></div>
  </section>
}
