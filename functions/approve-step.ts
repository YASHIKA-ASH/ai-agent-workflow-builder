import type { Request, Response } from 'express'
import { actionError, getActionUserId, getOrgRole, gql, queueRun, requireInternalSecret } from './_shared'

export default async function handler(req: Request, res: Response) {
  if (!requireInternalSecret(req, res)) return
  if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed' })

  try {
    const userId = getActionUserId(req)
    const stepRunId = String(req.body?.input?.step_run_id || '')
    if (!userId) return actionError(res, 401, 'Authentication required', 'UNAUTHENTICATED')
    if (!stepRunId) return actionError(res, 400, 'step_run_id is required')

    const data = await gql<{
      step_runs_by_pk: null | {
        id: string
        position: number
        status: string
        workflow_run: { id: string; org_id: string; status: string }
      }
    }>(`
      query ApprovalTarget($id: uuid!) {
        step_runs_by_pk(id: $id) {
          id position status
          workflow_run { id org_id status }
        }
      }
    `, { id: stepRunId })

    const step = data.step_runs_by_pk
    if (!step) return actionError(res, 404, 'Approval step not found', 'NOT_FOUND')

    const role = await getOrgRole(step.workflow_run.org_id, userId)
    if (!role || !['owner', 'editor'].includes(role)) {
      return actionError(res, 403, 'Only an owner/editor in this organization can approve', 'FORBIDDEN')
    }
    if (step.status !== 'awaiting_approval' || step.workflow_run.status !== 'paused') {
      return actionError(res, 409, 'This step is not currently awaiting approval', 'CONFLICT')
    }

    const now = new Date().toISOString()
    const updated = await gql<{ update_step_runs: { affected_rows: number } }>(`
      mutation Approve($stepId: uuid!, $userId: uuid!, $now: timestamptz!) {
        update_step_runs(
          where: {id: {_eq: $stepId}, status: {_eq: "awaiting_approval"}},
          _set: {status: "completed", approved_by: $userId, approved_at: $now, finished_at: $now, output: {approved: true}}
        ) { affected_rows }
      }
    `, { stepId: stepRunId, userId, now })

    if (updated.update_step_runs.affected_rows !== 1) return actionError(res, 409, 'Approval was already processed', 'CONFLICT')

    await gql(`
      mutation Resume($runId: uuid!, $next: Int!) {
        update_workflow_runs_by_pk(pk_columns: {id: $runId}, _set: {status: "queued", current_position: $next, error: null}) { id }
      }
    `, { runId: step.workflow_run.id, next: step.position + 1 })
    await queueRun(step.workflow_run.id, 'approval_resume')

    return res.status(200).json({ run_id: step.workflow_run.id, success: true, message: 'Approval accepted; workflow resumed' })
  } catch (error) {
    return actionError(res, 400, error instanceof Error ? error.message : 'Approval failed')
  }
}
