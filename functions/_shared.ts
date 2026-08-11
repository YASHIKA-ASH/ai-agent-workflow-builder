import crypto from 'node:crypto'
import type { Request, Response } from 'express'

export type OrgRole = 'owner' | 'editor' | 'viewer'
export type TriggerType = 'manual' | 'webhook' | 'scheduled' | 'database_event'

const gqlUrl = () => {
  const value = process.env.NHOST_GRAPHQL_URL
  if (!value) throw new Error('NHOST_GRAPHQL_URL is not configured')
  return value
}

const adminSecret = () => {
  const value = process.env.NHOST_ADMIN_SECRET
  if (!value) throw new Error('NHOST_ADMIN_SECRET is not configured')
  return value
}

export async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(gqlUrl(), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hasura-admin-secret': adminSecret(),
    },
    body: JSON.stringify({ query, variables }),
  })

  const body = await response.json() as { data?: T; errors?: Array<{ message: string }> }
  if (!response.ok || body.errors?.length || !body.data) {
    throw new Error(body.errors?.map((e) => e.message).join('; ') || `GraphQL request failed (${response.status})`)
  }
  return body.data
}

function constantTimeEqual(a: string, b: string) {
  const aa = Buffer.from(a)
  const bb = Buffer.from(b)
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb)
}

export function requireInternalSecret(req: Request, res: Response): boolean {
  const expected = process.env.ACTION_SECRET
  const supplied = String(req.headers['x-action-secret'] || '')
  if (!expected || !supplied || !constantTimeEqual(expected, supplied)) {
    res.status(403).json({ message: 'Forbidden', extensions: { code: 'FORBIDDEN' } })
    return false
  }
  return true
}

export function getActionUserId(req: Request): string | null {
  const variables = (req.body?.session_variables || {}) as Record<string, string>
  return variables['x-hasura-user-id'] || null
}

export function actionError(res: Response, status: number, message: string, code = 'BAD_REQUEST') {
  return res.status(status).json({ message, extensions: { code } })
}

export function parseJson(value: unknown, fallback: Record<string, unknown> = {}): Record<string, unknown> {
  if (value == null || value === '') return fallback
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value !== 'string') throw new Error('Expected a JSON object string')
  const parsed = JSON.parse(value)
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('Expected a JSON object')
  return parsed as Record<string, unknown>
}

export async function getOrgRole(orgId: string, userId: string): Promise<OrgRole | null> {
  const data = await gql<{ org_members: Array<{ role: OrgRole }> }>(`
    query OrgRole($orgId: uuid!, $userId: uuid!) {
      org_members(where: {org_id: {_eq: $orgId}, user_id: {_eq: $userId}}, limit: 1) { role }
    }
  `, { orgId, userId })
  return data.org_members[0]?.role || null
}

export async function getWorkflowAccess(workflowId: string, userId: string) {
  const data = await gql<{
    workflows_by_pk: null | {
      id: string
      org_id: string
      active: boolean
      organization: { members: Array<{ user_id: string; role: OrgRole }> }
    }
  }>(`
    query WorkflowAccess($id: uuid!) {
      workflows_by_pk(id: $id) {
        id org_id active
        organization { members { user_id role } }
      }
    }
  `, { id: workflowId })

  const workflow = data.workflows_by_pk
  if (!workflow) return null
  const member = workflow.organization.members.find((m) => m.user_id === userId)
  return member ? { workflow, role: member.role } : null
}

export async function reserveQuota(orgId: string): Promise<boolean> {
  const data = await gql<{ reserve_org_quota: Array<{ id: string }> }>(`
    mutation ReserveQuota($orgId: uuid!) {
      reserve_org_quota(args: {p_org_id: $orgId}) { id }
    }
  `, { orgId })
  return data.reserve_org_quota.length === 1
}

export async function releaseQuotaReservation(orgId: string) {
  await gql(`
    mutation ReleaseQuota($orgId: uuid!) {
      update_organizations(where: {id: {_eq: $orgId}, quota_reserved: {_gt: 0}}, _inc: {quota_reserved: -1}) {
        affected_rows
      }
    }
  `, { orgId })
}

export async function finishRun(runId: string, status: 'completed' | 'failed', error: string | null = null) {
  await gql(`
    mutation FinishRun($runId: uuid!, $status: String!, $error: String) {
      finish_workflow_run(args: {p_run_id: $runId, p_status: $status, p_error: $error}) { id status }
    }
  `, { runId, status, error })
}

