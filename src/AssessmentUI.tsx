import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ComponentType, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Bot, Check, ChevronLeft, ChevronRight, CircleAlert, ExternalLink, FileSearch, Fingerprint, Globe2, Hourglass, Landmark, Layers3, ListChecks, LoaderCircle, Maximize2, MessageSquareText, ScanLine, ShieldCheck, Workflow, X } from 'lucide-react'
import type { AgentId, EvidenceMark, EvidenceRef, FindingImpact, FindingView, NoteView, RunView, WorkerView } from './assessment'
import { docNames } from './documents'
import { clock, duration, originalPdfUrl, pageImageUrl } from './runs'

export const workerIcons: Record<AgentId, ComponentType<{ size?: number; strokeWidth?: number; className?: string }>> = {
  intake: Workflow, research: Globe2, extraction: FileSearch, ledger: ScanLine, credit: ShieldCheck,
  legal: Fingerprint, cashflow: Layers3, collateral: Landmark, policy: ListChecks, handoff: Bot,
}
const stateLabel: Record<WorkerView['state'], string> = { hidden: '', waiting: 'Waiting', running: 'Working', done: 'Done', attention: 'Findings', failed: 'Failed', cancelled: 'Cancelled' }
export const impactLabel: Record<FindingImpact, string> = { data: 'Blocks decision', block: 'Fails policy', condition: 'Condition', info: 'Advisory' }

export function ImpactTag({ impact }: { impact: FindingImpact }) {
  return <span className={'impact-tag impact-' + impact}>{impactLabel[impact]}</span>
}

/**
 * Where each role sits on the map (column, row). Rows follow the dependency
 * order; columns are chosen so that no edge passes behind an unrelated node
 * (identity research sits in its own column on the right).
 */
const LAYOUT: Record<AgentId, [number, number]> = {
  intake: [2, 0], extraction: [2, 1], research: [4, 1],
  ledger: [0, 2], credit: [1, 2], legal: [2, 2], collateral: [3, 2],
  cashflow: [0, 3], policy: [2, 4], handoff: [2, 5],
}
const SIZES = {
  full: { w: 176, h: 92, gx: 12, gy: 26 },
  compact: { w: 132, h: 56, gx: 10, gy: 30 },
  /** Left to right, for a wide and short space (the live run). */
  wide: { w: 186, h: 96, gx: 62, gy: 30 },
}
const PAD = 14

/** Dependency depth of every role: its longest path from the coordinator. */
function layers(view: RunView): Map<AgentId, number> {
  const depth = new Map<AgentId, number>()
  const of = (id: AgentId): number => {
    if (depth.has(id)) return depth.get(id)!
    const deps = view.workers[id]?.role.dependsOn ?? []
    const d = deps.length ? Math.max(...deps.map(of)) + 1 : 0
    depth.set(id, d)
    return d
  }
  view.order.forEach(of)
  return depth
}

/**
 * The agent map. A worker appears only once the engine has revealed it
 * (waiting on a dispatched dependency) or dispatched it.
 */
