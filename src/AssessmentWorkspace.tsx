import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { ArrowRight, ArrowUpRight, Check, CircleAlert, ClipboardCopy, Download, FileSearch, FileX2, ListChecks, LoaderCircle, MessageSquareText, PanelLeftClose, PanelLeftOpen, Radio, Send, ShieldCheck, Sparkles, X } from 'lucide-react'
import type { AgentId, AskAnswer, CheckResult, EvidenceRef, FindingView, RunEvent, RunView } from './assessment'
import { DEPENDENT_CHECKS, REQUIRED_DOCUMENTS, rankFindings } from './assessment'
import type { Company } from './types'
import { decisionLabels, ratio } from './analysis'
import { docNames } from './documents'
import { AgentMap, EvidenceViewer, FindingDetail, ImpactTag, NoteCard, emphasize, workerIcons } from './AssessmentUI'
import { askQuestion, clock, duration, listQuestions } from './runs'
import { AddDocumentButton } from './DossierDocuments'
import { downloadFile } from './storage'

type Panel = 'evidence' | 'ask' | 'activity' | 'sources'
/** A finding, or a place in the documents: from an answer, or opened while reading a finding (`back`). */
type Focus = { finding: string } | { evidence: EvidenceRef[]; title: string; back?: string } | null

/** How long an automatically opened finding stays in view before the next one. */
const DWELL_MS = 2600

const SUGGESTIONS = ['What is the biggest problem?', 'Why did the assessment reach this decision?', 'Which documents have to be corrected?', 'Is the company identity confirmed?']
const ABOUT_SUGGESTIONS = ['Explain this problem in plain words', 'What would resolve it?', 'Which figures cause it?', 'How does it change the decision?']

const storedMap = () => { try { return localStorage.getItem('creditdesk.map.hidden') === 'true' } catch { return false } }

export function describe(e: RunEvent, view: RunView): string | null {
  const p = e.payload as any
  const name = e.worker ? view.workers[e.worker]?.role.name ?? e.worker : 'Engine'
  switch (e.type) {
    case 'run_started': return 'Run started'
    case 'worker_dispatched': return name + ' dispatched'
    case 'worker_waiting': return 'Waiting for ' + p.waitingFor.map((d: AgentId) => view.workers[d]?.role.name ?? d).join(', ')
    case 'worker_activity': return p.text
    case 'llm_started': return 'Model working: ' + p.purpose
    case 'llm_finished': return p.ok ? 'Model answered in ' + (p.durationMs / 1000).toFixed(1) + ' s' : 'Model call failed: ' + p.reason
    case 'finding_raised': return 'Finding: ' + p.finding.title
    case 'worker_completed': return 'Completed · ' + p.summary
    case 'worker_failed': return 'Failed · ' + p.reason
    case 'decision_reached': return 'Decision: ' + decisionLabels[p.decision as keyof typeof decisionLabels]
    case 'report_written': return 'Assessment report written'
    case 'run_completed': return 'Run completed'
    case 'run_failed': return 'Run failed · ' + p.reason
    case 'run_cancelled': return 'Run cancelled by ' + p.by
    default: return null
  }
}

/**
 * The assessment workspace, shared by the live run and the completed
 * assessment: map and investigation panel fitted to the screen, then the
 * checks, the problems ranked by importance and the written report.
 */
