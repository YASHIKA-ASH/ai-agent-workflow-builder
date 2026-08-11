import type { Request, Response } from 'express'
import { eventNewRow, gql, requireInternalSecret, sleep } from './_shared'

export default async function handler(req: Request, res: Response) {
  if (!requireInternalSecret(req, res)) return
  const row = eventNewRow<{ id: string; payload: Record<string, unknown> }>(req)
  if (!row) return res.status(400).json({ message: 'Missing notification event' })

  try {
    await gql(`
      mutation NotificationAttempt($id: uuid!) {
        update_notification_outbox_by_pk(pk_columns: {id: $id}, _inc: {attempts: 1}, _set: {status: "pending", error: null}) { id }
      }
    `, { id: row.id })

    const channel = String(row.payload?.channel || 'slack')
    const message = String(row.payload?.message || 'Workflow notification')
    const slackUrl = process.env.SLACK_WEBHOOK_URL

    if (channel === 'slack' && slackUrl) {
      const response = await fetch(slackUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: message }),
      })
      if (!response.ok) throw new Error(`Slack delivery failed (${response.status})`)
    } else {
      // Disclosed demo stub when no provider is configured.
      await sleep(600)
    }

    await gql(`
      mutation NotificationDelivered($id: uuid!, $now: timestamptz!) {
        update_notification_outbox_by_pk(pk_columns: {id: $id}, _set: {status: "delivered", delivered_at: $now, error: null}) { id }
      }
    `, { id: row.id, now: new Date().toISOString() })
    return res.status(200).json({ delivered: true, provider: slackUrl ? 'slack' : 'stub' })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Notification failed'
    await gql(`
      mutation NotificationFailed($id: uuid!, $error: String!) {
        update_notification_outbox_by_pk(pk_columns: {id: $id}, _set: {status: "failed", error: $error}) { id }
      }
    `, { id: row.id, error: message })
    return res.status(500).json({ message })
  }
}
