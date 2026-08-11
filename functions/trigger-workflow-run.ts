import type { Request, Response } from 'express'
import { actionError, createAndQueueRun, getActionUserId, getEnabledTrigger, getWorkflowAccess, parseJson, requireInternalSecret } from './_shared'

export default async function handler(req: Request, res: Response) {
  if (!requireInternalSecret(req, res)) return
  if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed' })

  try {
    const userId = getActionUserId(req)
    const workflowId = String(req.body?.input?.workflow_id || '')
    if (!userId) return actionError(res, 401, 'Authentication required', 'UNAUTHENTICATED')
    if (!workflowId) return actionError(res, 400, 'workflow_id is required')

    const access = await getWorkflowAccess(workflowId, userId)
    if (!access) return actionError(res, 403, 'Workflow not found or access denied', 'FORBIDDEN')
    if (!['owner', 'editor'].includes(access.role)) return actionError(res, 403, 'Viewers cannot trigger workflow runs', 'FORBIDDEN')
    if (!access.workflow.active) return actionError(res, 409, 'Workflow is inactive', 'CONFLICT')

    const manualTrigger = await getEnabledTrigger(workflowId, 'manual')
    if (!manualTrigger) return actionError(res, 409, 'Manual trigger is not enabled for this workflow', 'CONFLICT')

    const payload = parseJson(req.body?.input?.payload)
    const run = await createAndQueueRun({
      workflowId,
      orgId: access.workflow.org_id,
      triggerType: 'manual',
      triggeredBy: userId,
      payload,
    })

    return res.status(200).json({ run_id: run.id, status: run.status, message: 'Workflow run queued' })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to trigger workflow'
    const status = message.includes('quota exhausted') ? 429 : 400
    return actionError(res, status, message, status === 429 ? 'QUOTA_EXHAUSTED' : 'BAD_REQUEST')
  }
}
