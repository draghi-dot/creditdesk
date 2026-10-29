import { useState } from 'react'
import { ArrowRight, Check, ChevronRight, FileText, Flag, Lock, LoaderCircle, PartyPopper, PenLine, Send, ShieldCheck, UserCheck } from 'lucide-react'
import type { Company, Decision } from './types'
import type { ReviewSection, Workflow } from './workspace'
import { REVIEW_SECTIONS } from './workspace'
import { decisionLabels, money } from './analysis'
import { Badge, Button, Select } from './components'
import { useSession, workflowStep } from './people'

/**
 * The path from a completed assessment to a signed client: every section of
 * the dossier reviewed, an analyst's recommendation, a second employee's
 * approval, the contract sent and signed. Each step is recorded in the
 * company's activity log; the engine refuses a step whose turn has not come.
 */

export const sectionLabels: Record<ReviewSection | 'contract', string> = { findings: 'Assessment', financials: 'Financials', documents: 'Documents', scenarios: 'Scenarios', audit: 'Activity & checks', contract: 'Decision' }
const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

/** Under each section: mark it reviewed, then go on to the next one. */
export function ReviewBar({ companyId, runId, section, flow, onFlow, onNext, toast }: {
  companyId: string; runId: string; section: ReviewSection; flow: Workflow | null; onFlow: (w: Workflow) => void; onNext: () => void; toast: (s: string) => void
}) {
  const [busy, setBusy] = useState(false)
  const done = flow?.reviewed[section]
  const next = REVIEW_SECTIONS[REVIEW_SECTIONS.indexOf(section) + 1]
  const remaining = REVIEW_SECTIONS.filter(s => !flow?.reviewed[s] && s !== section).length
  return <div className={'review-bar' + (done ? ' done' : '')}>
    <span className="review-bar-icon">{done ? <Check size={16} strokeWidth={2.6} /> : <ShieldCheck size={16} />}</span>
    <div><strong>{done ? sectionLabels[section] + ' reviewed' : 'Reviewed the ' + sectionLabels[section].toLowerCase() + '?'}</strong>
      <span>{done ? 'by ' + done.by + ' · ' + when(done.at) : 'Every section is reviewed before the decision can be signed' + (remaining ? ' · ' + remaining + ' more after this one' : ' · this is the last one')}</span></div>
    {!done && <Button variant="primary" disabled={busy || !flow} onClick={async () => { setBusy(true); try { onFlow(await workflowStep(companyId, runId, 'review', section)); toast(sectionLabels[section] + ' marked reviewed') } catch (e: any) { toast(e.message) } finally { setBusy(false) } }}><Check size={15} />Mark reviewed</Button>}
    <Button onClick={onNext}>{next ? 'Next: ' + sectionLabels[next] : 'Go to the decision'}<ArrowRight size={15} /></Button>
  </div>
}

/** The tabs as a path, the decision at its end. */
export function FlowTabs({ tabs, tab, onTab, flow, counts }: { tabs: { id: string; label: string }[]; tab: string; onTab: (id: any) => void; flow: Workflow | null; counts: Record<string, { n: number; alert?: boolean }> }) {
  const reviewedAll = REVIEW_SECTIONS.every(s => flow?.reviewed[s])
  return <div className="flow-tabs" role="tablist" aria-label="Dossier sections, in order">{tabs.map((item, i) => {
    const end = item.id === 'contract'
    const reviewed = !end && flow?.reviewed[item.id as ReviewSection]
    return <span key={item.id} className="flow-step">
      {i > 0 && <ChevronRight size={15} className={'flow-arrow' + (flow?.reviewed[tabs[i - 1].id as ReviewSection] ? ' passed' : '')} />}
      <button role="tab" aria-selected={tab === item.id} className={(tab === item.id ? 'active ' : '') + (end ? 'flow-end' + (reviewedAll ? ' ready' : '') : '') + (reviewed ? ' reviewed' : '')} onClick={() => onTab(item.id)}>
        {end ? (flow?.signed ? <PartyPopper size={14} /> : reviewedAll ? <Flag size={14} /> : <Lock size={13} />) : reviewed ? <span className="flow-tick"><Check size={11} strokeWidth={3} /></span> : <span className="flow-num">{i + 1}</span>}
        {item.label}
        {counts[item.id] && counts[item.id].n > 0 && <span className={counts[item.id].alert ? 'tab-count-alert' : ''}>{counts[item.id].n}</span>}
      </button>
    </span>
  })}</div>
}

