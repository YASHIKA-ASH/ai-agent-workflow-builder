# AgentFlow — AI Agent Workflow Builder

A compact n8n-style workflow engine built for the assignment using **Nhost + PostgreSQL + Hasura GraphQL + Nhost Auth + Nhost Functions + Next.js**.

The implementation prioritizes the assignment's end-to-end proof: multi-tenant isolation, two permission layers, real asynchronous execution, retries, quota enforcement, approval pause/resume, event-driven starts, and live GraphQL subscriptions.

## What is implemented

- Nhost Auth email/password login
- Two-organization multi-tenant data model
- `owner`, `editor`, `viewer` organization roles stored in `org_members`
- Org-scoped Hasura row permissions on every user-readable table
- Action-handler authorization for workflow writes, triggering, and approval
- Owner-only creation/modification of:
  - `db_write` steps
  - `notify` steps
  - `webhook` triggers
- Six step types:
  - `llm_call`
  - `http_request`
  - `db_write`
  - `notify`
  - `conditional_branch`
  - `approval_gate`
- Four trigger types:
  - manual
  - webhook (public Hasura Action with per-workflow secret; only a SHA-256 verifier is stored)
  - scheduled (Hasura cron → Nhost Function)
  - database event (`workflow_inbox` insert → Hasura Event Trigger)
- LLM/HTTP retry: **2 total attempts**
- Atomic monthly quota reservation to prevent concurrent-run quota races
- `paused` run state + `awaiting_approval` step state
- Owner/editor-only approval checked inside the `approveStep` Action handler
- Live `step_runs` / run subscription UI
- `notify` implemented through a Hasura Event Trigger + notification outbox
- Postgres `org_monthly_usage` view
- Simple responsive Next.js workflow builder with add/reorder/configure controls
- Seed script for the complete two-org review scenario

---

## Repository structure

```text
.
├── app/                          # Next.js App Router UI
│   ├── login/
│   ├── workflows/new/
│   ├── workflows/[id]/
│   └── runs/[id]/
├── components/
│   ├── AuthProvider.tsx
│   ├── Header.tsx
│   ├── RequireAuth.tsx
│   └── WorkflowEditor.tsx
├── lib/
│   ├── graphql.ts                # authenticated query/mutation + graphql-ws subscription
│   └── nhost.ts
├── functions/                    # Nhost Functions
│   ├── _shared.ts
│   ├── save-workflow.ts
│   ├── trigger-workflow-run.ts
│   ├── trigger-workflow-webhook.ts
│   ├── execute-run.ts
│   ├── approve-step.ts
│   ├── database-event-start.ts
│   ├── schedule-workflows.ts
│   └── send-notification.ts
├── nhost/
│   ├── migrations/default/...    # schema + quota functions + usage view
│   ├── metadata/                 # relationships, permissions, Actions, triggers, cron
│   └── nhost.toml
├── scripts/
│   └── seed-demo.mjs
└── docs/
    ├── WRITEUP.md
    └── DEMO.md
```

---

## Prerequisites

- Node.js 24 recommended
- Docker Desktop running
- Current Nhost CLI
- Optional: Gemini API key
- Optional: Slack incoming-webhook URL

Nhost Functions currently supports Node.js 24, and `nhost/nhost.toml` pins this project to that runtime.

---

# Local setup

## 1. Install packages

```bash
npm install
```

This also generates `package-lock.json`. Keep/commit that lockfile before starting or deploying Nhost Functions; the Functions runtime requires a lockfile in the functions directory or a parent directory.

## 2. Configure local secrets

Copy:

```bash
cp .secrets.example .secrets
```

On PowerShell:

```powershell
Copy-Item .secrets.example .secrets
```

Change `ACTION_SECRET` to a long random value if desired. The same value is exposed to Hasura and Functions through `nhost.toml`; direct calls to the private Action backing Functions are rejected without it.

## 3. Start Nhost

```bash
nhost up
```

The included migrations and Hasura metadata will be applied by the Nhost development environment.

Useful local URLs are normally:

```text
Hasura console: https://local.hasura.local.nhost.run
Nhost dashboard: https://local.dashboard.local.nhost.run
GraphQL:        https://local.graphql.local.nhost.run/v1
Auth:           https://local.auth.local.nhost.run/v1
```

If you changed the local Nhost subdomain, use the URLs printed by `nhost up` instead.

## 4. Configure the Next.js app / seed script

Copy:

```bash
cp .env.example .env.local
```

PowerShell:

```powershell
Copy-Item .env.example .env.local
```

The default file already targets the normal local Nhost endpoints.

If your local Hasura admin secret differs from `nhost-admin-secret`, update `NHOST_ADMIN_SECRET` in `.env.local` before seeding.

## 5. Seed the exact demo scenario

With Nhost running:

```bash
npm run seed:demo
```

This creates:

