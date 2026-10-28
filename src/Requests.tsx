import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { CircleAlert, Mail, PenLine, Plus, Send, Trash2, UserRound } from 'lucide-react'
import type { Company } from './types'
import type { CompanyRequest, Contact, GmailState } from './workspace'
import { undeliverable } from './workspace'
import { Button, Dialog } from './components'
import { when } from './runs'
import type { Drafted } from './people'
import { listContacts, removeContact, saveContact, saveRequest, sendRequest } from './people'

/** The company's representatives: who requests go to. */
export function ContactsCard({ company, onChange }: { company: Company; onChange?: (c: Contact[]) => void }) {
  const [contacts, setContacts] = useState<Contact[] | null>(null)
  const [editing, setEditing] = useState<Partial<Contact> | null>(null)
  const [error, setError] = useState('')
  const update = (c: Contact[]) => { setContacts(c); onChange?.(c) }
  useEffect(() => { listContacts(company.id).then(update).catch(() => update([])) }, [company.id])
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    try { update(await saveContact(company.id, { id: editing!.id, name: editing!.name ?? '', role: editing!.role ?? '', email: editing!.email ?? '', phone: editing!.phone ?? '' })); setEditing(null); setError('') }
    catch (err: any) { setError(err.message) }
  }
  const reachable = (contacts ?? []).filter(c => !c.placeholder)
  return <section className="panel side-card">
    <div className="side-card-head"><h2>Contacts</h2><button className="text-button" onClick={() => { setEditing({}); setError('') }}><Plus size={14} />Add contact</button></div>
    {!reachable.length && contacts && <p className="side-card-warn"><CircleAlert size={14} />No representative with an email address is on file. Add one to send requests.</p>}
    <ul className="contact-list">{(contacts ?? []).filter(c => !c.placeholder).map(c => <li key={c.id}>
      <span className="contact-icon"><UserRound size={14} /></span>
      <div><strong>{c.name}</strong><span>{c.role}{c.email ? ' · ' + c.email : ''}{c.phone ? ' · ' + c.phone : ''}</span></div>
      {c.source === 'added' && <div className="contact-actions"><button className="ws-icon" onClick={() => setEditing(c)} aria-label={'Edit ' + c.name}><PenLine size={13} /></button><button className="ws-icon" onClick={async () => update(await removeContact(company.id, c.id))} aria-label={'Remove ' + c.name}><Trash2 size={13} /></button></div>}
    </li>)}</ul>
    {editing && <Dialog title={editing.id ? 'Edit contact' : 'Add a contact'} description={company.name} onClose={() => setEditing(null)}>
      <form onSubmit={submit}><div className="form-content form-grid">
        <label className="field-label">Name<input required minLength={2} value={editing.name ?? ''} onChange={e => setEditing({ ...editing, name: e.target.value })} autoFocus /></label>
        <label className="field-label">Role<input value={editing.role ?? ''} placeholder="e.g. Chief financial officer" onChange={e => setEditing({ ...editing, role: e.target.value })} /></label>
        <label className="field-label">Email<input type="email" value={editing.email ?? ''} onChange={e => setEditing({ ...editing, email: e.target.value })} /></label>
        <label className="field-label">Phone<input value={editing.phone ?? ''} onChange={e => setEditing({ ...editing, phone: e.target.value })} /></label>
        {error && <p className="form-error"><CircleAlert size={14} />{error}</p>}
      </div><div className="dialog-actions"><Button type="button" onClick={() => setEditing(null)}>Cancel</Button><Button variant="primary" type="submit">Save contact</Button></div></form>
    </Dialog>}
  </section>
}