export function AgentMap({ view, selected, highlight, onSelect, compact = false, fit = false, maxScale = 1.12, horizontal = false }: {
  view: RunView; selected: AgentId | null; highlight: AgentId | null; onSelect: (id: AgentId) => void; compact?: boolean
  /** Scale to fit the container's height as well as its width. */
  fit?: boolean; maxScale?: number
  /** Dependencies flow left to right instead of top to bottom. */
  horizontal?: boolean
}) {
  const box = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 720, height: 600 })
  useLayoutEffect(() => {
    if (!box.current) return
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }))
    observer.observe(box.current)
    return () => observer.disconnect()
  }, [])
  const { w: NODE_W, h: NODE_H, gx, gy } = compact ? SIZES.compact : horizontal ? SIZES.wide : SIZES.full
  const cells = useMemo(() => {
    const depth = layers(view)
    return new Map(view.order.map(id => { const [col, row] = LAYOUT[id] ?? [0, depth.get(id)!]; return [id, horizontal ? [row, col] as [number, number] : [col, row] as [number, number]] as const }))
  }, [view.order.join(), horizontal])
  const columns = Math.max(...[...cells.values()].map(c => c[0])) + 1
  const rowCount = Math.max(...[...cells.values()].map(c => c[1])) + 1
  const logicalWidth = columns * (NODE_W + gx) - gx + PAD * 2
  const logicalHeight = rowCount * (NODE_H + gy) - gy + PAD * 2
  const scale = fit ? Math.max(.35, Math.min(maxScale, size.width / logicalWidth, size.height / logicalHeight)) : Math.min(1, size.width / logicalWidth)
  const pos = new Map<AgentId, { x: number; y: number }>()
  for (const [id, [col, row]] of cells) pos.set(id, { x: PAD + col * (NODE_W + gx), y: PAD + row * (NODE_H + gy) })
  const visible = (id: AgentId) => view.workers[id] && view.workers[id].state !== 'hidden'
  const edges = view.order.flatMap(to => (view.workers[to]?.role.dependsOn ?? []).filter(from => visible(from) && visible(to)).map(from => ({ from, to })))
  return <div className={'agent-map' + (compact ? ' agent-map-compact' : '') + (fit ? ' agent-map-fit' : '')} ref={box}>
    <div className="agent-map-canvas" style={{ width: logicalWidth * scale, height: logicalHeight * scale }}>
      <div style={{ width: logicalWidth, height: logicalHeight, transform: 'scale(' + scale + ')', transformOrigin: '0 0', position: 'relative' }}>
        <svg className="agent-map-edges" width={logicalWidth} height={logicalHeight} aria-hidden="true">
          <defs><marker id="map-arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6" fill="currentColor" /></marker></defs>
          {edges.map(({ from, to }) => {
            const a = pos.get(from)!, b = pos.get(to)!
            const x1 = horizontal ? a.x + NODE_W : a.x + NODE_W / 2, y1 = horizontal ? a.y + NODE_H / 2 : a.y + NODE_H
            const x2 = horizontal ? b.x : b.x + NODE_W / 2, y2 = horizontal ? b.y + NODE_H / 2 : b.y
            const mid = horizontal ? (x1 + x2) / 2 : (y1 + y2) / 2
            const source = view.workers[from].state, target = view.workers[to].state
            const state = target === 'running' ? 'flowing' : source === 'done' || source === 'attention' ? 'delivered' : 'pending'
            const d = horizontal ? 'M' + x1 + ',' + y1 + ' C' + mid + ',' + y1 + ' ' + mid + ',' + y2 + ' ' + (x2 - 2) + ',' + y2
              : 'M' + x1 + ',' + y1 + ' C' + x1 + ',' + mid + ' ' + x2 + ',' + mid + ' ' + x2 + ',' + (y2 - 2)
            // Work flowing into an agent that is working: dots travel along the link.
            return <g key={from + to}><path className={'map-edge map-edge-' + state} d={d} markerEnd="url(#map-arrow)" />
              {state === 'flowing' && [0, .6, 1.2].map(begin => <circle key={begin} r="3.2" className="edge-dot"><animateMotion dur="1.8s" begin={begin + 's'} repeatCount="indefinite" path={d} /></circle>)}</g>
          })}
        </svg>
        {view.order.filter(visible).map(id => {
          const w = view.workers[id]
          const Icon = workerIcons[id]
          const p = pos.get(id)!
          const text = w.state === 'waiting' ? 'Waiting for ' + w.waitingFor.map(d => view.workers[d]?.role.name ?? d).join(', ')
            : w.state === 'running' ? (w.llm?.running ? 'Model: ' + w.llm.purpose : w.activity?.text ?? w.role.role)
            : w.summary ?? w.role.role
          return <button key={id} className={'map-node map-' + w.state + (selected === id ? ' map-selected' : '') + (highlight === id ? ' map-highlight' : '')}
            style={{ left: p.x, top: p.y, width: NODE_W, height: NODE_H }} onClick={() => onSelect(id)} data-worker={id} data-state={w.state} aria-label={w.role.name + ': ' + stateLabel[w.state]}>
            <div className="map-node-top"><span className="map-node-icon"><Icon size={14} strokeWidth={1.8} /></span><span className="map-node-state">
              {w.state === 'running' ? <LoaderCircle size={10} className="spin" /> : w.state === 'waiting' ? <Hourglass size={10} /> : w.state === 'attention' ? <CircleAlert size={10} /> : w.state === 'done' ? <Check size={10} /> : w.state === 'failed' || w.state === 'cancelled' ? <X size={10} /> : null}
              {stateLabel[w.state]}</span>{w.findings.length > 0 && <span className="map-node-count" title={w.findings.length + ' findings'}>{w.findings.length}</span>}</div>
            <strong>{w.role.name}</strong>
            <span className="map-node-text" title={text}>{w.state === 'running' ? w.role.role : text}</span>
            {w.state === 'running' && <span className="map-bubble" key={text}>{text}</span>}
            {w.llm && <span className={'map-node-model' + (w.llm.running ? ' running' : '')}>{w.llm.running ? 'Model working' : w.llm.ok ? 'Model ' + ((w.llm.durationMs ?? 0) / 1000).toFixed(1) + ' s' : 'Model failed'}</span>}
          </button>
        })}
      </div>
    </div>
  </div>
}

