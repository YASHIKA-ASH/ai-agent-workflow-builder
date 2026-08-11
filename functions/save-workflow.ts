import crypto from 'node:crypto'
import type { Request, Response } from 'express'
import { actionError, getActionUserId, getOrgRole, gql, parseJson, requireInternalSecret } from './_shared'

const STEP_TYPES = new Set(['llm_call', 'http_request', 'db_write', 'notify', 'conditional_branch', 'approval_gate'])
const TRIGGER_TYPES = new Set(['manual', 'webhook', 'scheduled', 'database_event'])
const OWNER_STEPS = new Set(['db_write', 'notify'])

type StepInput = { id?: string | null; position: number; type: string; name: string; config: string }
type TriggerInput = { id?: string | null; type: string; enabled: boolean; config: string }
type ExistingWorkflow = {
  id: string
  org_id: string
  workflow_steps: Array<{
    id: string
    position: number
    type: string
    name: string
    config: Record<string, unknown>
  }>
  workflow_triggers: Array<{
    id: string
    type: string
    enabled: boolean
    config: Record<string, unknown>
  }>
}
const stable = (value: unknown): string => {
  const canon = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canon)
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canon(x)]))
    }
    return v
  }
  return JSON.stringify(canon(value))
}

function normalizeStep(step: StepInput) {
  return {
    id: step.id || null,
    position: Number(step.position),
    type: String(step.type),
    name: String(step.name || step.type),
    config: parseJson(step.config),
  }
}

function normalizeTrigger(trigger: TriggerInput) {
  const type = String(trigger.type)
  const config = parseJson(trigger.config)
  if (type === 'webhook' && typeof config.secret === 'string' && config.secret) {
    config.secretHash = crypto.createHash('sha256').update(config.secret).digest('hex')
    delete config.secret
  }
  return {
    id: trigger.id || null,
    type,
    enabled: Boolean(trigger.enabled),
    config,
  }
}

