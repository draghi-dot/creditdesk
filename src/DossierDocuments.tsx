import { useEffect, useRef, useState } from 'react'
import { ArrowRight, Check, CircleAlert, FilePlus2, FileText, LoaderCircle, RotateCcw, Upload, X } from 'lucide-react'
import type { DossierUpload } from './assessment'
import { REQUIRED_DOCUMENTS } from './assessment'
import type { Company } from './types'
import { docNames } from './documents'
import type { DossierState } from './runs'
import { addDocument, getDossier, removeDocument, when } from './runs'

const name = (kind: string) => docNames[kind] ?? kind

/**
 * Pick a PDF and add it to the dossier as `kind`. The engine accepts it only
 * if it is this company's document of that type and its fields can be read.
 */
export function AddDocumentButton({ company, kind, label, onAdded, onRunNew, compact = false }: {
  company: Company; kind: string; label?: string; onAdded?: (u: DossierUpload) => void; onRunNew?: () => void; compact?: boolean
}) {
  const input = useRef<HTMLInputElement>(null)
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
  return <div className={'add-doc' + (compact ? ' add-doc-compact' : '')}>
    <input ref={input} type="file" accept="application/pdf,.pdf" hidden onChange={e => pick(e.target.files?.[0])} />
    {state.status !== 'done' && <button className="add-doc-button" onClick={() => input.current?.click()} disabled={state.status === 'uploading'}>
      {state.status === 'uploading' ? <><LoaderCircle size={13} className="spin" />Checking {state.file}…</> : <><Upload size={13} />{label ?? 'Add ' + name(kind).toLowerCase()}</>}
    </button>}
    {state.status === 'error' && <div className="add-doc-error"><CircleAlert size={13} /><div><strong>Not added.</strong> {state.reason}</div><button className="ws-icon" onClick={() => setState({ status: 'idle' })} aria-label="Dismiss"><X size={12} /></button></div>}
    {state.status === 'done' && <div className="add-doc-done"><Check size={14} /><div><strong>{name(kind)} added.</strong> {state.upload.originalName} · {state.upload.pages} {state.upload.pages === 1 ? 'page' : 'pages'} · {state.upload.fields.toLocaleString('en-GB')} fields read. Run a new assessment to re-examine the company with it.</div>
      {onRunNew && <button className="add-doc-run" onClick={onRunNew}>Run new assessment<ArrowRight size={13} /></button>}</div>}
  </div>
}

/** The company's dossier as it stands now: what was submitted, what is missing, what the analyst added. */
export function DossierDocuments({ company, onRunNew, onChange, since }: { company: Company; onRunNew: () => void; onChange?: (s: DossierState) => void; since: string | null }) {
  const [state, setState] = useState<DossierState | null>(null)
  const [error, setError] = useState('')
  const [replacing, setReplacing] = useState<string | null>(null)
  const load = () => getDossier(company.id).then(s => { setState(s); onChange?.(s); setError('') }).catch(e => setError(e.message))
  useEffect(() => { load() }, [company.id])
  if (error) return null
  if (!state) return <section className="panel dossier-docs"><div className="dossier-docs-head"><FileText size={15} /><h2>Dossier documents</h2><span><LoaderCircle size={12} className="spin" /></span></div></section>
  const byKind = new Map(state.documents.map(d => [d.kind, d]))
  const changed = since ? state.uploads.filter(u => u.uploadedAt > since) : []
  return <section className="panel dossier-docs">
    <div className="dossier-docs-head"><FileText size={15} /><h2>Dossier documents</h2>
      <span>{REQUIRED_DOCUMENTS.length - state.missing.length} of {REQUIRED_DOCUMENTS.length} required present{state.uploads.length ? ' · ' + state.uploads.length + ' added by the analyst' : ''}</span></div>
    {changed.length > 0 && <div className="dossier-changed"><RotateCcw size={14} /><div><strong>The dossier changed after the latest assessment.</strong> {changed.map(u => name(u.kind)).join(', ')} {changed.length === 1 ? 'was' : 'were'} added since then. Run a new assessment to re-examine the company with {changed.length === 1 ? 'it' : 'them'}.</div><button className="add-doc-run" onClick={onRunNew}>Run new assessment<ArrowRight size={13} /></button></div>}
    <ul className="dossier-list">{REQUIRED_DOCUMENTS.map(kind => {
      const doc = byKind.get(kind)
      const upload = doc?.supplied ? state.uploads.find(u => u.id === doc.supplied!.uploadId) : undefined
      return <li key={kind} className={!doc ? 'doc-row-missing' : upload ? 'doc-row-added' : ''}>
        <span className="doc-row-state">{!doc ? <X size={13} /> : upload ? <FilePlus2 size={13} /> : <Check size={13} />}</span>
        <div className="doc-row-main"><strong>{name(kind)}</strong>
          <span>{!doc ? 'Missing from the dossier' : upload ? (upload.replaces ? 'Replaced' : 'Added') + ' by ' + upload.uploadedBy + ' · ' + when(upload.uploadedAt) + ' · ' + upload.originalName : doc.pages + (doc.pages === 1 ? ' page' : ' pages') + ' · submitted with the application'}</span></div>
        <div className="doc-row-actions">
          {!doc && <AddDocumentButton company={company} kind={kind} label="Add document" onAdded={load} compact />}
          {doc && !upload && (replacing === kind ? <AddDocumentButton company={company} kind={kind} label="Choose replacement PDF" onAdded={() => { setReplacing(null); load() }} compact /> : <button className="doc-row-link" onClick={() => setReplacing(kind)}>Replace</button>)}
          {upload && <button className="doc-row-link" onClick={async () => { await removeDocument(company.id, upload.id); load() }} title="Remove the added document (earlier assessments keep their copy)">Remove</button>}
        </div>
      </li>
    })}</ul>
    <p className="dossier-note">Added documents are checked before they are accepted: they must be this company's document of the chosen type, with readable fields. A document that was missing becomes the recorded data; a replacement is reconciled against the data the bank already recorded. Files are stored with the engine; the original dossier is not modified.</p>
  </section>
}
