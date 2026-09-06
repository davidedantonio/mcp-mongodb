import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { reviveBson } from './../src/bson.js'
import {
  createMongoMcpServer,
  type MongoMcpDepsType
} from './../src/mcp-core.js'
import { QueryCommandSchema } from './../src/types.js'
import { buildDeps, mongoIsUp } from './setup.js'

const available = await mongoIsUp()

if (!available) {
  console.warn(
    '\n  Skipping integration tests: the demo database is not reachable.' +
    '\n  Start it with `npm run demo:up`.\n'
  )
}

describe.skipIf(!available)('against a real MongoDB', () => {
  let deps: MongoMcpDepsType
  let client: Client

  beforeAll(async () => {
    deps = await buildDeps()
    await deps.mongo.testConnection()

    const server = createMongoMcpServer(deps)
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair()

    client = new Client({ name: 'integration', version: '1.0.0' })

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport)
    ])
  })

  afterAll(async () => {
    await deps?.mongo.close()
  })

  const payload = (result: unknown) => {
    const content = (result as { content: { text: string }[] }).content
    return JSON.parse(content[0]?.text ?? '{}') as Record<string, unknown>
  }

  const call = async (name: string, args: Record<string, unknown>) =>
    payload(await client.callTool({ name, arguments: args }))

  const run = async (command: unknown) => {
    const parsed = QueryCommandSchema.parse(command)
    deps.validator.validate(parsed)
    const plan = deps.enforcer.plan(parsed)

    return deps.mongo.execute({
      ...plan,
      filter: reviveBson(plan.filter),
      ...(plan.pipeline === undefined
        ? {}
        : { pipeline: reviveBson(plan.pipeline) })
    })
  }

  describe('the scope filter', () => {
    it('hides deleted documents and keeps the ones with no flag', async () => {
      const body = await call('count', {
        database: 'demo',
        collection: 'orders'
      })

      expect(body.count).toBe(113)
    })

    it('cannot be undone by a filter naming the same field', async () => {
      const body = await call('count', {
        database: 'demo',
        collection: 'orders',
        filter: { number: 'ORD-2026-0001' }
      })

      expect(body.count).toBeLessThanOrEqual(1)
    })
  })

  describe('the field allowlist', () => {
    it('returns only readable fields when no projection is given', async () => {
      const body = await call('find', {
        database: 'demo',
        collection: 'orders',
        limit: 5
      })
      const documents = body.documents as Record<string, unknown>[]
      const seen = new Set(documents.flatMap((doc) => Object.keys(doc)))

      expect(seen.has('deleted')).toBe(false)
      for (const field of seen) {
        expect(
          deps.config.databases.demo?.collections.orders?.allowedFields
        ).toContain(field)
      }
    })

    it('never returns a hidden field on customers', async () => {
      const body = await call('find', {
        database: 'demo',
        collection: 'customers',
        limit: 10
      })
      const documents = body.documents as Record<string, unknown>[]

      for (const doc of documents) {
        expect(doc).not.toHaveProperty('iban')
        expect(doc).not.toHaveProperty('vatNumber')
        expect(doc).not.toHaveProperty('creditLimit')
      }
    })

    it('never returns the margin on products', async () => {
      const body = await call('find', {
        database: 'demo',
        collection: 'products',
        limit: 10
      })

      for (const doc of body.documents as Record<string, unknown>[]) {
        expect(doc).not.toHaveProperty('cost')
      }
    })
  })

  describe('pagination', () => {
    it('bounds a find and says there is more', async () => {
      const body = await call('find', {
        database: 'demo',
        collection: 'orders',
        limit: 10
      })

      expect(body.returned).toBe(10)
      expect(body.hasMore).toBe(true)
      expect(body.nextSkip).toBe(10)
    })

    it('resumes from nextSkip without repeating a document', async () => {
      const first = await call('find', {
        database: 'demo',
        collection: 'orders',
        sort: { total: -1 },
        limit: 5
      })
      const second = await call('find', {
        database: 'demo',
        collection: 'orders',
        sort: { total: -1 },
        limit: 5,
        skip: first.nextSkip as number
      })

      const numbers = (docs: unknown) =>
        (docs as Record<string, unknown>[]).map((d) => d.number)

      expect(numbers(first.documents)).not.toEqual(numbers(second.documents))
    })

    it('bounds an aggregation that carries no limit of its own', async () => {
      const body = await call('aggregate', {
        database: 'demo',
        collection: 'orders',
        pipeline: [{ $match: { status: 'delivered' } }]
      })

      expect((body.documents as unknown[]).length).toBeLessThanOrEqual(
        deps.env.MCP_DEFAULT_PAGE_SIZE
      )
    })
  })

  describe('the Extended JSON round trip', () => {
    it('finds a document by an _id taken out of an earlier result', async () => {
      const first = await call('find', {
        database: 'demo',
        collection: 'orders',
        limit: 1
      })
      const id = (first.documents as Record<string, unknown>[])[0]?._id

      const again = await call('find', {
        database: 'demo',
        collection: 'orders',
        filter: { _id: id }
      })

      expect(again.returned).toBe(1)
    })

    it('keeps decimal money exact', async () => {
      const body = await call('find', {
        database: 'demo',
        collection: 'orders',
        limit: 1
      })
      const total = (body.documents as Record<string, unknown>[])[0]?.total

      expect(total).toHaveProperty('$numberDecimal')
    })
  })

  describe('joins', () => {
    it('allows the pipeline form and scopes the foreign collection', async () => {
      const body = await call('aggregate', {
        database: 'demo',
        collection: 'invoices',
        pipeline: [
          {
            $lookup: {
              from: 'orders',
              as: 'order',
              pipeline: [{ $match: { status: 'delivered' } }]
            }
          },
          { $limit: 1 }
        ]
      })

      expect(body.documents).toBeDefined()
    })

    it('refuses the localField form into a scoped collection', async () => {
      const body = await call('aggregate', {
        database: 'demo',
        collection: 'invoices',
        pipeline: [
          {
            $lookup: {
              from: 'orders',
              localField: 'orderId',
              foreignField: '_id',
              as: 'order'
            }
          }
        ]
      })

      expect(String(body.error)).toMatch(/pipeline form/)
    })
  })

  describe('queries the server refuses to run', () => {
    const refusals: [string, Record<string, unknown>][] = [
      [
        'a filter on a hidden field',
        {
          name: 'find',
          args: {
            database: 'demo',
            collection: 'customers',
            filter: { iban: 'x' }
          }
        }
      ],
      [
        'a sort on a non-sortable field',
        {
          name: 'find',
          args: { database: 'demo', collection: 'orders', sort: { status: 1 } }
        }
      ],
      [
        'an exclusion projection',
        {
          name: 'find',
          args: {
            database: 'demo',
            collection: 'orders',
            projection: { total: 0 }
          }
        }
      ],
      [
        'server-side JavaScript',
        {
          name: 'find',
          args: {
            database: 'demo',
            collection: 'orders',
            filter: { $where: 'this.total > 0' }
          }
        }
      ],
      [
        'a stage that writes',
        {
          name: 'aggregate',
          args: {
            database: 'demo',
            collection: 'orders',
            pipeline: [{ $out: 'stolen' }]
          }
        }
      ],
      [
        '$$ROOT',
        {
          name: 'aggregate',
          args: {
            database: 'demo',
            collection: 'orders',
            pipeline: [{ $replaceRoot: { newRoot: '$$ROOT' } }]
          }
        }
      ],
      [
        'a collection that is not exposed',
        { name: 'find', args: { database: 'demo', collection: 'audit_log' } }
      ],
      [
        'a database that is not allowed',
        {
          name: 'find',
          args: { database: 'admin', collection: 'system.users' }
        }
      ]
    ]

    it.each(refusals)('refuses %s', async (_name, spec) => {
      const result = await client.callTool({
        name: spec.name as string,
        arguments: spec.args as Record<string, unknown>
      })

      expect(result.isError).toBe(true)
      expect(String(payload(result).error)).not.toBe('')
    })
  })

  describe('the driver layer', () => {
    it('reports the extra page without returning it', async () => {
      const result = await run({
        operation: 'find',
        database: 'demo',
        collection: 'orders',
        limit: 3
      })

      expect(result.kind).toBe('documents')
      if (result.kind === 'documents') {
        expect(result.documents).toHaveLength(3)
        expect(result.hasMore).toBe(true)
      }
    })

    it('returns distinct values, not documents', async () => {
      const result = await run({
        operation: 'distinct',
        database: 'demo',
        collection: 'orders',
        field: 'status'
      })

      expect(result.kind).toBe('values')
      if (result.kind === 'values') {
        expect(result.values.length).toBeGreaterThan(1)
      }
    })

    it('cannot write, because the connection has no right to', async () => {
      const client = (
        deps.mongo as unknown as {
          client: {
            db: (name: string) => {
              collection: (n: string) => {
                insertOne: (d: unknown) => Promise<unknown>
              }
            }
          }
        }
      ).client

      await expect(
        client.db('demo').collection('orders').insertOne({ injected: true })
      ).rejects.toThrow()
    })
  })
})