export default async function handler(req: Request, res: Response) {
  if (!requireInternalSecret(req, res)) return
  if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed' })

  try {
    const userId = getActionUserId(req)
    if (!userId) return actionError(res, 401, 'Authentication required', 'UNAUTHENTICATED')

    const input = req.body?.input?.input || {}
    const workflowId = input.id ? String(input.id) : null
    const orgId = String(input.org_id || '')
    const name = String(input.name || '').trim()
    const description = String(input.description || '')
    const active = Boolean(input.active)
    const steps: ReturnType<typeof normalizeStep>[] =
  (input.steps || []).map((s: StepInput) => normalizeStep(s))

    const triggers: ReturnType<typeof normalizeTrigger>[] =
  (input.triggers || []).map((t: TriggerInput) => normalizeTrigger(t))

    if (!orgId || !name) return actionError(res, 400, 'org_id and workflow name are required')
    if (!steps.length) return actionError(res, 400, 'At least one workflow step is required')
    if (!triggers.some((t: ReturnType<typeof normalizeTrigger>) => t.type === 'manual' && t.enabled)) {
      return actionError(res, 400, 'An enabled manual trigger is required')
    }

    const role = await getOrgRole(orgId, userId)
    if (!role || !['owner', 'editor'].includes(role)) return actionError(res, 403, 'Only org owners/editors can save workflows', 'FORBIDDEN')

    const positions = new Set<number>()
    for (const step of steps) {
      if (!Number.isInteger(step.position) || step.position < 0 || positions.has(step.position)) return actionError(res, 400, 'Step positions must be unique non-negative integers')
      positions.add(step.position)
      if (!STEP_TYPES.has(step.type)) return actionError(res, 400, `Unsupported step type: ${step.type}`)
      if (!step.name.trim()) return actionError(res, 400, 'Every step needs a name')
    }
    if ([...positions].sort((a, b) => a - b).some((p, i) => p !== i)) {
      return actionError(res, 400, 'Step positions must be contiguous and start at 0')
    }
    for (const trigger of triggers) {
      if (!TRIGGER_TYPES.has(trigger.type)) return actionError(res, 400, `Unsupported trigger type: ${trigger.type}`)
    }
    if (new Set(triggers.map((t: ReturnType<typeof normalizeTrigger>) => t.type)).size !== triggers.length) {
      return actionError(res, 400, 'Only one trigger of each type is allowed')
    }

    let existing: ExistingWorkflow | null = null

    if (workflowId) {
      const data = await gql<{ workflows_by_pk: ExistingWorkflow | null }>(`
        query ExistingWorkflow($id: uuid!) {
          workflows_by_pk(id: $id) {
            id org_id
            workflow_steps(order_by: {position: asc}) { id position type name config }
            workflow_triggers { id type enabled config }
          }
        }
      `, { id: workflowId })
      existing = data.workflows_by_pk
      if (!existing || existing.org_id !== orgId) return actionError(res, 404, 'Workflow not found in this organization', 'NOT_FOUND')
    }

    if (role !== 'owner') {
      const restrictedIncomingSteps = steps.filter((s: ReturnType<typeof normalizeStep>) => OWNER_STEPS.has(s.type))
      const webhookIncoming = triggers.filter((t: ReturnType<typeof normalizeTrigger>) => t.type === 'webhook')

      if (!existing && (restrictedIncomingSteps.length || webhookIncoming.length)) {
        return actionError(res, 403, 'Only owners can add db_write/notify steps or webhook triggers', 'FORBIDDEN')
      }

      if (existing) {
        const oldRestricted = existing.workflow_steps.filter((s) => OWNER_STEPS.has(s.type))
        const oldWebhooks = existing.workflow_triggers.filter((t) => t.type === 'webhook')

        const oldStepMap = new Map(oldRestricted.map((s) => [s.id, stable({ ...s, config: s.config })]))
        const newStepMap = new Map(restrictedIncomingSteps.map((s) => [s.id, stable(s)]))
        const oldWebhookMap = new Map(oldWebhooks.map((t) => [t.id, stable({ ...t, config: t.config })]))
        const newWebhookMap = new Map(webhookIncoming.map((t) => [t.id, stable(t)]))

        const unchanged = (a: Map<unknown, unknown>, b: Map<unknown, unknown>) => a.size === b.size && [...a].every(([k, v]) => k && b.get(k) === v)
        if (!unchanged(oldStepMap, newStepMap) || !unchanged(oldWebhookMap, newWebhookMap)) {
          return actionError(res, 403, 'Editors cannot add, remove, or modify db_write/notify steps or webhook triggers', 'FORBIDDEN')
        }
      }
    }

    let id = workflowId
    if (!id) {
      const created = await gql<{ insert_workflows_one: { id: string } }>(`
        mutation CreateWorkflow($object: workflows_insert_input!) {
          insert_workflows_one(object: $object) { id }
        }
      `, { object: { org_id: orgId, name, description, active, created_by: userId } })
      id = created.insert_workflows_one.id
    } else {
      await gql(`
        mutation UpdateWorkflow($id: uuid!, $name: String!, $description: String!, $active: Boolean!) {
          update_workflows_by_pk(pk_columns: {id: $id}, _set: {name: $name, description: $description, active: $active}) { id }
        }
      `, { id, name, description, active })
    }

    await gql(`
      mutation ReplaceDefinition($workflowId: uuid!, $steps: [workflow_steps_insert_input!]!, $triggers: [workflow_triggers_insert_input!]!) {
        delete_workflow_steps(where: {workflow_id: {_eq: $workflowId}}) { affected_rows }
        delete_workflow_triggers(where: {workflow_id: {_eq: $workflowId}}) { affected_rows }
        insert_workflow_steps(objects: $steps) { affected_rows }
        insert_workflow_triggers(objects: $triggers) { affected_rows }
      }
    `, {
      workflowId: id,
      steps: steps.map((s: ReturnType<typeof normalizeStep>) => ({
        ...(s.id ? { id: s.id } : {}), workflow_id: id, position: s.position, type: s.type, name: s.name, config: s.config,
      })),
      triggers: triggers.map((t: ReturnType<typeof normalizeTrigger>) => ({
        ...(t.id ? { id: t.id } : {}), workflow_id: id, type: t.type, enabled: t.enabled, config: t.config, created_by: userId,
      })),
    })

    return res.status(200).json({ workflow_id: id, success: true, message: workflowId ? 'Workflow updated' : 'Workflow created' })
  } catch (error) {
    return actionError(res, 400, error instanceof Error ? error.message : 'Unable to save workflow')
  }
}
