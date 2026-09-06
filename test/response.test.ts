import { Decimal128, ObjectId } from 'bson'
import { describe, expect, it } from 'vitest'
import { createLogger } from './../src/logger.js'
import type { QueryResultType } from './../src/mongo.js'
import { ResponseRenderer } from './../src/response.js'
import {
  EnvSchema,
  type ExecutionPlanType,
  QueryExecutionError,
  QueryValidationError
} from './../src/types.js'

const makeEnv = (maxBytes: number) =>
  EnvSchema.parse({
    MONGODB_URI: 'mongodb://localhost:27017',
    MONGODB_ALLOWED_DATABASES: 'shop',
    MCP_MAX_RESPONSE_BYTES: String(maxBytes)
  })

const logger = createLogger({ level: 'silent' })

const findPlan: ExecutionPlanType = {
  operation: 'find',
  database: 'shop',
  collection: 'orders',
  filter: {},
  projection: { _id: 1 },
  sort: {},
  limit: 50,
  skip: 20,
  maxTimeMS: 10000
}

const renderer = new ResponseRenderer(makeEnv(1_000_000), logger)

const payload = (response: { content: { text: string }[] }) =>
  JSON.parse(response.content[0]?.text ?? '{}') as Record<string, unknown>

const documents = (
  docs: Record<string, unknown>[],
  hasMore = false
): QueryResultType => ({
  kind: 'documents',
  documents: docs,
  hasMore
})

describe('rendering documents', () => {
  it('wraps them in an envelope the model can page with', () => {
    const body = payload(
      renderer.render(documents([{ a: 1 }, { a: 2 }]), findPlan)
    )

    expect(body.returned).toBe(2)
    expect(body.hasMore).toBe(false)
    expect(body.nextSkip).toBe(22)
  })

  it('reports hasMore when the driver said there is another page', () => {
    const body = payload(
      renderer.render(documents([{ a: 1 }, { a: 2 }], true), findPlan)
    )

    expect(body.hasMore).toBe(true)
  })

  it('omits nextSkip for an aggregation, which cannot be resumed by skipping', () => {
    const body = payload(
      renderer.render(documents([{ a: 1 }]), {
        ...findPlan,
        operation: 'aggregate'
      })
    )

    expect(body).not.toHaveProperty('nextSkip')
  })

  it('renders BSON types as Extended JSON', () => {
    const body = payload(
      renderer.render(
        documents([
          {
            _id: new ObjectId('507f1f77bcf86cd799439011'),
            total: new Decimal128('11768.04'),
            at: new Date('2026-01-01T00:00:00Z')
          }
        ]),
        findPlan
      )
    )
    const first = (body.documents as Record<string, unknown>[])[0] ?? {}

    expect(first._id).toEqual({ $oid: '507f1f77bcf86cd799439011' })
    expect(first.total).toEqual({ $numberDecimal: '11768.04' })
  })
})

describe('the response budget', () => {
  const big = Array.from({ length: 200 }, (_, i) => ({
    i,
    padding: 'x'.repeat(200)
  }))

  it('cuts documents rather than characters, so the JSON stays valid', () => {
    const small = new ResponseRenderer(makeEnv(4000), logger)
    const response = small.render(documents(big), findPlan)

    expect(() => JSON.parse(response.content[0]?.text ?? '')).not.toThrow()
  })

  it('stays inside the budget', () => {
    const small = new ResponseRenderer(makeEnv(4000), logger)
    const text = small.render(documents(big), findPlan).content[0]?.text ?? ''

    expect(Buffer.byteLength(text, 'utf-8')).toBeLessThanOrEqual(4000)
  })

  it('says it truncated, and why', () => {
    const small = new ResponseRenderer(makeEnv(4000), logger)
    const body = payload(small.render(documents(big), findPlan))

    expect(body.truncated).toBe(true)
    expect(body.hasMore).toBe(true)
    expect(String(body.note)).toMatch(/fewer fields|projection/)
  })

  it('leaves a response that fits untouched', () => {
    const body = payload(renderer.render(documents(big), findPlan))

    expect(body.truncated).toBeUndefined()
    expect(body.returned).toBe(200)
  })

  it('explains itself when a single document is too large', () => {
    const huge = [{ blob: 'x'.repeat(50_000) }]
    const small = new ResponseRenderer(makeEnv(1000), logger)
    const body = payload(small.render(documents(huge), findPlan))

    expect(body.returned).toBe(0)
    expect(String(body.note)).toMatch(/single document/)
  })
})

describe('rendering counts and values', () => {
  it('renders a count as a count, not as one document', () => {
    const body = payload(
      renderer.render({ kind: 'count', count: 113 }, findPlan)
    )

    expect(body).toEqual({ count: 113 })
  })

  it('renders distinct values with their own envelope', () => {
    const body = payload(
      renderer.render(
        { kind: 'values', values: ['paid', 'shipped'], hasMore: false },
        findPlan
      )
    )

    expect(body.values).toEqual(['paid', 'shipped'])
    expect(body.returned).toBe(2)
  })
})

describe('rendering errors', () => {
  it('passes a validation error through, path included', () => {
    const response = renderer.error(
      new QueryValidationError('not filterable', 'filter')
    )

    expect(response.isError).toBe(true)
    expect(payload(response)).toEqual({
      error: 'not filterable',
      path: 'filter'
    })
  })

  it('reduces a driver error to its generic message', () => {
    const response = renderer.error(
      new QueryExecutionError(
        'Query execution failed',
        new Error('no primary at mongo-01.internal:27017')
      )
    )

    expect(payload(response)).toEqual({ error: 'Query execution failed' })
    expect(response.content[0]?.text).not.toContain('mongo-01')
  })

  it('says nothing useful about an error it did not expect', () => {
    const response = renderer.error(new TypeError('x is not a function'))

    expect(payload(response)).toEqual({ error: 'Unexpected server error' })
    expect(response.content[0]?.text).not.toContain('not a function')
  })

  it('marks every error response as an error', () => {
    for (const error of [
      new QueryValidationError('a'),
      new QueryExecutionError('b', new Error('c')),
      new Error('d')
    ]) {
      expect(renderer.error(error).isError).toBe(true)
    }
  })
})
