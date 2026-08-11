'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { gql } from '@/lib/graphql'
import { useAuth } from './AuthProvider'

type Role = 'owner' | 'editor' | 'viewer'
type StepType = 'llm_call' | 'http_request' | 'db_write' | 'notify' | 'conditional_branch' | 'approval_gate'
type TriggerType = 'manual' | 'webhook' | 'scheduled' | 'database_event'

type Org = { id: string; name: string; role: Role }
type Step = { id?: string; position: number; type: StepType; name: string; config: Record<string, unknown> }
type Trigger = { id?: string; type: TriggerType; enabled: boolean; config: Record<string, unknown> }

const restricted = new Set<StepType>(['db_write', 'notify'])

const stepDefaults: Record<StepType, { name: string; config: Record<string, unknown> }> = {
  llm_call: {
    name: 'Classify incident',
    config: {
      prompt: 'Classify this incident as urgent or normal. Return JSON with a priority field. Incident: {{input.message}}',
      model: 'gemini-3.6-flash',
      responseJson: true,
      delayMs: 900,
    },
  },
  http_request: {
    name: 'Fetch escalation context',
    config: { method: 'GET', url: 'https://jsonplaceholder.typicode.com/todos/1', timeoutMs: 8000 },
  },
  db_write: { name: 'Save result', config: { label: 'workflow-result' } },
  notify: { name: 'Notify team', config: { message: 'Workflow {{run_id}} is ready.', channel: 'slack' } },
  conditional_branch: {
    name: 'Is urgent?',
    config: { field: 'priority', operator: 'equals', value: 'urgent', ifTruePosition: 2, ifFalsePosition: 3 },
  },
  approval_gate: { name: 'Human approval', config: { instructions: 'Review the result before continuing.' } },
}

const triggerDefaults: Record<TriggerType, Record<string, unknown>> = {
  manual: {},
  webhook: { secret: '' },
  scheduled: { everyMinutes: 5 },
  database_event: {},
}

function pretty(value: unknown) {
  return JSON.stringify(value, null, 2)
}