/** Ask the assistant for a draft; the employee reviews it before anything is sent. */
export function DraftRequestButton({ label = 'Draft a request', draft, onDrafted, contacts, small }: {
  label?: string; draft: (options: { language: 'en' | 'ro'; instructions?: string; contactId?: string }) => Promise<Drafted>; onDrafted: (d: Drafted) => void; contacts: Contact[]; small?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [language, setLanguage] = useState<'en' | 'ro'>('en')
  const [instructions, setInstructions] = useState('')
  const [contactId, setContactId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const reachable = contacts.filter(c => !c.placeholder)
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError('')
    try { onDrafted(await draft({ language, instructions: instructions.trim() || undefined, contactId: contactId || undefined })); setOpen(false); setInstructions('') }
    catch (err: any) { setError(err.message) } finally { setBusy(false) }
  }
  return <>
    <Button small={small} onClick={() => setOpen(true)}><Mail size={14} />{label}</Button>
    {open && <Dialog title="Draft a request to the company" description="The assistant writes a draft from the problems on file. You review and edit it before sending." onClose={() => !busy && setOpen(false)}>
      <form onSubmit={submit}><div className="form-content">
        <label className="field-label">To<select value={contactId} onChange={e => setContactId(e.target.value)}>{reachable.length ? reachable.map(c => <option key={c.id} value={c.id}>{c.name} · {c.role}</option>) : <option value="">No contact on file (add one, or fill in the address in the draft)</option>}</select></label>
        <label className="field-label">Language<select value={language} onChange={e => setLanguage(e.target.value as 'en' | 'ro')}><option value="en">English</option><option value="ro">Romanian</option></select></label>
        <label className="field-label">Anything to add (optional)<textarea rows={3} value={instructions} onChange={e => setInstructions(e.target.value)} placeholder="e.g. ask for the signed version; mention our call on Tuesday" /></label>
        {error && <p className="form-error"><CircleAlert size={14} />{error}</p>}
      </div><div className="dialog-actions"><Button type="button" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button><Button variant="primary" type="submit" disabled={busy}>{busy ? 'Writing the draft…' : 'Write draft'}</Button></div></form>
    </Dialog>}
  </>
}

const statusText: Record<CompanyRequest['status'], string> = { draft: 'Draft', sent: 'Sent', failed: 'Not sent' }

/** Requests to the company: drafts to review and send, and what was sent, by whom and when. */
export function RequestList({ requests, gmail, onChange, toast }: { requests: CompanyRequest[]; gmail: GmailState | null; onChange: (r: CompanyRequest) => void; toast: (s: string) => void }) {
  const [open, setOpen] = useState<string | null>(requests.find(r => r.status !== 'sent')?.id ?? null)
  if (!requests.length) return <p className="side-card-empty">No requests yet.</p>
  return <ul className="request-list">{requests.map(r => <li key={r.id} className={'request-' + r.status}>
    <button className="request-row" onClick={() => setOpen(o => o === r.id ? null : r.id)} aria-expanded={open === r.id}>
      <span className={'request-status status-' + r.status}>{statusText[r.status]}</span>
      <div><strong>{r.subject}</strong><span>{r.status === 'sent' ? 'Sent by ' + r.sentBy + ' · ' + when(r.sentAt!) + ' · to ' + (r.to.name || r.to.email) : 'Drafted ' + when(r.createdAt) + (r.draftedBy.startsWith('Codex') ? ' by the assistant' : '')}</span></div>
    </button>
    {open === r.id && <RequestEditor request={r} gmail={gmail} onChange={onChange} toast={toast} />}
  </li>)}</ul>
}

export function RequestEditor({ request, gmail, onChange, toast }: { request: CompanyRequest; gmail: GmailState | null; onChange: (r: CompanyRequest) => void; toast: (s: string) => void }) {
  const [draft, setDraft] = useState(request)
  const [busy, setBusy] = useState<'save' | 'send' | null>(null)
  const [error, setError] = useState(request.error ?? '')
  const sent = request.status === 'sent'
  const changed = JSON.stringify([draft.to, draft.subject, draft.body]) !== JSON.stringify([request.to, request.subject, request.body])
  const blocker = !draft.to.email ? 'Add the recipient\'s email address.' : undeliverable(draft.to.email) ? 'The recipient\'s email address is not valid.'
    : !gmail?.configured ? 'Gmail is not set up for this workspace yet.' : !gmail.connected ? 'Connect your Gmail (your name, top right) to send.' : ''
  const save = async () => { setBusy('save'); try { onChange(await saveRequest(request.id, { to: draft.to, subject: draft.subject, body: draft.body })); setError('') } catch (e: any) { setError(e.message) } finally { setBusy(null) } }
  const send = async () => {
    setBusy('send')
    try {
      if (changed) await saveRequest(request.id, { to: draft.to, subject: draft.subject, body: draft.body })
      const done = await sendRequest(request.id)
      onChange(done); setError(''); toast('Request sent to ' + (done.to.name || done.to.email))
    } catch (e: any) { setError(e.message) } finally { setBusy(null) }
  }
  if (sent) return <div className="request-editor request-sent"><dl><div><dt>From</dt><dd>{request.sentBy} &lt;{request.sentFrom}&gt;</dd></div><div><dt>To</dt><dd>{request.to.name} &lt;{request.to.email}&gt;</dd></div></dl><pre>{request.body}</pre></div>
  return <div className="request-editor">
    <div className="request-to"><label>To<input value={draft.to.name} placeholder="Name" onChange={e => setDraft({ ...draft, to: { ...draft.to, name: e.target.value } })} /></label><label className="request-email"><span className="visually-hidden">Email</span><input type="email" value={draft.to.email} placeholder="name@company.ro" onChange={e => setDraft({ ...draft, to: { ...draft.to, email: e.target.value } })} /></label></div>
    <label className="request-subject">Subject<input value={draft.subject} onChange={e => setDraft({ ...draft, subject: e.target.value })} /></label>
    <textarea className="request-body" rows={12} value={draft.body} onChange={e => setDraft({ ...draft, body: e.target.value })} aria-label="Message" />
    {request.requirements.length > 0 && <div className="request-reqs"><span>Asks the company for</span><ul>{request.requirements.map((r, i) => <li key={i}>{r}</li>)}</ul></div>}
    {error && <p className="form-error"><CircleAlert size={14} />{error}</p>}
    <div className="request-actions">
      <span className="request-hint">{blocker || 'Sends from ' + gmail!.connected!.email + ' when you press Send.'}</span>
      {changed && <Button small onClick={save} disabled={!!busy}>{busy === 'save' ? 'Saving…' : 'Save draft'}</Button>}
      <Button small variant="primary" onClick={send} disabled={!!busy || !!blocker}><Send size={13} />{busy === 'send' ? 'Sending…' : 'Send'}</Button>
    </div>
  </div>
}

