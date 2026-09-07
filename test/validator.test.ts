import { describe, expect, it } from 'vitest'
import { createLogger } from './../src/logger.js'
import {
  type ConfigType,
  QueryCommandSchema,
  QueryValidationError
} from './../src/types.js'
import { assertSafeDocument, QueryValidator } from './../src/validator.js'

const config: ConfigType = {
  version: 1,
  databases: {
    shop: {
      collections: {
        orders: {
          allowedFields: ['_id', 'total', 'status', 'items', 'customerId'],
          filterableFields: ['status', 'total', 'items'],
          sortableFields: ['total'],
          requiredFilter: {}
        },
        customers: {
          allowedFields: ['_id', 'name'],
          filterableFields: ['name'],
          sortableFields: [],
          requiredFilter: {}
        }
      }
    }
  }
}

const validator = new QueryValidator({
  allowedDatabases: ['shop'],
  config,
  logger: createLogger({ level: 'silent' })
})

const run = (input: unknown) =>
  validator.validate(QueryCommandSchema.parse(input))

const rejects = (input: unknown, expected: RegExp) =>
  expect(() => run(input)).toThrow(expected)

const find = (extra: Record<string, unknown> = {}) => ({
  operation: 'find',
  database: 'shop',
  collection: 'orders',
  ...extra
})

const aggregate = (pipeline: unknown[]) => ({
  operation: 'aggregate',
  database: 'shop',
  collection: 'orders',
  pipeline
})

describe('queries that should go through', () => {
  it('allows a find within the allowlists', () => {
    const command = run(
      find({
        filter: { status: 'paid' },
        projection: { _id: 1, total: 1 },
        sort: { total: -1 },
        limit: 20
      })
    )

    expect(command.operation).toBe('find')
  })

  it('allows a read-only pipeline', () => {
    expect(() =>
      run(
        aggregate([
          { $match: { status: 'paid' } },
          { $group: { _id: '$status', revenue: { $sum: '$total' } } },
          { $sort: { total: -1 } }
        ])
      )
    ).not.toThrow()
  })

  it('treats array positions as part of the parent path', () => {
    expect(() => run(find({ filter: { 'items.0.sku': 'abc' } }))).not.toThrow()
  })

  it('resolves $elemMatch keys relative to their field', () => {
    expect(() =>
      run(find({ filter: { items: { $elemMatch: { sku: 'abc' } } } }))
    ).not.toThrow()
  })

  it('allows _id exclusion but nothing else', () => {
    expect(() => run(find({ projection: { _id: 0, total: 1 } }))).not.toThrow()
  })
})

describe('server-side JavaScript', () => {
  it('refuses $where at the top level', () => {
    rejects(find({ filter: { $where: 'this.total > 0' } }), /JavaScript/)
  })

  it('refuses $where nested under $or', () => {
    rejects(
      find({ filter: { $or: [{ status: 'paid' }, { $where: 'true' }] } }),
      /JavaScript/
    )
  })

  it('refuses $function hidden inside $expr', () => {
    rejects(
      find({
        filter: {
          $expr: {
            $function: {
              body: 'function () { return true }',
              args: [],
              lang: 'js'
            }
          }
        }
      }),
      /JavaScript/
    )
  })

  it('refuses $accumulator inside $group', () => {
    rejects(
      aggregate([
        {
          $group: {
            _id: '$status',
            v: { $accumulator: { init: 'function () {}', lang: 'js' } }
          }
        }
      ]),
      /JavaScript/
    )
  })

  it('refuses $code, which Extended JSON would revive into a Code object', () => {
    rejects(find({ filter: { fn: { $code: 'function () {}' } } }), /JavaScript/)
  })
})

describe('write stages', () => {
  it('refuses $out at the end of a pipeline', () => {
    rejects(
      aggregate([{ $match: { status: 'paid' } }, { $out: 'stolen' }]),
      /writes its result/
    )
  })

  it('refuses $merge', () => {
    rejects(aggregate([{ $merge: { into: 'stolen' } }]), /writes its result/)
  })

  it('refuses $out buried inside a $facet branch', () => {
    rejects(
      aggregate([
        { $facet: { a: [{ $match: { status: 'paid' } }, { $out: 'stolen' }] } }
      ]),
      /writes its result/
    )
  })
})

