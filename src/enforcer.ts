import type { Logger } from 'pino'
import {
  type CollectionRulesType,
  type ConfigType,
  type EnvType,
  type ExecutionPlanType,
  type QueryCommandType,
  QueryValidationError
} from './types.js'

const POSITION_LOCKED_STAGES: ReadonlySet<string> = new Set([
  '$geoNear',
  '$documents'
])

type Document = Record<string, unknown>

export interface QueryEnforcerOptions {
  config: ConfigType
  env: EnvType
  logger: Logger
}

export class QueryEnforcer {
  private readonly config: ConfigType
  private readonly env: EnvType
  private readonly logger: Logger

  constructor(options: QueryEnforcerOptions) {
    this.config = options.config
    this.env = options.env
    this.logger = options.logger
  }

  plan(command: QueryCommandType): ExecutionPlanType {
    const rules = this.rulesFor(command.database, command.collection)

    const base = {
      operation: command.operation,
      database: command.database,
      collection: command.collection,
      filter: {} as Document,
      projection: this.projectionFor(rules),
      sort: {} as Record<string, 1 | -1>,
      limit: this.env.MCP_DEFAULT_PAGE_SIZE,
      skip: 0,
      maxTimeMS: this.env.MONGODB_QUERY_TIMEOUT_MS
    }

    let plan: ExecutionPlanType

    switch (command.operation) {
      case 'find':
        plan = {
          ...base,
          filter: this.scopedFilter(command.filter, rules),
          projection: this.projectionFor(rules, command.projection),
          sort: command.sort ?? {},
          skip: command.skip ?? 0,
          limit: this.boundedLimit(command.limit)
        }
        break

      case 'countDocuments':
        plan = {
          ...base,
          filter: this.scopedFilter(command.filter, rules)
        }
        break

      case 'distinct':
        plan = {
          ...base,
          filter: this.scopedFilter(command.filter, rules),
          field: command.field
        }
        break

      case 'aggregate': {
        const limit = this.boundedLimit(undefined)

        plan = {
          ...base,
          limit,
          pipeline: [
            ...this.scopedPipeline(command.pipeline, rules, command.database),
            { $limit: limit + 1 }
          ]
        }
        break
      }
    }

    this.logger.debug(
      {
        operation: plan.operation,
        collection: `${plan.database}.${plan.collection}`,
        scoped: Object.keys(rules.requiredFilter).length > 0,
        limit: plan.limit
      },
      'Execution plan generated'
    )

    return plan
  }

  private scopedPipeline(
    pipeline: Document[],
    rules: CollectionRulesType,
    database: string
  ): Document[] {
    const first = pipeline[0]
    const firstName = first === undefined ? undefined : Object.keys(first)[0]

    if (firstName !== undefined && POSITION_LOCKED_STAGES.has(firstName)) {
      throw new QueryValidationError(
        `Stage "${firstName}" must be the first stage in the pipeline`,
        'pipeline'
      )
    }

    const prefix: Document[] = []
    if (Object.keys(rules.requiredFilter).length > 0) {
      prefix.push({ $match: rules.requiredFilter })
    }

    prefix.push({ $project: this.projectionFor(rules) })

    return [...prefix, ...this.scopeStages(pipeline, database)]
  }

  private scopeStages(stages: Document[], database: string): Document[] {
    return stages.map((stage) => this.scopeStage(stage, database))
  }