export default function AssessmentWorkspace({ company, view, events, live, connection, initialPanel, onRunNew }: {
  company: Company; view: RunView; events: RunEvent[]; live: boolean; connection?: string; initialPanel?: Panel; onRunNew?: () => void
}) {
  const ranked = useMemo(() => rankFindings(view.findings, view.decision), [view.findings.length, view.decision])
  const [panel, setPanel] = useState<Panel>(initialPanel ?? (live ? 'activity' : ranked.length ? 'evidence' : 'ask'))
  const [focus, setFocus] = useState<Focus>(!live && ranked[0] ? { finding: ranked[0].id } : null)
  const [follow, setFollow] = useState(live)
  const [shownAt, setShownAt] = useState(0)
  const [worker, setWorker] = useState<AgentId | null>(null)
  const [mapHidden, setMapHidden] = useState(storedMap)
  const [askAbout, setAskAbout] = useState<string | null>(null)
  const top = useRef<HTMLDivElement>(null)
  const toggleMap = () => setMapHidden(h => { try { localStorage.setItem('creditdesk.map.hidden', String(!h)) } catch { /* private mode */ } return !h })

  // Live: open each finding as the engine raises it, in the order raised.
  const raised = view.findings
  const focusedId = focus && 'finding' in focus ? focus.finding : null
  useEffect(() => {
    if (!follow) return
    const index = raised.findIndex(f => f.id === focusedId)
    const next = raised[index + 1]
    if (!next) return
    const timer = window.setTimeout(() => {
      setFocus({ finding: next.id })
      setShownAt(Date.now())
      setPanel(p => p === 'ask' || p === 'sources' ? p : 'evidence')
    }, Math.max(0, shownAt + DWELL_MS - Date.now()))
    return () => window.clearTimeout(timer)
  }, [follow, raised.length, focusedId, shownAt])

  const open = (next: Focus, scroll = false) => {
    setFollow(false)
    setFocus(next)
    setPanel('evidence')
    if (scroll) top.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  // An answer opens its finding, unless it located a different passage of its own.
  const openAnswer = (answer: AskAnswer) => {
    const finding = answer.findingId ? view.findings.find(f => f.id === answer.findingId) : undefined
    const samePlace = (e: EvidenceRef) => finding?.evidence.some(f => f.documentId === e.documentId && f.page === e.page)
    if (finding && (!answer.evidence.length || answer.evidence.every(samePlace))) open({ finding: finding.id })
    else if (answer.evidence.length) open({ evidence: answer.evidence, title: answer.question })
  }
  const focusedFinding = focusedId ? view.findings.find(f => f.id === focusedId) ?? null : null
  const rankOf = (id: string) => ranked.findIndex(f => f.id === id) + 1
  const highlight = focusedFinding?.worker ?? worker

  return <div className="ws">
    <div className={'ws-top' + (mapHidden ? ' map-hidden' : '')} ref={top}>
      {mapHidden ? <section className="ws-map-rail" aria-label="Agent map (hidden)">
        <button className="ws-icon" onClick={toggleMap} title="Show the agent map" aria-label="Show the agent map"><PanelLeftOpen size={14} /></button>
        {view.order.filter(id => view.workers[id].state !== 'hidden').map(id => { const w = view.workers[id]; const Icon = workerIcons[id]; return <button key={id} className={'rail-worker state-' + w.state + (highlight === id ? ' rail-highlight' : '')} title={w.role.name + ' · ' + w.state + (w.summary ? ' · ' + w.summary : '')} onClick={() => { setWorker(id); setPanel('activity') }}><Icon size={14} />{w.findings.length > 0 && <span>{w.findings.length}</span>}</button> })}
      </section> : <section className="ws-map">
        <div className="ws-heading"><h2>Agent map</h2><MapStatus view={view} live={live} /><button className="ws-icon" onClick={toggleMap} title="Hide the map to give the evidence more room" aria-label="Hide the agent map"><PanelLeftClose size={14} /></button></div>
        <AgentMap view={view} selected={worker} highlight={highlight} fit onSelect={id => { setWorker(w => w === id ? null : id); setPanel('activity') }} />
        <div className="ws-legend"><span><i className="lg-waiting" />Waiting</span><span><i className="lg-running" />Working</span><span><i className="lg-done" />Done</span><span><i className="lg-attention" />Raised findings</span><span className="ws-legend-hint">Select a worker to see what it did</span></div>
      </section>}
      <aside className="ws-panel">
        <div className="ws-tabs" role="tablist">
          <button role="tab" aria-selected={panel === 'evidence'} className={panel === 'evidence' ? 'active' : ''} onClick={() => setPanel('evidence')}><FileSearch size={13} />Evidence{ranked.length > 0 && <span className="ws-count alert">{ranked.length}</span>}</button>
          <button role="tab" aria-selected={panel === 'ask'} className={panel === 'ask' ? 'active' : ''} onClick={() => setPanel('ask')}><MessageSquareText size={13} />Ask</button>
          <button role="tab" aria-selected={panel === 'activity'} className={panel === 'activity' ? 'active' : ''} onClick={() => setPanel('activity')}><Radio size={13} />Activity</button>
          <button role="tab" aria-selected={panel === 'sources'} className={panel === 'sources' ? 'active' : ''} onClick={() => setPanel('sources')}><ShieldCheck size={13} />Sources{view.notes.length > 0 && <span className="ws-count">{view.notes.length}</span>}</button>
        </div>
        <div className="ws-panel-body">
          {panel === 'evidence' && <EvidencePanel company={company} view={view} finding={focusedFinding} rank={focusedFinding ? rankOf(focusedFinding.id) : 0} total={ranked.length}
            location={focus && 'evidence' in focus ? focus : null} follow={follow} live={live}
            onFollow={() => { setFollow(true); setShownAt(0) }} onClose={() => setFocus(null)} onStep={d => { const i = ranked.findIndex(f => f.id === focusedId); const n = ranked[i + d]; if (n) open({ finding: n.id }) }}
            onWorker={id => { setWorker(id); setPanel('activity') }} onTop={() => ranked[0] && open({ finding: ranked[0].id })} onLocate={(evidence, title) => open({ evidence, title, back: focusedId ?? undefined })} onBack={id => open({ finding: id })}
            onAsk={id => { setAskAbout(id); setPanel('ask') }} ranked={ranked} onSelect={id => open({ finding: id })} onRunNew={onRunNew} />}
          <div hidden={panel !== 'ask'} className="ws-ask-wrap"><AskPanel view={view} onOpen={openAnswer} about={askAbout ? view.findings.find(f => f.id === askAbout) ?? null : null} aboutRank={askAbout ? rankOf(askAbout) : 0} onClearAbout={() => setAskAbout(null)} /></div>
          {panel === 'activity' && <ActivityPanel view={view} events={events} worker={worker} onClear={() => setWorker(null)} connection={connection} />}
          {panel === 'sources' && <div className="ws-sources">{view.notes.length ? view.notes.map(n => <NoteCard key={n.seq} note={n} view={view} />) : <Empty icon={<ShieldCheck size={20} />} title="No sources yet">Identity research and legal review post what they consulted here.</Empty>}</div>}
        </div>
      </aside>
    </div>

    <CheckStrip view={view} live={live} />
    <ProblemList view={view} ranked={ranked} focused={focusedId} live={live} onOpen={id => open({ finding: id }, true)} />
    <ReportView company={company} view={view} live={live} ranked={ranked} onOpen={id => open({ finding: id }, true)} />
  </div>
}

function MapStatus({ view, live }: { view: RunView; live: boolean }) {
  const ws = Object.values(view.workers)
  const working = ws.filter(w => w.state === 'running').length
  const done = ws.filter(w => w.state === 'done' || w.state === 'attention').length
  return <span className="ws-map-status">{live && view.status === 'running' ? <><LoaderCircle size={11} className="spin" />{working} working · {done} of {ws.length} done</> : done + ' of ' + ws.length + ' workers completed'}</span>
}

function Empty({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return <div className="ws-empty">{icon}<strong>{title}</strong><p>{children}</p></div>
}

function EvidencePanel({ company, view, finding, rank, total, location, follow, live, onFollow, onClose, onStep, onWorker, onTop, onLocate, onBack, onAsk, ranked, onSelect, onRunNew }: {
  company: Company; view: RunView; finding: FindingView | null; rank: number; total: number; location: { evidence: EvidenceRef[]; title: string; back?: string } | null
  follow: boolean; live: boolean; onFollow: () => void; onClose: () => void; onStep: (d: number) => void; onWorker: (id: AgentId) => void; onTop: () => void
  onLocate: (evidence: EvidenceRef[], title: string) => void; onBack: (findingId: string) => void
  onAsk: (findingId: string) => void; ranked: FindingView[]; onSelect: (findingId: string) => void; onRunNew?: () => void
}) {
  const missing = finding && !finding.evidence.length ? finding.missingDocument ?? (finding.ruleIds.includes('DATA-01') ? REQUIRED_DOCUMENTS.find(k => finding.title.endsWith(docNames[k])) : undefined) : undefined
  if (finding) return <div className="ws-evidence">
    <div className="ws-evidence-bar">
      <span className="ws-rank">#{rank}<small>of {total}</small></span>
      <span>{rank === 1 ? 'Most important problem' : 'Problem ' + rank + ' by importance'}</span>
      <button className="ask-about" onClick={() => onAsk(finding.id)} title="Ask the assistant about this problem"><MessageSquareText size={12} />Ask about this</button>
      {live && view.status === 'running' && <button className={'follow-toggle' + (follow ? ' on' : '')} onClick={onFollow}>{follow ? 'Following' : 'Follow new'}</button>}
      <button className="ws-icon" onClick={() => onStep(-1)} disabled={rank <= 1} aria-label="Previous problem">‹</button>
      <button className="ws-icon" onClick={() => onStep(1)} disabled={rank >= total} aria-label="Next problem">›</button>
      <button className="ws-icon" onClick={onClose} aria-label="Close"><X size={13} /></button>
    </div>
    <FindingDetail finding={finding} view={view} onWorker={onWorker} compact />
    {missing ? <MissingDocument company={company} view={view} kind={missing} onLocate={onLocate} onRunNew={onRunNew} /> : <EvidenceViewer companyId={company.id} evidence={finding.evidence} title={finding.observed}
      aside={<LightboxContext finding={finding} rank={rank} ranked={ranked} view={view} onSelect={onSelect} onAsk={onAsk} />} />}
  </div>
  if (location) return <div className="ws-evidence">
    <div className="ws-evidence-bar">{location.back
      ? <><button className="ws-back" onClick={() => onBack(location.back!)}>‹ Back to problem</button><span className="ws-location-title">Dossier document: {location.title}</span></>
      : <><MessageSquareText size={13} /><span className="ws-location-title">From your question: “{location.title}”</span></>}<button className="ws-icon" onClick={onClose} aria-label="Close"><X size={13} /></button></div>
    <EvidenceViewer companyId={company.id} evidence={location.evidence} title="The answer did not point to a place in the documents." />
  </div>
  return <Empty icon={<FileSearch size={20} />} title={total ? 'Select a problem' : view.status === 'completed' ? 'No problems found' : 'No problems found yet'}>
    {total ? <>Pick a problem from the ranked list below, or <button className="text-button" onClick={onTop}>open the most important one<ArrowRight size={12} /></button></> :
      view.status === 'completed' ? 'Every document reconciled and every policy check passed. Ask a question or read the report below.' :
        'When a worker finds an issue, its original page opens here with the figures outlined.'}
  </Empty>
}

/** Next to the expanded page: the problem, and the other problems on the same document. */
function LightboxContext({ finding, rank, ranked, view, onSelect, onAsk }: { finding: FindingView; rank: number; ranked: FindingView[]; view: RunView; onSelect: (id: string) => void; onAsk: (id: string) => void }) {
  const docs = new Set(finding.evidence.map(e => e.documentId))
  const related = ranked.filter(f => f.evidence.some(e => docs.has(e.documentId)))
  return <div className="lightbox-context">
    <div className="lightbox-finding"><div><span className="ws-rank">#{rank}</span><ImpactTag impact={finding.impact} /></div><strong>{finding.title}</strong>
      <dl><dt>Observed</dt><dd>{emphasize(finding.observed)}</dd><dt>Compared against</dt><dd>{emphasize(finding.comparedAgainst)}</dd><dt>Effect</dt><dd>{emphasize(finding.effect)}</dd></dl>
      <button className="ask-about" onClick={() => onAsk(finding.id)}><MessageSquareText size={12} />Ask about this</button></div>
    {related.length > 1 && <><h5>Problems in this document</h5><ul className="lightbox-related">{related.map(f => <li key={f.id}><button className={f.id === finding.id ? 'active' : ''} onClick={() => onSelect(f.id)}><span>#{ranked.indexOf(f) + 1}</span>{f.title}</button></li>)}</ul></>}
    <small className="lightbox-note">{view.workers[finding.worker]?.role.name} · event #{finding.seq}</small>
  </div>
}

/** In place of a page: what the dossier does contain, and what the gap prevents. */
function MissingDocument({ company, view, kind, onLocate, onRunNew }: { company: Company; view: RunView; kind: string; onLocate: (evidence: EvidenceRef[], title: string) => void; onRunNew?: () => void }) {
  // The dossier as this run saw it: the submitted documents plus the analyst's additions at the time.
  const missingInRun = new Set(view.decision?.observations.missingDocuments ?? [kind])
  const added = new Map(view.uploads.map(u => [u.kind, u]))
  const present = new Map(company.tables.documente.filter(d => !added.has(d.tip_document)).map(d => [d.tip_document, { document_id: d.document_id, file: d.fisier.split('/').at(-1) as string, sha256: d.sha256, pagini: d.pagini }]))
  for (const u of view.uploads) present.set(u.kind, { document_id: u.kind, file: u.file, sha256: u.sha256, pagini: u.pages })
  for (const k of missingInRun) present.delete(k)
  const rules = view.decision?.scenarios.baza.rules ?? []
  const blocked = (DEPENDENT_CHECKS[kind] ?? []).map(id => rules.find(r => r.id === id)).filter(r => r && r.state === 'missing')
  const openDoc = (k: string) => {
    const d = present.get(k)!
    onLocate([{ documentId: d.document_id, kind: k, file: d.file, sha256: d.sha256, page: 1, pageCount: d.pagini, pageWidth: 595, pageHeight: 842, marks: [] }], docNames[k] ?? k)
  }
  return <div className="missing-doc">
    <div className="missing-doc-head"><span><FileX2 size={18} /></span><div><strong>{docNames[kind] ?? kind} is not in the dossier</strong><p>There is no page to open. The case coordinator checked the dossier against the required list and found no file for it.</p></div></div>
    <h5>Dossier checklist · {REQUIRED_DOCUMENTS.filter(k => present.has(k)).length} of {REQUIRED_DOCUMENTS.length} present</h5>
    <ul className="doc-checklist">{REQUIRED_DOCUMENTS.map(k => present.has(k)
      ? <li key={k}><button onClick={() => openDoc(k)} title="Open this document"><Check size={12} />{docNames[k] ?? k}<small>{added.has(k) ? 'added · ' : ''}{present.get(k)!.pagini} p.</small></button></li>
      : <li key={k} className={'doc-missing' + (k === kind ? ' doc-this' : '')}><span><X size={12} />{docNames[k] ?? k}<small>missing</small></span></li>)}</ul>
    {blocked.length > 0 && <><h5>Checks that cannot run without it</h5><ul className="doc-blocked">{blocked.map(r => <li key={r!.id}><code>{r!.id}</code><div><strong>{r!.title}</strong><span>{r!.explanation}</span></div></li>)}</ul></>}
    <div className="missing-doc-next"><ArrowRight size={13} /><div>Ask the client for the {(docNames[kind] ?? kind).toLowerCase()}, add it to the dossier here, then run a new assessment.
      <AddDocumentButton company={company} kind={kind} label={'Add the ' + (docNames[kind] ?? kind).toLowerCase()} onRunNew={onRunNew} /></div></div>
  </div>
}

function AskPanel({ view, onOpen, about, aboutRank, onClearAbout }: { view: RunView; onOpen: (a: AskAnswer) => void; about: FindingView | null; aboutRank: number; onClearAbout: () => void }) {
  const [items, setItems] = useState<AskAnswer[]>([])
  const [text, setText] = useState('')
  const [pending, setPending] = useState<{ question: string; since: number } | null>(null)
  const [, tick] = useState(0)
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => { listQuestions(view.runId).then(setItems).catch(() => {}) }, [view.runId])
  useEffect(() => { list.current?.scrollTo({ top: list.current.scrollHeight, behavior: 'smooth' }) }, [items.length, pending])
  useEffect(() => { if (!pending) return; const id = window.setInterval(() => tick(n => n + 1), 500); return () => window.clearInterval(id) }, [pending])
  const ask = async (question: string) => {
    if (!question.trim() || pending) return
    setText('')
    setPending({ question, since: Date.now() })
    try {
      const answer = await askQuestion(view.runId, question, about?.id)
      setItems(prev => [...prev, answer])
      // Jump to where the answer points, unless it is the problem the analyst is already asking about.
      if (answer.ok && (answer.findingId || answer.evidence.length) && !(about && answer.findingId === about.id)) onOpen(answer)
    } catch (e: any) {
      setItems(prev => [...prev, { id: String(Date.now()), runId: view.runId, ts: new Date().toISOString(), question, ok: false, answer: e.message || 'The engine could not answer.', findingId: null, evidence: [], author: 'engine', durationMs: 0, unsupported: [] }])
    } finally { setPending(null) }
  }
  const submit = (e: FormEvent) => { e.preventDefault(); ask(text) }
  return <div className="ask">
    <div className="ask-list" ref={list}>
      {!items.length && !pending && <div className="ask-intro"><Sparkles size={18} /><strong>Ask about this assessment</strong><p>Answers come from this run's findings, checks and original documents. When an answer points somewhere, the page opens with the place outlined.</p></div>}
      {items.map(a => <div key={a.id} className="ask-turn">
        <div className="ask-q">{a.question}</div>
        <div className={'ask-a' + (a.ok ? '' : ' ask-error')}>
          {a.about && <span className="ask-about-tag">About #{view.findings.findIndex(f => f.id === a.about) >= 0 ? rankFindings(view.findings, view.decision).findIndex(f => f.id === a.about) + 1 : '?'} · {view.findings.find(f => f.id === a.about)?.title}</span>}
          <p>{emphasize(a.answer)}</p>
          <div className="ask-meta">
            <span>{a.author}{a.durationMs ? ' · ' + (a.durationMs / 1000).toFixed(1) + ' s' : ''}</span>
            {a.ok && (a.unsupported.length ? <span className="note-flag"><CircleAlert size={11} />Unverified: {a.unsupported.join(', ')}</span> : <span className="note-verified"><ShieldCheck size={11} />Figures verified</span>)}
            {(a.findingId || a.evidence.length > 0) && <button className="ask-show" onClick={() => onOpen(a)}>Show me<ArrowUpRight size={12} /></button>}
          </div>
        </div>
      </div>)}
      {pending && <div className="ask-turn"><div className="ask-q">{pending.question}</div><div className="ask-a ask-pending"><LoaderCircle size={13} className="spin" />Reading the run and its documents · {((Date.now() - pending.since) / 1000).toFixed(0)} s</div></div>}
    </div>
    {about && <div className="ask-context"><MessageSquareText size={12} /><span>Asking about <strong>#{aboutRank} {about.title}</strong></span><button className="ws-icon" onClick={onClearAbout} aria-label="Ask about the whole assessment instead"><X size={12} /></button></div>}
    <div className="ask-suggest">{(about ? ABOUT_SUGGESTIONS : SUGGESTIONS).map(s => <button key={s} onClick={() => ask(s)} disabled={!!pending}>{s}</button>)}</div>
    <form className="ask-form" onSubmit={submit}>
      <input value={text} onChange={e => setText(e.target.value)} placeholder={about ? 'Ask about this problem…' : 'Ask about this assessment…'} aria-label="Ask a question" disabled={!!pending} />
      <button type="submit" disabled={!text.trim() || !!pending} aria-label="Send question"><Send size={14} /></button>
    </form>
  </div>
}

function ActivityPanel({ view, events, worker, onClear, connection }: { view: RunView; events: RunEvent[]; worker: AgentId | null; onClear: () => void; connection?: string }) {
  const list = useRef<HTMLOListElement>(null)
  const rows = useMemo(() => events.filter(e => !worker || e.worker === worker).map(e => ({ e, text: describe(e, view) })).filter(x => x.text), [events.length, worker, view.seq])
  useEffect(() => { list.current?.scrollTo({ top: list.current.scrollHeight }) }, [rows.length, worker])
  const w = worker ? view.workers[worker] : null
  const Icon = worker ? workerIcons[worker] : null
  return <div className="ws-activity">
    {w && Icon ? <div className="ws-worker">
      <div className="ws-worker-head"><span className={'map-node-icon state-' + w.state}><Icon size={14} /></span><div><strong>{w.role.name}</strong><span>{w.role.role}</span></div><button className="ws-icon" onClick={onClear} aria-label="Show all activity"><X size={13} /></button></div>
      <div className="ws-worker-facts">
        <span>{w.state === 'hidden' ? 'Not dispatched yet' : w.state}</span>
        <span>{w.role.dependsOn.length ? 'Needs ' + w.role.dependsOn.map(d => view.workers[d]?.role.name).join(', ') : 'Starts the run'}</span>
        {w.startedAt && <span>{duration(w.startedAt, w.endedAt)}</span>}
        {w.findings.length > 0 && <span className="alert">{w.findings.length} finding{w.findings.length === 1 ? '' : 's'}</span>}
      </div>
      {w.summary && <p className="ws-worker-summary">{w.summary}</p>}
      {w.checks.length > 0 && <div className="worker-checks">{w.checks.map(c => <span key={c.id} className={'check-chip check-' + c.state} title={c.title + ': ' + c.observed + ' · required ' + c.expected}>{c.id}</span>)}</div>}
    </div> : <div className="ws-activity-head"><span>All workers · {rows.length} events</span><span className={'stream-state stream-' + (connection ?? 'closed')}>{connection === 'live' ? 'Streaming' : 'Complete'}</span></div>}
    <ol ref={list}>{rows.map(({ e, text }) => { const I = e.worker ? workerIcons[e.worker] : null; return <li key={e.seq} className={'act act-' + e.type}>
      <time title={e.ts}>{clock(e.ts).slice(0, 8)}</time>
      <span className="act-who">{I ? <I size={11} /> : <span className="activity-engine" />}{!worker && <em>{e.worker ? view.workers[e.worker]?.role.name : 'Engine'}</em>}</span>
      <span className="act-text">{text}</span>
    </li> })}</ol>
  </div>
}

const TILES: { id: string; label: string }[] = [
  { id: 'FIN-01', label: 'Debt service coverage' }, { id: 'FIN-02', label: 'Lowest monthly coverage' }, { id: 'FIN-03', label: 'Current liquidity' },
  { id: 'FIN-04', label: 'Debt / EBITDA' }, { id: 'COL-01', label: 'Collateral coverage' }, { id: 'FIN-05', label: 'Own contribution' },
]
const GROUPS: { prefix: string; label: string }[] = [{ prefix: 'DATA-', label: 'Documents & data' }, { prefix: 'CRD-', label: 'Credit & tax' }, { prefix: 'LEG-', label: 'Legal' }, { prefix: 'KYC-', label: 'Operating history' }]
const STATE_LABEL: Record<CheckResult['state'], string> = { pass: 'Meets policy', fail: 'Fails policy', review: 'Needs review', missing: 'Cannot assess', info: 'Information' }

function CheckStrip({ view, live }: { view: RunView; live: boolean }) {
  const checks = new Map(Object.values(view.workers).flatMap(w => w.checks.map(c => [c.id, c] as const)))
  const owner = (id: string) => Object.values(view.workers).find(w => w.role.id === (id.startsWith('FIN') ? 'cashflow' : id.startsWith('COL') ? 'collateral' : id.startsWith('CRD') ? 'credit' : id.startsWith('LEG') ? 'legal' : id.startsWith('KYC') ? 'research' : 'ledger'))
  const total = checks.size
  const passing = [...checks.values()].filter(c => c.state === 'pass' || c.state === 'info').length
  return <section className="ws-section">
    <div className="ws-section-head"><ListChecks size={16} /><h2>Policy checks</h2><span>{total ? passing + ' of ' + total + ' met' : live ? 'Checks appear as workers finish' : 'No checks recorded'}{view.policy ? ' · ' + view.policy.politica_id : ''}</span></div>
    <div className="check-tiles">{TILES.map(t => {
      const c = checks.get(t.id)
      return <div key={t.id} className={'check-tile ' + (c ? 'tile-' + c.state : 'tile-pending')} title={c ? c.title + ': ' + c.observed : ''}>
        <span className="tile-label">{t.label}</span>
        <strong className="tile-value">{c ? c.observed.replace(/ · .*/, '') : '—'}</strong>
        <span className="tile-req">{c ? c.expected : 'Waiting for ' + (owner(t.id)?.role.name ?? 'worker')}</span>
        {c && <span className="tile-state">{STATE_LABEL[c.state]}</span>}
      </div>
    })}
    {GROUPS.map(g => {
      const list = [...checks.values()].filter(c => c.id.startsWith(g.prefix))
      const bad = list.filter(c => c.state !== 'pass' && c.state !== 'info')
      const state = !list.length ? 'pending' : bad.some(c => c.state === 'fail') ? 'fail' : bad.some(c => c.state === 'missing') ? 'missing' : bad.length ? 'review' : 'pass'
      return <div key={g.prefix} className={'check-tile tile-' + state} title={list.map(c => c.id + ' ' + c.title + ': ' + c.observed).join('\n')}>
        <span className="tile-label">{g.label}</span>
        <strong className="tile-value">{list.length ? (list.length - bad.length) + ' / ' + list.length : '—'}</strong>
        <span className="tile-req">{!list.length ? 'Waiting for ' + (owner(g.prefix)?.role.name ?? 'worker') : bad.length ? bad.map(c => c.title).join(', ') : 'All met'}</span>
        {list.length > 0 && <span className="tile-state">{state === 'pass' ? 'Meets policy' : STATE_LABEL[state as CheckResult['state']]}</span>}
      </div>
    })}</div>
  </section>
}

function ProblemList({ view, ranked, focused, live, onOpen }: { view: RunView; ranked: FindingView[]; focused: string | null; live: boolean; onOpen: (id: string) => void }) {
  return <section className="ws-section">
    <div className="ws-section-head"><CircleAlert size={16} /><h2>Problems, most important first</h2><span>{ranked.length ? ranked.length + (ranked.length === 1 ? ' problem' : ' problems') + ' · blocks decision → fails policy → condition → advisory' : ''}</span></div>
    {!ranked.length ? <div className="problems-none">{view.status === 'completed' ? <><Check size={18} /><div><strong>No problems found</strong><span>All documents reconciled with the recorded data and every policy check was met.</span></div></>
      : <><LoaderCircle size={16} className={live ? 'spin' : ''} /><div><strong>{live ? 'No problems found so far' : 'No problems recorded'}</strong><span>{live ? 'Workers are still reviewing the dossier.' : 'This run did not record findings.'}</span></div></>}</div> :
    <ol className="problems">{ranked.map((f, i) => {
      const Icon = workerIcons[f.worker]
      const where = f.evidence[0]
      return <li key={f.id}><button className={'problem impact-row-' + f.impact + (focused === f.id ? ' active' : '')} onClick={() => onOpen(f.id)}>
        <span className="problem-rank">{i + 1}</span>
        <div className="problem-body">
          <div className="problem-top"><ImpactTag impact={f.impact} /><strong>{f.title}</strong></div>
          <p>{emphasize(f.observed)}</p>
          <div className="problem-meta"><span><Icon size={11} />{view.workers[f.worker]?.role.name}</span>{where ? <span><FileSearch size={11} />{docNames[where.kind] ?? where.kind} · page {where.page}</span> : <span><FileSearch size={11} />No document</span>}{f.ruleIds.length > 0 && <span>{f.ruleIds.join(', ')}</span>}</div>
        </div>
        <span className="problem-open">Open<ArrowRight size={13} /></span>
      </button></li>
    })}</ol>}
  </section>
}

function reportMarkdown(view: RunView, company: Company): string {
  const r = view.report!.report
  return ['# ' + r.headline, '', company.name + ' · ' + view.policy?.politica_id + ' · ' + view.report!.author, '', r.summary, '',
    ...r.sections.flatMap(s => ['## ' + s.title, '', ...s.paragraphs.flatMap(p => [p, ''])]), '## Next steps', '', ...r.nextSteps.map((s, i) => (i + 1) + '. ' + s), ''].join('\n')
}

function ReportView({ company, view, live, ranked, onOpen }: { company: Company; view: RunView; live: boolean; ranked: FindingView[]; onOpen: (id: string) => void }) {
  const handoff = view.workers.handoff
  if (!view.report) {
    if (live && handoff && handoff.state !== 'done' && handoff.state !== 'attention') return <section className="ws-section report report-pending">
      <div className="ws-section-head"><Sparkles size={16} /><h2>Assessment report</h2><span>{handoff.state === 'running' ? 'Being written' : 'Written when the decision is reached'}</span></div>
      <div className="report-skeleton">{handoff.llm?.running ? <><LoaderCircle size={14} className="spin" />The analyst handoff worker is writing the report with {handoff.llm.model}…</> : 'The analyst handoff worker writes this report after the policy evaluation.'}<i /><i /><i /></div>
    </section>
    const memo = view.notes.find(n => n.worker === 'handoff')
    return memo ? <section className="ws-section"><div className="ws-section-head"><Sparkles size={16} /><h2>Analyst memo</h2><span>This run predates full reports</span></div><NoteCard note={memo} view={view} /></section> : null
  }
  const { report, author, verified, unsupported } = view.report
  const rank = (id: string) => ranked.findIndex(f => f.id === id) + 1
  const m = view.decision?.scenarios.baza.metrics
  const p = view.policy
  const figures = m && p ? [
    { label: 'DSCR', value: ratio(m.dscr), need: 'min ' + ratio(p.dscr_min), ok: m.dscr === null ? null : m.dscr >= p.dscr_min },
    { label: 'Lowest month', value: ratio(m.monthlyDscr), need: 'min 1.00×', ok: m.monthlyDscr === null ? null : m.monthlyDscr >= 1 },
    { label: 'Liquidity', value: ratio(m.liquidity), need: 'min ' + ratio(p.lichiditate_min), ok: m.liquidity === null ? null : m.liquidity >= p.lichiditate_min },
    { label: 'Debt / EBITDA', value: ratio(m.leverage), need: 'max ' + ratio(p.datorie_ebitda_max), ok: m.leverage === null ? null : m.leverage <= p.datorie_ebitda_max },
    { label: 'Collateral', value: (m.coverage * 100).toFixed(0) + '%', need: 'min 110%', ok: m.coverage >= 1.1 || m.guarantorCapable },
    { label: 'Own contribution', value: m.contribution.toFixed(1) + '%', need: 'min ' + p.aport_min_procente + '%', ok: m.contribution + .001 >= p.aport_min_procente },
  ] : []
  return <section className="ws-section report">
    <div className="ws-section-head"><Sparkles size={16} /><h2>Assessment report</h2><span>{author}</span>
      {verified ? <span className="note-verified"><ShieldCheck size={11} />Every figure checked against the run</span> : <span className="note-flag"><CircleAlert size={11} />Unverified figures: {unsupported.join(', ')}</span>}
      <div className="report-actions">
        <button onClick={() => navigator.clipboard?.writeText(reportMarkdown(view, company))} title="Copy as Markdown"><ClipboardCopy size={13} />Copy</button>
        <button onClick={() => downloadFile(company.id + '-assessment-report.md', reportMarkdown(view, company), 'text/markdown')} title="Download as Markdown"><Download size={13} />Download</button>
      </div>
    </div>
    <article className="report-doc">
      <header className="report-hero">
        <span className="eyebrow">{company.name} · {view.policy?.politica_id}</span>
        <div className="report-title">{view.decision && <span className={'report-outcome outcome-' + view.decision.decision}>{decisionLabels[view.decision.decision]}</span>}<h3>{report.headline}</h3></div>
        <p className="report-lead">{emphasize(report.summary)}</p>
        {figures.length > 0 && <div className="report-figures">{figures.map(f => <div key={f.label} className={f.ok === null ? 'fig-na' : f.ok ? 'fig-ok' : 'fig-bad'}>
          <span>{f.label}</span><strong>{f.value}</strong><small>{f.ok === null ? 'cannot assess' : f.need}</small></div>)}
          <div className={ranked.length ? 'fig-bad' : 'fig-ok'}><span>Problems</span><strong>{ranked.length}</strong><small>{ranked.length ? 'see the ranked list' : 'none found'}</small></div></div>}
      </header>
      <div className="report-body">{report.sections.map(sec => <section key={sec.title} className="report-row">
        <h4>{sec.title}</h4>
        <div>
          {sec.paragraphs.map((para, i) => <p key={i}>{emphasize(para)}</p>)}
          {sec.findingIds.length > 0 && <div className="report-refs">{sec.findingIds.map(id => { const f = view.findings.find(x => x.id === id); return f ? <button key={id} onClick={() => onOpen(id)}><span>#{rank(id)}</span>{f.title}<ArrowRight size={11} /></button> : null })}</div>}
        </div>
      </section>)}</div>
      {report.nextSteps.length > 0 && <footer className="report-next"><h4>Next steps for the analyst</h4><ol>{report.nextSteps.map((step, i) => <li key={i}><span>{i + 1}</span><div>{emphasize(step)}</div></li>)}</ol></footer>}
    </article>
  </section>
}
