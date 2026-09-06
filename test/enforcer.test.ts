import { describe, expect, it } from 'vitest'
import { QueryEnforcer } from './../src/enforcer.js'
import { createLogger } from './../src/logger.js'
import {
  type ConfigType,
  EnvSchema,
  type ExecutionPlanType,
  QueryCommandSchema
} from './../src/types.js'

const config: ConfigType = {
  version: 1,
  databases: {
    shop: {
      collections: {
        orders: {
          allowedFields: ['_id', 'number', 'status', 'total'],
          filterableFields: ['number', 'status'],
          sortableFields: ['total'],
          requiredFilter: { deleted: { $ne: true } }
        },
        events: {
          allowedFields: ['kind', 'at'],
          filterableFields: ['kind'],
          sortableFields: ['at'],
          requiredFilter: {}
        }
      }
    }
  }
}

const env = EnvSchema.parse({
  MONGODB_URI: 'mongodb://localhost:27017',
  MONGODB_ALLOWED_DATABASES: 'shop',
  MCP_DEFAULT_PAGE_SIZE: '50',
  MCP_MAX_PAGE_SIZE: '200',
  MONGODB_QUERY_TIMEOUT_MS: '10000'
})

const enforcer = new QueryEnforcer({
  config,
  env,
  logger: createLogger({ level: 'silent' })
})

const plan = (input: unknown): ExecutionPlanType =>
  enforcer.plan(QueryCommandSchema.parse(input))

const find = (extra: Record<string, unknown> = {}) => ({
  operation: 'find',
  database: 'shop',
  collection: 'orders',
  ...extra
})

const aggregate = (pipeline: unknown[], collection = 'orders') => ({
  operation: 'aggregate',
  database: 'shop',
  collection,
  pipeline
})

describe('the required filter', () => {
  it('is imposed on a query that carries no filter of its own', () => {
    expect(plan(find()).filter).toEqual({ deleted: { $ne: true } })
  })

  it('is combined with $and, never merged', () => {
    const result = plan(find({ filter: { status: 'paid' } }))

    expect(result.filter).toEqual({
      $and: [{ deleted: { $ne: true } }, { status: 'paid' }]
    })
  })

  it('cannot be overridden by a filter naming the same field', () => {
    const result = plan(find({ filter: { deleted: true } }))
    const clauses = result.filter.$and as Record<string, unknown>[]

    expect(clauses).toHaveLength(2)
    expect(clauses[0]).toEqual({ deleted: { $ne: true } })
    expect(clauses[1]).toEqual({ deleted: true })
  })

  it('is left out entirely for a collection with no scope', () => {
    const result = plan({
      operation: 'find',
      database: 'shop',
      collection: 'events'
    })

    expect(result.filter).toEqual({})
  })

  it('applies to count and distinct as well as find', () => {
    const counted = plan({
      operation: 'countDocuments',
      database: 'shop',
      collection: 'orders'
    })
    const distinct = plan({
      operation: 'distinct',
      database: 'shop',
      collection: 'orders',
      field: 'status'
    })

    expect(counted.filter).toEqual({ deleted: { $ne: true } })
    expect(distinct.filter).toEqual({ deleted: { $ne: true } })
    expect(distinct.field).toBe('status')
  })
})

describe('the projection', () => {
  it('is built from allowedFields when none is asked for', () => {
    expect(plan(find()).projection).toEqual({
      _id: 1,
      number: 1,
      status: 1,
      total: 1
    })
  })

  it('narrows to what was asked for, within what is allowed', () => {
    expect(plan(find({ projection: { number: 1 } })).projection).toEqual({
      number: 1
    })
  })

  it('excludes _id when _id is not readable', () => {
    const result = plan({
      operation: 'find',
      database: 'shop',
      collection: 'events'
    })

    expect(result.projection).toEqual({ kind: 1, at: 1, _id: 0 })
  })

  it('honours an explicit _id exclusion', () => {
    expect(plan(find({ projection: { _id: 0, total: 1 } })).projection).toEqual(
      {
        total: 1,
        _id: 0
      }
    )
  })

  it('falls back to every readable field when only _id is excluded', () => {
    const result = plan(find({ projection: { _id: 0 } }))
    expect(result.projection).toMatchObject({ number: 1, status: 1, total: 1 })
  })
})

describe('limits and deadlines', () => {
  it('applies the default page size when none is asked for', () => {
    expect(plan(find()).limit).toBe(50)
  })

  it('honours a smaller limit', () => {
    expect(plan(find({ limit: 10 })).limit).toBe(10)
  })

  it('clamps a limit above the maximum', () => {
    expect(plan(find({ limit: 100000 })).limit).toBe(200)
  })

  it('bounds count and distinct too', () => {
    expect(
      plan({
        operation: 'countDocuments',
        database: 'shop',
        collection: 'orders'
      }).limit
    ).toBeLessThanOrEqual(env.MCP_DEFAULT_PAGE_SIZE)
  })

  it('always attaches a deadline', () => {
    expect(plan(find()).maxTimeMS).toBe(10000)
  })

  it('defaults skip to zero', () => {
    expect(plan(find()).skip).toBe(0)
  })
})

