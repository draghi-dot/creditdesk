import { useEffect, useRef, useState } from 'react'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ArrowDownToLine, ArrowUpRight, Check, CheckCheck, ChevronDown, ChevronRight, CircleAlert, CircleHelp, Clock3, Copy, FileText, LoaderCircle, ShieldCheck, X } from 'lucide-react'
import type { AuditEvent, AuditRule, Company, Decision, Row, RuleState } from './types'
import { decisionLabels, documentUrl } from './analysis'
import { verifyEventChain } from './storage'

const badgeIcons: Record<Decision, typeof Check> = { ELIGIBIL: Check, CONDITIONAT: Clock3, DATE_INSUFICIENTE: CircleHelp, NEELIGIBIL: X }
export function Badge({ decision, small = false, large = false }: { decision: Decision; small?: boolean; large?: boolean }) {
  const Icon = badgeIcons[decision]
  return <span className={'badge badge-' + decision + (small ? ' badge-small' : '') + (large ? ' badge-large' : '')}><Icon size={large ? 15 : 12} strokeWidth={2.4} />{decisionLabels[decision]}</span>
}
export function NotAssessed({ small = false, large = false }: { small?: boolean; large?: boolean }) {
  return <span className={'badge badge-NONE' + (small ? ' badge-small' : '') + (large ? ' badge-large' : '')}><span />Not assessed</span>
}

export interface SelectOption { value: string; label: string; hint?: string }
/**
 * A dropdown that looks like the rest of the workspace instead of the
 * operating system's menu. Arrow keys, Enter, Escape and typing a letter work;
 * long lists get a filter box. The list is placed with fixed coordinates so
 * scrolling panels and dialogs do not clip it.
 */
