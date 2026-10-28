import { useEffect, useState } from 'react'
import { ArrowRight, Check, ChevronLeft, ChevronRight, CircleAlert, LoaderCircle, Radio, Square, X } from 'lucide-react'
import type { Company } from './types'
import { decisionLabels } from './analysis'
import { Badge, Button } from './components'
import AssessmentWorkspace from './AssessmentWorkspace'
import { cancelRun, clock, duration, useRunStream } from './runs'
import './assessment.css'

export default function AssessmentRun({ company, runId, onBack, onOpenAssessment, onSettled, onRunNew, toast }: {
  company: Company; runId: string; onBack: () => void; onOpenAssessment: (runId: string) => void; onSettled: () => void; onRunNew: () => void; toast: (s: string) => void
}) {
  const { view, events, connection } = useRunStream(runId)
  const [, tick] = useState(0)
  const [cancelling, setCancelling] = useState(false)
  const running = view?.status === 'running' || view?.status === 'created'
  useEffect(() => {
    if (!running) return
    const id = window.setInterval(() => tick(n => n + 1), 500)
    return () => window.clearInterval(id)
  }, [running])
  const settled = view && !running && view.seq > 0
  useEffect(() => { if (settled) onSettled() }, [settled])

  if (!view || view.seq === 0) return <div className="run-page page-enter"><div className="run-loading"><LoaderCircle size={20} className="spin" />{connection === 'error' ? 'The assessment engine is not reachable.' : 'Connecting to the assessment run…'}</div></div>

  const workers = Object.values(view.workers)
  const finished = workers.filter(w => w.state === 'done' || w.state === 'attention').length
  const cancel = async () => {
    setCancelling(true)
    try { await cancelRun(runId) } catch (e: any) { toast(e.message) }
    setCancelling(false)
  }
  return <div className="run-page page-enter" data-run-status={view.status}>
    <div className="dossier-breadcrumb"><button onClick={onBack}><ChevronLeft size={14} />{company.name}</button><ChevronRight size={12} /><span>Assessment run {runId.slice(0, 8)}</span></div>
    <header className="run-header">
      <div className="run-title">
        <span className={'run-live run-live-' + view.status}>{running ? <Radio size={13} /> : view.status === 'completed' ? <Check size={13} /> : <X size={13} />}</span>
        <div><h1>{running ? 'Assessment in progress' : view.status === 'completed' ? 'Assessment completed' : view.status === 'cancelled' ? 'Assessment cancelled' : 'Assessment failed'}</h1>
          <p>{company.name}<i />started {clock(view.createdAt!).slice(0, 8)}<i />{duration(view.createdAt, view.endedAt)}<i />{finished} of {workers.length} steps done<i />{view.findings.length} {view.findings.length === 1 ? 'problem' : 'problems'}</p></div>
      </div>
      {view.decision && <div className={'run-verdict decision-' + view.decision.decision}><Badge decision={view.decision.decision} /><span>{view.decision.reasons.length ? view.decision.reasons.map(r => r.split(':')[0]).join(' · ') : 'Every policy rule is met'}</span></div>}
      <div className="run-header-actions">
        <span className="run-provider" title="Model used for the legal reading, the report and questions">{view.provider?.id === 'codex' ? <>Codex {view.provider.model} · {view.provider.effort}</> : 'No model: checks only'}</span>
        {running && <Button small onClick={cancel} disabled={cancelling}><Square size={12} />{cancelling ? 'Cancelling…' : 'Cancel run'}</Button>}
        {view.status === 'completed' && <Button small variant="primary" onClick={() => onOpenAssessment(runId)}>Open full assessment<ArrowRight size={14} /></Button>}
      </div>
    </header>
    {view.failure && <div className="run-failure"><CircleAlert size={16} />{view.failure}</div>}
    <AssessmentWorkspace company={company} view={view} events={events} live connection={connection} onRunNew={running ? undefined : onRunNew} />
    {view.decision && <p className="run-footnote">{decisionLabels[view.decision.decision]} under {view.policy?.politica_id} {view.policy?.versiune}. Every step above is a recorded, hash-chained engine event.</p>}
  </div>
}