export default function WorkflowEditor({ workflowId }: { workflowId?: string }) {
  const { user } = useAuth()
  const router = useRouter()
  const [orgs, setOrgs] = useState<Org[]>([])
  const [orgId, setOrgId] = useState('')
  const [role, setRole] = useState<Role>('viewer')
  const [name, setName] = useState('Customer Incident Analyzer')
  const [description, setDescription] = useState('Classifies an incident, branches, calls an API, pauses for approval, and notifies the team.')
  const [active, setActive] = useState(true)
  const [steps, setSteps] = useState<Step[]>([])
  const [triggers, setTriggers] = useState<Trigger[]>([{ type: 'manual', enabled: true, config: {} }])
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState('')

  const load = useCallback(async () => {
    if (!user?.id) return
    setBusy(true)
    setError('')
    try {
      const data = await gql<{
        org_members: Array<{ role: Role; organization: { id: string; name: string } }>
        workflows_by_pk: null | {
          id: string; org_id: string; name: string; description: string; active: boolean
          workflow_steps: Array<{ id: string; position: number; type: StepType; name: string; config: Record<string, unknown> }>
          workflow_triggers: Array<{ id: string; type: TriggerType; enabled: boolean; config: Record<string, unknown> }>
        }
      }>(`
        query EditorData($userId: uuid!${workflowId ? ', $workflowId: uuid!' : ''}) {
          org_members(where: {user_id: {_eq: $userId}}, order_by: {created_at: asc}) {
            role organization { id name }
          }
          ${workflowId ? 'workflows_by_pk(id: $workflowId) { id org_id name description active workflow_steps(order_by: {position: asc}) { id position type name config } workflow_triggers(order_by: {type: asc}) { id type enabled config } }' : ''}
        }
      `, workflowId ? { userId: user.id, workflowId } : { userId: user.id })

      const nextOrgs = data.org_members.map((m) => ({ id: m.organization.id, name: m.organization.name, role: m.role }))
      setOrgs(nextOrgs)

      if (workflowId) {
        if (!data.workflows_by_pk) throw new Error('Workflow not found or you do not have access to it.')
        const w = data.workflows_by_pk
        setOrgId(w.org_id)
        setRole(nextOrgs.find((o) => o.id === w.org_id)?.role || 'viewer')
        setName(w.name)
        setDescription(w.description || '')
        setActive(w.active)
        setSteps(w.workflow_steps)
        setTriggers(w.workflow_triggers)
      } else {
        const editable = nextOrgs.find((o) => o.role !== 'viewer')
        if (!editable) throw new Error('You need owner/editor access in an organization to create a workflow.')
        setOrgId(editable.id)
        setRole(editable.role)
        const starter: Step[] = [
          { position: 0, type: 'llm_call', ...stepDefaults.llm_call },
          { position: 1, type: 'conditional_branch', ...stepDefaults.conditional_branch },
          { position: 2, type: 'http_request', ...stepDefaults.http_request },
          { position: 3, type: 'approval_gate', ...stepDefaults.approval_gate },
        ]
        if (editable.role === 'owner') starter.push({ position: 4, type: 'notify', ...stepDefaults.notify })
        setSteps(starter)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to load workflow')
    } finally {
      setBusy(false)
    }
  }, [user?.id, workflowId])

  useEffect(() => { load() }, [load])

  const hasRestricted = useMemo(() => steps.some((s) => restricted.has(s.type)) || triggers.some((t) => t.type === 'webhook'), [steps, triggers])
  const canReorder = role === 'owner' || !hasRestricted

  function selectOrg(nextId: string) {
    if (workflowId) return
    setOrgId(nextId)
    setRole(orgs.find((o) => o.id === nextId)?.role || 'viewer')
  }

  function addStep(type: StepType) {
    if (role !== 'owner' && restricted.has(type)) return
    const base = stepDefaults[type]
    setSteps((current) => [...current, { position: current.length, type, name: base.name, config: structuredClone(base.config) }])
  }

  function changeStep(i: number, patch: Partial<Step>) {
    setSteps((current) => current.map((s, idx) => idx === i ? { ...s, ...patch } : s))
  }

  function moveStep(i: number, delta: number) {
    if (!canReorder) return
    const j = i + delta
    if (j < 0 || j >= steps.length) return
    setSteps((current) => {
      const copy = [...current]
      ;[copy[i], copy[j]] = [copy[j], copy[i]]
      return copy.map((s, idx) => ({ ...s, position: idx }))
    })
  }

  function removeStep(i: number) {
    const target = steps[i]
    if (role !== 'owner' && restricted.has(target.type)) return
    setSteps((current) => current.filter((_, idx) => idx !== i).map((s, idx) => ({ ...s, position: idx })))
  }

  function toggleTrigger(type: TriggerType, enabled: boolean) {
    if (type === 'manual') return
    if (type === 'webhook' && role !== 'owner') return
    setTriggers((current) => {
      const found = current.find((t) => t.type === type)
      if (found) return current.map((t) => t.type === type ? { ...t, enabled } : t)
      const config = structuredClone(triggerDefaults[type])
      if (type === 'webhook') config.secret = crypto.randomUUID().replaceAll('-', '')
      return [...current, { type, enabled, config }]
    })
  }

  function updateTriggerConfig(type: TriggerType, text: string) {
    try {
      const config = JSON.parse(text)
      setTriggers((current) => current.map((t) => t.type === type ? { ...t, config } : t))
      setError('')
    } catch {
      setError(`Invalid JSON for ${type} trigger`)
    }
  }

  async function save() {
    setBusy(true)
    setError('')
    setSaved('')
    try {
      if (!orgId) throw new Error('Select an organization')
      if (!steps.length) throw new Error('Add at least one step')
      const data = await gql<{ saveWorkflow: { workflow_id: string; success: boolean; message: string } }>(`
        mutation SaveWorkflow($input: SaveWorkflowInput!) {
          saveWorkflow(input: $input) { workflow_id success message }
        }
      `, {
        input: {
          id: workflowId || null,
          org_id: orgId,
          name,
          description,
          active,
          steps: steps.map((s, i) => ({ id: s.id || null, position: i, type: s.type, name: s.name, config: JSON.stringify(s.config) })),
          triggers: triggers.map((t) => ({ id: t.id || null, type: t.type, enabled: t.enabled, config: JSON.stringify(t.config) })),
        },
      })
      setSaved(data.saveWorkflow.message)
      if (!workflowId) router.replace(`/workflows/${data.saveWorkflow.workflow_id}`)
      else await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to save')
    } finally {
      setBusy(false)
    }
  }

  if (busy && !steps.length) return <div className="panel">Loading workflow…</div>

  return (
    <div className="stack gap-lg">
      {error && <div className="alert error">{error}</div>}
      {saved && <div className="alert success">{saved}</div>}

      <section className="panel form-grid">
        <label>Organization
          <select value={orgId} onChange={(e) => selectOrg(e.target.value)} disabled={Boolean(workflowId)}>
            {orgs.filter((o) => o.role !== 'viewer').map((o) => <option key={o.id} value={o.id}>{o.name} · {o.role}</option>)}
          </select>
        </label>
        <label>Workflow name<input value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="span-2">Description<textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} /></label>
        <label className="checkbox"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Active</label>
      </section>

      <section className="panel">
        <div className="section-head"><div><h2>Steps</h2><p className="muted">Order is execution order. Config is JSON for speed and transparency.</p></div></div>
        {role === 'editor' && hasRestricted && <div className="alert info">This workflow contains owner-only nodes. Editors can edit ordinary nodes but cannot move/change/delete owner-only nodes.</div>}
        <div className="step-list">
          {steps.map((step, i) => {
            const locked = role !== 'owner' && restricted.has(step.type)
            return (
              <div className="step-card" key={step.id || `${step.type}-${i}`}>
                <div className="step-index">{i + 1}</div>
                <div className="step-main">
                  <div className="step-title-row">
                    <select value={step.type} disabled={locked} onChange={(e) => {
                      const type = e.target.value as StepType
                      if (role !== 'owner' && restricted.has(type)) return
                      const base = stepDefaults[type]
                      changeStep(i, { type, name: base.name, config: structuredClone(base.config) })
                    }}>
                      {(Object.keys(stepDefaults) as StepType[]).map((type) => <option key={type} value={type} disabled={role !== 'owner' && restricted.has(type)}>{type}{restricted.has(type) ? ' · owner only' : ''}</option>)}
                    </select>
                    <input value={step.name} disabled={locked} onChange={(e) => changeStep(i, { name: e.target.value })} />
                    <div className="icon-actions">
                      <button className="icon-btn" disabled={!canReorder || i === 0} onClick={() => moveStep(i, -1)}>↑</button>
                      <button className="icon-btn" disabled={!canReorder || i === steps.length - 1} onClick={() => moveStep(i, 1)}>↓</button>
                      <button className="icon-btn danger" disabled={locked} onClick={() => removeStep(i)}>×</button>
                    </div>
                  </div>
                  <textarea
                    key={`config-${step.id || i}-${step.type}`}
                    className="code-field"
                    rows={5}
                    disabled={locked}
                    defaultValue={pretty(step.config)}
                    onBlur={(e) => {
                      try { changeStep(i, { config: JSON.parse(e.target.value) }); setError('') }
                      catch { setError(`Step ${i + 1} has invalid JSON`) }
                    }}
                  />
                </div>
              </div>
            )
          })}
        </div>
        <div className="add-row">
          {(Object.keys(stepDefaults) as StepType[]).map((type) => (
            <button key={type} className="button secondary" disabled={role !== 'owner' && restricted.has(type)} onClick={() => addStep(type)}>+ {type}</button>
          ))}
        </div>
      </section>

      <section className="panel">
        <h2>Triggers</h2>
        <div className="trigger-grid">
          {(Object.keys(triggerDefaults) as TriggerType[]).map((type) => {
            const trigger = triggers.find((t) => t.type === type)
            const enabled = trigger?.enabled || type === 'manual'
            const locked = type === 'manual' || (type === 'webhook' && role !== 'owner')
            return (
              <div className="trigger-card" key={type}>
                <label className="checkbox"><input type="checkbox" checked={enabled} disabled={locked} onChange={(e) => toggleTrigger(type, e.target.checked)} /> <strong>{type}</strong>{type === 'webhook' && <span className="badge">owner only</span>}</label>
                {(trigger && enabled && type !== 'manual') && <textarea
                  key={`trigger-config-${type}-${trigger.id || 'new'}`}
                  className="code-field"
                  rows={4}
                  disabled={locked}
                  defaultValue={pretty(trigger.config)}
                  onBlur={(e) => updateTriggerConfig(type, e.target.value)}
                />}
              </div>
            )
          })}
        </div>
      </section>

      <div className="sticky-actions">
        <button className="button primary" disabled={busy || role === 'viewer'} onClick={save}>{busy ? 'Saving…' : 'Save workflow'}</button>
        {workflowId && <button className="button secondary" onClick={() => router.push('/')}>Back to dashboard</button>}
      </div>
    </div>
  )
}
