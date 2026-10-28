import { useEffect, useMemo, useState } from 'react'
import { ArrowDown, ArrowDownToLine, ArrowRight, ArrowUpDown, Building2, Check, CheckCheck, ChevronLeft, ChevronRight, Clock3, FileCheck2, FileText, FolderClosed, LayoutGrid, ListFilter, LoaderCircle, Play, RotateCcw, Search, ShieldCheck, Table2, X } from 'lucide-react'
import type { AuditEvent, Company, Decision, Policy } from './types'
import type { AssessmentDigest, AssessmentSummary } from './assessment'
import { REQUIRED_DOCUMENTS } from './assessment'
import { decisionLabels, money, ratio } from './analysis'
import { Badge, Button, CompanyMark, Dialog, Empty, NotAssessed, SectionHeading } from './components'
import { downloadFile } from './storage'
import { DEPARTMENTS } from './workspace'
import type { BatchStatus } from './people'
import { batchStatus, findAllContacts, findAllStatus, runAll, stopAll, useCases } from './people'
import type { FindAllStatus } from './people'

/** The engine's recorded result of the latest completed run, for companies that have one. */
type Assessments = Map<string, AssessmentDigest>
type Latest = Map<string, AssessmentSummary>
const states: Decision[] = ['ELIGIBIL', 'CONDITIONAT', 'DATE_INSUFICIENTE', 'NEELIGIBIL']
const NOT_ASSESSED = 'NONE'
const requested = (c: Company) => c.tables.solicitari[0].suma_solicitata

export function Stats({ companies, assessments }: { companies: Company[]; assessments: Assessments }) {
  const counts = Object.fromEntries(states.map(s => [s, companies.filter(c => assessments.get(c.id)?.decision === s).length]))
  const total = companies.reduce((n, c) => n + c.tables.solicitari[0].suma_solicitata, 0)
  return <div className="stats-grid">
    <div className="stat-card"><div className="stat-label">Total applications<FolderClosed size={17} /></div><div className="stat-number">{companies.length}<span className="stat-unit">dossiers</span></div><div className="stat-caption">{companies.length - assessments.size ? <><strong>{companies.length - assessments.size}</strong> not yet assessed<span className="caption-dot">·</span></> : null}<strong>{money(total, true)}</strong> requested</div></div>
    <div className="stat-card"><div className="stat-label">Meet the policy<span className="stat-dot green" /></div><div className="stat-number">{counts.ELIGIBIL}<span className="stat-tag tag-green">Eligible</span></div><div className="stat-caption">Ready for an analyst's review</div></div>
    <div className="stat-card"><div className="stat-label">Need attention<span className="stat-dot amber" /></div><div className="stat-number">{counts.CONDITIONAT + counts.DATE_INSUFICIENTE}<span className="stat-tag tag-amber">To review</span></div><div className="stat-caption">{counts.CONDITIONAT} conditional<span className="caption-dot">·</span>{counts.DATE_INSUFICIENTE} incomplete</div></div>
    <div className="stat-card"><div className="stat-label">Do not meet the policy<span className="stat-dot red" /></div><div className="stat-number">{counts.NEELIGIBIL}<span className="stat-tag tag-red">Not eligible</span></div><div className="stat-caption">Repayment or fiscal criteria unmet</div></div>
  </div>
}

