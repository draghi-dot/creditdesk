import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { AlertTriangle, ArrowRight, Bot, Check, CircleAlert, Gavel, Globe2, Lock, LoaderCircle, Mail, RefreshCw, Send, ShieldAlert, Snowflake, Unlock } from 'lucide-react'
import type { Company } from './types'
import type { MonitorEvent } from './monitoring'
import { compactSteps } from './monitoring'
import type { ClientRisk, CompanyRequest, RiskAction, WatchGrade } from './workspace'
import { riskActionLabels, riskStatus } from './workspace'
import { money } from './analysis'
import { Button, Dialog } from './components'
import { RequestEditor } from './Requests'
import type { RiskNoteView, SignalRef } from './people'
import { approveFreeze, assessSignal, clearWatchlist, discussSignal, draftNotice, getClients, getRisk, liftFreeze, openCase, requestFreeze, setWatchlist, snapshotUrl, useMonitoring, useSession } from './people'

/**
 * Early warning for credit clients. A serious monitoring signal is shown so it
 * cannot be missed; the assistant reads it against the credit line and says
 * what the bank usually does; every action is the employee's, recorded, and
 * the heavy ones (stopping drawdowns) need a second employee.
 */

const ACTION_ICONS: Record<RiskAction, typeof Lock> = { watchlist: ShieldAlert, information: Mail, freeze: Snowflake, reassess: RefreshCw, legal: Gavel }
const severityText = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' }

export function useRisk(companyId: string) {
  const [risk, setRisk] = useState<ClientRisk | null>(null)
  const reload = () => getRisk(companyId).then(setRisk).catch(() => {})
  useEffect(() => { reload() }, [companyId])
  useEffect(() => { const again = () => reload(); window.addEventListener('creditdesk:risk', again); return () => window.removeEventListener('creditdesk:risk', again) }, [companyId])
  return { risk, setRisk: (r: ClientRisk) => { setRisk(r); window.dispatchEvent(new Event('creditdesk:risk')) }, reload }
}

/** Every client's watch status, kept fresh when one changes. */
export function useClientRisks() {
  const [risks, setRisks] = useState<Map<string, ClientRisk>>(new Map())
  useEffect(() => {
    const load = () => getClients().then(v => setRisks(new Map(v.risk.map(r => [r.companyId, r])))).catch(() => {})
    load(); window.addEventListener('creditdesk:risk', load); return () => window.removeEventListener('creditdesk:risk', load)
  }, [])
  return risks
}

export function RiskChip({ risk }: { risk: ClientRisk | null }) {
  const status = riskStatus(risk)
  return <span className={'risk-chip risk-' + status.tone}>{status.tone === 'ok' ? <Check size={11} /> : <ShieldAlert size={11} />}{status.label}{risk?.freeze?.status === 'requested' ? ' · freeze awaiting approval' : ''}</span>
}

