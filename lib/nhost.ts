'use client'

import { createClient } from '@nhost/nhost-js'

const subdomain = process.env.NEXT_PUBLIC_NHOST_SUBDOMAIN || 'local'
const region = process.env.NEXT_PUBLIC_NHOST_REGION || 'local'

export const nhost = createClient({ subdomain, region })

export const graphqlHttpUrl =
  process.env.NEXT_PUBLIC_NHOST_GRAPHQL_URL ||
  (subdomain === 'local'
    ? 'https://local.graphql.local.nhost.run/v1'
    : `https://${subdomain}.graphql.${region}.nhost.run/v1`)

export const graphqlWsUrl = graphqlHttpUrl
  .replace(/^http:/, 'ws:')
  .replace(/^https:/, 'wss:')
