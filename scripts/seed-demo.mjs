import crypto from 'node:crypto'

const authUrl = process.env.NHOST_AUTH_URL || 'https://local.auth.local.nhost.run/v1'
const graphqlUrl = process.env.NHOST_GRAPHQL_URL || 'https://local.graphql.local.nhost.run/v1'
const adminSecret = process.env.NHOST_ADMIN_SECRET || 'nhost-admin-secret'
const password = process.env.DEMO_PASSWORD || 'DemoPass123!'
const webhookSecret = process.env.DEMO_WEBHOOK_SECRET || crypto.randomBytes(24).toString('hex')

const demoUsers = [
  { email: 'owner.a@example.com', name: 'Alice Owner A' },
  { email: 'editor.a@example.com', name: 'Bob Editor A' },
  { email: 'viewer.a@example.com', name: 'Charlie Viewer A' },
  { email: 'owner.b@example.com', name: 'David Owner B' },
]

async function request(query, variables = {}) {
  const res = await fetch(graphqlUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hasura-admin-secret': adminSecret },
    body: JSON.stringify({ query, variables }),
  })
  const body = await res.json()
  if (!res.ok || body.errors?.length) throw new Error(body.errors?.map((e) => e.message).join('; ') || `GraphQL ${res.status}`)
  return body.data
}

async function ensureUser(user) {
  const existing = await request(`query UserByEmail($email: citext!) { users(where: {email: {_eq: $email}}, limit: 1) { id email } }`, { email: user.email })
  if (existing.users[0]) return existing.users[0].id

  const res = await fetch(`${authUrl}/signup/email-password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: user.email, password, options: { displayName: user.name } }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    const retry = await request(`query UserByEmail($email: citext!) { users(where: {email: {_eq: $email}}, limit: 1) { id email } }`, { email: user.email })
    if (retry.users[0]) return retry.users[0].id
    throw new Error(`Could not create ${user.email}: ${body.message || res.status}`)
  }
  const id = body?.session?.user?.id || body?.user?.id
  if (!id) {
    const created = await request(`query UserByEmail($email: citext!) { users(where: {email: {_eq: $email}}, limit: 1) { id email } }`, { email: user.email })
    if (created.users[0]) return created.users[0].id
    throw new Error(`Created ${user.email}, but could not resolve its id`)
  }
  return id
}

async function main() {
  console.log('Creating/finding demo users…')
  const ids = {}
  for (const user of demoUsers) {
    ids[user.email] = await ensureUser(user)
    console.log(`  ✓ ${user.email}`)
  }

  const existing = await request(`query DemoOrgs { organizations(where: {name: {_in: ["Demo Org A", "Demo Org B"]}}) { id } }`)
  if (existing.organizations.length) {
    await request(`mutation ResetDemo($ids: [uuid!]!) { delete_organizations(where: {id: {_in: $ids}}) { affected_rows } }`, { ids: existing.organizations.map((o) => o.id) })
  }

  const seed = await request(`
    mutation Seed($orgs: [organizations_insert_input!]!) {
      insert_organizations(objects: $orgs) {
        returning {
          id name
          workflows { id name workflow_triggers { type config } }
        }
      }
    }
  `, {
    orgs: [
      {
        name: 'Demo Org A', quota_allowed: 25,
        members: { data: [
          { user_id: ids['owner.a@example.com'], role: 'owner' },
          { user_id: ids['editor.a@example.com'], role: 'editor' },
          { user_id: ids['viewer.a@example.com'], role: 'viewer' },
        ] },
        workflows: { data: [{
          name: 'Customer Incident Analyzer',
          description: 'LLM classification → conditional branch → HTTP enrichment → approval → notification.',
          active: true,
          created_by: ids['owner.a@example.com'],
          workflow_steps: { data: [
            { position: 0, type: 'llm_call', name: 'Classify incident', config: { prompt: 'Classify the customer incident as urgent or normal. Return ONLY JSON like {"priority":"urgent","summary":"..."}.', model: 'gemini-3.6-flash', delayMs: 1000 } },
            { position: 1, type: 'conditional_branch', name: 'Urgent?', config: { field: 'priority', operator: 'equals', value: 'urgent', ifTruePosition: 2, ifFalsePosition: 3 } },
            { position: 2, type: 'http_request', name: 'Fetch escalation context', config: { method: 'GET', url: 'https://jsonplaceholder.typicode.com/todos/1', timeoutMs: 8000 } },
            { position: 3, type: 'approval_gate', name: 'Approve escalation', config: { instructions: 'Owner/editor must approve before notification.' } },
            { position: 4, type: 'notify', name: 'Notify team', config: { channel: 'slack', message: 'Approved incident workflow completed.' } },
          ] },
          workflow_triggers: { data: [
            { type: 'manual', enabled: true, config: {}, created_by: ids['owner.a@example.com'] },
            { type: 'database_event', enabled: true, config: {}, created_by: ids['owner.a@example.com'] },
            { type: 'webhook', enabled: true, config: { secretHash: crypto.createHash('sha256').update(webhookSecret).digest('hex') }, created_by: ids['owner.a@example.com'] },
            { type: 'scheduled', enabled: false, config: { everyMinutes: 5 }, created_by: ids['owner.a@example.com'] },
          ] },
        }] },
      },
      {
        name: 'Demo Org B', quota_allowed: 25,
        members: { data: [{ user_id: ids['owner.b@example.com'], role: 'owner' }] },
        workflows: { data: [{
          name: 'Org B Private Workflow',
          description: 'Separate tenant used to prove cross-org isolation.',
          active: true,
          created_by: ids['owner.b@example.com'],
          workflow_steps: { data: [
            { position: 0, type: 'llm_call', name: 'Private Org B LLM', config: { prompt: 'Return {"priority":"normal"}.', delayMs: 500 } },
            { position: 1, type: 'approval_gate', name: 'Org B approval', config: {} },
          ] },
          workflow_triggers: { data: [{ type: 'manual', enabled: true, config: {}, created_by: ids['owner.b@example.com'] }] },
        }] },
      },
    ],
  })

  console.log('\nDemo data ready:')
  for (const org of seed.insert_organizations.returning) {
    console.log(`- ${org.name}: ${org.id}`)
    for (const wf of org.workflows) console.log(`    workflow ${wf.name}: ${wf.id}`)
  }
  console.log(`\nPassword for all demo accounts: ${password}`)
  console.log('Org A: owner.a@example.com / editor.a@example.com / viewer.a@example.com')
  console.log('Org B: owner.b@example.com')
  console.log(`Org A webhook secret for this seed: ${webhookSecret}`)
}

main().catch((error) => {
  console.error('\nSeed failed:', error.message)
  process.exit(1)
})
