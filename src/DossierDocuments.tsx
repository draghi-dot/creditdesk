import { useCallback, useEffect, useRef, useState } from 'react'
import type { DragEvent } from 'react'
import { ArrowRight, Check, CircleAlert, FilePlus2, FileText, FileX2, LoaderCircle, RotateCcw, Upload, X } from 'lucide-react'
import type { DossierUpload } from './assessment'
import { DEPENDENT_CHECKS, REQUIRED_DOCUMENTS } from './assessment'
import type { Company } from './types'
import { docNames } from './documents'
import type { DossierState } from './runs'
import { addDocument, getDossier, removeDocument, when } from './runs'

const name = (kind: string) => docNames[kind] ?? kind
/** The checks that cannot run without a document, in words. */
const CHECK_NAMES: Record<string, string> = { 'FIN-01': 'debt service coverage', 'FIN-02': 'lowest monthly coverage', 'FIN-03': 'current liquidity', 'FIN-04': 'debt to EBITDA', 'CRD-01': 'the credit report' }

/** The company's dossier as it stands now, shared by the parts of a page that show or change it. */
export function useDossier(companyId: string) {
  const [state, setState] = useState<DossierState | null>(null)
  const [error, setError] = useState('')
  const reload = useCallback(() => getDossier(companyId).then(s => { setState(s); setError('') }).catch(e => setError(e.message)), [companyId])
  useEffect(() => { reload() }, [reload])
  return { state, error, reload }
}

/**
 * Pick or drop a PDF to add to the dossier as `kind`. The engine accepts it
 * only if it is this company's document of that type and its fields can be read.
 */
export function AddDocumentButton({ company, kind, label, onAdded, onRunNew, compact = false }: {
  company: Company; kind: string; label?: string; onAdded?: (u: DossierUpload) => void; onRunNew?: () => void; compact?: boolean
}) {
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  const [state, setState] = useState<{ status: 'idle' } | { status: 'uploading'; file: string } | { status: 'error'; reason: string } | { status: 'done'; upload: DossierUpload }>({ status: 'idle' })
  const pick = async (file: File | undefined) => {
    if (!file) return
    setState({ status: 'uploading', file: file.name })
    try {
      const upload = await addDocument(company.id, kind, file)
      setState({ status: 'done', upload })
      onAdded?.(upload)
    } catch (e: any) {
      setState({ status: 'error', reason: e.message || 'The document could not be added.' })
    } finally {
      if (input.current) input.current.value = ''
    }
  }
  const drop = (e: DragEvent) => { e.preventDefault(); setOver(false); pick(e.dataTransfer.files[0]) }
  return <div className={'add-doc' + (compact ? ' add-doc-compact' : '') + (over ? ' add-doc-over' : '')} onDragOver={e => { e.preventDefault(); setOver(true) }} onDragLeave={() => setOver(false)} onDrop={drop} onClick={e => e.stopPropagation()}>
    <input ref={input} type="file" accept="application/pdf,.pdf" hidden onChange={e => pick(e.target.files?.[0])} />
    {state.status !== 'done' && <button className="add-doc-button" onClick={() => input.current?.click()} disabled={state.status === 'uploading'}>
      {state.status === 'uploading' ? <><LoaderCircle size={13} className="spin" />Checking {state.file}…</> : <><Upload size={13} />{label ?? 'Upload ' + name(kind).toLowerCase()}</>}
    </button>}
    {state.status === 'error' && <div className="add-doc-error"><CircleAlert size={13} /><div><strong>Not added.</strong> {state.reason}</div><button className="ws-icon" onClick={() => setState({ status: 'idle' })} aria-label="Dismiss"><X size={12} /></button></div>}
    {state.status === 'done' && <div className="add-doc-done"><Check size={14} /><div><strong>{name(kind)} added.</strong> {state.upload.originalName} · {state.upload.pages} {state.upload.pages === 1 ? 'page' : 'pages'} · {state.upload.fields.toLocaleString('en-GB')} fields read. Run a new assessment to review the dossier with it.</div>
      {onRunNew && <button className="add-doc-run" onClick={onRunNew}>Run new assessment<ArrowRight size={13} /></button>}</div>}
  </div>
}

