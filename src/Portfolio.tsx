import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { ArrowDown, ArrowDownToLine, ArrowRight, ArrowUpDown, Building2, Check, CheckCheck, ChevronLeft, ChevronRight, Clock3, FileCheck2, FileText, LayoutGrid, ListFilter, LoaderCircle, Play, RotateCcw, Search, ShieldCheck, Table2, X } from 'lucide-react'
import type { AuditEvent, Company, Decision, Policy } from './types'
import type { AssessmentDigest, AssessmentSummary } from './assessment'
import { REQUIRED_DOCUMENTS } from './assessment'
import { decisionLabels, money, ratio } from './analysis'
import { Badge, Button, Dialog, Empty, NotAssessed, SectionHeading, Select } from './components'
import { downloadFile } from './storage'
import type { Dossiers } from './runs'
import { getDossiers } from './runs'
import type { BatchStatus } from './people'
import { batchStatus, findAllContacts, findAllStatus, runAll, stopAll } from './people'
import type { FindAllStatus } from './people'

/** The engine's recorded result of the latest completed run, for companies that have one. */
type Assessments = Map<string, AssessmentDigest>
type Latest = Map<string, AssessmentSummary>
const states: Decision[] = ['ELIGIBIL', 'CONDITIONAT', 'DATE_INSUFICIENTE', 'NEELIGIBIL']
const NOT_ASSESSED = 'NONE'
const requested = (c: Company) => c.tables.solicitari[0].suma_solicitata

/** Decision filter values: one decision, every company needing attention, or the not assessed. */
const ATTENTION = 'ATTENTION'
const matchesStatus = (decision: string, status: string) => !status || decision === status || (status === ATTENTION && (decision === 'CONDITIONAT' || decision === 'DATE_INSUFICIENTE'))

/** The four headline numbers; each one filters the list to its companies. */
export function Stats({ companies, assessments, active = '', onPick }: { companies: Company[]; assessments: Assessments; active?: string; onPick: (status: string) => void }) {
  const counts = Object.fromEntries(states.map(s => [s, companies.filter(c => assessments.get(c.id)?.decision === s).length]))
  const total = companies.reduce((n, c) => n + c.tables.solicitari[0].suma_solicitata, 0)
  const notAssessed = companies.length - companies.filter(c => assessments.has(c.id)).length
  const share = (n: number) => companies.length ? n / companies.length * 100 + '%' : '0%'
  const card = (status: string, tone: string, label: string, count: number, caption: ReactNode, bar: ReactNode) =>
    <button className={'stat-card stat-pick stat-' + tone + (active === status ? ' picked' : '')} aria-pressed={active === status} onClick={() => onPick(active === status && status ? '' : status)}>
      <span className="stat-label">{label}</span>
      <span className="stat-number">{count}</span>
      <span className="stat-bar">{bar}</span>
      <span className="stat-caption">{caption}</span>
    </button>
  return <div className="stats-grid">
    {card('', 'all', 'All applications', companies.length, <>{notAssessed ? notAssessed + ' not assessed · ' : ''}{money(total, true)} requested</>,
      <>{states.map(s => <i key={s} className={'seg-' + s} style={{ width: share(counts[s]) }} />)}</>)}
    {card('ELIGIBIL', 'green', 'Eligible', counts.ELIGIBIL, 'Meet the policy · ready for review', <i className="seg-ELIGIBIL" style={{ width: share(counts.ELIGIBIL) }} />)}
    {card(ATTENTION, 'amber', 'Need attention', counts.CONDITIONAT + counts.DATE_INSUFICIENTE, counts.CONDITIONAT + ' conditional · ' + counts.DATE_INSUFICIENTE + ' incomplete',
      <><i className="seg-CONDITIONAT" style={{ width: share(counts.CONDITIONAT) }} /><i className="seg-DATE_INSUFICIENTE" style={{ width: share(counts.DATE_INSUFICIENTE) }} /></>)}
    {card('NEELIGIBIL', 'red', 'Not eligible', counts.NEELIGIBIL, 'Repayment or fiscal criteria unmet', <i className="seg-NEELIGIBIL" style={{ width: share(counts.NEELIGIBIL) }} />)}
  </div>
}