export function Select({ value, onChange, options, label, icon, className = '', small = false, disabled = false }: {
  value: string; onChange: (value: string) => void; options: SelectOption[]; label: string; icon?: ReactNode; className?: string; small?: boolean; disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [filter, setFilter] = useState('')
  const [place, setPlace] = useState<{ left: number; top?: number; bottom?: number; width: number; maxHeight: number } | null>(null)
  const button = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const current = options.find(o => o.value === value)
  const searchable = options.length > 9
  const shown = filter ? options.filter(o => o.label.toLowerCase().includes(filter.toLowerCase())) : options
  const host = button.current?.closest('dialog') ?? document.body
  const close = (focus = true) => { setOpen(false); setFilter(''); if (focus) button.current?.focus() }
  const pick = (o: SelectOption | undefined) => { if (!o) return; onChange(o.value); close() }
  const show = () => {
    const r = button.current!.getBoundingClientRect()
    const below = window.innerHeight - r.bottom - 12, above = r.top - 12
    const up = below < 240 && above > below
    setPlace({ left: Math.min(r.left, window.innerWidth - Math.max(r.width, 200) - 8), width: Math.max(r.width, 200), maxHeight: Math.min(340, up ? above : below), ...(up ? { bottom: window.innerHeight - r.top + 6 } : { top: r.bottom + 6 }) })
    setActive(Math.max(0, options.findIndex(o => o.value === value)))
    setOpen(true)
  }
  useEffect(() => {
    if (!open) return
    const outside = (e: MouseEvent) => { if (!list.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) close(false) }
    const scrolled = (e: Event) => { if (!list.current?.contains(e.target as Node)) close(false) }
    document.addEventListener('mousedown', outside)
    window.addEventListener('scroll', scrolled, true)
    window.addEventListener('resize', scrolled)
    return () => { document.removeEventListener('mousedown', outside); window.removeEventListener('scroll', scrolled, true); window.removeEventListener('resize', scrolled) }
  }, [open])
  useEffect(() => { list.current?.querySelector('.select-option.active')?.scrollIntoView({ block: 'nearest' }) }, [active, open])
  const key = (e: React.KeyboardEvent) => {
    if (!open) { if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); show() } return }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close() }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(shown.length - 1, a + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(0, a - 1)) }
    else if (e.key === 'Home') { e.preventDefault(); setActive(0) }
    else if (e.key === 'End') { e.preventDefault(); setActive(shown.length - 1) }
    else if (e.key === 'Enter' || (e.key === ' ' && !searchable)) { e.preventDefault(); pick(shown[active]) }
    else if (e.key === 'Tab') close(false)
    else if (!searchable && e.key.length === 1) { const i = options.findIndex(o => o.label.toLowerCase().startsWith(e.key.toLowerCase())); if (i >= 0) setActive(i) }
  }
  return <>
    <button ref={button} type="button" className={'select' + (small ? ' select-small' : '') + (open ? ' open' : '') + ' ' + className} onClick={() => open ? close() : show()} onKeyDown={key}
      aria-haspopup="listbox" aria-expanded={open} aria-label={label + ': ' + (current?.label ?? '')} disabled={disabled}>
      {icon}<span className="select-value">{current?.label ?? label}</span><ChevronDown size={14} className="select-chevron" />
    </button>
    {open && place && createPortal(<div ref={list} className="select-popover" style={{ position: 'fixed', left: place.left, top: place.top, bottom: place.bottom, minWidth: place.width, maxHeight: place.maxHeight }} onKeyDown={key}>
      {searchable && <input autoFocus className="select-filter" placeholder={'Find ' + label.toLowerCase() + '…'} value={filter} onChange={e => { setFilter(e.target.value); setActive(0) }} aria-label={'Filter ' + label} />}
      <div className="select-options" role="listbox" aria-label={label}>
        {shown.map((o, i) => <div key={o.value} role="option" aria-selected={o.value === value} className={'select-option' + (i === active ? ' active' : '') + (o.value === value ? ' chosen' : '')}
          onMouseEnter={() => setActive(i)} onMouseDown={e => e.preventDefault()} onClick={() => pick(o)}>
          <span>{o.label}{o.hint && <small>{o.hint}</small>}</span>{o.value === value && <Check size={14} />}
        </div>)}
        {!shown.length && <div className="select-none">No match</div>}
      </div>
    </div>, host)}
  </>
}
export function Button({ children, variant = 'secondary', small, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'dark'; small?: boolean }) {
  return <button className={'button button-' + variant + (small ? ' button-small' : '') + ' ' + className} {...props}>{children}</button>
}
export function CompanyMark({ company, large = false }: { company: Company; large?: boolean }) {
  const tone = [...company.symbol].reduce((a, c) => a + c.charCodeAt(0), 0) % 6
  return <span className={'company-mark tone-' + tone + (large ? ' company-mark-large' : '')}>{company.symbol.slice(0, 3)}</span>
}
export function RuleIcon({ state }: { state: RuleState }) {
  const Icon = state === 'pass' ? Check : state === 'missing' ? CircleHelp : state === 'review' ? Clock3 : state === 'info' ? ShieldCheck : X
  return <span className={'rule-icon rule-' + state}><Icon size={14} strokeWidth={2} /></span>
}
export function Empty({ title, children }: { title: string; children: ReactNode }) {
  return <div className="empty-state"><span className="empty-icon"><FileText size={24} /></span><h3>{title}</h3><p>{children}</p></div>
}
export function SectionHeading({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return <div className="section-heading"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>{action}</div>
}
let openDialogs = 0
export function Dialog({ title, description, children, onClose, wide = false }: { title: string; description?: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    ref.current?.showModal()
    // The page stays still while any dialog is open; counted, so dialogs opened over dialogs cannot leave it locked.
    openDialogs++
    document.body.style.overflow = 'hidden'
    return () => { if (--openDialogs <= 0) { openDialogs = 0; document.body.style.overflow = '' } }
  }, [])
  // Rendered at the end of the page, so the styles of whatever opened it (a banner, a list row) cannot reach inside.
  return createPortal(<dialog ref={ref} className={'dialog' + (wide ? ' dialog-wide' : '')} onCancel={e => { e.preventDefault(); onClose() }} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
    <div className="dialog-header"><div><h2>{title}</h2>{description && <p>{description}</p>}</div><button className="icon-button" onClick={onClose} aria-label="Close dialog"><X size={20} /></button></div>{children}
  </dialog>, document.body)
}
export function DocumentViewer({ company, document: doc, onClose, toast }: { company: Company; document: Row; onClose: () => void; toast: (s: string) => void }) {
  return <Dialog wide title={doc.tip_document.replaceAll('_', ' ')} description={company.name + ' · ' + doc.document_id} onClose={onClose}>
    <div className="document-meta"><span><FileText size={15} />{doc.pagini} {doc.pagini === 1 ? 'page' : 'pages'} · PDF</span>
      <a className="button button-secondary button-small" href={documentUrl(company, doc)} download><ArrowDownToLine size={14} />Download</a>
      <a className="icon-button" href={documentUrl(company, doc)} target="_blank" rel="noreferrer" aria-label="Open PDF in new tab"><ArrowUpRight size={17} /></a></div>
    <iframe className="pdf-frame" src={documentUrl(company, doc) + '#toolbar=1'} title={doc.tip_document} />
    <div className="hash-footer"><ShieldCheck size={15} /><span>SHA-256 <code>{doc.sha256}</code></span><button className="icon-button" aria-label="Copy document hash" onClick={async () => { try { await navigator.clipboard.writeText(doc.sha256); toast('Document hash copied') } catch { toast('Clipboard is unavailable. You can select and copy the displayed hash.') } }}><Copy size={14} /></button></div>
  </Dialog>
}
export function RuleList({ rules, onEvidence, expanded = true }: { rules: AuditRule[]; onEvidence: (id?: string) => void; expanded?: boolean }) {
  return <div className="rule-list">{rules.map(rule => <details className={'rule-detail rule-detail-' + rule.state} key={rule.id} open={expanded || undefined}>
    <summary><RuleIcon state={rule.state} /><div className="rule-summary-name"><strong>{rule.title}</strong><span>{rule.id} · {rule.area}</span></div><span className="rule-summary-value">{rule.observed}</span><ChevronRight className="detail-chevron" size={16} /></summary>
    <div className="rule-body"><p>{rule.explanation}</p><div className="rule-facts"><div><span>Observed</span><strong>{rule.observed}</strong></div><div><span>Policy requirement</span><strong>{rule.threshold}</strong></div></div>
      {rule.formula && <div className="formula"><span>Calculation</span><code>{rule.formula}</code></div>}
      {!!rule.evidence.length && <div className="evidence-links">{rule.evidence.map((proof, i) => <button key={i} className={'evidence-link' + (!proof.documentId ? ' evidence-missing' : '')} onClick={() => onEvidence(proof.documentId)}><FileText size={13} /><span>{proof.label}</span>{proof.documentId ? <ArrowUpRight size={12} /> : <CircleAlert size={12} />}</button>)}</div>}
    </div>
  </details>)}</div>
}
export function Loading({ label = 'Loading company dossiers' }: { label?: string }) {
  return <div className="loading"><LoaderCircle className="spin" size={25} /><h2>{label}</h2><p>Preparing the evidence, financials and decision trail.</p></div>
}
export function Toast({ message }: { message: string }) {
  return <div className="toast" role="status"><CheckCheck size={17} />{message}</div>
}
export function AuditIntegrity({ events }: { events: AuditEvent[] }) {
  const [valid, setValid] = useState<boolean | null>(null)
  useEffect(() => { let current = true; setValid(null); verifyEventChain(events).then(result => { if (current) setValid(result) }).catch(() => { if (current) setValid(false) }); return () => { current = false } }, [events])
  return !events.length ? null : <span className={'integrity-state' + (valid === false ? ' integrity-invalid' : '')}>{valid === false ? <CircleAlert size={13} /> : <ShieldCheck size={13} />}{valid === null ? 'Checking audit integrity…' : valid ? 'Local audit chain intact' : 'Audit integrity check failed'}</span>
}
