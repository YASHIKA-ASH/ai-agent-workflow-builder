import type { Request, Response } from 'express'
import { createAndQueueRun, eventNewRow, getEnabledTrigger, gql, requireInternalSecret } from './_shared'

export default async function handler(req: Request, res: Response) {
  if (!requireInternalSecret(req, res)) return
  try {
    const row = eventNewRow<{ id: string; workflow_id: string; payload: Record<string, unknown> }>(req)
    if (!row) return res.status(400).json({ message: 'Missing event row' })

    const data = await gql<{ workflows_by_pk: null | { id: string; org_id: string; active: boolean } }>(`
      query EventWorkflow($id: uuid!) { workflows_by_pk(id: $id) { id org_id active } }
    `, { id: row.workflow_id })
    const workflow = data.workflows_by_pk
    const trigger = workflow?.active ? await getEnabledTrigger(row.workflow_id, 'database_event') : null
    if (!workflow || !trigger) return res.status(200).json({ skipped: true, reason: 'Database event trigger not enabled' })

    const run = await createAndQueueRun({
      workflowId: workflow.id,
      orgId: workflow.org_id,
      triggerType: 'database_event',
      payload: row.payload || {},
      dedupeKey: `db-event:${row.id}`,
    })
    return res.status(200).json({ run_id: run.id, queued: !run.existing })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Database event start failed'
    if (message.includes('quota exhausted')) return res.status(200).json({ skipped: true, reason: message })
    return res.status(500).json({ message })
  }
}
