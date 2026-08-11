import type { Request, Response } from 'express'
import {
  assertSafeExternalUrl,
  evaluateCondition,
  eventNewRow,
  finishRun,
  getPath,
  gql,
  parseJson,
  requireInternalSecret,
  retry,
  sleep,
} from './_shared'

type Step = {
  id: string
  position: number
  type: string
  name: string
  config: Record<string, unknown>
}

type StepRun = {
  id: string
  position: number
  status: string
  output: unknown
  attempt_count: number
}

type Run = {
  id: string
  org_id: string
  status: string
  current_position: number
  started_at: string | null
  trigger_payload: Record<string, unknown>
  workflow: { id: string; active: boolean; workflow_steps: Step[] }
  step_runs: StepRun[]
}

function stripFence(text: string) {
  return text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
}

function parseModelOutput(text: string): Record<string, unknown> {
  const clean = stripFence(text)
  try {
    const value = JSON.parse(clean)
    return value && typeof value === 'object' && !Array.isArray(value) ? value : { value }
  } catch {
    return { text: clean }
  }
}

async function runLlm(config: Record<string, unknown>, previous: unknown, triggerPayload: Record<string, unknown>) {
  const prompt = String(config.prompt || 'Classify the input and return JSON.')
  const fullPrompt = `${prompt}\n\nTrigger payload:\n${JSON.stringify(triggerPayload)}\n\nPrevious step output:\n${JSON.stringify(previous)}`
  const key = process.env.GEMINI_API_KEY

  if (!key) {
    const delay = Math.max(300, Number(config.delayMs || 900))
    await sleep(delay)
    const haystack = JSON.stringify({ triggerPayload, previous }).toLowerCase()
    const urgent = ['urgent', 'down', 'outage', 'critical', 'production', 'payment system'].some((word) => haystack.includes(word))
    return {
      priority: urgent ? 'urgent' : 'normal',
      summary: urgent ? 'Stub classified the incident as urgent.' : 'Stub classified the incident as normal.',
      stubbed: true,
      artificialDelayMs: delay,
    }
  }

  const model = String(config.model || process.env.GEMINI_MODEL || 'gemini-3.6-flash')
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: fullPrompt }] }],
      generationConfig: { responseMimeType: 'application/json' },
    }),
  })
  const body = await response.json() as any
  if (!response.ok) throw new Error(`Gemini ${response.status}: ${JSON.stringify(body).slice(0, 500)}`)
  const text = body?.candidates?.[0]?.content?.parts?.map((p: any) => p.text || '').join('') || ''
  if (!text) throw new Error('Gemini returned no text')
  return { ...parseModelOutput(text), provider: 'gemini', model }
}

