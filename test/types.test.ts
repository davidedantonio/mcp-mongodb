import { describe, expect, it } from 'vitest'
import {
  ConfigSchema,
  EnvSchema,
  QueryCommandSchema,
  QueryExecutionError,
  QueryValidationError
} from './../src/types.js'

const minimalEnv = {
  MONGODB_URI: 'mongodb://localhost:27017',
  MONGODB_ALLOWED_DATABASES: 'demo'
}

describe('EnvSchema', () => {
  it('fills in the documented defaults', () => {
    const env = EnvSchema.parse(minimalEnv)

    expect(env.MCP_TRANSPORT).toBe('stdio')
    expect(env.MCP_DEFAULT_PAGE_SIZE).toBe(50)
    expect(env.MCP_MAX_PAGE_SIZE).toBe(200)
    expect(env.LOG_LEVEL).toBe('info')
    expect(env.MONGODB_CONNECT_TIMEOUT_MS).toBe(5000)
  })

  it('splits, trims and deduplicates the database allowlist', () => {
    const env = EnvSchema.parse({
      ...minimalEnv,
      MONGODB_ALLOWED_DATABASES: ' demo , other,demo '
    })

    expect(env.MONGODB_ALLOWED_DATABASES).toEqual(['demo', 'other'])
  })

  it('rejects a URI that is not a MongoDB connection string', () => {
    expect(() =>
      EnvSchema.parse({ ...minimalEnv, MONGODB_URI: 'postgres://localhost' })
    ).toThrow()
  })

  it('accepts mongodb+srv', () => {
    expect(() =>
      EnvSchema.parse({ ...minimalEnv, MONGODB_URI: 'mongodb+srv://host/db' })
    ).not.toThrow()
  })

  it('refuses a connect timeout that is not shorter than the query timeout', () => {
    expect(() =>
      EnvSchema.parse({
        ...minimalEnv,
        MONGODB_CONNECT_TIMEOUT_MS: '10000',
        MONGODB_QUERY_TIMEOUT_MS: '10000'
      })
    ).toThrow()
  })

  it('refuses a default page size above the maximum', () => {
    expect(() =>
      EnvSchema.parse({
        ...minimalEnv,
        MCP_DEFAULT_PAGE_SIZE: '500',
        MCP_MAX_PAGE_SIZE: '200'
      })
    ).toThrow()
  })

  it('refuses an HTTP token shorter than 32 characters', () => {
    expect(() =>
      EnvSchema.parse({ ...minimalEnv, MCP_HTTP_AUTH_TOKEN: 'too-short' })
    ).toThrow()
  })
})

describe('ConfigSchema', () => {
  const collection = {
    allowedFields: ['_id', 'name', 'total'],
    filterableFields: ['name'],
    sortableFields: ['total'],
    requiredFilter: { deleted: { $ne: true } }
  }

  const wrap = (rules: unknown) => ({
    version: 1,
    databases: { demo: { collections: { orders: rules } } }
  })

  it('accepts a well-formed config', () => {
    expect(() => ConfigSchema.parse(wrap(collection))).not.toThrow()
  })

  it('defaults the three optional rule lists', () => {
    const config = ConfigSchema.parse(wrap({ allowedFields: ['_id'] }))
    const rules = config.databases.demo?.collections.orders

    expect(rules?.filterableFields).toEqual([])
    expect(rules?.sortableFields).toEqual([])
    expect(rules?.requiredFilter).toEqual({})
  })

  it('refuses a filterable field that is not readable', () => {
    expect(() =>
      ConfigSchema.parse(wrap({ ...collection, filterableFields: ['secret'] }))
    ).toThrow(/allowedFields/)
  })

  it('refuses a sortable field that is not readable', () => {
    expect(() =>
      ConfigSchema.parse(wrap({ ...collection, sortableFields: ['secret'] }))
    ).toThrow(/allowedFields/)
  })

  it('refuses an empty allowedFields', () => {
    expect(() => ConfigSchema.parse(wrap({ allowedFields: [] }))).toThrow()
  })

  it('refuses an unknown key, so a misspelt rule cannot pass unnoticed', () => {
    expect(() =>
      ConfigSchema.parse(wrap({ ...collection, allowedField: ['oops'] }))
    ).toThrow()
  })

  it('refuses a version it does not understand', () => {
    expect(() => ConfigSchema.parse({ version: 2, databases: {} })).toThrow()
  })
})

describe('QueryCommandSchema', () => {
  const target = { database: 'demo', collection: 'orders' }

  it('applies the find defaults', () => {
    const command = QueryCommandSchema.parse({ ...target, operation: 'find' })

    expect(command).toMatchObject({ operation: 'find', filter: {}, skip: 0 })
  })

  it('leaves sort, limit and projection absent when not given', () => {
    const command = QueryCommandSchema.parse({ ...target, operation: 'find' })

    expect(command).not.toHaveProperty('sort')
    expect(command).not.toHaveProperty('limit')
    expect(command).not.toHaveProperty('projection')
  })

  it('only accepts 1 and -1 as sort directions', () => {
    expect(() =>
      QueryCommandSchema.parse({
        ...target,
        operation: 'find',
        sort: { total: 2 }
      })
    ).toThrow()
  })

  it('refuses an operation outside the closed set', () => {
    expect(() =>
      QueryCommandSchema.parse({ ...target, operation: 'insertOne' })
    ).toThrow()
  })

  it('refuses unknown keys on a command', () => {
    expect(() =>
      QueryCommandSchema.parse({ ...target, operation: 'find', dropMe: true })
    ).toThrow()
  })

  it('requires at least one stage in a pipeline', () => {
    expect(() =>
      QueryCommandSchema.parse({
        ...target,
        operation: 'aggregate',
        pipeline: []
      })
    ).toThrow()
  })

  it('requires a field for distinct', () => {
    expect(() =>
      QueryCommandSchema.parse({ ...target, operation: 'distinct' })
    ).toThrow()
  })
})

describe('error types', () => {
  it('carries the path that identifies the offending part of a command', () => {
    const error = new QueryValidationError('nope', 'pipeline[2].$lookup.from')

    expect(error.name).toBe('QueryValidationError')
    expect(error.path).toBe('pipeline[2].$lookup.from')
    expect(error).toBeInstanceOf(Error)
  })

  it('keeps a validation error path optional', () => {
    expect(new QueryValidationError('nope').path).toBeUndefined()
  })

  it('keeps the driver error out of the message it exposes', () => {
    const cause = new Error('connection refused to mongo-01.internal:27017')
    const error = new QueryExecutionError('Query execution failed', cause)

    expect(error.message).toBe('Query execution failed')
    expect(error.message).not.toContain('mongo-01')
    expect(error.cause).toBe(cause)
  })
})