export function Directory({ companies, assessments, latest, queue, initialStatus, onOpen, toast, policy, onRunsChanged }: { companies: Company[]; assessments: Assessments; latest: Latest; queue: boolean; initialStatus: string; onOpen: (id: string) => void; onQueue: () => void; toast: (s: string) => void; policy: Policy; runs: AssessmentSummary[]; onRunsChanged: () => void }) {
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState(initialStatus)
  const [sector, setSector] = useState('')
  const [sort, setSort] = useState('dossier')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const [layout, setLayout] = useState<'table' | 'grid'>('table')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [filterOpen, setFilterOpen] = useState(false)
  const [minAmount, setMinAmount] = useState('')
  const [maxAmount, setMaxAmount] = useState('')
  const [anomaliesOnly, setAnomaliesOnly] = useState(false)
  useEffect(() => setStatus(initialStatus), [initialStatus])
  const decisionOf = (c: Company) => assessments.get(c.id)?.decision ?? NOT_ASSESSED
  const available = companies.filter(c => !queue || ['CONDITIONAT', 'DATE_INSUFICIENTE'].includes(decisionOf(c)))
  const counts = Object.fromEntries([...states, NOT_ASSESSED].map(s => [s, available.filter(c => decisionOf(c) === s).length]))
  const sectors = [...new Set(companies.map(c => c.sector))].sort()
  const filtered = useMemo(() => available.filter(c => {
    const observed = latest.get(c.id)?.observations
    return (!query || [c.name, c.symbol, c.cui, c.id, c.sector].join(' ').toLowerCase().includes(query.toLowerCase())) &&
      (!status || decisionOf(c) === status) && (!sector || c.sector === sector) &&
      (!minAmount || requested(c) >= Number(minAmount)) && (!maxAmount || requested(c) <= Number(maxAmount)) &&
      (!anomaliesOnly || !!observed && (observed.discrepancies.length > 0 || observed.missingDocuments.length > 0 || ['DATA-02', 'DATA-03', 'DATA-04'].some(id => assessments.get(c.id)?.failing.includes(id))))
  }).sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name) : sort === 'amount-desc' ? requested(b) - requested(a) :
    sort === 'amount-asc' ? requested(a) - requested(b) : a.id.localeCompare(b.id)), [available, assessments, latest, query, status, sector, sort, minAmount, maxAmount, anomaliesOnly])
  useEffect(() => setPage(1), [query, status, sector, sort, pageSize, minAmount, maxAmount, anomaliesOnly])
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const currentPage = Math.min(page, pages)
  const visible = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize)
  const reset = () => { setQuery(''); setStatus(''); setSector(''); setMinAmount(''); setMaxAmount(''); setAnomaliesOnly(false) }
  const activeFilters = !!query || !!status || !!sector || !!minAmount || !!maxAmount || anomaliesOnly
  const toggle = (id: string) => setSelected(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  const allSelected = visible.length > 0 && visible.every(c => selected.has(c.id))
  const exportCsv = (picked = false) => {
    const rows = (picked ? companies.filter(c => selected.has(c.id)) : filtered).map(c => {
      const a = assessments.get(c.id)
      return [c.id, c.name, c.cui, c.sector, requested(c), a ? decisionLabels[a.decision] : 'Not assessed', a?.metrics.dscr ?? '', a?.metrics.coverage ?? '', latest.get(c.id)?.endedAt ?? '', c.tables.documente.length]
    })
    const csv = [['Dossier', 'Company', 'CUI', 'Sector', 'Requested RON', 'Latest assessment', 'DSCR', 'Collateral ratio', 'Assessed at', 'Documents'], ...rows]
      .map(row => row.map(cell => '"' + String(cell).replaceAll('"', '""') + '"').join(',')).join('\r\n')
    downloadFile('creditdesk-portfolio.csv', '\ufeff' + csv, 'text/csv;charset=utf-8')
    toast(rows.length + ' company dossiers exported')
  }
  return <div className="page-enter">
    <div className="page-heading"><div><h1>{queue ? 'Review queue' : 'Companies'}<span className="heading-count">{available.length}</span></h1><p>{queue ? 'Assessed companies with conditions or missing evidence.' : 'Every application, its latest assessment and its documents.'}</p></div><div className="page-actions">{!queue && <FindContacts toast={toast} />}{!queue && <RunAll policy={policy} total={companies.length} onChange={onRunsChanged} toast={toast} />}<Button onClick={() => exportCsv()}><ArrowDownToLine size={16} />Export list</Button></div></div>
    <Stats companies={companies} assessments={assessments} />
    <section className="portfolio-panel">
      <div className="directory-heading"><h2>{queue ? 'Companies requiring attention' : 'All companies'}<span>{available.length} companies</span></h2><div className="view-toggle"><button className={layout === 'table' ? 'selected' : ''} onClick={() => setLayout('table')} aria-label="Table view"><Table2 size={16} /></button><button className={layout === 'grid' ? 'selected' : ''} onClick={() => setLayout('grid')} aria-label="Grid view"><LayoutGrid size={16} /></button></div></div>
      <div className="filter-tabs" role="tablist" aria-label="Filter companies by decision"><button role="tab" aria-selected={!status} className={!status ? 'active' : ''} onClick={() => setStatus('')}>All companies<span>{available.length}</span></button>{states.map(s => <button role="tab" aria-selected={status === s} className={status === s ? 'active' : ''} key={s} onClick={() => setStatus(s)}><span className={'tab-dot dot-' + s} />{decisionLabels[s]}<span>{counts[s]}</span></button>)}{!queue && <button role="tab" aria-selected={status === NOT_ASSESSED} className={status === NOT_ASSESSED ? 'active' : ''} onClick={() => setStatus(NOT_ASSESSED)}><span className="tab-dot dot-NONE" />Not assessed<span>{counts[NOT_ASSESSED]}</span></button>}</div>
      <div className="directory-toolbar"><label className="search-input"><Search size={17} /><input aria-label="Search company directory" placeholder="Search company, CUI or dossier ID…" value={query} onChange={e => setQuery(e.target.value)} />{query && <button aria-label="Clear search" onClick={() => setQuery('')}><X size={14} /></button>}</label><div className="toolbar-controls"><label className="select-wrap sector-select"><Building2 size={15} /><select aria-label="Filter by sector" value={sector} onChange={e => setSector(e.target.value)}><option value="">All sectors</option>{sectors.map(s => <option key={s}>{s}</option>)}</select></label><Button small onClick={() => setFilterOpen(true)}><ListFilter size={15} />Filters{(minAmount || maxAmount || anomaliesOnly) && <span className="filter-active-dot" />}</Button><label className="select-wrap sort-select"><ArrowUpDown size={14} /><select value={sort} onChange={e => setSort(e.target.value)} aria-label="Sort companies"><option value="dossier">Dossier order</option><option value="name">Company name</option><option value="amount-desc">Amount: highest</option><option value="amount-asc">Amount: lowest</option></select></label></div></div>
      {(selected.size > 0 || activeFilters) && <div className="selection-bar"><span>{selected.size ? selected.size + ' companies selected' : filtered.length + ' matching companies'}</span>{!!selected.size && <><button onClick={() => exportCsv(true)}><ArrowDownToLine size={13} />Export selection</button><button onClick={() => setSelected(new Set())}>Deselect all</button></>}{activeFilters && <button className="clear-filters" onClick={reset}><X size={13} />Clear filters</button>}</div>}
      {!filtered.length ? <Empty title="No companies match these filters">Try another company name or CUI, or <button className="text-button" onClick={reset}>clear your filters</button>.</Empty> :
        layout === 'table' ? <div className="table-scroll"><table className="company-table"><thead><tr><th className="checkbox-cell"><input aria-label="Select visible companies" type="checkbox" checked={allSelected} onChange={() => setSelected(s => { const n = new Set(s); visible.forEach(c => allSelected ? n.delete(c.id) : n.add(c.id)); return n })} /></th><th>Company<ArrowDown size={12} /></th><th>Requested financing</th><th>Assessment</th><th>Debt coverage<span className="table-help" title="DSCR = cash available for debt service divided by debt payments">?</span></th><th>Documents</th><th /></tr></thead><tbody>{visible.map(c => {
          const a = assessments.get(c.id)
          return <tr key={c.id} onClick={() => onOpen(c.id)} className={selected.has(c.id) ? 'row-selected' : ''}><td className="checkbox-cell" onClick={e => e.stopPropagation()}><input type="checkbox" checked={selected.has(c.id)} onChange={() => toggle(c.id)} aria-label={'Select ' + c.name} /></td><td><div className="company-cell"><CompanyMark company={c} /><div><button className="company-name" aria-label={'Open ' + c.name}>{c.name}</button><span>{c.sector}<span className="inline-dot">·</span>{c.symbol}</span></div></div></td><td><strong className="table-amount">{money(requested(c))}</strong><span className="cell-subtext">Investment loan · {c.tables.solicitari[0].durata_luni} months</span></td><td>{a ? <Badge decision={a.decision} /> : <NotAssessed />}</td><td>{a ? <div className="dscr-cell"><strong className={a.metrics.dscr == null ? 'text-muted' : a.metrics.dscr < 1.2 ? 'text-red' : ''}>{ratio(a.metrics.dscr)}</strong><span className="mini-meter"><i className={a.metrics.dscr != null && a.metrics.dscr < 1.2 ? 'meter-red' : ''} style={{ width: a.metrics.dscr == null ? '0%' : Math.min(100, a.metrics.dscr / 3 * 100) + '%' }} /></span></div> : <span className="text-muted">—</span>}</td><td>{c.tables.documente.length < REQUIRED_DOCUMENTS.length ? <span className="document-count document-missing" title="Open the company to upload it"><FileText size={15} />{REQUIRED_DOCUMENTS.length - c.tables.documente.length} missing</span> : <span className="document-count"><FileText size={15} />{c.tables.documente.length}<span>files</span></span>}</td><td><ChevronRight className="row-chevron" size={17} /></td></tr>
        })}</tbody></table></div> :
          <div className="company-grid">{visible.map(c => { const a = assessments.get(c.id); return <button className="company-grid-card" key={c.id} onClick={() => onOpen(c.id)}><div><CompanyMark company={c} />{a ? <Badge decision={a.decision} small /> : <NotAssessed small />}</div><h3>{c.name}</h3><p>{c.sector} · CUI {c.cui}</p><div className="grid-card-metrics"><span>Requested<strong>{money(requested(c))}</strong></span><span>DSCR<strong>{a ? ratio(a.metrics.dscr) : '—'}</strong></span></div><div className="grid-card-footer"><span><FileText size={13} />{c.tables.documente.length} source documents</span><ArrowRight size={15} /></div></button> })}</div>}
      <div className="table-pagination"><div>Showing <strong>{filtered.length ? (currentPage - 1) * pageSize + 1 : 0}–{Math.min(currentPage * pageSize, filtered.length)}</strong> of <strong>{filtered.length}</strong> companies</div><div className="pagination-controls"><label>Rows per page<select aria-label="Rows per page" value={pageSize} onChange={e => setPageSize(Number(e.target.value))}><option>10</option><option>20</option><option>50</option></select></label><button className="pagination-arrow" disabled={currentPage === 1} onClick={() => setPage(p => p - 1)} aria-label="Previous page"><ChevronLeft size={16} /></button>{Array.from({ length: pages }, (_, i) => <button key={i} className={'page-number' + (currentPage === i + 1 ? 'current' : '')} onClick={() => setPage(i + 1)} aria-label={'Page ' + (i + 1)} aria-current={currentPage === i + 1 ? 'page' : undefined}>{i + 1}</button>)}<button className="pagination-arrow" disabled={currentPage === pages} onClick={() => setPage(p => p + 1)} aria-label="Next page"><ChevronRight size={16} /></button></div></div>
    </section>
    <div className="directory-footnote"><ShieldCheck size={14} /><span>Outcomes shown are from each company's latest completed assessment run. Companies without one are not assessed.</span><span>Financial reference: 30 Sep 2026</span></div>
    {filterOpen && <Dialog title="Refine the portfolio" description="Combine financing range and source-quality filters." onClose={() => setFilterOpen(false)}><div className="form-content"><label className="field-label">Minimum financing (RON)<input type="number" min="0" value={minAmount} onChange={e => setMinAmount(e.target.value)} placeholder="No minimum" /></label><label className="field-label">Maximum financing (RON)<input type="number" min="0" value={maxAmount} onChange={e => setMaxAmount(e.target.value)} placeholder="No maximum" /></label><label className="checkbox-label"><input type="checkbox" checked={anomaliesOnly} onChange={e => setAnomaliesOnly(e.target.checked)} /><span><strong>Only dossiers whose latest assessment found source problems</strong><small>Missing documents, unbalanced ledgers, duplicate accounts, mixed units or conflicting amounts.</small></span></label></div><div className="dialog-actions"><Button onClick={() => { setMinAmount(''); setMaxAmount(''); setAnomaliesOnly(false) }}><RotateCcw size={14} />Reset</Button><Button variant="primary" onClick={() => setFilterOpen(false)}>Show matching companies<ArrowRight size={15} /></Button></div></Dialog>}
  </div>
}

