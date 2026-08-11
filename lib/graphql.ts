'use client'

import { createClient as createWsClient, type Client as WsClient } from 'graphql-ws'
import { graphqlHttpUrl, graphqlWsUrl, nhost } from './nhost'

type GraphQLError = { message: string; extensions?: { code?: string } }

export async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const session = (await nhost.refreshSession(60)) || nhost.getUserSession()
  const response = await fetch(graphqlHttpUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(session?.accessToken ? { authorization: `Bearer ${session.accessToken}` } : {}),
    },
    body: JSON.stringify({ query, variables }),
  })

  const body = (await response.json()) as { data?: T; errors?: GraphQLError[] }
  if (!response.ok || body.errors?.length || !body.data) {
    throw new Error(body.errors?.map((e) => e.message).join('; ') || `GraphQL request failed (${response.status})`)
  }
  return body.data
}

export function subscribe<T>(
  query: string,
  variables: Record<string, unknown>,
  handlers: { next: (data: T) => void; error: (error: unknown) => void },
) {
  let client: WsClient | null = null
  client = createWsClient({
    url: graphqlWsUrl,
    connectionParams: async () => {
      const session = (await nhost.refreshSession(60)) || nhost.getUserSession()
      return session?.accessToken
        ? { headers: { authorization: `Bearer ${session.accessToken}` } }
        : {}
    },
    retryAttempts: 5,
  })

  const dispose = client.subscribe<T>(
    { query, variables },
    {
      next: (value) => {
        if (value.errors?.length) handlers.error(new Error(value.errors.map((e) => e.message).join('; ')))
        else if (value.data) handlers.next(value.data)
      },
      error: handlers.error,
      complete: () => undefined,
    },
  )

  return () => {
    dispose()
    client?.dispose()
  }
}