/** Figures, amounts, ratios and rule ids, made easy to spot in running text. */
const NUMBER = /(RON\s?-?[\d,]+(?:\.\d+)?|-?\d[\d,]*(?:\.\d+)?\s?(?:×|%)|\b(?:DATA|FIN|CRD|COL|LEG|KYC)-\d+\b)/g
export function emphasize(text: string): ReactNode[] {
  return text.split(NUMBER).map((part, i) => i % 2 ? <strong key={i} className="num">{part}</strong> : part)
}

/** One rendered original page with its marks; scrolls its container to the focused mark. */
function PageCanvas({ companyId, evidence: ref, page, scrollRef, focus, large = false, zoom = 1, onFocus, onAsk }: {
  companyId: string; evidence: EvidenceRef; page: number; scrollRef: React.RefObject<HTMLDivElement | null>; focus: number | null; large?: boolean; zoom?: number
  onFocus?: (i: number) => void; onAsk?: (mark: EvidenceMark) => void
}) {
  const [loaded, setLoaded] = useState(false)
  useEffect(() => setLoaded(false), [ref.file, page])
  const onMarks = page === ref.page
  const target = focus ?? ref.marks.findIndex(m => m.tone === 'issue')
  useEffect(() => {
    const box = scrollRef.current
    if (!loaded || !onMarks || !box || target < 0 || !ref.marks[target]) return
    const img = box.querySelector('img')
    if (!img) return
    const y = ref.marks[target].box.y0 / ref.pageHeight * img.clientHeight
    const x = ref.marks[target].box.x0 / ref.pageWidth * img.clientWidth
    box.scrollTo({ top: Math.max(0, y - box.clientHeight / 3), left: Math.max(0, x - box.clientWidth / 5), behavior: 'smooth' })
  }, [loaded, onMarks, ref.documentId, ref.page, target, focus, zoom])
  const labelled = focus ?? ref.marks.findIndex(x => x.tone === 'issue')
  // The line the problem is on is banded across the whole page, and the rest of the page is dimmed around it.
  const lines = onMarks ? ref.marks.filter(m => m.tone === 'issue') : []
  return <div className={'evidence-page' + (large ? ' evidence-page-large' : '') + (zoom > 1 ? ' zoomed' : '') + (loaded && lines.length ? ' spotlit' : '')}>
    <img src={pageImageUrl(companyId, ref.file, page)} alt={(docNames[ref.kind] ?? ref.kind) + ', page ' + page} onLoad={() => setLoaded(true)} />
    {!loaded && <div className="evidence-loading"><LoaderCircle size={18} className="spin" />Rendering original page…</div>}
    {loaded && lines.map((m, i) => <div key={'line' + i} className="evidence-line" style={{ top: (m.box.y0 - 4) / ref.pageHeight * 100 + '%', height: (m.box.y1 - m.box.y0 + 8) / ref.pageHeight * 100 + '%' }} />)}
    {loaded && onMarks && ref.marks.map((m, i) => <div key={i} className={'evidence-mark mark-' + m.tone + (focus === i ? ' mark-focus' : '') + (i === labelled ? ' mark-spot' : '')} style={{
      left: (m.box.x0 - 3) / ref.pageWidth * 100 + '%', top: (m.box.y0 - 2.5) / ref.pageHeight * 100 + '%',
      width: (m.box.x1 - m.box.x0 + 6) / ref.pageWidth * 100 + '%', height: (m.box.y1 - m.box.y0 + 5) / ref.pageHeight * 100 + '%',
    }} title={m.label} onClick={() => onFocus?.(i)}>
      {i === labelled ? <span className={'evidence-mark-label ' + (m.box.x1 / ref.pageWidth < .55 ? 'label-right' : 'label-above')}><span>{m.label}</span>{onAsk && <button onClick={e => { e.stopPropagation(); onAsk(m) }} title="Ask the assistant about this figure"><MessageSquareText size={11} />Ask</button>}</span>
        : onAsk && <button className="mark-ask" onClick={e => { e.stopPropagation(); onAsk(m) }} title={'Ask about ' + m.label}><MessageSquareText size={11} />Ask</button>}
    </div>)}
  </div>
}