export function Overview({ companies, assessments, latest, onOpen, onQueue }: { companies: Company[]; assessments: Assessments; latest: Latest; onOpen: (id: string) => void; onQueue: () => void }) {
  const counts = [...states.map(s => ({ state: s as string, count: companies.filter(c => assessments.get(c.id)?.decision === s).length })), { state: NOT_ASSESSED, count: companies.length - assessments.size }]
  const volume = companies.reduce((n, c) => n + c.tables.solicitari[0].suma_solicitata, 0)
  const sectors = [...new Set(companies.map(c => c.sector))].map(s => ({ name: s, companies: companies.filter(c => c.sector === s) })).map(s => ({ ...s, amount: s.companies.reduce((n, c) => n + c.tables.solicitari[0].suma_solicitata, 0) })).sort((a, b) => b.amount - a.amount).slice(0, 5)
  const priorities = [...companies].filter(c => assessments.get(c.id)?.reasons.length).sort((a, b) => assessments.get(b.id)!.reasons.length - assessments.get(a.id)!.reasons.length).slice(0, 5)
  let offset = 0
  return <div className="page-enter"><div className="page-heading"><div><h1>Overview</h1><p>Where the applications stand and what needs attention.</p></div><Button onClick={onQueue}>Open review queue<ArrowRight size={16} /></Button></div><Stats companies={companies} assessments={assessments} />
    <div className="overview-grid"><section className="panel"><SectionHeading title="Assessment distribution" subtitle={'Latest completed runs · ' + latest.size + ' of ' + companies.length + ' companies assessed'} /><div className="distribution-content"><div className="donut"><svg viewBox="0 0 180 180" role="img" aria-label="Distribution of company assessment outcomes"><circle cx="90" cy="90" r="70" fill="none" stroke="#f0f1f3" strokeWidth="19" />{counts.map(({ state, count }) => { const length = count / companies.length * 439.823; const start = offset; offset += length; return <circle key={state} className={'donut-' + state} cx="90" cy="90" r="70" fill="none" strokeWidth="19" strokeDasharray={length - 4 + ' ' + (439.823 - length + 4)} strokeDashoffset={-start} transform="rotate(-90 90 90)" /> })}</svg><div><strong>{latest.size}</strong><span>assessed</span></div></div><div className="distribution-legend">{counts.map(({ state, count }) => <div key={state}><span className={'tab-dot dot-' + state} /><span>{state === NOT_ASSESSED ? 'Not assessed' : decisionLabels[state as Decision]}</span><strong>{count}</strong><small>{Math.round(count / companies.length * 100)}%</small></div>)}</div></div></section>
    <section className="panel"><SectionHeading title="Financing by sector" subtitle="Top five sectors by requested amount" /><div className="sector-chart">{sectors.map((s, i) => <div key={s.name}><div><span><span className="sector-rank">{String(i + 1).padStart(2, '0')}</span>{s.name}</span><strong>{money(s.amount, true)}</strong></div><span className="sector-bar"><i style={{ width: s.amount / sectors[0].amount * 100 + '%' }} /></span></div>)}</div><div className="chart-footer">Across all sectors<strong>{money(volume)}</strong></div></section></div>
    <div className="overview-lower"><section className="panel"><SectionHeading title="Needs attention" subtitle="Assessed companies with the most open checks" action={<button className="text-button" onClick={onQueue}>View all<ArrowRight size={14} /></button>} /><div className="priority-list">{!priorities.length && <p className="priority-empty">No assessed company has open checks. Run assessments from Companies.</p>}{priorities.map(c => <button key={c.id} onClick={() => onOpen(c.id)}><CompanyMark company={c} /><div><strong>{c.name}</strong><span>{assessments.get(c.id)!.reasons[0].title} · {assessments.get(c.id)!.reasons.length} outstanding checks</span></div><Badge decision={assessments.get(c.id)!.decision} small /><ChevronRight size={16} /></button>)}</div></section><DepartmentSummary /></div>
  </div>
}