| Account | Org | Role | Password |
|---|---|---|---|
| `owner.a@example.com` | Demo Org A | owner | `DemoPass123!` |
| `editor.a@example.com` | Demo Org A | editor | `DemoPass123!` |
| `viewer.a@example.com` | Demo Org A | viewer | `DemoPass123!` |
| `owner.b@example.com` | Demo Org B | owner | `DemoPass123!` |

It also creates:

- `Customer Incident Analyzer` in Org A
- `Org B Private Workflow` in Org B

## 6. Start Next.js

```bash
npm run dev
```

Open:

```text
http://localhost:3000
```

---

# Real Gemini configuration

The project works without an LLM key. In that mode the `llm_call` step is **explicitly stubbed** with an artificial delay and returns an `urgent` / `normal` JSON classification.

To use a real Gemini call, expose this environment variable to the Nhost Functions runtime:

```text
GEMINI_API_KEY=<your-key>
```

For Nhost Cloud, store the value as a project secret and expose it through project environment configuration. You can also add this to `nhost.toml` after creating the secret:

```toml
[[global.environment]]
name = 'GEMINI_API_KEY'
value = '{{ secrets.GEMINI_API_KEY }}'
```

The default model is:

```text
gemini-3.6-flash
```

---

# Optional Slack delivery

`notify` is intentionally **not delivered directly by the runner**. The runner inserts into `notification_outbox`; the `deliver_notification` Hasura Event Trigger invokes `send-notification.ts`.

Without `SLACK_WEBHOOK_URL`, the function uses a disclosed ~600 ms delivery stub and marks the outbox item delivered.

For real Slack delivery, expose:

```text
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
```

---

# Core GraphQL operations

## Workflows + steps + triggers + latest run

The dashboard executes an org-scoped query equivalent to:

```graphql
query Dashboard($userId: uuid!) {
  org_members(where: {user_id: {_eq: $userId}}) {
    role
    organization {
      id
      name
      workflows {
        id
        name
        workflow_steps(order_by: {position: asc}) {
          id
          type
          position
        }
        workflow_triggers {
          id
          type
          enabled
        }
        workflow_runs(order_by: {created_at: desc}, limit: 1) {
          id
          status
          trigger_type
        }
      }
    }
  }
}
```

## Save/create workflow

```graphql
mutation Save($input: SaveWorkflowInput!) {
  saveWorkflow(input: $input) {
    workflow_id
    success
    message
  }
}
```

This is an Action rather than direct table writes so owner-only step/trigger checks cannot be bypassed by changing frontend code. Webhook secrets are converted to SHA-256 verifiers before the definition is stored.

## Manual run

```graphql
mutation Run($workflowId: String!, $payload: String) {
  triggerWorkflowRun(workflow_id: $workflowId, payload: $payload) {
    run_id
    status
    message
  }
}
```

## Approval

```graphql
mutation Approve($stepRunId: String!) {
  approveStep(step_run_id: $stepRunId) {
    run_id
    success
    message
  }
}
```

## Live progress

The run page subscribes to both the run and its `step_runs`:

```graphql
subscription RunLive($runId: uuid!) {
  workflow_runs_by_pk(id: $runId) {
    id
    status
    current_position
  }
  step_runs(
    where: {workflow_run_id: {_eq: $runId}}
    order_by: {position: asc}
  ) {
    id
    position
    step_type
    step_name
    status
    attempt_count
    output
    error
    approved_by
    approved_at
  }
}
```

---

# Triggering without the Run button

## Database event trigger

The seeded Org A workflow has `database_event` enabled.

As Org A owner/editor, execute:

```graphql
mutation DatabaseEvent($workflowId: uuid!) {
  insert_workflow_inbox_one(
    object: {
      workflow_id: $workflowId
      payload: {
        message: "Production payment system is down"
        source: "database-event-demo"
      }
    }
  ) {
    id
  }
}
```

Flow:

```text
workflow_inbox INSERT
→ Hasura Event Trigger
→ database-event-start Function
→ atomic quota reserve
→ workflow_run INSERT
→ run_jobs INSERT
→ execute_workflow_run Event Trigger
→ execute-run Function
```

No manual workflow-run Action is involved.

## Public webhook Action

The seed script prints a fresh Org A webhook secret to the terminal. Copy that value for the webhook test. You may make it deterministic by setting `DEMO_WEBHOOK_SECRET` before running the seed.

External systems can POST to the normal Hasura GraphQL endpoint without a user JWT:

```graphql
mutation Webhook {
  triggerWorkflowWebhook(
    workflow_id: "<ORG_A_WORKFLOW_ID>"
    secret: "<SECRET_PRINTED_BY_SEED>"
    payload: "{\"message\":\"Production payments are down\",\"event_id\":\"webhook-demo-1\"}"
  ) {
    run_id
    status
    message
  }
}
```

The Hasura Action itself is callable by the `public` role, but the handler hashes the supplied secret and checks it against the stored SHA-256 verifier before reserving quota or creating a run. The plaintext secret is never stored in the trigger row.

## Scheduled trigger

Enable the workflow's `scheduled` trigger and set for example:

