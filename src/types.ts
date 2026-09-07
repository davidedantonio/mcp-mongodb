import { z } from 'zod'

const positiveInteger = z.coerce.number().int().positive()
const fieldList = z.array(z.string().trim().min(1))

// Define the environment variable schema using Zod
export const EnvSchema = z
  .object({
    // MongoDB configuration environment variables
    MONGODB_URI: z.string().regex(/^mongodb(?:\+srv)?:\/\/\S+$/),
    MONGODB_ALLOWED_DATABASES: z
      .string()
      .transform((value) =>
        value.split(',').map((dbName: string) => dbName.trim())
      )
      .pipe(z.array(z.string().min(1)).min(1))
      .transform((dbNames) => [...new Set(dbNames)]),
    MONGODB_CONNECT_TIMEOUT_MS: positiveInteger.default(5000),
    MONGODB_QUERY_TIMEOUT_MS: positiveInteger.default(10000),

    // MCP configuration environment variables
    MCP_TRANSPORT: z.enum(['stdio', 'http']).default('stdio'),
    MCP_DEFAULT_PAGE_SIZE: positiveInteger.default(50),
    MCP_MAX_PAGE_SIZE: positiveInteger.default(200),
    MCP_MAX_RESPONSE_BYTES: positiveInteger.default(10485760),
    MCP_CONFIG_PATH: z.string().trim().min(1).optional(),

    MCP_HTTP_PORT: positiveInteger.default(3000),
    MCP_HTTP_AUTH_TOKEN: z.string().min(32).optional(),
    MCP_HTTP_ALLOWED_HOSTS: z
      .string()
      .transform((value) => value.split(',').map((host) => host.trim()))
      .pipe(z.array(z.string().min(1)).min(1))
      .optional(),
    MCP_HTTP_MAX_BODY_BYTES: positiveInteger.default(1048576),
    // Log level
    LOG_LEVEL: z
      .enum(['debug', 'info', 'warn', 'error', 'silent'])
      .default('info')
  })
  .refine(
    (env) => env.MONGODB_CONNECT_TIMEOUT_MS < env.MONGODB_QUERY_TIMEOUT_MS,
    {
      message:
        'MONGODB_CONNECT_TIMEOUT_MS must be less than MONGODB_QUERY_TIMEOUT_MS'
    }
  )
  .refine((env) => env.MCP_DEFAULT_PAGE_SIZE <= env.MCP_MAX_PAGE_SIZE, {
    message:
      'MCP_DEFAULT_PAGE_SIZE must be less than or equal to MCP_MAX_PAGE_SIZE'
  })

// Define the collection schema using Zod
const CollectionSchema = z
  .strictObject({
    allowedFields: fieldList.min(1),
    filterableFields: fieldList.default([]),
    sortableFields: fieldList.default([]),
    requiredFilter: z.record(z.string().min(1), z.json()).default({})
  })
  .superRefine((collection, ctx) => {
    for (const key of ['filterableFields', 'sortableFields'] as const) {
      for (const field of collection[key]) {
        if (!collection.allowedFields.includes(field)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `${key} contains a field that is not in allowedFields: ${field}`
          })
        }
      }
    }
  })

// Define the configuration schema using Zod
export const ConfigSchema = z.strictObject({
  version: z.literal(1),
  databases: z.record(
    z.string().min(1),
    z.strictObject({
      collections: z.record(z.string().min(1), CollectionSchema)
    })
  )
})

export type EnvType = z.infer<typeof EnvSchema>
export type ConfigType = z.infer<typeof ConfigSchema>

/**
 * Raised when a command is refused. `path` points at the offending spot
 * inside the command (e.g. `pipeline[2].$lookup.from`) so the caller can
 * tell the model what to fix without leaking the rest of the query.
 */
export class QueryValidationError extends Error {
  readonly path: string | undefined

  constructor(message: string, path?: string) {
    super(message)
    this.name = 'QueryValidationError'
    this.path = path
  }
}

const queryDocument = z.record(z.string(), z.unknown())

const sortDocument = z.record(
  z.string().trim().min(1),
  z.union([z.literal(1), z.literal(-1)])
)

const target = {
  database: z
    .string()
    .trim()
    .min(1)
    .describe('The name of the database to query'),
  collection: z
    .string()
    .trim()
    .min(1)
    .describe('The name of the collection to query')
}

export const FindCommandSchema = z.strictObject({
  ...target,
  operation: z.literal('find'),
  filter: queryDocument.default({}).describe('The query filter to apply'),
  projection: queryDocument
    .optional()
    .describe('The fields to include or exclude'),
  sort: sortDocument.optional().describe('The sort order for the results'),
  limit: positiveInteger
    .optional()
    .describe('The maximum number of documents to return'),
  skip: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(0)
    .describe('The number of documents to skip')
})

export const AggregateCommandSchema = z.strictObject({
  ...target,
  operation: z.literal('aggregate'),
  pipeline: z
    .array(queryDocument)
    .min(1)
    .describe('The aggregation pipeline to execute')
})

export const CountCommandSchema = z.strictObject({
  ...target,
  operation: z.literal('countDocuments'),
  filter: queryDocument.default({}).describe('The query filter to apply')
})

export const DistinctCommandSchema = z.strictObject({
  ...target,
  operation: z.literal('distinct'),
  field: z
    .string()
    .trim()
    .min(1)
    .describe('The field for which to return distinct values'),
  filter: queryDocument.default({}).describe('The query filter to apply')
})

export const QueryCommandSchema = z.discriminatedUnion('operation', [
  FindCommandSchema,
  AggregateCommandSchema,
  CountCommandSchema,
  DistinctCommandSchema
])

export type QueryCommandType = z.infer<typeof QueryCommandSchema>
export type CollectionRulesType = z.infer<typeof CollectionSchema>

export interface ExecutionPlanType {
  operation: QueryCommandType['operation']
  database: string
  collection: string
  filter: Record<string, unknown>
  projection: Record<string, 1 | 0>
  sort: Record<string, 1 | -1>
  limit: number
  skip: number
  maxTimeMS: number
  pipeline?: Record<string, unknown>[]
  field?: string
}

export class QueryExecutionError extends Error {
  readonly cause: unknown

  constructor(message: string, cause: unknown) {
    super(message)
    this.name = 'QueryExecutionError'
    this.cause = cause
  }
}
