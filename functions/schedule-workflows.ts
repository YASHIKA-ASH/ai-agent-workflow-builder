import type { Request, Response } from 'express'
import { createAndQueueRun, gql, requireInternalSecret } from './_shared'

export default async function handler(req: Request, res: Response) {
  if (!requireInternalSecret(req, res)) return
  try {
    const data = await gql<{
      workflow_triggers: Array<{ id: string; workflow_id: string; config: Record<string, unknown>; workflow: { org_id: string; active: boolean } }>
    }>(`
      query ScheduledTriggers {
        workflow_triggers(where: {type: {_eq: "scheduled"}, enabled: {_eq: true}}) {
          id workflow_id config workflow { org_id active }
        }
      }
    `)

    const now = new Date()
    const minuteBucket = now.toISOString().slice(0, 16)
    let queued = 0

    for (const trigger of data.workflow_triggers) {
      if (!trigger.workflow.active) continue
      const everyMinutes = Math.max(1, Number(trigger.config?.everyMinutes || 5))
      const minuteOfDay = now.getUTCHours() * 60 + now.getUTCMinutes()
      if (minuteOfDay % everyMinutes !== 0) continue

      try {
        const run = await createAndQueueRun({
          workflowId: trigger.workflow_id,
          orgId: trigger.workflow.org_id,
          triggerType: 'scheduled',
          payload: { scheduled_at: now.toISOString(), everyMinutes },
          dedupeKey: `scheduled:${trigger.id}:${minuteBucket}`,
        })
        if (!run.existing) queued++
      } catch (error) {
        console.error('scheduled workflow skipped', trigger.id, error)
      }
    }

    return res.status(200).json({ queued })
  } catch (error) {
    return res.status(500).json({ message: error instanceof Error ? error.message : 'Scheduler failed' })
  }
}