/** Across the top of a credit client's page when something serious is open: what it is, the client's watch status, and what to do. */
export function RiskBanner({ company, onReview, toast }: { company: Company; onReview: (e: MonitorEvent) => void; toast: (s: string) => void }) {
  const { state, refresh } = useMonitoring()
  const { risk, setRisk } = useRisk(company.id)
  const critical = (state?.events ?? []).filter(e => e.companyId === company.id && e.severity === 'alert' && !e.reviewedAt)
  const watch = (state?.events ?? []).filter(e => e.companyId === company.id && e.severity === 'watch' && !e.reviewedAt)
  if (!critical.length && !watch.length && !risk?.watchlist && !risk?.freeze) return null
  const top = critical[0] ?? watch[0]
  return <section className={'risk-banner' + (critical.length ? ' critical' : ' watched')} role="alert">
    <span className="risk-banner-icon"><AlertTriangle size={22} /></span>
    <div className="risk-banner-main">
      <div className="risk-banner-top"><strong>{critical.length ? critical.length + (critical.length === 1 ? ' critical signal' : ' critical signals') + ' on ' + (company.monitorTerms?.[0] ?? company.name) : watch.length ? watch.length + (watch.length === 1 ? ' signal' : ' signals') + ' to look at on ' + (company.monitorTerms?.[0] ?? company.name) : 'Under watch'}</strong><RiskChip risk={risk} /></div>
      {top && <p><span>{top.title}</span>{top.data?.site ? ' · ' + top.data.site : ''}{top.data?.published ? ' · ' + top.data.published : ''}</p>}
      {[...critical, ...watch].length > 1 && <ul>{[...critical, ...watch].slice(1, 4).map(e => <li key={e.id}><button onClick={() => onReview(e)}>{e.title}</button></li>)}</ul>}
      {risk?.watchlist && <p className="risk-banner-watch">Watchlist {risk.watchlist.grade} since {new Date(risk.watchlist.since).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} · owner {risk.watchlist.owner} · review by {risk.watchlist.reviewDate} · {risk.watchlist.reason}</p>}
    </div>
    {top?.data?.snapshot && top.data.sha256 && <PagePreview sha={top.data.sha256} title={top.title} onOpen={() => onReview(top)} />}
    <div className="risk-banner-actions">
      {top && <Button variant="dark" onClick={() => onReview(top)}><Bot size={15} />Review with the assistant</Button>}
      <FreezeControl company={company} risk={risk} onRisk={setRisk} toast={toast} />
      {risk?.watchlist ? <Button onClick={async () => { const note = window.prompt('Why does the watch end?', 'The client explained; the risk is resolved.'); if (note === null) return; setRisk(await clearWatchlist(company.id, note)); refresh(); toast('Taken off the watchlist') }}>End watch</Button> : null}
    </div>
  </section>
}

/** Stopping drawdowns: one employee asks, a second approves (four eyes). */
function FreezeControl({ company, risk, onRisk, toast }: { company: Company; risk: ClientRisk | null; onRisk: (r: ClientRisk) => void; toast: (s: string) => void }) {
  const { session } = useSession()
  const me = session?.user.name
  if (!risk?.freeze) return null
  if (risk.freeze.status === 'active') return <Button onClick={async () => { const note = window.prompt('Why are drawdowns allowed again?'); if (!note) return; try { onRisk(await liftFreeze(company.id, note)); toast('Drawdowns allowed again') } catch (e: any) { toast(e.message) } }}><Unlock size={14} />Lift freeze</Button>
  return risk.freeze.requestedBy === me
    ? <span className="freeze-wait" title="Switch employee from the menu to approve as someone else"><Snowflake size={13} />Freeze waiting for a second approver</span>
    : <Button variant="primary" onClick={async () => { try { onRisk(await approveFreeze(company.id)); toast('Drawdowns frozen') } catch (e: any) { toast(e.message) } }}><Snowflake size={14} />Approve freeze (asked by {risk.freeze.requestedBy.split(' ')[0]})</Button>
}

