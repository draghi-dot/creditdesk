import { useEffect, useRef, useState } from 'react'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { ArrowDownToLine, ArrowUpRight, Check, CheckCheck, ChevronRight, CircleAlert, CircleHelp, Clock3, Copy, FileText, LoaderCircle, ShieldCheck, X } from 'lucide-react'
import type { AuditEvent, AuditRule, Company, Decision, Row, RuleState } from './types'
import { decisionLabels, documentUrl } from './analysis'
import { verifyEventChain } from './storage'

export function Badge({ decision, small = false }: { decision: Decision; small?: boolean }) {
  return <span className={'badge badge-' + decision + (small ? ' badge-small' : '')}><span />{decisionLabels[decision]}</span>
}
export function NotAssessed({ small = false }: { small?: boolean }) {
  return <span className={'badge badge-NONE' + (small ? ' badge-small' : '')}><span />Not assessed</span>
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
export function Dialog({ title, description, children, onClose, wide = false }: { title: string; description?: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    ref.current?.showModal()
    const bodyOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = bodyOverflow }
  }, [])
  return <dialog ref={ref} className={'dialog' + (wide ? ' dialog-wide' : '')} onCancel={e => { e.preventDefault(); onClose() }} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
    <div className="dialog-header"><div><h2>{title}</h2>{description && <p>{description}</p>}</div><button className="icon-button" onClick={onClose} aria-label="Close dialog"><X size={20} /></button></div>{children}
  </dialog>
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
