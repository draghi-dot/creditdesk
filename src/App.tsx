import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowDownToLine, ArrowRight, Bell, Building2, ChevronDown, ChevronLeft, ChevronRight, CircleHelp, Command, FolderClosed, LayoutDashboard, ListFilter, Menu, PanelLeftClose, PanelLeftOpen, Search, ShieldCheck, SlidersHorizontal, Sparkles, X } from 'lucide-react'
import type { AuditEvent, Company, Policy, Portfolio } from './types'
import type { AssessmentDigest, AssessmentSummary } from './assessment'
import { decisionLabels } from './analysis'
import { Badge, Button, CompanyMark, Dialog, DocumentViewer, Loading, NotAssessed, Toast } from './components'
import { Directory, Overview, PolicyPage, WorkspaceAudit } from './Portfolio'
import CompanyDetail from './CompanyDetail'
import CompanyEntry from './CompanyEntry'
import AssessmentRun from './AssessmentRun'
import { appendEvent, downloadFile, readEvents } from './storage'
import type { EngineHealth } from './runs'
import { getHealth, startRun, useRunIndex } from './runs'

function useRoute() {
  const [route, setRoute] = useState(() => window.location.hash.slice(1) || '/companies')
  useEffect(() => { const handler = () => setRoute(window.location.hash.slice(1) || '/companies'); window.addEventListener('hashchange', handler); return () => window.removeEventListener('hashchange', handler) }, [])
  return [route, (target: string) => { window.location.hash = target; window.scrollTo({ top: 0 }) }] as const
}