export async function createRun(args: {
  workflowId: string
  orgId: string
  triggerType: TriggerType
  triggeredBy?: string | null
  payload?: Record<string, unknown>
  dedupeKey?: string | null
}) {
  if (args.dedupeKey) {
    const existing = await gql<{ workflow_runs: Array<{ id: string; status: string }> }>(`
      query ExistingRun($key: String!) {
        workflow_runs(where: {dedupe_key: {_eq: $key}}, limit: 1) { id status }
      }
    `, { key: args.dedupeKey })
    if (existing.workflow_runs[0]) return { ...existing.workflow_runs[0], existing: true }
  }

  const reserved = await reserveQuota(args.orgId)
  if (!reserved) throw new Error('Organization quota exhausted')

  try {
    const data = await gql<{ insert_workflow_runs_one: { id: string; status: string } }>(`
      mutation CreateRun($object: workflow_runs_insert_input!) {
        insert_workflow_runs_one(object: $object) { id status }
      }
    `, {
      object: {
        workflow_id: args.workflowId,
        org_id: args.orgId,
        trigger_type: args.triggerType,
        triggered_by: args.triggeredBy || null,
        trigger_payload: args.payload || {},
        dedupe_key: args.dedupeKey || null,
        status: 'queued',
        current_position: 0,
        quota_reserved: true,
      },
    })
    return { ...data.insert_workflow_runs_one, existing: false }
  } catch (error) {
    await releaseQuotaReservation(args.orgId)
    if (args.dedupeKey) {
      const existing = await gql<{ workflow_runs: Array<{ id: string; status: string }> }>(`
        query ExistingRun($key: String!) {
          workflow_runs(where: {dedupe_key: {_eq: $key}}, limit: 1) { id status }
        }
      `, { key: args.dedupeKey })
      if (existing.workflow_runs[0]) return { ...existing.workflow_runs[0], existing: true }
    }
    throw error
  }
}

export async function queueRun(runId: string, reason: string) {
  await gql(`
    mutation QueueRun($runId: uuid!, $reason: String!) {
      insert_run_jobs_one(object: {workflow_run_id: $runId, reason: $reason}) { id }
    }
  `, { runId, reason })
}

export async function createAndQueueRun(args: Parameters<typeof createRun>[0]) {
  const run = await createRun(args)
  if (!run.existing) await queueRun(run.id, args.triggerType)
  return run
}

export async function getEnabledTrigger(workflowId: string, type: TriggerType) {
  const data = await gql<{ workflow_triggers: Array<{ id: string; config: Record<string, unknown>; enabled: boolean }> }>(`
    query Trigger($workflowId: uuid!, $type: String!) {
      workflow_triggers(where: {workflow_id: {_eq: $workflowId}, type: {_eq: $type}, enabled: {_eq: true}}, limit: 1) {
        id config enabled
      }
    }
  `, { workflowId, type })
  return data.workflow_triggers[0] || null
}

export function eventNewRow<T>(req: Request): T | null {
  return (req.body?.event?.data?.new || null) as T | null
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export async function retry<T>(
  fn: (attempt: number) => Promise<T>,
  maxAttempts = 2,
  onAttempt?: (attempt: number) => Promise<void> | void,
): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await onAttempt?.(attempt)
      return await fn(attempt)
    } catch (error) {
      lastError = error
      if (attempt < maxAttempts) await sleep(700 * attempt)
    }
  }
  throw lastError
}

export function getPath(value: unknown, path: string): unknown {
  return path.split('.').filter(Boolean).reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object' && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key]
    }
    return undefined
  }, value)
}

export function evaluateCondition(actual: unknown, operator: string, expected: unknown) {
  switch (operator) {
    case 'equals': return actual === expected
    case 'not_equals': return actual !== expected
    case 'contains': return String(actual ?? '').includes(String(expected ?? ''))
    case 'gt': return Number(actual) > Number(expected)
    case 'gte': return Number(actual) >= Number(expected)
    case 'lt': return Number(actual) < Number(expected)
    case 'lte': return Number(actual) <= Number(expected)
    case 'truthy': return Boolean(actual)
    default: throw new Error(`Unsupported conditional operator: ${operator}`)
  }
}

export function assertSafeExternalUrl(raw: string) {
  const url = new URL(raw)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only http/https URLs are supported')
  if (process.env.ALLOW_PRIVATE_HTTP === 'true') return url

  const host = url.hostname.toLowerCase()
  const privateHost =
    host === 'localhost' || host === '::1' || host.endsWith('.local') ||
    /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)

  if (privateHost) throw new Error('Private/internal HTTP targets are blocked')
  return url
}