/** The assistant on one signal: its risk note, the actions it proposes, and a conversation. */
export function SignalAgent({ company, signal, toast, compact = false }: { company: Company; signal: SignalRef; toast: (s: string) => void; compact?: boolean }) {
  const [note, setNote] = useState<RiskNoteView | null>(null)
  const [error, setError] = useState('')
  const [turns, setTurns] = useState<{ question: string; answer: string; actions: RiskAction[]; author: string }[]>([])
  const [question, setQuestion] = useState('')
  const [asking, setAsking] = useState<string | null>(null)
  const [doing, setDoing] = useState<RiskAction | null>(null)
  const { risk, setRisk } = useRisk(company.id)
  const list = useRef<HTMLDivElement>(null)
  const key = signal.eventId ?? signal.url
  useEffect(() => { setNote(null); setError(''); setTurns([]); assessSignal(signal).then(setNote).catch(e => setError(e.message)) }, [key])
  useEffect(() => { list.current?.scrollTo({ top: list.current.scrollHeight, behavior: 'smooth' }) }, [turns.length, asking])
  const ask = async (e?: FormEvent, text = question) => {
    e?.preventDefault()
    if (!text.trim() || asking) return
    setQuestion(''); setAsking(text)
    try { const a = await discussSignal(signal, text, turns.map(t => ({ question: t.question, answer: t.answer }))); setTurns(t => [...t, { question: text, answer: a.answer, actions: a.actions, author: a.author }]) }
    catch (err: any) { toast(err.message) } finally { setAsking(null) }
  }
  const proposed = note ? note.actions : []
  return <div className={'signal-agent' + (compact ? ' compact' : '')}>
    <div className="sa-head"><span className="sa-avatar"><Bot size={15} /></span><div><strong>Risk assistant</strong><span>{note ? note.author : 'Reading the signal against the credit line…'}</span></div><RiskChip risk={risk} /></div>
    <div className="sa-body" ref={list}>
      {!note && !error && <div className="sa-loading"><LoaderCircle size={14} className="spin" />Weighing it against the credit line, the latest assessment and the other signals</div>}
      {error && <p className="form-error"><CircleAlert size={13} />{error}</p>}
      {note && <div className={'sa-note sev-' + note.severity}>
        <span className="sa-severity">{severityText[note.severity]}{note.grade !== 'none' ? ' · watchlist ' + note.grade + ' recommended' : ''}</span>
        <strong>{note.headline}</strong>
        <p>{note.summary}</p>
        <p className="sa-exposure">{note.exposure}</p>
        {note.unsupported.length > 0 && <p className="sa-flag"><CircleAlert size={11} />Not found in the facts: {note.unsupported.join(', ')}</p>}
        {proposed.length > 0 && <><h5>What the bank usually does</h5><ol className="sa-actions">{proposed.map((a, i) => { const Icon = ACTION_ICONS[a.kind]; return <li key={i}>
          <div><Icon size={14} /><div><strong>{riskActionLabels[a.kind]}</strong><span>{a.why}</span></div></div>
          <ActionButton kind={a.kind} company={company} risk={risk} grade={note.grade === 'none' ? 'amber' : note.grade} reason={note.headline} signal={signal} busy={doing === a.kind} onBusy={b => setDoing(b ? a.kind : null)} onRisk={setRisk} toast={toast} />
        </li> })}</ol></>}
      </div>}
      {turns.map((t, i) => <div key={i} className="sa-turn"><p className="sa-q">{t.question}</p><div className="sa-a"><p>{t.answer}</p>{t.actions.length > 0 && <div className="sa-chips">{t.actions.map(a => <ActionButton key={a} kind={a} company={company} risk={risk} grade={note?.grade === 'red' ? 'red' : 'amber'} reason={note?.headline ?? ''} signal={signal} busy={doing === a} onBusy={b => setDoing(b ? a : null)} onRisk={setRisk} toast={toast} small />)}</div>}<small>{t.author}</small></div></div>)}
      {asking && <div className="sa-turn"><p className="sa-q">{asking}</p><div className="sa-a sa-pending"><LoaderCircle size={13} className="spin" />Thinking it through</div></div>}
    </div>
    {note && !turns.length && !asking && <div className="sa-suggest">{['How bad is this for our loan?', 'What should we ask the client?', 'Should we stop drawdowns?'].map(q => <button key={q} onClick={() => ask(undefined, q)}>{q}</button>)}</div>}
    <form className="sa-form" onSubmit={ask}><input value={question} onChange={e => setQuestion(e.target.value)} placeholder="Ask the assistant about this…" aria-label="Ask the risk assistant" disabled={!!asking} /><button type="submit" disabled={!question.trim() || !!asking} aria-label="Ask"><Send size={14} /></button></form>
  </div>
}