export default function App() {
  const [data, setData] = useState<Portfolio | null>(null)
  const [error, setError] = useState('')
  const [policy, setPolicy] = useState<Policy | null>(null)
  const [route, navigate] = useRoute()
  const [sidebar, setSidebar] = useState(false)
  const [toast, setToast] = useState('')
  const [events, setEvents] = useState<AuditEvent[]>(readEvents)
  const [searchOpen, setSearchOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [notifications, setNotifications] = useState(false)
  const [help, setHelp] = useState(false)
  const [doc, setDoc] = useState<{ company: Company; document: any } | null>(null)
  const [sessionTime] = useState(() => new Date().toISOString())
  const [headerProfile, setHeaderProfile] = useState(false)
  const [navPreference, setNavPreference] = useState<boolean | null>(() => { try { const v = localStorage.getItem('creditdesk.nav.collapsed'); return v === null ? null : v === 'true' } catch { return null } })
  const { runs, offline, refresh: refreshRuns } = useRunIndex()
  const [health, setHealth] = useState<EngineHealth | null>(null)
  const [starting, setStarting] = useState(false)
  useEffect(() => { getHealth().then(setHealth).catch(() => setHealth(null)) }, [offline])
  useEffect(() => {
    const controller = new AbortController()
    const initialize = (value: Portfolio) => {
      setData(value)
      try { const saved = JSON.parse(localStorage.getItem('creditdesk.policy.v1') || 'null'); setPolicy(saved && saved.politica_id ? { ...value.policy, ...saved } : value.policy) } catch { setPolicy(value.policy) }
    }
    const embedded = document.getElementById('creditdesk-data')?.textContent
    if (embedded) {
      try { initialize(JSON.parse(embedded)) } catch { setError('The embedded company dataset could not be read.') }
    } else {
      fetch('/data/portfolio.json', { signal: controller.signal }).then(r => { if (!r.ok) throw new Error('The prepared dataset could not be loaded.'); return r.json() }).then(initialize)
        .catch(e => { if (e.name !== 'AbortError') setError(e.message) })
    }
    return () => controller.abort()
  }, [])
  useEffect(() => {
    const keydown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setSearchOpen(s => !s) }
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  }, [])
  useEffect(() => { if (!toast) return; const id = setTimeout(() => setToast(''), 4200); return () => clearTimeout(id) }, [toast])
  const record = useCallback(async (companyId: string, action: string, detail: string, payload?: unknown) => {
    try { const next = await appendEvent(companyId, action, detail, payload); setEvents(next); return true }
    catch { setToast('This browser could not save the activity. Please export the audit before closing.'); return false }
  }, [])
  // Decisions exist only for companies with a completed assessment run.
  const latest = useMemo(() => {
    const map = new Map<string, AssessmentSummary>()
    for (const r of runs ?? []) if (r.status === 'completed' && r.digest && !map.has(r.companyId)) map.set(r.companyId, r)
    return map
  }, [runs])
  // The engine's recorded result of each latest run; nothing is recomputed here.
  const assessments = useMemo(() => {
    const map = new Map<string, AssessmentDigest>()
    for (const [id, run] of latest) if (run.digest) map.set(id, run.digest)
    return map
  }, [latest])
  const segments = route.split('?')[0].split('/')
  const companyId = route.startsWith('/companies/') ? segments[2] : null
  const sub = segments[3] as 'run' | 'assessment' | undefined
  const subRunId = segments[4]
  const company = data?.companies.find(c => c.id === companyId)
  const view = companyId ? 'companies' : route.split('?')[0].replace('/', '')
  const counts = [...assessments.values()].reduce((acc, result) => { acc[result.decision] = (acc[result.decision] || 0) + 1; return acc }, {} as Record<string, number>)
  const runNew = async (target: Company) => {
    if (!policy) return
    setStarting(true)
    try {
      const { runId } = await startRun(target.id, policy)
      refreshRuns()
      navigate('/companies/' + target.id + '/run/' + runId)
    } catch (e: any) {
      if (e.body?.runId) navigate('/companies/' + target.id + '/run/' + e.body.runId)
      else setToast(e.message || 'The assessment engine could not start the run.')
    } finally { setStarting(false) }
  }
  const needsAttention = (counts.CONDITIONAT || 0) + (counts.DATE_INSUFICIENTE || 0)
  const nav = (target: string) => { navigate(target); setSidebar(false); setNotifications(false) }
  const showEvidence = (selected: Company, id?: string) => {
    const found = selected.tables.documente.find(d => d.document_id === id)
    if (!found) setToast('This source is missing from the dossier. Request it before completing the assessment.')
    else setDoc({ company: selected, document: found })
  }
  const matches = data?.companies.filter(c => [c.name, c.cui, c.symbol, c.id].join(' ').toLowerCase().includes(search.toLowerCase())).slice(0, 7) || []
  const onPolicySave = async (next: Policy) => {
    try {
      localStorage.setItem('creditdesk.policy.v1', JSON.stringify(next))
      setPolicy(next)
      await record('workspace', 'Demo policy updated', 'Portfolio decisions were recalculated using the updated demonstration thresholds.', { before: policy, after: next })
      setToast('Demo policy saved. New assessments will run under it; completed ones keep the policy they used.')
    } catch { setToast('The policy could not be saved in this browser.') }
  }
  // On assessment pages the navigation folds to an icon rail unless the analyst chose otherwise.
  const assessmentPage = sub === 'run' || sub === 'assessment'
  const collapsed = navPreference ?? assessmentPage
  const toggleNav = () => { const next = !collapsed; setNavPreference(next); try { localStorage.setItem('creditdesk.nav.collapsed', String(next)) } catch { /* private mode */ } }
  return <div className={'app-shell' + (collapsed ? ' nav-collapsed' : '')}>
    {sidebar && <button className="sidebar-scrim" aria-label="Close navigation" onClick={() => setSidebar(false)} />}
    <aside className={'sidebar' + (sidebar ? ' sidebar-open' : '')}>
      <a className="brand" href="#/companies"><span className="brand-symbol"><span>C</span><ArrowRight size={18} strokeWidth={2.7} /></span><div>CreditDesk<span>CORPORATE BANKING</span></div></a>
      <button className="nav-collapse" onClick={toggleNav} aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'} title={collapsed ? 'Expand navigation' : 'Collapse navigation'}>{collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}</button>
      <div className="workspace-selector"><span className="workspace-avatar"><Building2 size={16} /></span><div><strong>Corporate lending</strong><span>Internal workspace</span></div><ChevronDown size={14} /></div>
      <div className="nav-label">WORKSPACE</div>
      <nav aria-label="Main navigation">
        <button className={'nav-item' + (view === 'overview' ? ' active' : '')} onClick={() => nav('/overview')} title="Portfolio overview"><LayoutDashboard size={18} /><span className="nav-text">Portfolio overview</span></button>
        <button className={'nav-item' + (view === 'companies' ? ' active' : '')} onClick={() => nav('/companies')} title="Company dossiers"><FolderClosed size={18} /><span className="nav-text">Company dossiers</span><span className="nav-count">50</span></button>
        <button className={'nav-item' + (view === 'queue' ? ' active' : '')} onClick={() => nav('/queue')} title="Review queue"><ListFilter size={18} /><span className="nav-text">Review queue</span><span className="nav-count nav-count-yellow">{needsAttention}</span></button>
      </nav>
      <div className="nav-label governance-label">GOVERNANCE</div>
      <nav aria-label="Governance navigation">
        <button className={'nav-item' + (view === 'audit' ? ' active' : '')} onClick={() => nav('/audit')} title="Audit trail"><ShieldCheck size={18} /><span className="nav-text">Audit trail</span>{events.length > 0 && <span className="nav-count">{events.length}</span>}</button>
        <button className={'nav-item' + (view === 'policy' ? ' active' : '')} onClick={() => nav('/policy')} title="Credit policy"><SlidersHorizontal size={18} /><span className="nav-text">Credit policy</span><span className="nav-demo">DEMO</span></button>
      </nav>
      <div className="sidebar-bottom">
        <button className="explain-card" onClick={() => setHelp(true)}><span><Sparkles size={17} />Built for a second look</span><p>Every assessment leads back to its evidence.</p><div>Explore the workspace<ArrowUpRightIcon /></div></button>
        <div className="environment-indicator"><span />SIMULATION ENVIRONMENT<CircleHelp size={13} /></div>
        <button className="profile" onClick={() => setHeaderProfile(true)}><span className="user-avatar">DA</span><div><strong>Demo analyst</strong><span>Corporate credit team</span></div><ChevronDown size={14} /></button>
      </div>
    </aside>
    <div className="workspace-main">
      <header className="topbar">
        <div className="topbar-left"><button className="icon-button mobile-menu" aria-label="Open navigation" onClick={() => setSidebar(true)}><Menu size={20} /></button><span>Corporate banking</span><ChevronRight size={13} /><strong>{company ? 'Company dossier' : view === 'overview' ? 'Portfolio overview' : view === 'queue' ? 'Review queue' : view === 'audit' ? 'Audit trail' : view === 'policy' ? 'Credit policy' : 'Company dossiers'}</strong></div>
        <div className="topbar-right"><span className="reference-date">28 Oct 2026</span><span className="environment-pill"><span />Demo workspace</span><button className="global-search" onClick={() => setSearchOpen(true)} aria-label="Search workspace"><Search size={16} /><kbd>⌘ K</kbd></button>
          <div className="notification-wrap"><button className={'icon-button notification-button' + (notifications ? ' selected' : '')} aria-label="Open notifications" onClick={() => setNotifications(v => !v)}><Bell size={18} /><span /></button>
            {notifications && <div className="notification-popover"><h3>Workspace priorities<span>3</span></h3><button onClick={() => nav('/queue')}><span className="notification-dot amber" /><div><strong>{counts.DATE_INSUFICIENTE || 0} dossiers need more evidence</strong><p>Missing documents or unresolved data discrepancies.</p></div><ChevronRight size={15} /></button><button onClick={() => nav('/companies?status=ELIGIBIL')}><span className="notification-dot green" /><div><strong>{counts.ELIGIBIL || 0} meet the demo policy</strong><p>Ready for an analyst's review.</p></div><ChevronRight size={15} /></button><button onClick={() => nav('/policy')}><span className="notification-dot blue" /><div><strong>Demonstration policy is active</strong><p>Review and adjust the thresholds used across the portfolio.</p></div><ChevronRight size={15} /></button></div>}
          </div><button className="user-avatar user-avatar-small" aria-label="Open analyst profile" onClick={() => setHeaderProfile(true)}>DA</button></div>
      </header>
      <main id="main-content">
        {error ? <div className="loading"><CircleHelp size={30} /><h2>Dataset unavailable</h2><p>{error}</p><Button onClick={() => window.location.reload()}>Try again</Button></div> : !data || !policy ? <Loading /> :
          company && sub === 'run' && subRunId ? <AssessmentRun key={subRunId} company={company} runId={subRunId} onBack={() => navigate('/companies/' + company.id)} onOpenAssessment={id => navigate('/companies/' + company.id + '/assessment/' + id)} onSettled={refreshRuns} onRunNew={() => runNew(company)} toast={setToast} /> :
          company && sub === 'assessment' && subRunId ? <CompanyDetail key={subRunId} company={company} runId={subRunId} workspacePolicy={policy} events={events.filter(e => e.companyId === company.id)} onBack={() => navigate('/companies/' + company.id)} onRunNew={() => runNew(company)} showEvidence={id => showEvidence(company, id)} record={record} toast={setToast} /> :
          company ? <CompanyEntry key={company.id} company={company} runs={(runs ?? []).filter(r => r.companyId === company.id)} health={health} offline={offline} starting={starting} onBack={() => navigate('/companies')} onView={id => navigate('/companies/' + company.id + '/assessment/' + id)} onLive={id => navigate('/companies/' + company.id + '/run/' + id)} onRun={() => runNew(company)} /> :
          companyId ? <div className="empty-state"><h2>Company not found</h2><Button onClick={() => nav('/companies')}>Back to company dossiers</Button></div> :
          view === 'overview' ? <Overview companies={data.companies} assessments={assessments} latest={latest} onOpen={id => nav('/companies/' + id)} onQueue={() => nav('/queue')} /> :
          view === 'policy' ? <PolicyPage policy={policy} original={data.policy} onSave={onPolicySave} /> :
          view === 'audit' ? <WorkspaceAudit companies={data.companies} events={events} runs={runs ?? []} sessionTime={sessionTime} onOpen={id => nav('/companies/' + id)} /> :
          <Directory key={view} companies={data.companies} assessments={assessments} latest={latest} queue={view === 'queue'} initialStatus={new URLSearchParams(route.split('?')[1] || '').get('status') || ''} onOpen={id => nav('/companies/' + id)} onQueue={() => nav('/queue')} toast={setToast} />}
      </main>
      <footer className="app-footer"><span><ShieldCheck size={12} />Internal banking prototype</span><span>Synthetic financial data · Demonstration policy · No live banking connections</span><span>CreditDesk <span className="footer-version">v0.1</span></span></footer>
    </div>
    {searchOpen && <Dialog title="Find a company" description="Search company name, CUI, ticker or dossier ID." onClose={() => { setSearchOpen(false); setSearch('') }}>
      <div className="command-search"><Search size={19} /><input autoFocus value={search} onChange={e => setSearch(e.target.value)} placeholder="Search all 50 company dossiers…" aria-label="Find company" /></div>
      <div className="command-results">{matches.map(c => <button key={c.id} onClick={() => { nav('/companies/' + c.id); setSearchOpen(false); setSearch('') }}><CompanyMark company={c} /><div><strong>{c.name}</strong><span>{c.id} · CUI {c.cui}</span></div>{assessments.get(c.id) ? <Badge decision={assessments.get(c.id)!.decision} small /> : <NotAssessed small />}<ChevronRight size={16} /></button>)}{!matches.length && <p className="no-results">No matching companies. Try a different name or CUI.</p>}</div><div className="command-footer"><Command size={13} />Search the complete portfolio<span>Esc to close</span></div>
    </Dialog>}
    {help && <Dialog title="A complete credit workspace" description="Designed for an analyst to inspect, challenge and explain every decision." onClose={() => setHelp(false)}><div className="help-content"><div><FolderClosed size={20} /><h3>Run an assessment</h3><p>Ten workers review the original PDFs. Findings open the exact page and outline the figures involved.</p></div><div><SlidersHorizontal size={20} /><h3>Challenge the assessment</h3><p>Inspect each rule and its calculation. Compare four financing scenarios or test a different amount and cash-flow assumption.</p></div><div><ShieldCheck size={20} /><h3>Leave a clear trail</h3><p>Every assessment is a recorded engine run: its events are hash-chained on the server and can be verified in the browser. Analyst notes stay in this browser.</p></div><div className="info-box">This is a local UI prototype. The policy and all financial data are synthetic; no real creditworthiness is asserted.</div></div></Dialog>}
    {headerProfile && <Dialog title="Demo analyst" description="Corporate credit team · Analyst workspace" onClose={() => setHeaderProfile(false)}><div className="help-content"><div className="profile-detail"><span className="user-avatar">DA</span><div><h3>Local demonstration session</h3><p>Notes, reviews and policy edits persist in this browser. Authentication and server-side access controls are not connected in this UI prototype.</p></div></div><Button onClick={() => { downloadFile('creditdesk-local-activity.json', JSON.stringify(events, null, 2)); setToast('Local activity exported') }}><ArrowDownToLine size={16} />Export my activity</Button></div></Dialog>}
    {doc && <DocumentViewer company={doc.company} document={doc.document} onClose={() => setDoc(null)} toast={setToast} />}
    {toast && <Toast message={toast} />}
  </div>
}
function ArrowUpRightIcon() { return <ArrowRight size={14} className="rotate-up" /> }
