import { useCallback, useEffect, useMemo, useState } from 'react'
import { Activity, ArrowRight, Bell, Building2, Check, ChevronDown, ChevronRight, CircleHelp, Command, FolderClosed, LayoutDashboard, ListFilter, Mail, Menu, PanelLeftClose, PanelLeftOpen, Search, ShieldCheck, SlidersHorizontal, Users } from 'lucide-react'
import type { Company, Policy, Portfolio } from './types'
import type { AssessmentDigest, AssessmentSummary } from './assessment'
import type { ActivityEvent } from './workspace'
import { DEPARTMENTS, departmentName } from './workspace'
import { Badge, Button, Dialog, DocumentViewer, Loading, NotAssessed, Toast } from './components'
import { Directory, PolicyPage, WorkspaceAudit } from './Portfolio'
import Today from './Today'
import CompanyDetail from './CompanyDetail'
import CompanyEntry from './CompanyEntry'
import AssessmentRun from './AssessmentRun'
import Departments, { CasePage } from './Departments'
import Monitoring, { ClientsTable } from './LiveMonitoring'
import type { EngineHealth } from './runs'
import { getHealth, startRun, useRunIndex } from './runs'
import { disconnectGmail, getClients, gmailConnectUrl, listActivity, recordActivity, useCases, useMonitoring, useSession } from './people'

/** The first visit of the day opens on Today; later visits go straight to the companies. */
function landing() {
  try {
    const day = new Date().toDateString(), seen = localStorage.getItem('creditdesk.day')
    localStorage.setItem('creditdesk.day', day)
    return seen === day ? '/companies' : '/overview'
  } catch { return '/companies' }
}

function useRoute() {
  const [route, setRoute] = useState(() => window.location.hash.slice(1) || landing())
  useEffect(() => { const handler = () => setRoute(window.location.hash.slice(1) || '/companies'); window.addEventListener('hashchange', handler); return () => window.removeEventListener('hashchange', handler) }, [])
  return [route, (target: string) => { window.location.hash = target; window.scrollTo({ top: 0 }) }] as const
}