```json
{ "everyMinutes": 5 }
```

Hasura runs the scheduler Function every minute. The Function evaluates due schedules and uses a time-bucket dedupe key so retries do not create duplicate scheduled runs.

---

# How permissions are enforced

## Layer 1 — organization + role scoping

All authenticated users use the normal Nhost `user` Hasura role. `owner/editor/viewer` is **organization-specific application data**, not a global JWT role.

Example workflow select permission:

```yaml
filter:
  organization:
    members:
      user_id:
        _eq: X-Hasura-User-Id
```

Therefore an Org B user cannot read an Org A workflow even if they know its UUID.

Actions (`triggerWorkflowRun`, `approveStep`, `saveWorkflow`) repeat the membership lookup server-side before doing privileged work.

## Layer 2 — step-level gating

`saveWorkflow` checks the caller's membership role and rejects attempts by editors to add/change/remove:

```text
db_write
notify
webhook trigger
```

The restriction is enforced by the Action handler, not only by hiding controls in React.

`approveStep` independently resolves:

```text
step_run → workflow_run → org_id → org_members
```

and only resumes if the caller is owner/editor in that exact organization.

---

# Quota behavior

Run creation calls the Postgres function `reserve_org_quota(org_id)`.

It locks the organization row and only increments `quota_reserved` when:

```text
quota_used + quota_reserved < quota_allowed
```

This avoids the common race where two simultaneous requests both see one remaining call.

On completion:

```text
quota_reserved -= 1
quota_used += 1
```

On failure:

```text
quota_reserved -= 1
quota_used unchanged
```

The function also resets monthly counters when a new quota period begins.

---

# Executor behavior

Execution is asynchronous:

```text
Action returns run_id
→ run_jobs row
→ Hasura Event Trigger
→ executor
```

This lets the browser subscribe immediately instead of keeping an Action request open for the whole workflow.

For `llm_call` and `http_request`:

```text
attempt 1
→ failure
→ short delay
→ attempt 2
→ fail run if both attempts fail
```

`attempt_count` is written before every attempt.

At `approval_gate`:

```text
step_run.status = awaiting_approval
workflow_run.status = paused
executor returns
```

`approveStep` marks the step completed, records `approved_by` / `approved_at`, sets the run back to `queued`, and inserts another `run_jobs` row starting at the next position.

---

# Cross-org attack checks

Log in as `owner.b@example.com` and take an Org A UUID from the owner recording.

### Query guessed Org A workflow

```graphql
query Guess($id: uuid!) {
  workflows_by_pk(id: $id) { id name }
}
```

Expected:

```json
{ "workflows_by_pk": null }
```

### Trigger guessed Org A workflow

```graphql
mutation GuessRun($id: String!) {
  triggerWorkflowRun(workflow_id: $id) { run_id }
}
```

Expected: Action authorization error / forbidden.

### Approve guessed Org A step run

```graphql
mutation GuessApproval($id: String!) {
  approveStep(step_run_id: $id) { success }
}
```

Expected: forbidden.

This proves both Hasura read isolation and Action-layer authorization.

---

# Deploying

## Backend / Nhost

1. Create an Nhost Cloud project.
2. Add an `ACTION_SECRET` project secret.
3. If using real providers, add `GEMINI_API_KEY` and/or `SLACK_WEBHOOK_URL`, then expose them as environment variables.
4. Connect this GitHub repository under Nhost **Settings → Deployments** or use the Nhost CLI deployment workflow.
5. Verify the deployment applied:
   - migrations
   - metadata
   - Functions
   - Hasura Actions/Event Triggers/cron
6. Run the demo seed against the cloud endpoints by setting `NHOST_AUTH_URL`, `NHOST_GRAPHQL_URL`, and `NHOST_ADMIN_SECRET` in your local shell before `npm run seed:demo`.

## Frontend / Vercel

Set:

```text
NEXT_PUBLIC_NHOST_SUBDOMAIN=<your-nhost-subdomain>
NEXT_PUBLIC_NHOST_REGION=<your-region>
NEXT_PUBLIC_NHOST_GRAPHQL_URL=https://<subdomain>.graphql.<region>.nhost.run/v1
```

Then import the GitHub repository into Vercel and deploy.

The admin secret and Action secret **must never** be configured as `NEXT_PUBLIC_*` variables.

---

# Before submitting

Run:

```bash
npm run typecheck
npm run build
```

Then follow [`docs/DEMO.md`](docs/DEMO.md) and record the final scenario.

Also include [`docs/WRITEUP.md`](docs/WRITEUP.md) as the requested ~1 page architecture/security write-up.

---

# Submission links

Fill these three lines after you push/deploy/record:

```text
GitHub repository: <paste GitHub URL>
Hosted Next.js app: <paste Vercel URL>
Final-task recording: <paste Drive/Loom URL>
```

Do not commit `.env.local`, `.secrets`, the Hasura admin secret, Gemini key, Slack webhook URL, or generated plaintext workflow webhook secrets.