/** The end of the path: the decision, the second approval, the contract sent and signed, and the client it makes. */
export function DecisionPanel({ company, runId, decision, flow, onFlow, onRecommend, onTab, onOpenClient, onContract, contractHash, toast }: {
  company: Company; runId: string; decision: Decision; flow: Workflow | null; onFlow: (w: Workflow) => void; onRecommend: () => void; onTab: (id: any) => void
  onOpenClient: () => void; onContract: () => void; contractHash: string; toast: (s: string) => void
}) {
  const { session, switchUser } = useSession()
  const me = session?.user.name ?? ''
  // Four eyes: whoever recommended cannot approve; the approval can be handed to a colleague from here.
  const approvers = (session?.users ?? []).filter(u => u.name !== flow?.recommendation?.by)
  const approveAs = async (userId: string) => {
    setBusy('approve')
    try {
      await switchUser(userId)
      window.dispatchEvent(new Event('creditdesk:session'))
      onFlow(await workflowStep(company.id, runId, 'approve'))
      toast('Credit approved by ' + (approvers.find(u => u.id === userId)?.name ?? 'a second employee'))
    } catch (e: any) { toast(e.message) } finally { setBusy(null) }
  }
  const [busy, setBusy] = useState<string | null>(null)
  const request = company.tables.solicitari[0]
  const reviewedAll = REVIEW_SECTIONS.every(s => flow?.reviewed[s])
  const eligible = decision === 'ELIGIBIL'
  const recommended = flow?.recommendation?.value === 'approval'
  const step = async (action: 'approve' | 'send' | 'sign', done: string) => {
    setBusy(action)
    try { const next = await workflowStep(company.id, runId, action); onFlow(next); toast(done); if (action === 'sign') window.dispatchEvent(new Event('creditdesk:clients')) }
    catch (e: any) { toast(e.message) } finally { setBusy(null) }
  }
  const steps: { done: boolean; title: string; detail: React.ReactNode; action?: React.ReactNode }[] = [
    { done: eligible, title: 'Assessment', detail: <><Badge decision={decision} small /> {eligible ? 'The application as submitted meets the credit policy.' : decisionLabels[decision] + ': only an eligible assessment can be signed. Resolve the problems and run a new assessment.'}</> },
    { done: reviewedAll, title: 'Every section reviewed', detail: <span className="flow-review-list">{REVIEW_SECTIONS.map(s => <button key={s} className={flow?.reviewed[s] ? 'ok' : ''} onClick={() => onTab(s)}>{flow?.reviewed[s] ? <Check size={11} /> : null}{sectionLabels[s]}</button>)}</span> },
    { done: recommended, title: 'Analyst recommendation', detail: flow?.recommendation ? (recommended ? 'Approval recommended by ' + flow.recommendation.by + ' · ' + when(flow.recommendation.at) : 'Recommended: ' + flow.recommendation.value + ' (' + flow.recommendation.by + ')') : 'The analyst records a recommendation with the reasons for it.',
      action: !recommended && <Button small onClick={onRecommend} disabled={!eligible || !reviewedAll}><PenLine size={13} />Record recommendation</Button> },
    { done: !!flow?.approval, title: 'Credit approval · second employee', detail: flow?.approval ? 'Approved by ' + flow.approval.by + ' · ' + when(flow.approval.at) : recommended && flow!.recommendation!.by === me ? 'You recommended it, so a colleague approves it (four eyes). Choose who approves.' : 'A second employee approves what the analyst recommended (four eyes).',
      action: !flow?.approval && (recommended && flow!.recommendation!.by === me
        ? <Select small label="Approve as" icon={busy === 'approve' ? <LoaderCircle size={13} className="spin" /> : <UserCheck size={13} />} value="" onChange={id => { if (id) approveAs(id) }} options={[{ value: '', label: 'Approve as…' }, ...approvers.map(u => ({ value: u.id, label: u.name, hint: u.title }))]} disabled={!!busy} />
        : <Button small variant="primary" disabled={!recommended || !!busy} onClick={() => step('approve', 'Credit approved')}>{busy === 'approve' ? <LoaderCircle size={13} className="spin" /> : <UserCheck size={13} />}Approve as {me.split(' ')[0] || 'me'}</Button>) },
    { done: !!flow?.sent, title: 'Contract sent for signature', detail: flow?.sent ? 'Sent to ' + flow.sent.to + ' by ' + flow.sent.by + ' · ' + when(flow.sent.at) + ' · simulated delivery' : 'The contract goes to the company\'s representative to sign.',
      action: !flow?.sent && <Button small disabled={!flow?.approval || !!busy} onClick={() => step('send', 'Contract sent for signature (simulated)')}>{busy === 'send' ? <LoaderCircle size={13} className="spin" /> : <Send size={13} />}{busy === 'send' ? 'Sending…' : 'Send contract'}</Button> },
    { done: !!flow?.signed, title: 'Signature recorded', detail: flow?.signed ? 'Recorded by ' + flow.signed.by + ' · ' + when(flow.signed.at) + ' against the contract\'s SHA-256 ' + contractHash.slice(0, 12) + '…' : 'Once the client has signed, record it here. The company then becomes a credit client.',
      action: !flow?.signed && <Button small variant="primary" disabled={!flow?.sent || !!busy} onClick={() => step('sign', company.name + ' signed: now a credit client')}>{busy === 'sign' ? <LoaderCircle size={13} className="spin" /> : <PenLine size={13} />}Record signature</Button> },
  ]
  const done = steps.filter(s => s.done).length
  return <div className="decision-end">
    <section className={'decision-hero' + (flow?.signed ? ' signed' : '')}>
      <span className="decision-flag">{flow?.signed ? <PartyPopper size={22} /> : <Flag size={22} />}</span>
      <div><span className="decision-eyebrow">Decision · the end of the review</span>
        <h2>{flow?.signed ? 'Signed. ' + company.name + ' is a credit client.' : flow?.client ? company.name + ' is already a credit client (' + (company.creditLine?.facilityId ?? 'credit line') + ').'
          : !eligible ? decisionLabels[decision] + ': not ready for a decision.' : flow?.sent ? 'Sent for signature. Record it once the client signs.' : flow?.approval ? 'Approved. The contract is next.'
          : recommended ? 'Recommended. A second employee approves next.' : reviewedAll ? 'Every section reviewed. The recommendation is next.' : 'Ready for a decision once every section is reviewed.'}</h2>
        <p>{money(request.suma_solicitata)} · {request.durata_luni} months · {done} of {steps.length} steps done</p></div>
      {flow?.client && <Button variant="primary" onClick={onOpenClient}>Open the credit client<ArrowRight size={15} /></Button>}
      <i className="decision-progress"><b style={{ width: done / steps.length * 100 + '%' }} /></i>
    </section>
    <div className="decision-grid">
      <ol className="decision-steps">{steps.map((s, i) => <li key={s.title} className={s.done ? 'done' : steps.slice(0, i).every(p => p.done) ? 'current' : ''}>
        <span className="ds-mark">{s.done ? <Check size={14} strokeWidth={2.6} /> : i + 1}</span>
        <div><strong>{s.title}</strong><div className="ds-detail">{s.detail}</div></div>
        {s.action && <div className="ds-action">{s.action}</div>}
      </li>)}</ol>
      <aside className="panel decision-contract"><FileText size={22} /><h3>Draft financing agreement</h3>
        <dl><div><dt>Borrower</dt><dd>{company.name}</dd></div><div><dt>Amount</dt><dd>{money(request.suma_solicitata)}</dd></div><div><dt>Term</dt><dd>{request.durata_luni} months</dd></div><div><dt>Interest assumption</dt><dd>{(request.dobanda_anuala_ipoteza * 100).toFixed(2)}%</dd></div></dl>
        <Button onClick={onContract}><FileText size={14} />Read the contract</Button>
        <p><ShieldCheck size={12} />Every step is recorded in the company's activity log against the contract's fingerprint.</p></aside>
    </div>
  </div>
}
