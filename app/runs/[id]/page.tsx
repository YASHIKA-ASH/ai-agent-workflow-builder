'use client'

import Link from 'next/link'
import { use, useCallback, useEffect, useMemo, useState } from 'react'
import RequireAuth from '@/components/RequireAuth'
import Header from '@/components/Header'
import { useAuth } from '@/components/AuthProvider'
import { gql, subscribe } from '@/lib/graphql'

type Role = 'owner' | 'editor' | 'viewer'
type StepDefinition = { id: string; position: number; type: string; name: string; config: Record<string, unknown> }
type StepRun = {
  id: string; workflow_step_id: string | null; position: number; step_type: string; step_name: string; status: string
  input: unknown; output: unknown; error: string | null; attempt_count: number; approved_by: string | null; approved_at: string | null
}
type LiveRun = {
  id: string; workflow_id: string; org_id: string; status: string; trigger_type: string; trigger_payload: unknown
  current_position: number; started_at: string | null; finished_at: string | null; error: string | null
  workflow: { name: string; workflow_steps: StepDefinition[] }
  organization: { id: string; name: string; members: Array<{ user_id: string; role: Role }> }
}

const RUN_SUB = `
  subscription RunLive($runId: uuid!) {
    workflow_runs_by_pk(id: $runId) {
      id workflow_id org_id status trigger_type trigger_payload current_position started_at finished_at error
      workflow { name workflow_steps(order_by: {position: asc}) { id position type name config } }
      organization { id name members { user_id role } }
    }
    step_runs(where: {workflow_run_id: {_eq: $runId}}, order_by: {position: asc}) {
      id workflow_step_id position step_type step_name status input output error attempt_count approved_by approved_at
    }
  }
`

export default function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const { user } = useAuth()
  const [run, setRun] = useState<LiveRun | null>(null)
  const [stepRuns, setStepRuns] = useState<StepRun[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [approving, setApproving] = useState('')

  const apply = useCallback((data: { workflow_runs_by_pk: LiveRun | null; step_runs: StepRun[] }) => {
    setRun(data.workflow_runs_by_pk)
    setStepRuns(data.step_runs || [])
    setLoading(false)
  }, [])

  useEffect(() => {
    let dispose: () => void = () => {}
    ;(async () => {
      try {
        const first = await gql<{ workflow_runs_by_pk: LiveRun | null; step_runs: StepRun[] }>(RUN_SUB.replace('subscription RunLive', 'query RunLive'), { runId: id })
        apply(first)
        dispose = subscribe<{ workflow_runs_by_pk: LiveRun | null; step_runs: StepRun[] }>(RUN_SUB, { runId: id }, {
          next: apply,
          error: (e) => setError(e instanceof Error ? e.message : 'Live subscription disconnected'),
        })
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Unable to access this run')
        setLoading(false)
      }
    })()
    return () => dispose()
  }, [id, apply])

  const role = useMemo(() => run?.organization.members.find((m) => m.user_id === user?.id)?.role || null, [run, user?.id])
  const byPosition = useMemo(() => new Map(stepRuns.map((s) => [s.position, s])), [stepRuns])

  async function approve(stepRunId: string) {
    setApproving(stepRunId)
    setError('')
    try {
      await gql(`mutation Approve($id: String!) { approveStep(step_run_id: $id) { success run_id message } }`, { id: stepRunId })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Approval failed')
    } finally {
      setApproving('')
    }
  }

  return <RequireAuth><Header /><main className="page container stack gap-lg">
    {error && <div className="alert error">{error}</div>}
    {loading ? <div className="panel">Opening live run…</div> : !run ? <div className="panel denied"><h1>Run unavailable</h1><p>This run does not exist or your organization permissions do not allow you to see it.</p><Link className="button primary" href="/">Back to dashboard</Link></div> : <>
      <div className="page-head">
        <div><p className="eyebrow">LIVE EXECUTION · {run.organization.name}</p><h1>{run.workflow.name}</h1><p className="muted">Started by {run.trigger_type} · Run {run.id.slice(0, 8)}</p></div>
        <div className="run-head-actions"><span className={`status large ${run.status}`}>{run.status}</span><Link className="button secondary" href={`/workflows/${run.workflow_id}`}>Workflow</Link></div>
      </div>

      <section className="run-summary panel">
        <div><span className="label">Your org role</span><strong>{role || 'none'}</strong></div>
        <div><span className="label">Current position</span><strong>{run.current_position + 1}</strong></div>
        <div><span className="label">Trigger</span><strong>{run.trigger_type}</strong></div>
        <div><span className="label">Retries</span><strong>LLM/HTTP: 2 attempts</strong></div>
      </section>

      <section className="timeline">
        {run.workflow.workflow_steps.map((def) => {
          const sr = byPosition.get(def.position)
          const status = sr?.status || (run.status === 'completed' ? 'skipped' : 'pending')
          const canApprove = sr?.status === 'awaiting_approval' && (role === 'owner' || role === 'editor')
          return <article className={`timeline-step ${status}`} key={def.id}>
            <div className="timeline-marker">{status === 'completed' ? '✓' : status === 'failed' ? '!' : status === 'awaiting_approval' ? 'Ⅱ' : def.position + 1}</div>
            <div className="timeline-content panel">
              <div className="card-head"><div><span className="node-pill">{def.type}</span><h2>{def.name}</h2></div><span className={`status ${status}`}>{status.replaceAll('_', ' ')}</span></div>
              {sr && <div className="step-details">
                <span>Attempts: {sr.attempt_count}</span>{sr.approved_at && <span>Approved {new Date(sr.approved_at).toLocaleTimeString()}</span>}
              </div>}
              {sr?.error && <div className="alert error">{sr.error}</div>}
              {sr?.output != null && <details><summary>Output</summary><pre>{JSON.stringify(sr.output, null, 2)}</pre></details>}
              {sr?.status === 'awaiting_approval' && <div className="approval-box"><div><strong>Paused, awaiting approval</strong><p>Only an owner/editor in {run.organization.name} can resume this run.</p></div>{canApprove ? <button className="button primary" disabled={approving === sr.id} onClick={() => approve(sr.id)}>{approving === sr.id ? 'Approving…' : 'Approve & resume'}</button> : <span className="badge">No approval permission</span>}</div>}
            </div>
          </article>
        })}
      </section>

      {run.error && <div className="alert error"><strong>Run failed:</strong> {run.error}</div>}
      <p className="muted center">This page is driven by a GraphQL subscription. No refresh is required.</p>
    </>}
  </main></RequireAuth>
}
