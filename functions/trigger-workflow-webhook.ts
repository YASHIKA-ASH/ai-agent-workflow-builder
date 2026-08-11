import crypto from 'node:crypto'
import type { Request, Response } from 'express'
import { actionError, createAndQueueRun, getEnabledTrigger, gql, parseJson, requireInternalSecret } from './_shared'

function sameSecret(storedHash: string, supplied: string) {
  const suppliedHash = crypto.createHash('sha256').update(supplied).digest('hex')
  const aa = Buffer.from(storedHash, 'hex')
  const bb = Buffer.from(suppliedHash, 'hex')
  return aa.length === 32 && bb.length === 32 && crypto.timingSafeEqual(aa, bb)
}

export default async function handler(req: Request, res: Response) {
  if (!requireInternalSecret(req, res)) return
  if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed' })

  try {
    const workflowId = String(req.body?.input?.workflow_id || '')
    const suppliedSecret = String(req.body?.input?.secret || '')
    const payload = parseJson(req.body?.input?.payload)
    if (!workflowId || !suppliedSecret) return actionError(res, 400, 'workflow_id and secret are required')

    const data = await gql<{ workflows_by_pk: null | { id: string; org_id: string; active: boolean } }>(`
      query WebhookWorkflow($id: uuid!) { workflows_by_pk(id: $id) { id org_id active } }
    `, { id: workflowId })
    const workflow = data.workflows_by_pk
    if (!workflow || !workflow.active) return actionError(res, 404, 'Webhook workflow not found', 'NOT_FOUND')

    const trigger = await getEnabledTrigger(workflowId, 'webhook')
    if (!trigger) return actionError(res, 404, 'Webhook trigger is not enabled', 'NOT_FOUND')
    const expectedHash = String(trigger.config?.secretHash || '')
    if (!expectedHash || !sameSecret(expectedHash, suppliedSecret)) return actionError(res, 403, 'Invalid webhook secret', 'FORBIDDEN')

    const eventId = typeof payload.event_id === 'string' ? payload.event_id : null
    const run = await createAndQueueRun({
      workflowId,
      orgId: workflow.org_id,
      triggerType: 'webhook',
      payload,
      dedupeKey: eventId ? `webhook:${trigger.id}:${eventId}` : null,
    })

    return res.status(200).json({ run_id: run.id, status: run.status, message: run.existing ? 'Existing idempotent run returned' : 'Webhook run queued' })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Webhook failed'
    const status = message.includes('quota exhausted') ? 429 : 400
    return actionError(res, status, message, status === 429 ? 'QUOTA_EXHAUSTED' : 'BAD_REQUEST')
  }
}