export function Directory({ companies, assessments, latest, queue, initialStatus, onOpen, toast, policy, onRunsChanged, heading }: { heading?: ReactNode; companies: Company[]; assessments: Assessments; latest: Latest; queue: boolean; initialStatus: string; onOpen: (id: string) => void; onQueue: () => void; toast: (s: string) => void; policy: Policy; runs: AssessmentSummary[]; onRunsChanged: () => void }) {
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState(initialStatus)
  const [sector, setSector] = useState('')
  const [sort, setSort] = useState('dossier')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(12)
  const [layout, setLayoutState] = useState<'table' | 'grid'>(() => { try { return localStorage.getItem('creditdesk.companies.layout') === 'table' ? 'table' : 'grid' } catch { return 'grid' } })
  const setLayout = (next: 'table' | 'grid') => { setLayoutState(next); try { localStorage.setItem('creditdesk.companies.layout', next) } catch { /* private mode */ } }
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [filterOpen, setFilterOpen] = useState(false)
  const [minAmount, setMinAmount] = useState('')
  const [maxAmount, setMaxAmount] = useState('')
  const [anomaliesOnly, setAnomaliesOnly] = useState(false)
  useEffect(() => setStatus(initialStatus), [initialStatus])
  // What is missing counts the documents employees added, not only the dossier as submitted.
  const [dossiers, setDossiers] = useState<Dossiers | null>(null)
  useEffect(() => { getDossiers().then(setDossiers).catch(() => {}) }, [])
  const missingOf = (c: Company) => dossiers?.[c.id]?.missing.length ?? Math.max(0, REQUIRED_DOCUMENTS.length - c.tables.documente.length)
  const decisionOf = (c: Company) => assessments.get(c.id)?.decision ?? NOT_ASSESSED
  const available = companies.filter(c => !queue || ['CONDITIONAT', 'DATE_INSUFICIENTE'].includes(decisionOf(c)))
  const counts = Object.fromEntries([...states, NOT_ASSESSED].map(s => [s, available.filter(c => decisionOf(c) === s).length]))
  const sectors = [...new Set(companies.map(c => c.sector))].sort()
  const filtered = useMemo(() => available.filter(c => {
    const observed = latest.get(c.id)?.observations
    return (!query || [c.name, c.symbol, c.cui, c.id, c.sector].join(' ').toLowerCase().includes(query.toLowerCase())) &&
      matchesStatus(decisionOf(c), status) && (!sector || c.sector === sector) &&
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
    <div className="page-heading"><div>{heading ?? <h1>{queue ? 'Review queue' : 'Applications'}</h1>}<p>{queue ? 'Assessed applications with conditions or missing evidence.' : 'Financing requests waiting for a decision.'}</p></div><div className="page-actions"><Button onClick={() => exportCsv()} title="Download the list as CSV"><ArrowDownToLine size={16} />Export</Button>{!queue && <FindContacts toast={toast} />}{!queue && <RunAll policy={policy} total={companies.length} onChange={onRunsChanged} toast={toast} />}</div></div>
    <Stats companies={available} assessments={assessments} active={status} onPick={setStatus} />
    <section className="portfolio-panel">
      <div className="filter-tabs" role="tablist" aria-label="Filter companies by decision"><button role="tab" aria-selected={!status} className={!status ? 'active' : ''} onClick={() => setStatus('')}>All companies<span>{available.length}</span></button>{states.map(s => <button role="tab" aria-selected={status === s} className={status === s ? 'active' : ''} key={s} onClick={() => setStatus(s)}><span className={'tab-dot dot-' + s} />{decisionLabels[s]}<span>{counts[s]}</span></button>)}{!queue && <button role="tab" aria-selected={status === NOT_ASSESSED} className={status === NOT_ASSESSED ? 'active' : ''} onClick={() => setStatus(NOT_ASSESSED)}><span className="tab-dot dot-NONE" />Not assessed<span>{counts[NOT_ASSESSED]}</span></button>}</div>
      <div className="directory-toolbar"><label className="search-input"><Search size={17} /><input aria-label="Search company directory" placeholder="Search company, CUI or dossier ID…" value={query} onChange={e => setQuery(e.target.value)} />{query && <button aria-label="Clear search" onClick={() => setQuery('')}><X size={14} /></button>}</label><div className="toolbar-controls"><div className="view-toggle"><button className={layout === 'table' ? 'selected' : ''} onClick={() => setLayout('table')} aria-label="Table view"><Table2 size={16} /></button><button className={layout === 'grid' ? 'selected' : ''} onClick={() => setLayout('grid')} aria-label="Grid view"><LayoutGrid size={16} /></button></div><Select label="Sector" icon={<Building2 size={15} />} className="sector-select" value={sector} onChange={setSector} options={[{ value: '', label: 'All sectors' }, ...sectors.map(s => ({ value: s, label: s, hint: String(available.filter(c => c.sector === s).length) }))]} /><Button small onClick={() => setFilterOpen(true)}><ListFilter size={15} />Filters{(minAmount || maxAmount || anomaliesOnly) && <span className="filter-active-dot" />}</Button><Select label="Sort" icon={<ArrowUpDown size={14} />} value={sort} onChange={setSort} options={[{ value: 'dossier', label: 'Dossier order' }, { value: 'name', label: 'Company name' }, { value: 'amount-desc', label: 'Amount: highest' }, { value: 'amount-asc', label: 'Amount: lowest' }]} /></div></div>
      {(selected.size > 0 || activeFilters) && <div className="selection-bar"><span>{selected.size ? selected.size + ' companies selected' : filtered.length + ' matching companies'}</span>{!!selected.size && <><button onClick={() => exportCsv(true)}><ArrowDownToLine size={13} />Export selection</button><button onClick={() => setSelected(new Set())}>Deselect all</button></>}{activeFilters && <button className="clear-filters" onClick={reset}><X size={13} />Clear filters</button>}</div>}
      {!filtered.length ? <Empty title="No companies match these filters">Try another company name or CUI, or <button className="text-button" onClick={reset}>clear your filters</button>.</Empty> :
        layout === 'table' ? <div className="table-scroll"><table className="company-table"><thead><tr><th className="checkbox-cell"><input aria-label="Select visible companies" type="checkbox" checked={allSelected} onChange={() => setSelected(s => { const n = new Set(s); visible.forEach(c => allSelected ? n.delete(c.id) : n.add(c.id)); return n })} /></th><th>Company<ArrowDown size={12} /></th><th>Requested financing</th><th>Assessment</th><th>Debt coverage<span className="table-help" title="DSCR = cash available for debt service divided by debt payments">?</span></th><th>Documents</th><th /></tr></thead><tbody>{visible.map(c => {
          const a = assessments.get(c.id)
          return <tr key={c.id} onClick={() => onOpen(c.id)} className={selected.has(c.id) ? 'row-selected' : ''}><td className="checkbox-cell" onClick={e => e.stopPropagation()}><input type="checkbox" checked={selected.has(c.id)} onChange={() => toggle(c.id)} aria-label={'Select ' + c.name} /></td><td><div className="company-cell"><div><button className="company-name" aria-label={'Open ' + c.name}>{c.name}</button><span>{c.sector}<span className="inline-dot">·</span>{c.symbol}</span></div></div></td><td><strong className="table-amount">{money(requested(c))}</strong><span className="cell-subtext">Investment loan · {c.tables.solicitari[0].durata_luni} months</span></td><td>{a ? <Badge decision={a.decision} /> : <NotAssessed />}</td><td>{a ? <div className="dscr-cell"><strong className={a.metrics.dscr == null ? 'text-muted' : a.metrics.dscr < 1.2 ? 'text-red' : ''}>{ratio(a.metrics.dscr)}</strong><span className="mini-meter"><i className={a.metrics.dscr != null && a.metrics.dscr < 1.2 ? 'meter-red' : ''} style={{ width: a.metrics.dscr == null ? '0%' : Math.min(100, a.metrics.dscr / 3 * 100) + '%' }} /></span></div> : <span className="text-muted">—</span>}</td><td>{missingOf(c) > 0 ? <span className="document-count document-missing" title="Open the company to upload it"><FileText size={15} />{missingOf(c)} missing</span> : <span className="document-count"><FileText size={15} />{REQUIRED_DOCUMENTS.length}<span>files</span></span>}</td><td><ChevronRight className="row-chevron" size={17} /></td></tr>
        })}</tbody></table></div> :
          <div className="company-grid">{visible.map(c => <CompanyCard key={c.id} company={c} assessment={assessments.get(c.id)} run={latest.get(c.id)} missing={missingOf(c)} added={dossiers?.[c.id]?.added.length ?? 0} onOpen={() => onOpen(c.id)} />)}</div>}
      <div className="table-pagination"><div>Showing <strong>{filtered.length ? (currentPage - 1) * pageSize + 1 : 0}–{Math.min(currentPage * pageSize, filtered.length)}</strong> of <strong>{filtered.length}</strong> companies</div><div className="pagination-controls"><label>Per page<Select small label="Per page" value={String(pageSize)} onChange={v => setPageSize(Number(v))} options={['12', '24', '48'].map(v => ({ value: v, label: v }))} /></label><button className="pagination-arrow" disabled={currentPage === 1} onClick={() => setPage(p => p - 1)} aria-label="Previous page"><ChevronLeft size={16} /></button>{Array.from({ length: pages }, (_, i) => <button key={i} className={'page-number' + (currentPage === i + 1 ? 'current' : '')} onClick={() => setPage(i + 1)} aria-label={'Page ' + (i + 1)} aria-current={currentPage === i + 1 ? 'page' : undefined}>{i + 1}</button>)}<button className="pagination-arrow" disabled={currentPage === pages} onClick={() => setPage(p => p + 1)} aria-label="Next page"><ChevronRight size={16} /></button></div></div>
    </section>
    <div className="directory-footnote"><ShieldCheck size={14} /><span>Outcomes shown are from each company's latest completed assessment run. Companies without one are not assessed.</span><span>Financial reference: 30 Sep 2026</span></div>
    {filterOpen && <Dialog title="Refine the portfolio" description="Combine financing range and source-quality filters." onClose={() => setFilterOpen(false)}><div className="form-content"><label className="field-label">Minimum financing (RON)<input type="number" min="0" value={minAmount} onChange={e => setMinAmount(e.target.value)} placeholder="No minimum" /></label><label className="field-label">Maximum financing (RON)<input type="number" min="0" value={maxAmount} onChange={e => setMaxAmount(e.target.value)} placeholder="No maximum" /></label><label className="checkbox-label"><input type="checkbox" checked={anomaliesOnly} onChange={e => setAnomaliesOnly(e.target.checked)} /><span><strong>Only dossiers whose latest assessment found source problems</strong><small>Missing documents, unbalanced ledgers, duplicate accounts, mixed units or conflicting amounts.</small></span></label></div><div className="dialog-actions"><Button onClick={() => { setMinAmount(''); setMaxAmount(''); setAnomaliesOnly(false) }}><RotateCcw size={14} />Reset</Button><Button variant="primary" onClick={() => setFilterOpen(false)}>Show matching companies<ArrowRight size={15} /></Button></div></Dialog>}
  </div>
}

/** A company in the grid: its outcome first, then the name, the request and the state of its dossier. */
function CompanyCard({ company: c, assessment: a, run, missing, added, onOpen }: { company: Company; assessment?: AssessmentDigest; run?: AssessmentSummary; missing: number; added: number; onOpen: () => void }) {
  const dscr = a?.metrics.dscr
  return <button className={'company-card card-' + (a?.decision ?? 'NONE')} onClick={onOpen}>
    <div className="cc-top">{a ? <Badge decision={a.decision} /> : <NotAssessed />}{run && run.findings > 0 && <span className="cc-problems">{run.findings} {run.findings === 1 ? 'problem' : 'problems'}</span>}</div>
    <h3>{c.name}</h3>
    <p className="cc-sub">{c.sector}<span>·</span>{c.city || 'Romania'}<span>·</span>CUI {c.cui}</p>
    <dl className="cc-figures">
      <div><dt>Requested</dt><dd>{money(requested(c), true)}</dd></div>
      <div><dt>Term</dt><dd>{c.tables.solicitari[0].durata_luni} mo</dd></div>
      <div><dt>DSCR</dt><dd className={dscr == null ? 'text-muted' : dscr < 1.2 ? 'text-red' : 'text-green'}>{a ? ratio(dscr) : '—'}</dd></div>
    </dl>
    <div className="cc-foot">
      <span className={missing > 0 ? 'cc-missing' : ''}><FileText size={13} />{missing > 0 ? missing + ' document' + (missing === 1 ? '' : 's') + ' missing' : REQUIRED_DOCUMENTS.length + ' documents' + (added ? ' · ' + added + ' added' : '')}</span>
      <span className="cc-when">{run?.endedAt ? 'Assessed ' + new Date(run.endedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : 'Not assessed yet'}</span>
      <ArrowRight size={15} />
    </div>
  </button>
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
    <section className="panel"><div className="audit-toolbar"><label className="search-input"><Search size={17} /><input aria-label="Search audit activity" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search companies, events or notes…" /></label><Select label="Activity" icon={<ListFilter size={15} />} value={kind} onChange={setKind} options={[{ value: 'all', label: 'All activity' }, { value: 'analyst', label: 'Employee actions only' }, { value: 'runs', label: 'Assessment runs only' }]} /></div>
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