/** Required documents the dossier does not have, each with its upload right there. */
export function MissingDocuments({ company, state, onAdded, onRunNew }: { company: Company; state: DossierState; onAdded: () => void; onRunNew: () => void }) {
  if (!state.missing.length) return null
  return <section className="missing-alert" aria-label="Missing documents">
    <div className="missing-alert-head"><FileX2 size={18} /><div><h2>{state.missing.length === 1 ? '1 required document is missing' : state.missing.length + ' required documents are missing'}</h2><p>Upload the PDF here (or drop it on the row), then run a new assessment. The engine checks it is this company's document before accepting it.</p></div></div>
    <ul>{state.missing.map(kind => <li key={kind}>
      <div><strong>{name(kind)}</strong>{(DEPENDENT_CHECKS[kind] ?? []).length > 0 && <span>Without it the assessment cannot check {(DEPENDENT_CHECKS[kind] ?? []).map(id => CHECK_NAMES[id] ?? id).join(' or ')}.</span>}</div>
      <AddDocumentButton company={company} kind={kind} label="Upload PDF" onAdded={onAdded} onRunNew={onRunNew} compact />
    </li>)}</ul>
  </section>
}

/** Everything in the dossier: submitted with the application, missing, or added by an employee. */
export function DossierDocuments({ company, state, reload, onRunNew, since }: { company: Company; state: DossierState | null; reload: () => void; onRunNew: () => void; since: string | null }) {
  const [replacing, setReplacing] = useState<string | null>(null)
  if (!state) return <section className="panel dossier-docs"><div className="dossier-docs-head"><FileText size={15} /><h2>Documents</h2><span><LoaderCircle size={12} className="spin" /></span></div></section>
  const byKind = new Map(state.documents.map(d => [d.kind, d]))
  const changed = since ? state.uploads.filter(u => u.uploadedAt > since) : []
  const order = [...REQUIRED_DOCUMENTS].sort((a, b) => Number(byKind.has(a)) - Number(byKind.has(b)))
  return <section className="panel dossier-docs">
    <div className="dossier-docs-head"><FileText size={15} /><h2>Documents</h2>
      <span>{REQUIRED_DOCUMENTS.length - state.missing.length} of {REQUIRED_DOCUMENTS.length} required{state.uploads.length ? ' · ' + state.uploads.length + ' added by employees' : ''}</span></div>
    {changed.length > 0 && <div className="dossier-changed"><RotateCcw size={14} /><div><strong>Documents changed after the latest assessment.</strong> {changed.map(u => name(u.kind)).join(', ')} {changed.length === 1 ? 'was' : 'were'} added since then.</div><button className="add-doc-run" onClick={onRunNew}>Run new assessment<ArrowRight size={13} /></button></div>}
    <ul className="dossier-list">{order.map(kind => {
      const doc = byKind.get(kind)
      const upload = doc?.supplied ? state.uploads.find(u => u.id === doc.supplied!.uploadId) : undefined
      return <li key={kind} className={!doc ? 'doc-row-missing' : upload ? 'doc-row-added' : ''}>
        <span className="doc-row-state">{!doc ? <X size={13} /> : upload ? <FilePlus2 size={13} /> : <Check size={13} />}</span>
        <div className="doc-row-main"><strong>{name(kind)}</strong>
          <span>{!doc ? 'Missing' : upload ? (upload.replaces ? 'Replaced' : 'Added') + ' by ' + upload.uploadedBy + ' · ' + when(upload.uploadedAt) + ' · ' + upload.originalName : doc.pages + (doc.pages === 1 ? ' page' : ' pages') + ' · with the application'}</span></div>
        <div className="doc-row-actions">
          {!doc && <AddDocumentButton company={company} kind={kind} label="Upload PDF" onAdded={reload} compact />}
          {doc && !upload && (replacing === kind ? <AddDocumentButton company={company} kind={kind} label="Choose the new PDF" onAdded={() => { setReplacing(null); reload() }} compact /> : <button className="doc-row-link" onClick={() => setReplacing(kind)}>Replace</button>)}
          {upload && <button className="doc-row-link" onClick={async () => { await removeDocument(company.id, upload.id); reload() }} title="Remove the added document (earlier assessments keep their copy)">Remove</button>}
        </div>
      </li>
    })}</ul>
  </section>
}