export default function App() {
  const [data, setData] = useState<Portfolio | null>(null)
  /** Companies with an approved credit line; they can be assessed again and are monitored. */
  const [clients, setClients] = useState<Company[]>([])
  const [error, setError] = useState('')
  const [policy, setPolicy] = useState<Policy | null>(null)
  const [route, navigate] = useRoute()
  const [sidebar, setSidebar] = useState(false)
  const [toast, setToast] = useState('')
  const [events, setEvents] = useState<ActivityEvent[]>([])
  const [searchOpen, setSearchOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [notifications, setNotifications] = useState(false)
  const [userMenu, setUserMenu] = useState(false)
  const [doc, setDoc] = useState<{ company: Company; document: any } | null>(null)
  const [navPreference, setNavPreference] = useState<boolean | null>(() => { try { const v = localStorage.getItem('creditdesk.nav.collapsed'); return v === null ? null : v === 'true' } catch { return null } })
  const { runs, offline, refresh: refreshRuns } = useRunIndex()
  const { session, switchUser, refresh: refreshSession } = useSession()
  const me = session?.user ?? null
  const { cases: myCases, refresh: refreshCases } = useCases(me ? { department: me.department } : {})
  const [health, setHealth] = useState<EngineHealth | null>(null)
  const [starting, setStarting] = useState(false)
  useEffect(() => { getHealth().then(setHealth).catch(() => setHealth(null)) }, [offline])
  const refreshActivity = useCallback(() => listActivity().then(setEvents).catch(() => {}), [])
  // Credit clients come from the engine: the approved lines, and applications whose contract was signed since.
  const loadClients = useCallback(() => getClients().then(v => setClients(v.clients)).catch(() => fetch('/data/clients.json').then(r => r.ok ? r.json() : { clients: [] }).then(v => setClients(v.clients ?? [])).catch(() => {})), [])
  useEffect(() => { const reload = () => loadClients(); window.addEventListener('creditdesk:clients', reload); return () => window.removeEventListener('creditdesk:clients', reload) }, [loadClients])
  useEffect(() => { refreshActivity() }, [refreshActivity, me?.id])
  useEffect(() => {
    const controller = new AbortController()
    const initialize = (value: Portfolio) => {
      setData(value)
      try { const saved = JSON.parse(localStorage.getItem('creditdesk.policy.v1') || 'null'); setPolicy(saved && saved.politica_id === value.policy.politica_id ? { ...value.policy, ...saved } : value.policy) } catch { setPolicy(value.policy) }
    }
    loadClients()
    fetch('/data/portfolio.json', { signal: controller.signal }).then(r => { if (!r.ok) throw new Error('The company data could not be loaded.'); return r.json() }).then(initialize)
      .catch(e => { if (e.name !== 'AbortError') setError(e.message) })
    return () => controller.abort()
  }, [])
  useEffect(() => {
    const keydown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setSearchOpen(s => !s) }
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  }, [])
  useEffect(() => { const changed = () => refreshSession(); window.addEventListener('creditdesk:session', changed); return () => window.removeEventListener('creditdesk:session', changed) }, [refreshSession])
  useEffect(() => { if (!toast) return; const id = setTimeout(() => setToast(''), 4200); return () => clearTimeout(id) }, [toast])
  // Back from Google's sign-in page: ?gmail=connected, or the reason it did not connect.
  useEffect(() => {
    const result = new URLSearchParams(route.split('?')[1] || '').get('gmail')
    if (!result) return
    setToast(result === 'connected' ? 'Gmail connected. Requests you send now go from your mailbox.' : 'Gmail was not connected: ' + result)
    refreshSession()
    navigate(route.split('?')[0])
  }, [route])
  const record = useCallback(async (companyId: string, action: string, detail: string, payload?: unknown) => {
    try { await recordActivity(companyId, action, detail, payload); await refreshActivity(); return true }
    catch { setToast('The activity could not be saved. Check that the engine is running.'); return false }
  }, [refreshActivity])
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
  const path = route.split('?')[0]
  const segments = path.split('/')
  const companyId = path.startsWith('/companies/') ? segments[2] : null
  const sub = segments[3] as 'run' | 'assessment' | undefined
  const subRunId = segments[4]
  // A signed application is a credit client, no longer an application.
  const applications = useMemo(() => (data?.companies ?? []).filter(c => !clients.some(k => k.id === c.id)), [data, clients])
  const everyone = useMemo(() => [...applications, ...clients], [applications, clients])
  const company = everyone.find(c => c.id === companyId)
  const view = companyId ? 'companies' : segments[1] || 'companies'
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
  // A new assessment asked for from elsewhere (the early-warning assistant).
  useEffect(() => { const run = (e: Event) => { const target = everyone.find(c => c.id === (e as CustomEvent<string>).detail); if (target) runNew(target) }; window.addEventListener('creditdesk:run', run); return () => window.removeEventListener('creditdesk:run', run) }, [everyone, policy])
  const { state: monitoring } = useMonitoring()
  const monitoringOpen = (monitoring?.clients ?? []).reduce((n, c) => n + c.open, 0)
  const openMine = (myCases ?? []).filter(c => c.status !== 'resolved')
  const assignedToMe = openMine.filter(c => c.assignee === me?.name)
  const nav = (target: string) => { navigate(target); setSidebar(false); setNotifications(false); setUserMenu(false) }
  const showEvidence = (selected: Company, id?: string) => {
    const found = selected.tables.documente.find(d => d.document_id === id)
    if (!found) setToast('This document is not in the dossier. Add it from the company page.')
    else setDoc({ company: selected, document: found })
  }
  const matches = everyone.filter(c => [c.name, c.cui, c.symbol, c.id].join(' ').toLowerCase().includes(search.toLowerCase())).slice(0, 7) || []
  const onPolicySave = async (next: Policy) => {
    try {
      localStorage.setItem('creditdesk.policy.v1', JSON.stringify(next))
      setPolicy(next)
      await record('workspace', 'Credit policy updated', 'New assessments run under the updated thresholds.', { before: policy, after: next })
      setToast('Policy saved. New assessments run under it; completed ones keep the policy they used.')
    } catch { setToast('The policy could not be saved in this browser.') }
  }
  const choose = async (id: string) => { setUserMenu(false); const s = await switchUser(id); refreshCases(); if (s) setToast('Signed in as ' + s.user.name + ' · ' + departmentName(s.user.department)) }
  const title = company ? company.name : view === 'overview' ? 'Today' : view === 'queue' ? 'Review queue' : view === 'audit' ? 'Audit trail' : view === 'policy' ? 'Credit policy' : view === 'departments' || view === 'cases' ? 'Departments' : view === 'monitoring' ? 'Live monitoring' : view === 'clients' ? 'Credit clients' : 'Companies'
  // On assessment pages the navigation folds to an icon rail unless the employee chose otherwise.
  const assessmentPage = sub === 'run' || sub === 'assessment'
  const collapsed = navPreference ?? assessmentPage
  const toggleNav = () => { const next = !collapsed; setNavPreference(next); try { localStorage.setItem('creditdesk.nav.collapsed', String(next)) } catch { /* private mode */ } }
  const item = (target: string, active: boolean, Icon: typeof Users, label: string, count?: number | null, hint?: string) =>
    <button className={'nav-item' + (active ? ' active' : '')} onClick={() => nav(target)} title={hint ?? label}><Icon size={18} /><span className="nav-text">{label}</span>{count ? <span className="nav-count" aria-label={hint}>{count}</span> : null}</button>
  return <div className={'app-shell' + (collapsed ? ' nav-collapsed' : '')}>
    {sidebar && <button className="sidebar-scrim" aria-label="Close navigation" onClick={() => setSidebar(false)} />}
    <aside className={'sidebar' + (sidebar ? ' sidebar-open' : '')}>
      <a className="brand" href="#/overview" aria-label="finra"><span className="wordmark"><u>fin</u>ra</span><span className="wordmark wordmark-short"><u>f</u></span></a>
      <button className="nav-collapse" onClick={toggleNav} aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'} title={collapsed ? 'Expand navigation' : 'Collapse navigation'}>{collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}</button>
      <nav aria-label="Main navigation">
        {item('/overview', view === 'overview', LayoutDashboard, 'Today')}
        {item('/companies', view === 'companies' || view === 'clients', FolderClosed, 'Companies', everyone.length || null)}
        {item('/queue', view === 'queue', ListFilter, 'Review queue', needsAttention)}
        {item('/departments' + (me ? '/' + me.department : ''), view === 'departments' || view === 'cases', Users, 'Departments', openMine.length)}
        {item('/monitoring', view === 'monitoring', Activity, 'Live monitoring', monitoringOpen || null, monitoringOpen ? monitoringOpen + (monitoringOpen === 1 ? ' change found by monitoring is' : ' changes found by monitoring are') + ' waiting for review' : undefined)}
      </nav>
      <div className="nav-label">Governance</div>
      <nav aria-label="Governance navigation">
        {item('/audit', view === 'audit', ShieldCheck, 'Audit trail')}
        {item('/policy', view === 'policy', SlidersHorizontal, 'Credit policy')}
      </nav>
      <div className="sidebar-bottom">
        {me && <button className="profile" onClick={() => setUserMenu(v => !v)} aria-haspopup="menu" aria-expanded={userMenu}><span className="user-avatar">{me.initials}</span><div><strong>{me.name}</strong><span>{me.title} · {departmentName(me.department)}</span></div><ChevronDown size={14} /></button>}
      </div>
    </aside>
    <div className="workspace-main">
      <header className="topbar">
        <div className="topbar-left"><button className="icon-button mobile-menu" aria-label="Open navigation" onClick={() => setSidebar(true)}><Menu size={20} /></button><span>Corporate lending</span><ChevronRight size={13} /><strong>{title}</strong></div>
        <div className="topbar-right">
          <button className="global-search" onClick={() => setSearchOpen(true)} aria-label="Find a company"><Search size={16} /><span>Find a company</span><kbd>⌘ K</kbd></button>
          <div className="notification-wrap"><button className={'icon-button notification-button' + (notifications ? ' selected' : '')} aria-label="Open notifications" onClick={() => { setNotifications(v => !v); setUserMenu(false); refreshCases() }}><Bell size={18} />{assignedToMe.length > 0 && <span />}</button>
            {notifications && me && <div className="notification-popover"><h3>{departmentName(me.department)} cases<span>{openMine.length}</span></h3>
              {openMine.slice(0, 5).map(c => <button key={c.id} onClick={() => nav('/cases/' + c.id)}><span className={'notification-dot ' + (c.assignee === me.name ? 'amber' : 'blue')} /><div><strong>{c.ref} · {c.title}</strong><p>{c.companyName}{c.assignee ? ' · ' + c.assignee : ' · not assigned'}</p></div><ChevronRight size={15} /></button>)}
              {!openMine.length && <p className="notification-empty">No open cases in {departmentName(me.department)}.</p>}
              <button className="notification-all" onClick={() => nav('/departments/' + me.department)}>Open {departmentName(me.department)}<ChevronRight size={14} /></button></div>}
          </div>
          {me && <button className="user-avatar user-avatar-small" aria-label="Switch employee" onClick={() => { setUserMenu(v => !v); setNotifications(false) }}>{me.initials}</button>}
        </div>
      </header>
      {userMenu && session && <UserMenu session={session} onChoose={choose} onClose={() => setUserMenu(false)} onGmailChange={() => { refreshSession() }} route={path} toast={setToast} />}
      <main id="main-content">
        {error ? <div className="loading"><CircleHelp size={30} /><h2>Company data unavailable</h2><p>{error}</p><Button onClick={() => window.location.reload()}>Try again</Button></div> : !data || !policy ? <Loading /> :
          company && sub === 'run' && subRunId ? <AssessmentRun key={subRunId} company={company} runId={subRunId} onBack={() => navigate('/companies/' + company.id)} onOpenAssessment={id => navigate('/companies/' + company.id + '/assessment/' + id)} onSettled={refreshRuns} onRunNew={() => runNew(company)} toast={setToast} /> :
          company && sub === 'assessment' && subRunId ? <CompanyDetail key={subRunId} company={company} runId={subRunId} workspacePolicy={policy} events={events.filter(e => e.companyId === company.id)} onBack={() => navigate('/companies/' + company.id)} onRunNew={() => runNew(company)} showEvidence={id => showEvidence(company, id)} record={record} toast={setToast} /> :
          company ? <CompanyEntry key={company.id} company={company} runs={(runs ?? []).filter(r => r.companyId === company.id)} health={health} offline={offline} starting={starting} onBack={() => navigate('/companies')} onView={id => navigate('/companies/' + company.id + '/assessment/' + id)} onLive={id => navigate('/companies/' + company.id + '/run/' + id)} onRun={() => runNew(company)} onCase={id => nav('/cases/' + id)} toast={setToast} gmail={session?.gmail ?? null} /> :
          companyId ? <div className="empty-state"><h2>Company not found</h2><Button onClick={() => nav('/companies')}>Back to companies</Button></div> :
          view === 'overview' ? <Today me={me} companies={applications} clients={clients} assessments={assessments} latest={latest} runs={runs ?? []} events={events} nav={nav} /> :
          view === 'policy' ? <PolicyPage policy={policy} original={data.policy} onSave={onPolicySave} /> :
          view === 'audit' ? <WorkspaceAudit companies={everyone} events={events} runs={runs ?? []} onOpen={id => nav('/companies/' + id)} /> :
          view === 'cases' && segments[2] ? <CasePage key={segments[2]} caseId={segments[2]} companies={everyone} session={session} onCompany={id => nav('/companies/' + id)} onDepartment={d => nav('/departments/' + d)} toast={setToast} onChange={refreshCases} /> :
          view === 'monitoring' ? <Monitoring clients={clients} onOpen={id => nav('/companies/' + id)} toast={setToast} /> :
          view === 'clients' ? <div className="page-enter"><div className="page-heading"><div><CompaniesTabs view="clients" applications={applications.length} clients={clients.length} onView={nav} /><p>Approved and drawn credit lines. Live monitoring checks each one every hour.</p></div></div><ClientsTable clients={clients} latest={latest} onOpen={id => nav('/companies/' + id)} /></div> :
          view === 'departments' ? <Departments department={DEPARTMENTS.some(d => d.id === segments[2]) ? segments[2] as typeof DEPARTMENTS[number]['id'] : me?.department ?? 'legal'} session={session} onDepartment={d => nav('/departments/' + d)} onCase={id => nav('/cases/' + id)} onSessionChange={refreshSession} toast={setToast} /> :
          <><Directory heading={view === 'queue' ? undefined : <CompaniesTabs view="applications" applications={applications.length} clients={clients.length} onView={nav} />} key={view} companies={applications} assessments={assessments} latest={latest} queue={view === 'queue'} initialStatus={new URLSearchParams(route.split('?')[1] || '').get('status') || ''} onOpen={id => nav('/companies/' + id)} onQueue={() => nav('/queue')} toast={setToast} policy={policy} runs={runs ?? []} onRunsChanged={refreshRuns} /></>}
      </main>
    </div>
    {searchOpen && <Dialog title="Find a company" description="Search by company name, CUI, ticker or dossier number." onClose={() => { setSearchOpen(false); setSearch('') }}>
      <div className="command-search"><Search size={19} /><input autoFocus value={search} onChange={e => setSearch(e.target.value)} placeholder="Company name or CUI…" aria-label="Find company" /></div>
      <div className="command-results">{matches.map(c => <button key={c.id} onClick={() => { nav('/companies/' + c.id); setSearchOpen(false); setSearch('') }}><div><strong>{c.name}</strong><span>{c.id} · CUI {c.cui}</span></div>{assessments.get(c.id) ? <Badge decision={assessments.get(c.id)!.decision} small /> : <NotAssessed small />}<ChevronRight size={16} /></button>)}{!matches.length && <p className="no-results">No matching companies. Try a different name or CUI.</p>}</div><div className="command-footer"><Command size={13} />All {data?.companies.length ?? 0} companies<span>Esc to close</span></div>
    </Dialog>}
    {doc && <DocumentViewer company={doc.company} document={doc.document} onClose={() => setDoc(null)} toast={setToast} />}
    {toast && <Toast message={toast} />}
  </div>
}