/** One proposed action: the employee decides, the engine records. */
function ActionButton({ kind, company, risk, grade, reason, signal, busy, onBusy, onRisk, toast, small = false }: {
  kind: RiskAction; company: Company; risk: ClientRisk | null; grade: WatchGrade; reason: string; signal: SignalRef; busy: boolean; onBusy: (b: boolean) => void; onRisk: (r: ClientRisk) => void; toast: (s: string) => void; small?: boolean
}) {
  const [open, setOpen] = useState<RiskAction | null>(null)
  const [request, setRequest] = useState<CompanyRequest | null>(null)
  const done = kind === 'watchlist' ? !!risk?.watchlist : kind === 'freeze' ? !!risk?.freeze : false
  const label = done ? (kind === 'watchlist' ? 'On the watchlist' : risk?.freeze?.status === 'active' ? 'Frozen' : 'Waiting for approval') : riskActionLabels[kind]
  const go = async () => {
    if (kind === 'reassess') { window.dispatchEvent(new CustomEvent('creditdesk:run', { detail: company.id })); toast('Starting a new assessment of ' + company.name); return }
    if (kind === 'legal') {
      onBusy(true)
      try { const { case: c } = await openCase({ companyId: company.id, runId: null, department: 'legal', title: 'Early warning: ' + reason.slice(0, 120), note: 'Raised from a monitoring signal' + (signal.url ? ': ' + signal.url : '') + '.' }); toast('Sent to Legal as case ' + c.ref) }
      catch (e: any) { toast(e.message) } finally { onBusy(false) }
      return
    }
    if (kind === 'information') {
      onBusy(true)
      try { const d = await draftNotice(signal, 'en'); setRequest(d.request); setOpen('information') } catch (e: any) { toast(e.message) } finally { onBusy(false) }
      return
    }
    setOpen(kind)
  }
  return <>
    <Button small variant={done ? 'secondary' : kind === 'watchlist' || kind === 'freeze' ? 'dark' : 'secondary'} disabled={done || busy} onClick={go}>{busy ? <LoaderCircle size={13} className="spin" /> : done ? <Check size={13} /> : null}{busy && kind === 'information' ? 'Drafting…' : label}</Button>
    {open === 'watchlist' && <WatchlistDialog company={company} grade={grade} reason={reason} onClose={() => setOpen(null)} onDone={r => { onRisk(r); setOpen(null); toast('On the watchlist (' + r.watchlist!.grade + '); a case was opened in Credit') }} />}
    {open === 'freeze' && <FreezeDialog company={company} reason={reason} onClose={() => setOpen(null)} onDone={r => { onRisk(r); setOpen(null); toast('Freeze requested; a second employee has to approve it') }} />}
    {open === 'information' && request && <Dialog wide title="Request for information" description={company.name + ' · drafted by the assistant; review it and press Send'} onClose={() => setOpen(null)}>
      <div className="notice-editor"><RequestEditor request={request} gmail={null} onChange={r => { setRequest(r); if (r.status === 'sent') { toast('Request for information recorded as sent (simulated)'); setOpen(null) } }} toast={toast} /></div>
    </Dialog>}
  </>
}

function WatchlistDialog({ company, grade: initial, reason: initialReason, onClose, onDone }: { company: Company; grade: WatchGrade; reason: string; onClose: () => void; onDone: (r: ClientRisk) => void }) {
  const { session } = useSession()
  const [grade, setGrade] = useState<WatchGrade>(initial)
  const [reason, setReason] = useState(initialReason)
  const [reviewDate, setReviewDate] = useState(new Date(Date.now() + (initial === 'red' ? 7 : 30) * 86_400_000).toISOString().slice(0, 10))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submit = async (e: FormEvent) => { e.preventDefault(); setBusy(true); try { onDone(await setWatchlist(company.id, { grade, reason, reviewDate, owner: session?.user.name })) } catch (err: any) { setError(err.message) } finally { setBusy(false) } }
  return <Dialog title="Put on the watchlist" description={company.name + ' · ' + money(company.creditLine!.drawn) + ' drawn of ' + money(company.creditLine!.limit)} onClose={() => !busy && onClose()}>
    <form onSubmit={submit}><div className="form-content">
      <fieldset className="grade-choice"><legend>Grade</legend>
        <label className={grade === 'amber' ? 'checked amber' : 'amber'}><input type="radio" checked={grade === 'amber'} onChange={() => { setGrade('amber'); setReviewDate(new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10)) }} /><strong>Amber</strong><span>Closer watch; the client explains</span></label>
        <label className={grade === 'red' ? 'checked red' : 'red'}><input type="radio" checked={grade === 'red'} onChange={() => { setGrade('red'); setReviewDate(new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10)) }} /><strong>Red</strong><span>Repayment may be at risk</span></label>
      </fieldset>
      <label className="field-label">Why<textarea rows={3} value={reason} onChange={e => setReason(e.target.value)} required /></label>
      <label className="field-label">Review by<input type="date" value={reviewDate} onChange={e => setReviewDate(e.target.value)} required /></label>
      <p className="field-help">You become the owner. A case opens in Credit to work the watch; the requests sent to the client are kept there.</p>
      {error && <p className="form-error"><CircleAlert size={13} />{error}</p>}
    </div><div className="dialog-actions"><Button type="button" onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" disabled={busy}><ShieldAlert size={14} />{busy ? 'Saving…' : 'Put on watchlist (' + grade + ')'}</Button></div></form>
  </Dialog>
}

