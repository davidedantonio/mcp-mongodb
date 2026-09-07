import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { QueryEnforcer } from './../src/enforcer.js'
import { createLogger } from './../src/logger.js'
import {
  createMongoMcpServer,
  type MongoMcpDepsType
} from './../src/mcp-core.js'
import type { MongoConnection, QueryResultType } from './../src/mongo.js'
import { ResponseRenderer } from './../src/response.js'
import {
  type ConfigType,
  EnvSchema,
  type ExecutionPlanType
} from './../src/types.js'
import { QueryValidator } from './../src/validator.js'

const config: ConfigType = {
  version: 1,
  databases: {
    demo: {
      collections: {
        orders: {
          allowedFields: ['_id', 'number', 'status', 'total'],
          filterableFields: ['number', 'status'],
          sortableFields: ['total'],
          requiredFilter: { deleted: { $ne: true } }
        },
        customers: {
          allowedFields: ['_id', 'name'],
          filterableFields: ['name'],
          sortableFields: ['name'],
          requiredFilter: {}
        }
      }
    }
  }
}

const env = EnvSchema.parse({
  MONGODB_URI: 'mongodb://localhost:27017',
  MONGODB_ALLOWED_DATABASES: 'demo'
})

const logger = createLogger({ level: 'silent' })

const execute = vi.fn<(plan: ExecutionPlanType) => Promise<QueryResultType>>(
  async () => ({
    kind: 'documents',
    documents: [{ number: 'ORD-1', status: 'paid' }],
    hasMore: false
  })
)

const deps: MongoMcpDepsType = {
  env,
  config,
  logger,
  mongo: { execute } as unknown as MongoConnection,
  validator: new QueryValidator({
    allowedDatabases: env.MONGODB_ALLOWED_DATABASES,
    config,
    logger
  }),
  enforcer: new QueryEnforcer({ config, env, logger }),
  renderer: new ResponseRenderer(env, logger)
}

let client: Client

beforeAll(async () => {
  const server = createMongoMcpServer(deps)
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair()

  client = new Client({ name: 'test', version: '1.0.0' })

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport)
  ])
})

const payload = (result: unknown) => {
  const content = (result as { content: { text: string }[] }).content
  return JSON.parse(content[0]?.text ?? '{}') as Record<string, unknown>
}

describe('the tools a client sees', () => {
  it('exposes exactly the four read operations', async () => {
    const { tools } = await client.listTools()

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'aggregate',
      'count',
      'distinct',
      'find'
    ])
  })

  it('marks them read-only', async () => {
    const { tools } = await client.listTools()

    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true)
    }
  })

  it('names the exposed collections and their fields in every description', async () => {
    const { tools } = await client.listTools()

    for (const tool of tools) {
      expect(tool.description).toContain('demo.orders')
      expect(tool.description).toContain('filterable: number, status')
    }
  })

  it('does not ask the model to name the operation it already chose', async () => {
    const { tools } = await client.listTools()

    for (const tool of tools) {
      expect(tool.inputSchema.properties).not.toHaveProperty('operation')
    }
  })

  it('publishes a flat filter schema, without recursive $ref', async () => {
    const { tools } = await client.listTools()
    const find = tools.find((tool) => tool.name === 'find')

    expect(JSON.stringify(find?.inputSchema)).not.toContain('$ref')
  })
})

describe('the resources a client sees', () => {
  it('lists the exposed collections', async () => {
    const { resources } = await client.listResources()

    expect(resources.map((r) => r.uri)).toContain('mongodb://collections')
  })

  it('returns the catalogue as JSON', async () => {
    const result = await client.readResource({ uri: 'mongodb://collections' })
    const first = result.contents[0]

    if (first === undefined || !('text' in first)) {
      expect.unreachable('expected a text resource')
    }

    const body = JSON.parse(String(first.text)) as unknown[]

    expect(body).toEqual([
      { database: 'demo', collection: 'orders' },
      { database: 'demo', collection: 'customers' }
    ])
  })

  it('offers a per-collection resource describing its queryable fields', async () => {
    const { resourceTemplates } = await client.listResourceTemplates()

    expect(resourceTemplates.map((t) => t.uriTemplate)).toContain(
      'mongodb://collection/{database}/{collection}'
    )
  })
})

describe('calling a tool', () => {
  it('runs the whole chain and returns the envelope', async () => {
    execute.mockClear()

    const result = await client.callTool({
      name: 'find',
      arguments: { database: 'demo', collection: 'orders', limit: 5 }
    })

    expect(payload(result).returned).toBe(1)
    expect(execute).toHaveBeenCalledOnce()
  })

  it('hands the driver a plan that is already scoped and projected', async () => {
    execute.mockClear()

    await client.callTool({
      name: 'find',
      arguments: {
        database: 'demo',
        collection: 'orders',
        filter: { status: 'paid' }
      }
    })

    const plan = execute.mock.calls[0]?.[0]

    if (plan === undefined) expect.unreachable('execute was not called')

    expect(plan.filter).toEqual({
      $and: [{ deleted: { $ne: true } }, { status: 'paid' }]
    })
    expect(plan.projection).toEqual({ _id: 1, number: 1, status: 1, total: 1 })
    expect(plan.maxTimeMS).toBeGreaterThan(0)
  })

  it('applies the schema defaults even when the caller omits everything', async () => {
    execute.mockClear()

    await client.callTool({
      name: 'find',
      arguments: { database: 'demo', collection: 'orders' }
    })

    expect(execute.mock.calls[0]?.[0]?.skip).toBe(0)
  })

  it('returns a refusal as a readable payload, not a protocol error', async () => {
    const result = await client.callTool({
      name: 'find',
      arguments: {
        database: 'demo',
        collection: 'orders',
        filter: { $where: 'true' }
      }
    })

    expect(result.isError).toBe(true)
    expect(String(payload(result).error)).toMatch(/JavaScript/)
  })

  it('tells the model where the problem is', async () => {
    const result = await client.callTool({
      name: 'find',
      arguments: { database: 'demo', collection: 'orders', sort: { status: 1 } }
    })

    expect(payload(result).path).toBeDefined()
  })

  it('never reaches the driver for a refused query', async () => {
    execute.mockClear()

    await client.callTool({
      name: 'aggregate',
      arguments: {
        database: 'demo',
        collection: 'orders',
        pipeline: [{ $out: 'stolen' }]
      }
    })

    expect(execute).not.toHaveBeenCalled()
  })

  it('refuses a collection that is not exposed', async () => {
    const result = await client.callTool({
      name: 'count',
      arguments: { database: 'demo', collection: 'audit_log' }
    })

    expect(result.isError).toBe(true)
  })
})