/** The outlined figures on the page, in reading order; selecting one scrolls to it. */
function FigureList({ evidence: ref, page, focus, onFocus }: { evidence: EvidenceRef; page: number; focus: number | null; onFocus: (i: number) => void }) {
  if (page !== ref.page || !ref.marks.length) return null
  const order = ref.marks.map((m, i) => ({ m, i })).sort((a, b) => a.m.box.y0 - b.m.box.y0)
  return <ul className="figure-list">{order.map(({ m, i }) => <li key={i}><button className={'figure-' + m.tone + (focus === i ? ' active' : '')} onClick={() => onFocus(i)}>
    <i />{(() => { const at = m.label.indexOf(': '); return at > 0 ? <><span>{m.label.slice(0, at)}</span><strong>{m.label.slice(at + 2)}</strong></> : <span>{m.label}</span> })()}
  </button></li>)}</ul>
}

/**
 * Original page as rendered by the engine, with the finding's marks outlined.
 * "Expand" opens a large in-page view; `aside` is shown next to it there.
 */
export function EvidenceViewer({ companyId, evidence, title, aside, focus: focusProp, onFocus, index: indexProp, onIndex, figures = true, onAskMark }: {
  companyId: string; evidence: EvidenceRef[]; title?: string; aside?: ReactNode
  /** Set to share the outlined figure in focus and the document shown with a panel beside the viewer. */
  focus?: number | null; onFocus?: (i: number | null) => void; index?: number; onIndex?: (i: number) => void
  /** The list of outlined figures above the page; off when shown beside it. */
  figures?: boolean; onAskMark?: (mark: EvidenceMark, ref: EvidenceRef) => void
}) {
  const [indexState, setIndexState] = useState(0)
  const [page, setPage] = useState(evidence[0]?.page ?? 1)
  const [focusState, setFocusState] = useState<number | null>(null)
  const focus = focusProp !== undefined ? focusProp : focusState
  const setFocus = onFocus ?? setFocusState
  const index = indexProp ?? indexState
  const setIndex = onIndex ?? setIndexState
  const [expanded, setExpanded] = useState(false)
  const [zoom, setZoom] = useState(1)
  const scroller = useRef<HTMLDivElement>(null)
  // In a narrow panel the page opens enlarged at the problem, so the figures can be read without expanding.
  const [inline, setInline] = useState<number | null>(null)
  useLayoutEffect(() => { if (inline === null && scroller.current) setInline(scroller.current.clientWidth < 560 ? 1.6 : 1) })
  const bigScroller = useRef<HTMLDivElement>(null)
  const key = evidence.map(e => e.documentId + e.page).join()
  useEffect(() => { setIndex(0); setPage(evidence[0]?.page ?? 1); setFocus(null) }, [key])
  const ref = evidence[Math.min(index, evidence.length - 1)]
  useEffect(() => { if (ref) { setPage(ref.page); setFocus(null) } }, [ref?.documentId, ref?.page])
  useEffect(() => {
    if (!expanded) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setExpanded(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [expanded])
  if (!ref) return <div className="evidence-empty"><FileSearch size={22} /><strong>No document to show</strong><p>{title ?? 'This finding concerns a document that is not in the dossier.'}</p></div>
  const tabs = evidence.length > 1 && <div className="evidence-tabs">{evidence.map((e, i) => <button key={e.documentId + e.page} className={i === index ? 'active' : ''} onClick={() => setIndex(i)}>
    <span className={'evidence-tab-dot' + (e.marks.some(m => m.tone === 'issue') ? ' issue' : '')} />{docNames[e.kind] ?? e.kind}<small>p. {e.page}</small></button>)}</div>
  const pager = <div className="evidence-pager"><button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1} aria-label="Previous page"><ChevronLeft size={14} /></button><span>Page {page} / {ref.pageCount}</span><button onClick={() => setPage(p => Math.min(ref.pageCount, p + 1))} disabled={page >= ref.pageCount} aria-label="Next page"><ChevronRight size={14} /></button></div>
  const back = page !== ref.page && <button className="evidence-back" onClick={() => setPage(ref.page)}>Back to the marked page ({ref.page})</button>
  return <div className="evidence-viewer">
    {tabs}
    <div className="evidence-toolbar">
      <div><strong>{docNames[ref.kind] ?? ref.kind}</strong><span>{ref.file} · SHA-256 {ref.sha256.slice(0, 12)}…</span></div>
      {pager}
      <div className="doc-zoom inline-zoom">{[1, 1.6, 2.2].map(z => <button key={z} className={(inline ?? 1) === z ? 'active' : ''} onClick={() => setInline(z)}>{z === 1 ? 'Fit' : Math.round(z * 100) + '%'}</button>)}</div>
      <button className="evidence-expand" onClick={() => setExpanded(true)} title="Open the page full screen"><Maximize2 size={13} />Expand</button>
    </div>
    {figures && <FigureList evidence={ref} page={page} focus={focus} onFocus={setFocus} />}
    <div className="evidence-page-scroll" ref={scroller}><div className="evidence-zoom" style={{ width: (inline ?? 1) * 100 + '%' }}><PageCanvas companyId={companyId} evidence={ref} page={page} scrollRef={scroller} focus={focus} zoom={inline ?? 1} onFocus={setFocus} onAsk={onAskMark && (m => onAskMark(m, ref))} /></div></div>
    {back}
    <div className="evidence-legend"><span><i className="legend-issue" />Problem</span><span><i className="legend-reference" />Compared with</span></div>
    {/* Rendered at the document root: containers with transforms or container queries would otherwise clip a fixed overlay. */}
    {expanded && createPortal(<div className="doc-lightbox" role="dialog" aria-modal="true" aria-label={(docNames[ref.kind] ?? ref.kind) + ', expanded'} onMouseDown={e => { if (e.target === e.currentTarget) setExpanded(false) }}>
      <div className="doc-lightbox-frame">
        <header>
          <div><strong>{docNames[ref.kind] ?? ref.kind}</strong><span>{ref.file} · SHA-256 {ref.sha256.slice(0, 16)}…</span></div>
          {pager}
          <div className="doc-zoom">{[1, 1.5, 2].map(z => <button key={z} className={zoom === z ? 'active' : ''} onClick={() => setZoom(z)}>{z === 1 ? 'Fit' : z * 100 + '%'}</button>)}</div>
          <a className="doc-original" href={originalPdfUrl(companyId, ref.file, page)} target="_blank" rel="noreferrer" title="Open the original PDF file in a new tab"><ExternalLink size={12} />Original PDF</a>
          <button className="ws-icon" onClick={() => setExpanded(false)} aria-label="Close expanded view"><X size={14} /></button>
        </header>
        <div className="doc-lightbox-body">
          <aside>{aside}<h5>Outlined on this page</h5><FigureList evidence={ref} page={page} focus={focus} onFocus={setFocus} />{page !== ref.page && <p className="doc-lightbox-hint">Nothing is outlined on page {page}.</p>}{tabs}</aside>
          <div className="doc-lightbox-page" ref={bigScroller}><div style={{ width: zoom === 1 ? '100%' : zoom * 100 + '%' }}><PageCanvas companyId={companyId} evidence={ref} page={page} scrollRef={bigScroller} focus={focus} large zoom={zoom} onFocus={setFocus} onAsk={onAskMark && (m => { setExpanded(false); onAskMark(m, ref) })} /></div>{back}</div>
        </div>
      </div>
    </div>, document.body)}
  </div>
}

/**
 * The outlined lines of the page, cut out and enlarged so they can be read
 * without zooming: the problem first, then what it was compared with.
 * Selecting one scrolls the page to it.
 */
export function Closeups({ companyId, evidence: ref, focus, onFocus, onAsk }: { companyId: string; evidence: EvidenceRef; focus: number | null; onFocus: (i: number) => void; onAsk?: (mark: EvidenceMark) => void }) {
  if (!ref.marks.length) return null
  const order = ref.marks.map((m, i) => ({ m, i })).sort((a, b) => (a.m.tone === b.m.tone ? 0 : a.m.tone === 'issue' ? -1 : 1) || a.m.box.y0 - b.m.box.y0)
  const image = 'url("' + pageImageUrl(companyId, ref.file, ref.page) + '")'
  return <div className="closeups">
    <h5>On {docNames[ref.kind] ?? ref.kind}, page {ref.page}</h5>
    {order.map(({ m, i }) => {
      const pad = 4
      const w = Math.min(ref.pageWidth, Math.max(m.box.x1 - m.box.x0 + 44, 200))
      const x0 = Math.min(Math.max(0, m.box.x0 - 18), ref.pageWidth - w)
      const y0 = Math.max(0, m.box.y0 - pad)
      const h = Math.min(ref.pageHeight - y0, m.box.y1 - m.box.y0 + pad * 2)
      const at = m.label.indexOf(': ')
      return <div key={i} className={'closeup closeup-' + m.tone + (focus === i ? ' active' : '')}>
        <button className="closeup-main" onClick={() => onFocus(i)} title="Show it on the page">
          <span className="closeup-label"><i />{at > 0 ? <>{m.label.slice(0, at)}<strong>{m.label.slice(at + 2)}</strong></> : m.label}</span>
          <span className="closeup-crop" style={{ paddingTop: h / w * 100 + '%', backgroundImage: image, backgroundSize: ref.pageWidth / w * 100 + '% auto', backgroundPosition: (w < ref.pageWidth ? x0 / (ref.pageWidth - w) * 100 : 0) + '% ' + (h < ref.pageHeight ? y0 / (ref.pageHeight - h) * 100 : 0) + '%' }}>
            <b style={{ left: (m.box.x0 - x0 - 2) / w * 100 + '%', top: (m.box.y0 - y0 - 2) / h * 100 + '%', width: (m.box.x1 - m.box.x0 + 4) / w * 100 + '%', height: (m.box.y1 - m.box.y0 + 4) / h * 100 + '%' }} />
          </span>
        </button>
        {onAsk && <button className="closeup-ask" onClick={() => onAsk(m)} title={'Ask the assistant about ' + m.label}><MessageSquareText size={12} />Ask</button>}
      </div>
    })}
  </div>
}

export function FindingDetail({ finding, view, onWorker, compact = false }: { finding: FindingView; view: RunView; onWorker?: (id: AgentId) => void; compact?: boolean }) {
  const worker = view.workers[finding.worker]
  const Icon = workerIcons[finding.worker]
  return <article className={'finding-detail' + (compact ? ' finding-compact' : '')} data-finding={finding.id}>
    <header><div className="finding-detail-meta"><ImpactTag impact={finding.impact} /><button className="finding-worker" onClick={() => onWorker?.(finding.worker)}><Icon size={12} />{worker?.role.name ?? finding.worker}</button><time title={finding.ts}>{clock(finding.ts)}</time></div>
      <h3>{finding.title}</h3></header>
    <dl>
      <div><dt>Observed</dt><dd>{emphasize(finding.observed)}</dd></div>
      <div><dt>Compared against</dt><dd>{emphasize(finding.comparedAgainst)}</dd></div>
      <div><dt>Why it matters</dt><dd>{emphasize(finding.whyItMatters)}</dd></div>
      <div className="finding-effect"><dt>Effect on the assessment</dt><dd>{emphasize(finding.effect)}</dd></div>
    </dl>
    {finding.ruleIds.length > 0 && <footer>{finding.ruleIds.map(id => <code key={id}>{id}</code>)}<span>event #{finding.seq}</span></footer>}
  </article>
}

export function NoteCard({ note, view }: { note: NoteView; view: RunView }) {
  const Icon = workerIcons[note.worker]
  return <div className={'note-card' + (note.verified ? '' : ' note-unverified')}>
    <div className="note-card-head"><Icon size={13} /><strong>{note.title}</strong><span>{note.author}</span>{note.verified ? <span className="note-verified"><ShieldCheck size={11} />Verified</span> : <span className="note-flag"><CircleAlert size={11} />Not fully verified</span>}</div>
    {note.fields?.length ? <>
      <dl className="note-fields">{note.fields.map(f => <div key={f.label} className={f.tone ? 'tone-' + f.tone : ''}><dt>{f.label}</dt><dd>{f.tone === 'ok' && <Check size={11} />}{f.tone === 'warn' && <CircleAlert size={11} />}{f.value}</dd></div>)}</dl>
      <p className="note-foot">{note.text.split('\n').at(-1)}</p>
    </> : <>
      {note.text.split('\n').filter(Boolean).map((line, i) => <p key={i}>{line}</p>)}
      {note.points && note.points.length > 0 && <ul className="note-points">{note.points.map((pt, i) => <li key={i} className={pt.verified ? 'pt-ok' : 'pt-bad'}>
        <span className="pt-mark">{pt.verified ? <Check size={11} /> : <X size={11} />}</span>
        <div><strong>{pt.text}</strong>{pt.quote && <q>{pt.quote}</q>}<small>{pt.verified ? 'Quote located on the page' : 'Quote not found in the document'}{pt.review ? ' · needs review' : ''}</small></div>
      </li>)}</ul>}
    </>}
    <small>{view.workers[note.worker]?.role.name} · event #{note.seq}</small>
  </div>
}