function FreezeDialog({ company, reason: initialReason, onClose, onDone }: { company: Company; reason: string; onClose: () => void; onDone: (r: ClientRisk) => void }) {
  const [reason, setReason] = useState(initialReason)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const line = company.creditLine!
  const submit = async (e: FormEvent) => { e.preventDefault(); setBusy(true); try { onDone(await requestFreeze(company.id, reason)) } catch (err: any) { setError(err.message) } finally { setBusy(false) } }
  return <Dialog title="Freeze drawdowns" description={company.name + ' · undrawn ' + money(line.limit - line.drawn) + ' of ' + money(line.limit)} onClose={() => !busy && onClose()}>
    <form onSubmit={submit}><div className="form-content">
      <p className="dialog-text">The client can no longer draw the undrawn {money(line.limit - line.drawn)}. What is already drawn is not affected. A second employee has to approve before it takes effect.</p>
      <label className="field-label">Why<textarea rows={3} value={reason} onChange={e => setReason(e.target.value)} required /></label>
      {error && <p className="form-error"><CircleAlert size={13} />{error}</p>}
    </div><div className="dialog-actions"><Button type="button" onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" disabled={busy}><Snowflake size={14} />{busy ? 'Asking…' : 'Ask for the freeze'}</Button></div></form>
  </Dialog>
}

/** The page as the crawler read it, small: a render of the captured snapshot, scripts off. */
export function PagePreview({ sha, title, onOpen, large = false }: { sha: string; title: string; onOpen?: () => void; large?: boolean }) {
  return <button type="button" className={'page-preview' + (large ? ' large' : '')} onClick={onOpen} title="The page as it was read" disabled={!onOpen}>
    <iframe sandbox="" src={snapshotUrl(sha)} tabIndex={-1} aria-hidden="true" title={'Page as read: ' + title} loading="lazy" />
    <span className="page-preview-label"><Globe2 size={11} />Page as read</span>
  </button>
}

/** A signal that is not an article (register, covenants, or any news change): the assistant in a dialog. */
export function SignalDialog({ company, event, onClose, toast }: { company: Company; event: MonitorEvent; onClose: () => void; toast: (s: string) => void }) {
  return <Dialog wide title={event.title} description={company.name + ' · ' + (event.data?.site ?? event.source) + (event.data?.published ? ' · ' + event.data.published : '')} onClose={onClose}>
    <div className="signal-dialog">
      <div className="signal-dialog-main">
        <blockquote>{event.detail}</blockquote>
        {/* The page as the crawler read it, full size and scrollable, its scripts off. */}
        {event.data?.snapshot && event.data.sha256 ? <div className="signal-page"><div className="signal-page-bar"><Globe2 size={12} />Page as read · {event.data.site}{event.data.published ? ' · ' + event.data.published : ''}{event.data.url && <a href={event.data.url} target="_blank" rel="noreferrer">Open the original<ArrowRight size={11} /></a>}</div><iframe sandbox="" src={snapshotUrl(event.data.sha256)} title={'Page as read: ' + event.title} /></div>
          : event.data?.url && <a className="text-button" href={event.data.url} target="_blank" rel="noreferrer">Open the original<ArrowRight size={12} /></a>}
        {!!event.data?.steps?.length && <details className="signal-steps" open={!event.data?.snapshot}><summary>How it was found · {compactSteps(event.data.steps).length} steps</summary><ol className="found-steps">{compactSteps(event.data.steps).map((s, i, all) => <li key={i} className={i === all.length - 1 ? 'last' : ''}>{s}</li>)}</ol></details>}
      </div>
      <SignalAgent company={company} signal={{ companyId: company.id, eventId: event.id, url: event.data?.url }} toast={toast} />
    </div>
  </Dialog>
}