export function PolicyPage({ policy, original, onSave }: { policy: Policy; original: Policy; onSave: (p: Policy) => Promise<void> }) {
  const [draft, setDraft] = useState(policy)
  const [saved, setSaved] = useState(false)
  useEffect(() => setDraft(policy), [policy])
  const fields = [
    ['dscr_min', 'Minimum debt service coverage', 'CFADS divided by annual debt service, including fees.', '×', .05],
    ['lichiditate_min', 'Minimum current liquidity', 'Current assets divided by current liabilities.', '×', .1],
    ['datorie_ebitda_max', 'Maximum debt / EBITDA', 'Existing drawn debt plus proposed financing / EBITDA.', '×', .1],
    ['vechime_min_luni', 'Minimum operating history', 'Months since the company was incorporated.', 'months', 1],
    ['aport_min_procente', 'Minimum own contribution', 'Applicant contribution as a percentage of the investment.', '%', 1],
  ] as const
  return <div className="page-enter"><div className="page-heading"><div><h1>Credit policy</h1><p>The rules every new assessment applies.</p></div><Button onClick={() => downloadFile('creditdesk-credit-policy.json', JSON.stringify(policy, null, 2))}><ArrowDownToLine size={16} />Export policy</Button></div>
    <div className="policy-notice"><ShieldCheck size={21} /><div><strong>Changes apply to new assessments.</strong><p>Completed assessments keep the policy they were run under, so their results never change after the fact.</p></div><span>{policy.politica_id} · v{policy.versiune}</span></div>
    <div className="policy-layout"><section className="panel"><SectionHeading title="Financial thresholds" subtitle="Edit the policy used by new assessment runs." /><div className="policy-fields">{fields.map(([key, label, description, unit, step]) => <div className="policy-field" key={key}><div><label htmlFor={key}>{label}</label><p>{description}</p></div><div className="policy-number"><input id={key} type="number" min={key === 'aport_min_procente' ? 0 : .01} max={key === 'aport_min_procente' ? 100 : undefined} step={step} value={draft[key]} onChange={e => setDraft({ ...draft, [key]: Number(e.target.value) })} /><span>{unit}</span></div></div>)}</div><div className="policy-save-bar"><Button onClick={() => setDraft(original)}><RotateCcw size={15} />Restore defaults</Button><Button variant="primary" disabled={fields.some(([k]) => !Number.isFinite(draft[k]) || draft[k] <= 0) || draft.aport_min_procente > 100} onClick={async () => { await onSave(draft); setSaved(true); setTimeout(() => setSaved(false), 3000) }}>{saved ? <CheckCheck size={16} /> : <Check size={16} />}{saved ? 'Policy saved' : 'Save policy'}</Button></div></section>
    <aside className="panel policy-rules"><SectionHeading title="Assessment logic" subtitle="Fixed checks applied with these thresholds" /><div><span>01</span><h3>Evidence comes first</h3><p>Missing financials, inconsistent amounts or an invalid trial balance produce an incomplete assessment.</p></div><div><span>02</span><h3>Repayment capacity is essential</h3><p>Monthly coverage below 1.00×, arrears over 30 days or tax obligations above zero are blocking criteria.</p></div><div><span>03</span><h3>Collateral can be remedied</h3><p>Coverage below 110% needs additional collateral or a capable verified guarantor. Cash requires blocking and source evidence.</p></div><div><span>04</span><h3>Legal uncertainty needs review</h3><p>Unconfirmed identity or defendant exposure above 20% of financing calls for human review.</p></div><div className="subtle-note">Outcome order: incomplete → not eligible → conditional → eligible. The outcome supports the credit decision; it does not replace it.</div></aside></div>
  </div>
}