async function runHttp(config: Record<string, unknown>, previous: unknown) {
  const method = String(config.method || 'GET').toUpperCase()
  const rawUrl = String(config.url || '')
  if (!rawUrl) throw new Error('http_request requires config.url')
  const url = assertSafeExternalUrl(rawUrl)
  const headers = (config.headers && typeof config.headers === 'object' && !Array.isArray(config.headers))
    ? config.headers as Record<string, string>
    : {}

  let body: string | undefined
  if (!['GET', 'HEAD'].includes(method)) {
    body = JSON.stringify(config.body ?? { previous })
    if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json'
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), Math.max(1000, Number(config.timeoutMs || 10000)))
  try {
    const response = await fetch(url, { method, headers, body, signal: controller.signal })
    const text = await response.text()
    let data: unknown = text
    try { data = JSON.parse(text) } catch { /* keep text */ }
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 400)}`)
    return { status: response.status, data }
  } finally {
    clearTimeout(timeout)
  }
}

async function setRunState(runId: string, status: string, currentPosition?: number) {
  const set: Record<string, unknown> = { status }
  if (typeof currentPosition === 'number') set.current_position = currentPosition
  await gql(`
    mutation SetRunState($id: uuid!, $set: workflow_runs_set_input!) {
      update_workflow_runs_by_pk(pk_columns: {id: $id}, _set: $set) { id }
    }
  `, { id: runId, set })
}

async function updateStepRun(id: string, set: Record<string, unknown>) {
  await gql(`
    mutation UpdateStepRun($id: uuid!, $set: step_runs_set_input!) {
      update_step_runs_by_pk(pk_columns: {id: $id}, _set: $set) { id }
    }
  `, { id, set })
}

async function ensureStepRun(run: Run, step: Step, previous: unknown): Promise<StepRun> {
  const existing = run.step_runs.find((s) => s.position === step.position)
  if (existing) return existing
  const data = await gql<{ insert_step_runs_one: StepRun }>(`
    mutation CreateStepRun($object: step_runs_insert_input!) {
      insert_step_runs_one(object: $object) { id position status output attempt_count }
    }
  `, {
    object: {
      workflow_run_id: run.id,
      workflow_step_id: step.id,
      position: step.position,
      step_type: step.type,
      step_name: step.name,
      status: 'pending',
      input: previous ?? null,
    },
  })
  run.step_runs.push(data.insert_step_runs_one)
  return data.insert_step_runs_one
}

async function markSkipped(run: Run, step: Step) {
  const sr = await ensureStepRun(run, step, null)
  if (['completed', 'skipped'].includes(sr.status)) return
  await updateStepRun(sr.id, { status: 'skipped', finished_at: new Date().toISOString(), output: { reason: 'conditional_branch' } })
  sr.status = 'skipped'
}

async function writeDbRecord(run: Run, step: Step, previous: unknown, config: Record<string, unknown>) {
  const data = await gql<{ insert_db_write_records_one: { id: string } }>(`
    mutation DbWrite($object: db_write_records_insert_input!) {
      insert_db_write_records_one(object: $object) { id }
    }
  `, {
    object: {
      org_id: run.org_id,
      workflow_run_id: run.id,
      workflow_step_id: step.id,
      data: { label: config.label || step.name, previous, extra: config.data || {} },
    },
  })
  return { recordId: data.insert_db_write_records_one.id }
}

async function enqueueNotification(run: Run, step: Step, previous: unknown, config: Record<string, unknown>) {
  const data = await gql<{ insert_notification_outbox_one: { id: string } }>(`
    mutation Notify($object: notification_outbox_insert_input!) {
      insert_notification_outbox_one(object: $object) { id }
    }
  `, {
    object: {
      org_id: run.org_id,
      workflow_run_id: run.id,
      workflow_step_id: step.id,
      payload: {
        channel: config.channel || 'slack',
        message: config.message || `Workflow ${run.workflow.id} completed its approval path.`,
        previous,
      },
    },
  })
  return { notificationId: data.insert_notification_outbox_one.id, delivery: 'event_trigger_queued' }
}

export default async function handler(req: Request, res: Response) {
  if (!requireInternalSecret(req, res)) return
  const job = eventNewRow<{ id: string; workflow_run_id: string; processed: boolean }>(req)
  if (!job) return res.status(400).json({ message: 'Missing run job event' })

  try {
    const claimedJob = await gql<{ update_run_jobs: { affected_rows: number } }>(`
      mutation ClaimJob($id: uuid!, $now: timestamptz!) {
        update_run_jobs(where: {id: {_eq: $id}, processed: {_eq: false}}, _set: {processed: true, processed_at: $now}) { affected_rows }
      }
    `, { id: job.id, now: new Date().toISOString() })
    if (claimedJob.update_run_jobs.affected_rows !== 1) return res.status(200).json({ skipped: true, reason: 'job already processed' })

    const data = await gql<{ workflow_runs_by_pk: Run | null }>(`
      query RunForExecution($id: uuid!) {
        workflow_runs_by_pk(id: $id) {
          id org_id status current_position started_at trigger_payload
          workflow {
            id active
            workflow_steps(order_by: {position: asc}) { id position type name config }
          }
          step_runs(order_by: {position: asc}) { id position status output attempt_count }
        }
      }
    `, { id: job.workflow_run_id })

    const run = data.workflow_runs_by_pk
    if (!run) return res.status(200).json({ skipped: true, reason: 'run deleted' })
    if (['completed', 'failed', 'paused'].includes(run.status)) return res.status(200).json({ skipped: true, reason: `run is ${run.status}` })
    if (!run.workflow.active) {
      await finishRun(run.id, 'failed', 'Workflow was disabled before execution')
      return res.status(200).json({ failed: true })
    }

    if (run.status === 'queued') {
      const now = new Date().toISOString()
      const set: Record<string, unknown> = { status: 'running' }
      if (!run.started_at) set.started_at = now
      const claimedRun = await gql<{ update_workflow_runs: { affected_rows: number } }>(`
        mutation ClaimRun($id: uuid!, $set: workflow_runs_set_input!) {
          update_workflow_runs(where: {id: {_eq: $id}, status: {_eq: "queued"}}, _set: $set) { affected_rows }
        }
      `, { id: run.id, set })
      if (claimedRun.update_workflow_runs.affected_rows !== 1) {
        throw new Error('Run changed while executor was claiming it')
      }
    }

    const steps = run.workflow.workflow_steps
    if (!steps.length) {
      await finishRun(run.id, 'completed')
      return res.status(200).json({ completed: true, empty: true })
    }

    let cursor = Math.max(0, run.current_position)
    let previous: unknown = run.step_runs
      .filter((s) => s.status === 'completed' && s.position < cursor)
      .sort((a, b) => b.position - a.position)[0]?.output ?? run.trigger_payload

    while (cursor < steps.length) {
      const step = steps[cursor]
      const stepRun = await ensureStepRun(run, step, previous)
      if (stepRun.status === 'completed' || stepRun.status === 'skipped') {
        previous = stepRun.output
        cursor++
        continue
      }
      if (stepRun.status === 'awaiting_approval') {
        await setRunState(run.id, 'paused', step.position)
        return res.status(200).json({ paused: true, step_run_id: stepRun.id })
      }

      if (step.type === 'approval_gate') {
        await updateStepRun(stepRun.id, {
          status: 'awaiting_approval',
          input: previous ?? null,
          started_at: new Date().toISOString(),
          error: null,
        })
        await setRunState(run.id, 'paused', step.position)
        return res.status(200).json({ paused: true, step_run_id: stepRun.id })
      }

      await updateStepRun(stepRun.id, {
        status: 'running',
        input: previous ?? null,
        started_at: stepRun.status === 'pending' ? new Date().toISOString() : undefined,
        error: null,
      })

      try {
        let output: Record<string, unknown>

        if (step.type === 'conditional_branch') {
          const field = String(step.config.field || 'priority')
          const operator = String(step.config.operator || 'equals')
          const expected = step.config.value ?? 'urgent'
          const matched = evaluateCondition(getPath(previous, field), operator, expected)
          const target = Number(matched ? step.config.ifTruePosition : step.config.ifFalsePosition)
          if (!Number.isInteger(target) || target <= step.position || target >= steps.length) {
            throw new Error('conditional_branch must point to a later valid step position')
          }
          for (let p = step.position + 1; p < target; p++) await markSkipped(run, steps[p])
          output = { matched, field, operator, expected, nextPosition: target, observed: getPath(previous, field) }
          await updateStepRun(stepRun.id, { status: 'completed', output, finished_at: new Date().toISOString(), attempt_count: 1 })
          await setRunState(run.id, 'running', target)
          previous = output
          cursor = target
          continue
        }

        output = await retry(async () => {
          if (step.type === 'llm_call') return await runLlm(step.config, previous, run.trigger_payload)
          if (step.type === 'http_request') return await runHttp(step.config, previous)
          if (step.type === 'db_write') return await writeDbRecord(run, step, previous, step.config)
          if (step.type === 'notify') return await enqueueNotification(run, step, previous, step.config)
          throw new Error(`Unsupported step type: ${step.type}`)
        }, ['llm_call', 'http_request'].includes(step.type) ? 2 : 1, async (attempt) => {
          await updateStepRun(stepRun.id, { status: 'running', attempt_count: attempt, error: null })
        })

        await updateStepRun(stepRun.id, { status: 'completed', output, finished_at: new Date().toISOString() })
        stepRun.status = 'completed'
        stepRun.output = output
        previous = output
        cursor++
        await setRunState(run.id, 'running', cursor)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Step failed'
        await updateStepRun(stepRun.id, { status: 'failed', error: message, finished_at: new Date().toISOString() })
        await finishRun(run.id, 'failed', `${step.name}: ${message}`)
        return res.status(200).json({ failed: true, error: message })
      }
    }

    await finishRun(run.id, 'completed')
    return res.status(200).json({ completed: true })
  } catch (error) {
    console.error('execute-run failed', error)
    // Release the event-delivery claim so Hasura's configured Event Trigger retry
    // can resume the run from persisted step state after an unexpected handler error.
    try {
      await gql(`
        mutation ReleaseJob($id: uuid!) {
          update_run_jobs_by_pk(pk_columns: {id: $id}, _set: {processed: false, processed_at: null}) { id }
        }
      `, { id: job.id })
    } catch (releaseError) {
      console.error('failed to release run job for retry', releaseError)
    }
    return res.status(500).json({ message: error instanceof Error ? error.message : 'Executor failed' })
  }
}
