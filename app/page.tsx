'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import RequireAuth from '@/components/RequireAuth'
import Header from '@/components/Header'
import { useAuth } from '@/components/AuthProvider'
import { gql } from '@/lib/graphql'

type Role = 'owner' | 'editor' | 'viewer'
type Run = { id: string; status: string; trigger_type: string; created_at: string }
type Workflow = {
  id: string; name: string; description: string; active: boolean
  workflow_steps: Array<{ id: string; position: number; type: string; name: string }>
  workflow_triggers: Array<{ id: string; type: string; enabled: boolean; config: Record<string, unknown> }>
  workflow_runs: Run[]
}
type OrgMembership = {
  role: Role
  organization: { id: string; name: string; quota_allowed: number; quota_used: number; quota_reserved: number; workflows: Workflow[] }
}

export default function Dashboard() {
  const { user } = useAuth()
  const router = useRouter()
  const [memberships, setMemberships] = useState<OrgMembership[]>([])
  const [orgId, setOrgId] = useState('')
  const [loading, setLoading] = useState(true)
  const [busyRun, setBusyRun] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    if (!user?.id) return
    setLoading(true)
    try {
      const data = await gql<{ org_members: OrgMembership[] }>(`
        query Dashboard($userId: uuid!) {
          org_members(where: {user_id: {_eq: $userId}}, order_by: {created_at: asc}) {
            role
            organization {
              id name quota_allowed quota_used quota_reserved
              workflows(order_by: {updated_at: desc}) {
                id name description active
                workflow_steps(order_by: {position: asc}) { id position type name }
                workflow_triggers(order_by: {type: asc}) { id type enabled config }
                workflow_runs(order_by: {created_at: desc}, limit: 1) { id status trigger_type created_at }
              }
            }
          }
        }
      `, { userId: user.id })
      setMemberships(data.org_members)
      setOrgId((current) => current || data.org_members[0]?.organization.id || '')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to load dashboard')
    } finally {
      setLoading(false)
    }
  }, [user?.id])

  useEffect(() => { load() }, [load])

  const selected = useMemo(() => memberships.find((m) => m.organization.id === orgId), [memberships, orgId])

  async function run(workflowId: string) {
    setBusyRun(workflowId)
    setError('')
    try {
      const data = await gql<{ triggerWorkflowRun: { run_id: string; status: string; message: string } }>(`
        mutation Trigger($workflowId: String!, $payload: String) {
          triggerWorkflowRun(workflow_id: $workflowId, payload: $payload) { run_id status message }
        }
      `, {
        workflowId,
        payload: JSON.stringify({
          message: 'URGENT: Production payment system is down and customers cannot checkout.',
          source: 'manual-demo',
        }),
      })
      router.push(`/runs/${data.triggerWorkflowRun.run_id}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start workflow')
    } finally {
      setBusyRun('')
    }
  }

  return (
    <RequireAuth>
      <Header />
      <main className="page container stack gap-lg">
        <div className="page-head">
          <div><p className="eyebrow">WORKSPACE</p><h1>Workflow dashboard</h1><p className="muted">Run workflows and inspect their latest execution without leaving your organization boundary.</p></div>
          {selected && selected.role !== 'viewer' && <Link className="button primary" href="/workflows/new">+ New workflow</Link>}
        </div>

        {error && <div className="alert error">{error}</div>}
        {loading ? <div className="panel">Loading organizations…</div> : memberships.length === 0 ? (
          <div className="empty panel"><h2>No organization membership yet</h2><p>Run the demo seed or ask an owner to add this account to an organization.</p></div>
        ) : <>
          <section className="org-strip panel">
            <div><span className="label">Organization</span><select value={orgId} onChange={(e) => setOrgId(e.target.value)}>{memberships.map((m) => <option key={m.organization.id} value={m.organization.id}>{m.organization.name} · {m.role}</option>)}</select></div>
            {selected && <div className="quota-block">
              <div className="quota-label"><span>Monthly usage</span><strong>{selected.organization.quota_used} / {selected.organization.quota_allowed}</strong></div>
              <div className="progress"><span style={{ width: `${Math.min(100, ((selected.organization.quota_used + selected.organization.quota_reserved) / Math.max(1, selected.organization.quota_allowed)) * 100)}%` }} /></div>
              <span className="muted small">{selected.organization.quota_reserved} call(s) reserved by active runs</span>
            </div>}
          </section>

          <section className="workflow-grid">
            {selected?.organization.workflows.length ? selected.organization.workflows.map((w) => {
              const latest = w.workflow_runs[0]
              return <article className="workflow-card" key={w.id}>
                <div className="card-head"><div><h2>{w.name}</h2><p className="muted">{w.description || 'No description'}</p></div><span className={`status ${w.active ? 'completed' : 'skipped'}`}>{w.active ? 'active' : 'inactive'}</span></div>
                <div className="pill-row">{w.workflow_steps.map((s) => <span className="node-pill" key={s.id}>{s.position + 1}. {s.type}</span>)}</div>
                <div className="card-meta"><span>{w.workflow_steps.length} steps</span><span>{w.workflow_triggers.filter((t) => t.enabled).map((t) => t.type).join(' · ')}</span></div>
                <div className="latest-run"><span className="muted">Latest run</span>{latest ? <Link href={`/runs/${latest.id}`}><span className={`status ${latest.status}`}>{latest.status}</span> · {latest.trigger_type}</Link> : <span>Never run</span>}</div>
                <div className="card-actions">
                  <Link className="button secondary" href={`/workflows/${w.id}`}>{selected.role === 'viewer' ? 'View' : 'Edit'}</Link>
                  {selected.role !== 'viewer' && <button className="button primary" disabled={!w.active || busyRun === w.id} onClick={() => run(w.id)}>{busyRun === w.id ? 'Starting…' : 'Run'}</button>}
                </div>
              </article>
            }) : <div className="empty panel"><h2>No workflows yet</h2><p>Create the first workflow for this organization.</p></div>}
          </section>
        </>}
      </main>
    </RequireAuth>
  )
}