export function WorkspaceAudit({ companies, events, runs, onOpen }: { companies: Company[]; events: AuditEvent[]; runs: AssessmentSummary[]; onOpen: (id: string) => void }) {
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState('all')
  const runStatus: Record<AssessmentSummary['status'], string> = { created: 'started', running: 'in progress', completed: 'completed', failed: 'failed', cancelled: 'cancelled' }
  const baselines = runs.map(r => ({ id: r.runId, companyId: r.companyId, time: r.endedAt ?? r.createdAt, action: 'Assessment run ' + runStatus[r.status], detail: (r.decision ? decisionLabels[r.decision] + ' · ' : '') + r.findings + (r.findings === 1 ? ' problem' : ' problems') + ' · run ' + r.runId.slice(0, 8) + (r.provider.id === 'codex' ? ' · Codex ' + r.provider.model : ''), actor: r.startedBy ?? 'Assessment engine', previousHash: '', hash: '' }))
  const all = (kind === 'runs' ? [] : [...events]).concat(kind === 'analyst' ? [] : baselines).sort((a, b) => b.time.localeCompare(a.time)).filter(e => {
    const c = companies.find(c => c.id === e.companyId)
    return [e.action, e.detail, c?.name, e.companyId].join(' ').toLowerCase().includes(query.toLowerCase())
  })
  return <div className="page-enter"><div className="page-heading"><div><h1>Audit trail</h1><p>Every assessment run and every action by an employee, newest first.</p></div><Button onClick={() => downloadFile('creditdesk-audit-trail.json', JSON.stringify({ exportedAt: new Date().toISOString(), activity: events, runs: baselines }, null, 2))}><ArrowDownToLine size={16} />Export activity</Button></div>
    <div className="audit-summary"><div><ShieldCheck size={20} /><span><strong>{events.length}</strong> employee actions</span></div><div><FileCheck2 size={20} /><span><strong>{runs.length}</strong> assessment runs</span></div><div><Clock3 size={20} /><span><strong>{new Set(events.map(e => e.actor)).size}</strong> employees involved</span></div></div>
    <section className="panel"><div className="audit-toolbar"><label className="search-input"><Search size={17} /><input aria-label="Search audit activity" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search companies, events or notes…" /></label><label className="select-wrap"><ListFilter size={15} /><select value={kind} onChange={e => setKind(e.target.value)} aria-label="Filter audit events"><option value="all">All activity</option><option value="analyst">Employee actions only</option><option value="runs">Assessment runs only</option></select></label></div>
      {!all.length ? <Empty title="No matching activity">Assessment runs and actions by employees appear here.</Empty> : <div className="workspace-audit-list">{all.map(e => { const c = companies.find(c => c.id === e.companyId); return <div key={e.id} className="workspace-audit-event"><span className={'timeline-marker' + (e.hash ? ' marker-yellow' : '')}>{e.hash ? <ShieldCheck size={15} /> : <FileCheck2 size={15} />}</span><div><div><strong>{e.action}</strong><time>{new Date(e.time).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</time></div><p>{e.detail}</p><div className="audit-event-bottom">{c ? <button className="text-button" onClick={() => onOpen(c.id)}>{c.name}<ArrowRight size={12} /></button> : <span>Workspace</span>}<span>{e.actor}</span>{e.hash && <span title={e.hash} className="hash-chip"><ShieldCheck size={11} />{e.hash.slice(0, 12)}</span>}</div></div></div> })}</div>}
    </section><div className="directory-footnote"><ShieldCheck size={14} /><span>Assessment runs are hash-chained per run by the engine. Employee actions are chained per company on the server and can be verified in the browser.</span></div>
  </div>
}

/** A new assessment for every company; the engine starts them a few at a time and keeps every run. */
function RunAll({ policy, total, onChange, toast }: { policy: Policy; total: number; onChange: () => void; toast: (s: string) => void }) {
  const [status, setStatus] = useState<BatchStatus | null>(null)
  const [confirm, setConfirm] = useState(false)
  useEffect(() => { batchStatus().then(setStatus).catch(() => {}) }, [])
  useEffect(() => {
    if (!status?.active) return
    const id = window.setInterval(async () => {
      const next = await batchStatus().catch(() => null)
      if (!next) return
      setStatus(next)
      onChange()
      if (!next.active) toast('All assessments finished: ' + next.finished.filter(f => f.status === 'completed').length + ' of ' + next.total + ' completed')
    }, 2000)
    return () => window.clearInterval(id)
  }, [status?.active])
  if (status?.active) {
    const done = status.finished.length
    return <div className="run-all-progress" role="status"><LoaderCircle className="spin" size={14} /><span>Assessing all companies · <strong>{done} of {status.total}</strong> done · {status.running.length} running</span><progress max={status.total} value={done} /><button className="text-button" onClick={async () => setStatus(await stopAll())}>Stop after these</button></div>
  }
  return <>
    <Button variant="primary" onClick={() => setConfirm(true)}><Play size={15} />Run all assessments</Button>
    {confirm && <Dialog title="Run a new assessment for every company?" description={total + ' companies · ' + policy.politica_id + ' v' + policy.versiune} onClose={() => setConfirm(false)}>
      <div className="form-content"><p className="dialog-text">Each company gets a new assessment under the current credit policy. Earlier assessments are kept and stay viewable. With the model two run at a time; depending on how fast the model answers, all of them take roughly 20–60 minutes. You can keep working meanwhile.</p></div>
      <div className="dialog-actions"><Button onClick={() => setConfirm(false)}>Cancel</Button><Button variant="primary" onClick={async () => { setConfirm(false); try { setStatus(await runAll(policy)); onChange(); toast('Assessments started for all companies') } catch (e: any) { toast(e.message) } }}><Play size={15} />Run {total} assessments</Button></div>
    </Dialog>}
  </>
}

/** Open cases per department, each linking to its department. */
function DepartmentSummary() {
  const { cases } = useCases({})
  return <section className="panel department-summary"><SectionHeading title="Open cases by department" subtitle="Problems sent from assessments" />
    <div>{DEPARTMENTS.map(d => {
      const open = (cases ?? []).filter(c => c.department === d.id && c.status !== 'resolved')
      const waiting = open.filter(c => c.status === 'waiting').length
      return <a key={d.id} href={'#/departments/' + d.id}><span className="dept-name">{d.name}</span><span className="dept-meta">{waiting ? waiting + ' waiting on the company' : d.handles}</span><strong>{open.length}</strong><ChevronRight size={15} /></a>
    })}</div>
  </section>
}

/** The assistant looks up the published contact of every company that has none yet, one company at a time. */
function FindContacts({ toast }: { toast: (s: string) => void }) {
  const [status, setStatus] = useState<FindAllStatus | null>(null)
  useEffect(() => { findAllStatus().then(setStatus).catch(() => {}) }, [])
  useEffect(() => {
    if (!status?.active) return
    const id = window.setInterval(async () => {
      const next = await findAllStatus().catch(() => null)
      if (!next) return
      setStatus(next)
      if (!next.active) toast('Contact research finished for ' + next.total + ' companies')
    }, 4000)
    return () => window.clearInterval(id)
  }, [status?.active])
  if (status?.active) return <div className="run-all-progress" role="status"><LoaderCircle className="spin" size={14} /><span>Finding contacts · <strong>{status.done} of {status.total}</strong></span><progress max={status.total} value={status.done} /></div>
  return <Button onClick={async () => { try { const s = await findAllContacts(); setStatus(s); toast(s.total ? 'Looking up the published contact of ' + s.total + ' companies' : 'Every company already has a contact') } catch (e: any) { toast(e.message) } }}>Find contacts</Button>
}