describe('pipelines', () => {
  it('puts the scope $match before the $project', () => {
    const stages = plan(aggregate([{ $match: { status: 'paid' } }])).pipeline

    expect(stages?.[0]).toEqual({ $match: { deleted: { $ne: true } } })
    expect(Object.keys(stages?.[1] ?? {})).toEqual(['$project'])
  })

  it('strips at the entrance rather than the exit', () => {
    const stages = plan(
      aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }])
    ).pipeline
    const last = stages?.[stages.length - 1] ?? {}

    expect(Object.keys(last)).toEqual(['$limit'])
  })

  it('bounds an aggregation that carries no limit of its own', () => {
    const result = plan(aggregate([{ $match: { status: 'paid' } }]))
    const last = result.pipeline?.[result.pipeline.length - 1]

    expect(last).toEqual({ $limit: result.limit + 1 })
  })

  it('leaves the user stages in order between the prefix and the limit', () => {
    const stages = plan(
      aggregate([{ $match: { status: 'paid' } }, { $sort: { total: -1 } }])
    ).pipeline

    expect(stages?.[2]).toEqual({ $match: { status: 'paid' } })
    expect(stages?.[3]).toEqual({ $sort: { total: -1 } })
  })

  it('refuses a pipeline whose first stage must stay first', () => {
    expect(() => plan(aggregate([{ $geoNear: { near: [0, 0] } }]))).toThrow(
      /first stage/
    )
    expect(() => plan(aggregate([{ $documents: [{ a: 1 }] }]))).toThrow(
      /first stage/
    )
  })
})

describe('joins', () => {
  it('injects the foreign collection scope into a $lookup sub-pipeline', () => {
    const stages = plan(
      aggregate(
        [
          {
            $lookup: {
              from: 'orders',
              as: 'order',
              pipeline: [{ $match: { status: 'paid' } }]
            }
          }
        ],
        'events'
      )
    ).pipeline

    const lookup = stages?.find((stage) => '$lookup' in stage)?.$lookup as {
      pipeline: Record<string, unknown>[]
    }

    expect(lookup.pipeline[0]).toEqual({ $match: { deleted: { $ne: true } } })
    expect(lookup.pipeline[1]).toEqual({ $match: { status: 'paid' } })
  })

  it('refuses the localField form when the foreign collection is scoped', () => {
    expect(() =>
      plan(
        aggregate(
          [
            {
              $lookup: {
                from: 'orders',
                localField: 'a',
                foreignField: 'b',
                as: 'order'
              }
            }
          ],
          'events'
        )
      )
    ).toThrow(/pipeline form/)
  })

  it('allows the localField form when the foreign collection is not scoped', () => {
    expect(() =>
      plan(
        aggregate([
          {
            $lookup: {
              from: 'events',
              localField: 'a',
              foreignField: 'b',
              as: 'e'
            }
          }
        ])
      )
    ).not.toThrow()
  })

  it('refuses $graphLookup into a scoped collection, which cannot be filtered', () => {
    expect(() =>
      plan(
        aggregate(
          [
            {
              $graphLookup: {
                from: 'orders',
                startWith: '$a',
                connectFromField: 'a',
                connectToField: 'b',
                as: 'g'
              }
            }
          ],
          'events'
        )
      )
    ).toThrow(/graphLookup/i)
  })

  it('rewrites the $unionWith shorthand so the scope has somewhere to go', () => {
    const stages = plan(
      aggregate([{ $unionWith: 'orders' }], 'events')
    ).pipeline
    const union = stages?.find((stage) => '$unionWith' in stage)
      ?.$unionWith as { coll: string; pipeline: Record<string, unknown>[] }

    expect(union.coll).toBe('orders')
    expect(union.pipeline[0]).toEqual({ $match: { deleted: { $ne: true } } })
  })

  it('reaches joins nested inside a $facet branch', () => {
    expect(() =>
      plan(
        aggregate(
          [
            {
              $facet: {
                a: [
                  {
                    $lookup: {
                      from: 'orders',
                      localField: 'x',
                      foreignField: 'y',
                      as: 'o'
                    }
                  }
                ]
              }
            }
          ],
          'events'
        )
      )
    ).toThrow(/pipeline form/)
  })
})

describe('the collection allowlist', () => {
  it('refuses to plan for a collection that is not exposed', () => {
    expect(() =>
      plan({ operation: 'find', database: 'shop', collection: 'secrets' })
    ).toThrow(/secrets/)
  })
})
