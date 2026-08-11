# Final Task Recording Script

Use this sequence for a short reviewer-friendly recording.

## 0. Prepare

Run:

```bash
npm run seed:demo
```

Keep these accounts ready:

```text
owner.a@example.com   DemoPass123!
editor.a@example.com  DemoPass123!
viewer.a@example.com  DemoPass123!
owner.b@example.com   DemoPass123!
```

Copy the seeded Org A workflow UUID and generated webhook secret printed by the seed script.

## 1. Show Org A owner + workflow structure

Sign in as `owner.a@example.com`.

Open **Customer Incident Analyzer** and briefly show:

1. `llm_call`
2. `conditional_branch`
3. `http_request`
4. `approval_gate`
5. `notify`

Show the enabled manual + database-event + webhook triggers.

Point out that `notify` and webhook are owner-only.

## 2. Manual execution + live subscription

Go to dashboard → **Run**.

Use a payload containing an urgent phrase if you call the mutation from Hasura, or use the default seeded/stub classification. The seeded stub prompt contains the production incident context when triggered with:

```json
{ "message": "Production payment system is completely down" }
```

Watch the run page update without refresh:

```text
llm_call            completed
conditional_branch  completed (matched = true)
http_request         completed
approval_gate        awaiting approval
workflow             paused
```

The browser is now waiting on a GraphQL subscription; do not refresh.

## 3. Viewer cannot approve/trigger

Sign out and sign in as `viewer.a@example.com`.

Show:

- Run button is absent.
- Edit controls are not available for privileged changes.
- Approval button is absent.

For stronger proof, try `triggerWorkflowRun` in the Hasura/API client using the viewer JWT and show the authorization error.

## 4. Editor can approve

Sign in as `editor.a@example.com`.

Open the paused run and click **Approve & resume**.

Show live transition:

```text
approval_gate   completed
notify          completed
run             completed
```

Point out `approved_by`, `approved_at`, and that `notify` queued an Event Trigger delivery.

## 5. Start the same workflow without the manual Run Action

While signed in as Org A owner/editor, execute in Hasura GraphQL:

```graphql
mutation FireDatabaseEvent($workflowId: uuid!) {
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

Then show a new `workflow_run` whose `trigger_type` is `database_event`.

Explain the chain:

```text
DB row insert → Hasura Event Trigger → Function → queued run → executor Event Trigger
```

Optional additional proof: call the public `triggerWorkflowWebhook` Action using the generated secret printed by `npm run seed:demo`.

## 6. Prove Org B isolation including guessed IDs

Copy an Org A workflow UUID and paused/completed step-run UUID first.

Sign in as `owner.b@example.com`.

Show Org B dashboard: Org A is absent.

Then test a guessed Org A workflow ID:

```graphql
query GuessOrgA($id: uuid!) {
  workflows_by_pk(id: $id) {
    id
    name
  }
}
```

Expected:

```json
{
  "data": {
    "workflows_by_pk": null
  }
}
```

Try triggering the same guessed ID:

```graphql
mutation GuessTrigger($id: String!) {
  triggerWorkflowRun(workflow_id: $id) {
    run_id
  }
}
```

Expected: forbidden/access denied.

Try approving the Org A step-run ID:

```graphql
mutation GuessApprove($id: String!) {
  approveStep(step_run_id: $id) {
    success
  }
}
```

Expected: forbidden.

Finish by showing Org B's own private workflow is still visible and usable to its owner.

## What this single walkthrough proves

- schema relationships are correct
- org-scoped Hasura permissions work
- step-level Action checks work
- manual execution works
- a non-manual event trigger works
- quota gate is in the run-start path
- LLM/HTTP/conditional logic executes
- approval truly pauses/resumes
- subscriptions update live
- cross-org ID guessing fails for reads, runs, and approval
