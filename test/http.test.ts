import { createServer } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { QueryEnforcer } from '../src/enforcer.js'
import { createLogger } from '../src/logger.js'
import type { MongoMcpDepsType } from '../src/mcp-core.js'
import {
  type RunningHttpServerType,
  startMcpServerHttp
} from '../src/mcp-server-http.js'
import type { MongoConnection, QueryResultType } from '../src/mongo.js'
import { ResponseRenderer } from '../src/response.js'
import {
  type ConfigType,
  EnvSchema,
  type ExecutionPlanType
} from '../src/types.js'
import { QueryValidator } from '../src/validator.js'

const TOKEN = 'a'.repeat(32)

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port =
        typeof address === 'object' && address !== null ? address.port : 0
      probe.close(() => resolve(port))
    })
  })

const config: ConfigType = {
  version: 1,
  databases: {
    demo: {
      collections: {
        orders: {
          allowedFields: ['_id', 'number', 'status'],
          filterableFields: ['_id', 'number', 'status'],
          sortableFields: ['number'],
          requiredFilter: {}
        }
      }
    }
  }
}

const execute = vi.fn<(plan: ExecutionPlanType) => Promise<QueryResultType>>(
  async () => ({
    kind: 'documents',
    documents: [{ number: 'ORD-1', status: 'paid' }],
    hasMore: false
  })
)

const buildDeps = (
  port: number,
  overrides: Record<string, string> = {}
): MongoMcpDepsType => {
  const env = EnvSchema.parse({
    MONGODB_URI: 'mongodb://localhost:27017',
    MONGODB_ALLOWED_DATABASES: 'demo',
    MCP_TRANSPORT: 'http',
    MCP_HTTP_AUTH_TOKEN: TOKEN,
    MCP_HTTP_PORT: String(port),
    LOG_LEVEL: 'silent',
    ...overrides
  })
  const logger = createLogger({ level: 'silent' })

  return {
    env,
    config,
    logger,
    mongo: {
      testConnection: async () => undefined,
      execute,
      close: async () => undefined
    } as unknown as MongoConnection,
    validator: new QueryValidator({
      allowWriteOps: false,
      allowedDatabases: env.MONGODB_ALLOWED_DATABASES,
      config,
      logger
    }),
    enforcer: new QueryEnforcer({ config, env, logger }),
    renderer: new ResponseRenderer(env, logger)
  }
}

let server: RunningHttpServerType
let url: URL

beforeAll(async () => {
  server = await startMcpServerHttp(buildDeps(await freePort()))
  url = new URL(`http://127.0.0.1:${server.port}/mcp`)
})

afterAll(async () => {
  await server?.close()
})

const post = (body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers
    },
    body: JSON.stringify(body)
  })

const initialize = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'curl', version: '1.0.0' }
  }
}

describe('refusing to start', () => {
  it('will not open a port without an authentication token', async () => {
    const deps = buildDeps(await freePort())
    const { MCP_HTTP_AUTH_TOKEN: _token, ...env } = deps.env

    await expect(
      startMcpServerHttp({ ...deps, env: env as typeof deps.env })
    ).rejects.toThrow(/MCP_HTTP_AUTH_TOKEN/)
  })
})

describe('the door', () => {
  it('turns away a request with no credentials', async () => {
    const response = await post(initialize)

    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toBe('Bearer')
  })

  it('turns away a wrong token', async () => {
    const response = await post(initialize, {
      authorization: `Bearer ${'b'.repeat(32)}`
    })

    expect(response.status).toBe(401)
  })

  it('turns away a token of the right length but wrong value', async () => {
    const response = await post(initialize, {
      authorization: `Bearer ${TOKEN.slice(0, 31)}b`
    })

    expect(response.status).toBe(401)
  })

  it('says nothing useful in the refusal', async () => {
    const body = await (await post(initialize)).text()

    expect(body).not.toContain(TOKEN)
    expect(body.length).toBeLessThan(50)
  })

  it('answers 404 outside /mcp', async () => {
    const response = await fetch(`http://127.0.0.1:${server.port}/`, {
      headers: { authorization: `Bearer ${TOKEN}` }
    })

    expect(response.status).toBe(404)
  })

  it('answers 405 to a method it does not serve', async () => {
    const response = await fetch(url, {
      method: 'PUT',
      headers: { authorization: `Bearer ${TOKEN}` }
    })

    expect(response.status).toBe(405)
  })

  it('refuses a body larger than the limit', async () => {
    let status: number | 'connection dropped'

    try {
      const response = await post(
        { ...initialize, padding: 'x'.repeat(2_000_000) },
        { authorization: `Bearer ${TOKEN}` }
      )
      status = response.status
    } catch {
      status = 'connection dropped'
    }

    expect([413, 'connection dropped']).toContain(status)
  })

  it('lets a valid token through', async () => {
    const response = await post(initialize, {
      authorization: `Bearer ${TOKEN}`
    })

    expect(response.status).toBe(200)
  })
})

describe('a real client over HTTP', () => {
  it('still accepts clients after an oversized request', async () => {
    await post(
      { ...initialize, padding: 'x'.repeat(2_000_000) },
      { authorization: `Bearer ${TOKEN}` }
    ).catch(() => undefined)

    const client = new Client({ name: 'after-413', version: '1.0.0' })

    await client.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { authorization: `Bearer ${TOKEN}` } }
      })
    )

    const { tools } = await client.listTools()

    expect(tools).toHaveLength(4)

    await client.close()
  })

  it('completes a handshake, lists tools and runs a query', async () => {
    const client = new Client({ name: 'http-test', version: '1.0.0' })

    await client.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { authorization: `Bearer ${TOKEN}` } }
      })
    )

    const { tools } = await client.listTools()

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'aggregate',
      'count',
      'distinct',
      'find'
    ])

    execute.mockClear()

    const result = await client.callTool({
      name: 'find',
      arguments: { database: 'demo', collection: 'orders', limit: 1 }
    })
    const content = (result as { content: { text: string }[] }).content
    const body = JSON.parse(content[0]?.text ?? '{}') as { returned: number }

    expect(body.returned).toBe(1)
    expect(execute).toHaveBeenCalledOnce()

    await client.close()
  })
})
