import {
  type Collection,
  type Document,
  type Filter,
  MongoClient,
  type Sort
} from 'mongodb'
import type { Logger } from 'pino'
import {
  type EnvType,
  type ExecutionPlanType,
  QueryExecutionError
} from './types.js'

export type QueryResultType =
  | { kind: 'documents'; documents: Document[]; hasMore: boolean }
  | { kind: 'values'; values: unknown[]; hasMore: boolean }
  | { kind: 'count'; count: number }

export class MongoConnection {
  private readonly client: MongoClient
  private readonly env: EnvType
  private readonly logger: Logger

  constructor(env: EnvType, logger: Logger) {
    this.env = env
    this.logger = logger
    this.client = new MongoClient(env.MONGODB_URI, {
      connectTimeoutMS: env.MONGODB_CONNECT_TIMEOUT_MS,
      serverSelectionTimeoutMS: env.MONGODB_CONNECT_TIMEOUT_MS,
      maxPoolSize: 10,
      retryWrites: false
    })
  }

  async testConnection(): Promise<void> {
    const database = this.env.MONGODB_ALLOWED_DATABASES[0] ?? 'admin'

    try {
      await this.client.connect()
      await this.client.db(database).command({ ping: 1 })
      this.logger.info(
        `Successfully connected to MongoDB database "${database}"`
      )
    } catch (error) {
      throw this.wrap(error, 'Failed to connect to MongoDB')
    }
  }

  async execute(plan: ExecutionPlanType): Promise<QueryResultType> {
    const collection = this.client.db(plan.database).collection(plan.collection)
    const started = Date.now()

    try {
      const result = await this.run(collection, plan)

      this.logger.debug(
        {
          operation: plan.operation,
          collection: `${plan.database}.${plan.collection}`,
          ms: Date.now() - started
        },
        'Query executed successfully'
      )

      return result
    } catch (error) {
      this.logger.error(
        {
          operation: plan.operation,
          err: error
        },
        'Query execution failed'
      )

      throw this.wrap(error, 'Query execution failed')
    }
  }

  private async run(
    collection: Collection<Document>,
    plan: ExecutionPlanType
  ): Promise<QueryResultType> {
    switch (plan.operation) {
      case 'find': {
        const documents = await collection
          .find(plan.filter as Filter<Document>, {
            projection: plan.projection,
            sort: plan.sort as Sort,
            skip: plan.skip,
            limit: plan.limit + 1,
            maxTimeMS: plan.maxTimeMS
          })
          .toArray()

        return this.paginate(documents, plan.limit)
      }

      case 'aggregate': {
        const documents = await collection
          .aggregate(plan.pipeline ?? [], {
            allowDiskUse: false,
            maxTimeMS: plan.maxTimeMS
          })
          .toArray()

        return this.paginate(documents, plan.limit)
      }

      case 'countDocuments': {
        const count = await collection.countDocuments(
          plan.filter as Filter<Document>,
          {
            maxTimeMS: plan.maxTimeMS
          }
        )

        return { kind: 'count', count }
      }

      case 'distinct': {
        const values = await collection.distinct(
          plan.field ?? '_id',
          plan.filter as Filter<Document>,
          {
            maxTimeMS: plan.maxTimeMS
          }
        )

        const hasMore = values.length > plan.limit

        return {
          kind: 'values',
          values: hasMore ? values.slice(0, plan.limit) : values,
          hasMore
        }
      }
    }
  }

  private wrap(error: unknown, message: string): QueryExecutionError {
    return error instanceof QueryExecutionError
      ? error
      : new QueryExecutionError(message, error)
  }

  private paginate(documents: Document[], limit: number): QueryResultType {
    const hasMore = documents.length > limit

    return {
      kind: 'documents',
      documents: hasMore ? documents.slice(0, limit) : documents,
      hasMore
    }
  }

  async close(): Promise<void> {
    try {
      await this.client.close()
      this.logger.info('MongoDB connection closed')
    } catch (error) {
      throw this.wrap(error, 'Failed to close MongoDB connection')
    }
  }
}