/** Switch the employee this browser acts as, and connect their Gmail. */
function UserMenu({ session, onChoose, onClose, onGmailChange, route, toast }: { session: NonNullable<ReturnType<typeof useSession>['session']>; onChoose: (id: string) => void; onClose: () => void; onGmailChange: () => void; route: string; toast: (s: string) => void }) {
  const { user, users, gmail } = session
  return <>
    <button className="menu-scrim" aria-label="Close menu" onClick={onClose} />
    <div className="user-menu" role="menu">
      <div className="user-menu-head"><span className="user-avatar">{user.initials}</span><div><strong>{user.name}</strong><span>{user.title} · {departmentName(user.department)}</span></div></div>
      <div className="user-menu-mail"><Mail size={14} />{gmail.connected ? <><span>Gmail: <strong>{gmail.connected.email}</strong></span><button onClick={async () => { await disconnectGmail(); onGmailChange(); toast('Gmail disconnected') }}>Disconnect</button></>
        : gmail.configured ? <><span>Gmail not connected</span><a href={gmailConnectUrl(user.id, '/#' + route)}>Connect Gmail</a></>
        : <span>Gmail is not set up for this workspace. See README → Gmail.</span>}</div>
      <div className="user-menu-label">Switch employee</div>
      {DEPARTMENTS.map(d => {
        const people = users.filter(u => u.department === d.id)
        return people.length ? <div key={d.id} className="user-menu-group"><span>{d.name}</span>{people.map(u => <button key={u.id} role="menuitemradio" aria-checked={u.id === user.id} onClick={() => onChoose(u.id)}><span className="user-avatar">{u.initials}</span><div><strong>{u.name}</strong><small>{u.title}</small></div>{u.id === user.id && <Check size={14} />}</button>)}</div> : null
      })}
      <div className="user-menu-foot"><Building2 size={13} />Employees and departments are managed under Departments.</div>
    </div>
  </>
}

/** Applications under review and companies that already have approved credit. */
function CompaniesTabs({ view, applications, clients, onView }: { view: 'applications' | 'clients'; applications: number; clients: number; onView: (route: string) => void }) {
  return <div className="companies-tabs" role="tablist" aria-label="Companies">
    <button role="tab" aria-selected={view === 'applications'} className={view === 'applications' ? 'active' : ''} onClick={() => onView('/companies')}>Applications<span>{applications}</span></button>
    <button role="tab" aria-selected={view === 'clients'} className={view === 'clients' ? 'active' : ''} onClick={() => onView('/clients')}>Credit clients<span>{clients}</span></button>
  </div>
}