describe('the collection allowlist', () => {
  it('refuses an unknown database', () => {
    rejects({ ...find(), database: 'admin' }, /is not allowed/)
  })

  it('refuses a collection missing from the config', () => {
    rejects({ ...find(), collection: 'secrets' }, /is not exposed/)
  })

  it('refuses a $lookup into a collection that is not exposed', () => {
    rejects(
      aggregate([
        {
          $lookup: {
            from: 'secrets',
            localField: '_id',
            foreignField: '_id',
            as: 'x'
          }
        }
      ]),
      /is not exposed/
    )
  })

  it('checks a $lookup sub-pipeline against the foreign collection rules', () => {
    rejects(
      aggregate([
        {
          $lookup: {
            from: 'customers',
            as: 'customer',
            pipeline: [{ $match: { total: { $gt: 0 } } }]
          }
        }
      ]),
      /not filterable/
    )
  })

  it('refuses a $unionWith shorthand into a hidden collection', () => {
    rejects(aggregate([{ $unionWith: 'secrets' }]), /is not exposed/)
  })
})

describe('the field allowlists', () => {
  it('refuses a filter on a readable but non-filterable field', () => {
    rejects(find({ filter: { customerId: 'c1' } }), /not filterable/)
  })

  it('refuses a sort on a non-sortable field', () => {
    rejects(find({ sort: { status: 1 } }), /not sortable/)
  })

  it('refuses a field reference smuggled through $expr', () => {
    rejects(
      find({ filter: { $expr: { $gt: ['$customerId', 0] } } }),
      /not filterable/
    )
  })

  it('refuses an exclusion projection', () => {
    rejects(find({ projection: { total: 0 } }), /Exclusion projections/)
  })

  it('refuses a computed projection over a hidden field', () => {
    rejects(
      aggregate([{ $project: { label: { $concat: ['$secretNote', '!'] } } }]),
      /not readable/
    )
  })

  it('refuses $$ROOT, which would return the whole document', () => {
    rejects(
      aggregate([{ $replaceRoot: { newRoot: '$$ROOT' } }]),
      /whole document/
    )
  })

  it('refuses distinct on a hidden field', () => {
    rejects(
      {
        operation: 'distinct',
        database: 'shop',
        collection: 'orders',
        field: 'secretNote'
      },
      /not readable/
    )
  })
})

describe('the stage allowlist and resource limits', () => {
  it('refuses an introspection stage', () => {
    rejects(aggregate([{ $collStats: {} }]), /is not allowed/)
  })

  it('refuses a stage document with more than one key', () => {
    rejects(aggregate([{ $match: {}, $limit: 1 }]), /exactly one field/)
  })

  it('refuses a pipeline longer than the configured maximum', () => {
    rejects(
      aggregate(Array.from({ length: 51 }, () => ({ $limit: 1 }))),
      /may not exceed/
    )
  })

  it('refuses a command nested past the depth limit', () => {
    let filter: Record<string, unknown> = { status: 'paid' }
    for (let i = 0; i < 30; i++) {
      filter = { $and: [filter] }
    }

    rejects(find({ filter }), /nesting exceeds/)
  })

  it('refuses prototype-polluting keys the schema lets through', () => {
    rejects(
      JSON.parse(
        '{"operation":"find","database":"shop","collection":"orders","filter":{"items":{"constructor":{"prototype":{"admin":true}}}}}'
      ),
      /not allowed in a command/
    )
  })

  it('drops __proto__ while parsing, without polluting anything', () => {
    const command = QueryCommandSchema.parse(
      JSON.parse(
        '{"operation":"find","database":"shop","collection":"orders","filter":{"__proto__":{"admin":true}}}'
      )
    ) as { filter: Record<string, unknown> }

    expect(Object.keys(command.filter)).toEqual([])
    expect(({} as Record<string, unknown>).admin).toBeUndefined()
  })
})

describe('the operation allowlist', () => {
  it('rejects an unknown operation before the validator sees it', () => {
    expect(() =>
      QueryCommandSchema.parse({ ...find(), operation: 'drop' })
    ).toThrow()
  })

  it('refuses a write operation when writes are disabled', () => {
    expect(() =>
      validator.validate({ ...find(), operation: 'insertOne' } as never)
    ).toThrow(/Write operations are disabled/)
  })
})

describe('assertSafeDocument on its own', () => {
  it('accepts an ordinary filter', () => {
    expect(() => assertSafeDocument({ deleted: { $ne: true } })).not.toThrow()
  })

  it('refuses server-side JavaScript', () => {
    expect(() => assertSafeDocument({ $where: 'true' })).toThrow(
      QueryValidationError
    )
  })

  it('refuses a write stage', () => {
    expect(() => assertSafeDocument({ $out: 'stolen' })).toThrow(/writes/)
  })

  it('reports where the problem is', () => {
    try {
      assertSafeDocument({ a: { b: { $where: 'true' } } })
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as QueryValidationError).path).toBe('a.b.$where')
    }
  })

  it('honours a custom depth limit', () => {
    let value: Record<string, unknown> = { a: 1 }
    for (let i = 0; i < 5; i++) value = { nested: value }

    expect(() => assertSafeDocument(value, '', 3)).toThrow(/nesting exceeds/)
    expect(() => assertSafeDocument(value, '', 50)).not.toThrow()
  })
})