  private scopeStage(stage: Document, database: string): Document {
    const name = Object.keys(stage)[0]

    if (name === undefined) {
      return stage
    }

    const body = stage[name]
    if (name === '$facet') {
      if (body === null || typeof body !== 'object') {
        return stage
      }

      const branches: Document = {}
      for (const [key, sub] of Object.entries(body as Document)) {
        branches[key] = Array.isArray(sub)
          ? this.scopeStages(sub as Document[], database)
          : sub
      }

      return { $facet: branches }
    }

    if (name === '$unionWith') {
      if (typeof body === 'string') {
        const required = this.requiredFilterFor(database, body)

        return required === undefined
          ? stage
          : { $unionWith: { coll: body, pipeline: [{ $match: required }] } }
      }

      if (body === null || typeof body !== 'object') {
        return stage
      }

      const source = body as Document
      const coll = source.coll

      if (typeof coll !== 'string') {
        return stage
      }

      return {
        $unionWith: {
          ...source,
          pipeline: this.scopedSubPipeline(source.pipeline, database, coll)
        }
      }
    }

    if (name === '$lookup') {
      if (body === null || typeof body !== 'object') {
        return stage
      }

      const source = body as Document
      const from = source.from

      if (typeof from !== 'string') {
        return stage
      }

      const required = this.requiredFilterFor(database, from)
      if (source.pipeline === undefined) {
        if (required === undefined) {
          return stage
        }

        throw new QueryValidationError(
          `${from} si a scoped collection, so it can be only be joined with the $lookup pipeline form, not localField/foreignField`,
          '$lookup.from'
        )
      }

      return {
        $lookup: {
          ...source,
          pipeline: this.scopedSubPipeline(source.pipeline, database, from)
        }
      }
    }

    if (name === '$graphLookup') {
      if (body === null || typeof body !== 'object') {
        return stage
      }

      const from = (body as Document).from

      if (typeof from !== 'string') {
        return stage
      }

      if (this.requiredFilterFor(database, from) === undefined) {
        return stage
      }

      throw new QueryValidationError(
        `${from} is a scoped collection, so it can not be used in $graphLookup`,
        '$graphLookup.from'
      )
    }

    return stage
  }

  private scopedSubPipeline(
    pipeline: unknown,
    database: string,
    collection: string
  ): Document[] {
    const stages = Array.isArray(pipeline) ? (pipeline as Document[]) : []
    const required = this.requiredFilterFor(database, collection)
    const scoped = this.scopeStages(stages, database)

    if (required === undefined) {
      return scoped
    }

    return [{ $match: required }, ...scoped]
  }

  private requiredFilterFor(
    database: string,
    collection: string
  ): Document | undefined {
    const rules = this.rulesFor(database, collection)

    if (Object.keys(rules.requiredFilter).length === 0) {
      return undefined
    }

    return rules.requiredFilter
  }

  private boundedLimit(requested: number | undefined): number {
    return Math.min(
      requested ?? this.env.MCP_DEFAULT_PAGE_SIZE,
      this.env.MCP_MAX_PAGE_SIZE
    )
  }

  private scopedFilter(filter: Document, rules: CollectionRulesType): Document {
    if (Object.keys(rules.requiredFilter).length === 0) {
      return filter
    }

    if (Object.keys(filter).length === 0) {
      return { ...rules.requiredFilter }
    }

    return { $and: [rules.requiredFilter, filter] }
  }

  private rulesFor(database: string, collection: string): CollectionRulesType {
    const rules = this.config.databases[database]?.collections[collection]

    if (rules === undefined) {
      throw new QueryValidationError(
        `Collection "${collection}" not found in database "${database}"`,
        'collection'
      )
    }

    return rules
  }

  private projectionFor(
    rules: CollectionRulesType,
    requested?: Document
  ): Record<string, 0 | 1> {
    const entries =
      requested === undefined ? undefined : Object.entries(requested)

    const asked = entries
      ?.filter(([_, value]) => value === true || value === 1)
      .map(([field]) => field)

    const wanted =
      asked !== undefined && asked.length > 0 ? new Set(asked) : undefined

    const projection: Record<string, 0 | 1> = {}

    for (const field of rules.allowedFields) {
      if (wanted === undefined || wanted.has(field)) {
        projection[field] = 1
      }
    }

    const dropId =
      !rules.allowedFields.includes('_id') ||
      entries?.some(
        ([field, value]) => field === '_id' && (value === false || value === 0)
      )

    if (dropId === true) {
      Object.assign(projection, { _id: 0 })
    }

    return projection
  }
}
