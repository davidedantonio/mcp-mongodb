import {
  McpServer,
  ResourceTemplate
} from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Logger } from 'pino'
import { reviveBson } from './bson.js'
import type { QueryEnforcer } from './enforcer.js'
import type { MongoConnection } from './mongo.js'
import type { McpTextResponseType, ResponseRenderer } from './response.js'
import {
  AggregateCommandSchema,
  type ConfigType,
  CountCommandSchema,
  DistinctCommandSchema,
  type EnvType,
  FindCommandSchema,
  type QueryCommandType
} from './types.js'
import type { QueryValidator } from './validator.js'

export interface MongoMcpDepsType {
  env: EnvType
  config: ConfigType
  logger: Logger
  mongo: MongoConnection
  validator: QueryValidator
  enforcer: QueryEnforcer
  renderer: ResponseRenderer
}

interface CollectionEntryType {
  database: string
  collection: string
}

export function createMongoMcpServer(deps: MongoMcpDepsType): McpServer {
  const server = new McpServer({
    name: 'mongodb-mcp-server',
    version: '1.0.0'
  })

  registerQuerytTools(server, deps)
  registerSchemaResources(server, deps)

  deps.logger.info(
    { collections: listCollections(deps.config).length },
    'MCP server configured'
  )

  return server
}

function registerSchemaResources(
  server: McpServer,
  deps: MongoMcpDepsType
): void {
  server.registerResource(
    'collections',
    'mongodb://collections',
    {
      title: 'Exposed collections',
      description: 'Every database and collection this server exposes.',
      mimeType: 'application/json'
    },
    async (uri) => {
      const collections = listCollections(deps.config)

      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify(collections)
          }
        ]
      }
    }
  )

  server.registerResource(
    'collection',
    new ResourceTemplate('mongodb://collection/{database}/{collection}', {
      list: async () => ({
        resources: listCollections(deps.config).map((entry) => ({
          uri: `mongodb://collection/${encodeURIComponent(entry.database)}/${encodeURIComponent(entry.collection)}`,
          name: `${entry.database}.${entry.collection}`,
          description: `Queryable fields for ${entry.database}.${entry.collection}`,
          mimeType: 'application/json'
        }))
      })
    }),
    {
      title: 'Collection fields',
      description:
        'Which fields of a collection can be read, filtered and sorted.',
      mimeType: 'application/json'
    },
    async (uri, variables) => {
      const database = String(variables.database ?? '')
      const collection = String(variables.collection ?? '')
      const rules = deps.config.databases[database]?.collections[collection]

      const body =
        rules === undefined
          ? { error: `${database}.${collection} is not exposed` }
          : {
            database,
            collection,
            readableFields: rules.allowedFields,
            filterableFields: rules.filterableFields,
            sortableFields: rules.sortableFields,
            scoped: Object.keys(rules.requiredFilter).length > 0
          }

      return {
        contents: [{ uri: uri.href, text: JSON.stringify(body, null, 2) }]
      }
    }
  )
}

function registerQuerytTools(server: McpServer, deps: MongoMcpDepsType): void {
  const catalogue = describeCollections(deps.config)

  const { operation: _find, ...findShape } = FindCommandSchema.shape
  const { operation: _aggregate, ...aggregateShape } =
    AggregateCommandSchema.shape
  const { operation: _count, ...countShape } = CountCommandSchema.shape
  const { operation: _distinct, ...distinctShape } = DistinctCommandSchema.shape

  server.registerTool(
    'find',
    {
      title: 'MongoDB Find',
      description: `Find documents in a MongoDB collection.\n\n${catalogue}`,
      inputSchema: findShape,
      annotations: { readOnlyHint: true }
    },
    async (args) =>
      handle(deps, () =>
        runCommand(
          deps,
          FindCommandSchema.parse({ ...args, operation: 'find' })
        )
      )
  )

  server.registerTool(
    'aggregate',
    {
      title: 'MongoDB Aggregate',
      description:
        'Run a read-only aggregation pipeline. $out, $merge and any ' +
        `server-side JavaScript are refused.\n\n${catalogue}`,
      inputSchema: aggregateShape,
      annotations: { readOnlyHint: true }
    },
    async (args) =>
      handle(deps, () =>
        runCommand(
          deps,
          AggregateCommandSchema.parse({ ...args, operation: 'aggregate' })
        )
      )
  )

  server.registerTool(
    'count',
    {
      title: 'MongoDB Count',
      description: `Count the documents matching a filter.\n\n${catalogue}`,
      inputSchema: countShape,
      annotations: { readOnlyHint: true }
    },
    async (args) =>
      handle(deps, () =>
        runCommand(
          deps,
          CountCommandSchema.parse({ ...args, operation: 'countDocuments' })
        )
      )
  )

  server.registerTool(
    'distinct',
    {
      title: 'MongoDB Distinct',
      description: `List the distinct values of one field.\n\n${catalogue}`,
      inputSchema: distinctShape,
      annotations: { readOnlyHint: true }
    },
    async (args) =>
      handle(deps, () =>
        runCommand(
          deps,
          DistinctCommandSchema.parse({ ...args, operation: 'distinct' })
        )
      )
  )
}

async function runCommand(
  deps: MongoMcpDepsType,
  command: QueryCommandType
): Promise<McpTextResponseType> {
  deps.validator.validate(command)

  const plan = deps.enforcer.plan(command)

  const result = await deps.mongo.execute({
    ...plan,
    filter: reviveBson(plan.filter),
    ...(plan.pipeline === undefined
      ? {}
      : { pipeline: reviveBson(plan.pipeline) })
  })

  return deps.renderer.render(result, plan)
}

async function handle(
  deps: MongoMcpDepsType,
  run: () => Promise<McpTextResponseType>
): Promise<McpTextResponseType> {
  try {
    return await run()
  } catch (error) {
    return deps.renderer.error(error)
  }
}

function listCollections(config: ConfigType): CollectionEntryType[] {
  return Object.entries(config.databases).flatMap(
    ([database, { collections }]) =>
      Object.keys(collections).map((collection) => ({ database, collection }))
  )
}

function describeCollections(config: ConfigType): string {
  const lines = []

  for (const [database, { collections }] of Object.entries(config.databases)) {
    for (const [collection, rules] of Object.entries(collections)) {
      lines.push(
        [
          `${database}.${collection}`,
          `  readable:   ${rules.allowedFields.join(', ')}`,
          `  filterable: ${rules.filterableFields.join(', ') || '(none)'}`,
          `  sortable:   ${rules.sortableFields.join(', ') || '(none)'}`
        ].join('\n')
      )
    }
  }

  return lines.length === 0
    ? 'No collections are exposed by this deployment.'
    : `Available collections:\n${lines.join('\n')}`
}
