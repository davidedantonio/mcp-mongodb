import type { Logger } from 'pino'

import {
  ALLOWED_STAGES,
  CROSS_COLLECTION_STAGES,
  FORBIDDEN_VARIABLES,
  JAVASCRIPT_OPERATORS,
  LITERAL_OPERATORS,
  LOGICAL_OPERATORS,
  PROTOTYPE_KEYS,
  READ_OPERATIONS,
  WRITE_STAGES
} from './operators.js'

import {
  type CollectionRulesType,
  type ConfigType,
  type QueryCommandType,
  QueryValidationError
} from './types.js'

export interface QueryValidatorOptions {
  allowWriteOps: boolean
  allowedDatabases: Iterable<string>
  config: ConfigType
  logger: Logger
  maxDepth?: number
  maxPipelineStages?: number
}

type FieldKind = 'read' | 'filter' | 'sort'

const FIELD_KIND_LABEL: Record<FieldKind, string> = {
  read: 'readable',
  filter: 'filterable',
  sort: 'sortable'
}

interface StageContext {
  database: string
  rules: CollectionRulesType
}

export const DEFAULT_MAX_DEPTH = 20

export function assertSafeDocument(
  value: unknown,
  path = '',
  maxDepth: number = DEFAULT_MAX_DEPTH,
  depth = 0
): void {
  if (depth > maxDepth) {
    throw new QueryValidationError(
      `Document nesting exceeds the maximum depth of ${maxDepth}`,
      path
    )
  }

  if (typeof value === 'string') {
    const variable = value.split('.')[0] ?? value

    if (FORBIDDEN_VARIABLES.has(variable)) {
      throw new QueryValidationError(
        `${variable} exposes the whole document and defeats the field allowlist`,
        path
      )
    }

    return
  }

  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      assertSafeDocument(item, `${path}[${index}]`, maxDepth, depth + 1)
    }

    return
  }

  if (value === null || typeof value !== 'object') {
    return
  }

  for (const [key, child] of Object.entries(value)) {
    const childPath = path === '' ? key : `${path}.${key}`

    if (PROTOTYPE_KEYS.has(key)) {
      throw new QueryValidationError(
        `The key "${key}" is not allowed in a command`,
        childPath
      )
    }

    if (JAVASCRIPT_OPERATORS.has(key)) {
      throw new QueryValidationError(
        `${key} executes JavaScript on the database server and is always refused`,
        childPath
      )
    }

    if (WRITE_STAGES.has(key)) {
      throw new QueryValidationError(
        `${key} writes its result to a collection and is always refused`,
        childPath
      )
    }

    assertSafeDocument(child, childPath, maxDepth, depth + 1)
  }
}

export class QueryValidator {
  private readonly allowWriteOps: boolean
  private readonly allowedDatabases: ReadonlySet<string>
  private readonly config: ConfigType
  private readonly logger: Logger
  private readonly maxDepth: number
  private readonly maxPipelineStages: number

  constructor(options: QueryValidatorOptions) {
    this.allowWriteOps = options.allowWriteOps
    this.allowedDatabases = new Set(options.allowedDatabases)
    this.config = options.config
    this.logger = options.logger
    this.maxDepth = options.maxDepth ?? 20
    this.maxPipelineStages = options.maxPipelineStages ?? 50
  }

  validate(command: QueryCommandType): QueryCommandType {
    this.assertOperationAllowed(command.operation)

    const rules = this.resolveCollection(command.database, command.collection)
    const context: StageContext = { database: command.database, rules }

    assertSafeDocument(command, '', this.maxDepth)

    switch (command.operation) {
      case 'find':
        this.assertFields(
          this.filterFields(command.filter),
          context,
          'filter',
          'filter'
        )

        this.assertFields(
          Object.keys(command.sort ?? {}),
          context,
          'sort',
          'sort'
        )
        if (command.projection !== undefined) {
          const fields = this.projectionFields(command.projection, 'projection')
          this.assertFields(fields, context, 'read', 'projection')
        }
        break

      case 'countDocuments':
        this.assertFields(
          this.filterFields(command.filter),
          context,
          'filter',
          'filter'
        )
        break

      case 'distinct':
        this.assertFields([command.field], context, 'read', 'field')
        this.assertFields(
          this.filterFields(command.filter),
          context,
          'filter',
          'filter'
        )
        break

      case 'aggregate':
        this.validatePipeline(command.pipeline, context, 'pipeline')
        break
    }

    this.logger.debug(
      {
        operation: command.operation,
        database: command.database,
        collection: command.collection,
        allowWriteOps: this.allowWriteOps
      },
      'Query validated successfully'
    )

    return command
  }

  private assertOperationAllowed(operation: string): void {
    if (READ_OPERATIONS.has(operation) || this.allowWriteOps) {
      return
    }

    throw new QueryValidationError(
      'Write operations are disabled. Consult a human to enable this.',
      'operation'
    )
  }

  private resolveCollection(
    database: string,
    collection: string
  ): CollectionRulesType {
    if (!this.allowedDatabases.has(database)) {
      throw new QueryValidationError(
        `Database "${database}" is not allowed`,
        'database'
      )
    }

    const rules = this.config.databases[database]?.collections[collection]

    if (rules === undefined) {
      throw new QueryValidationError(
        `Collection "${collection}" is not exposed on database "${database}"`,
        'collection'
      )
    }

    return rules
  }

  private validatePipeline(
    pipeline: readonly unknown[],
    context: StageContext,
    path: string
  ): void {
    if (pipeline.length > this.maxPipelineStages) {
      throw new QueryValidationError(
        `A pipeline may not exceed ${this.maxPipelineStages} stages`,
        path
      )
    }

    for (const [index, stage] of pipeline.entries()) {
      this.validateStage(stage, context, `${path}[${index}]`)
    }
  }

  private validateStage(
    stage: unknown,
    context: StageContext,
    path: string
  ): void {
    if (stage === null || typeof stage !== 'object' || Array.isArray(stage)) {
      throw new QueryValidationError(
        'A pipeline stage must be a document',
        path
      )
    }

    const entries = Object.entries(stage)
    const entry = entries[0]

    if (entries.length !== 1 || entry === undefined) {
      throw new QueryValidationError(
        'A pipeline stage must have exactly one field naming the stage',
        path
      )
    }

    const [name, body] = entry
    const stagePath = `${path}.${name}`

    if (WRITE_STAGES.has(name)) {
      throw new QueryValidationError(
        `${name} writes its result to a collection and is always refused`,
        stagePath
      )
    }

    if (!ALLOWED_STAGES.has(name)) {
      throw new QueryValidationError(
        `The ${name} stage is not allowed`,
        stagePath
      )
    }

    if (CROSS_COLLECTION_STAGES.has(name)) {
      this.validateCrossCollectionStage(name, body, context, stagePath)
      return
    }

    switch (name) {
      case '$match':
        this.assertFields(this.filterFields(body), context, 'filter', stagePath)
        return

      case '$sort':
      case '$sortByCount': {
        const fields =
          typeof body === 'string' || Array.isArray(body)
            ? this.expressionFields(body)
            : Object.keys(this.asDocument(body, stagePath))

        this.assertFields(fields, context, 'sort', stagePath)
        return
      }

      case '$facet':
        for (const [facet, sub] of Object.entries(
          this.asDocument(body, stagePath)
        )) {
          const facetPath = `${stagePath}.${facet}`

          if (!Array.isArray(sub)) {
            throw new QueryValidationError(
              'A $facet branch must be a pipeline',
              facetPath
            )
          }

          this.validatePipeline(sub, context, facetPath)
        }
        return

      case '$project':
        this.assertFields(
          this.projectionFields(body, stagePath),
          context,
          'read',
          stagePath
        )
        return

      case '$unset':
        return

      default:
        this.assertFields(
          this.expressionFields(body),
          context,
          'read',
          stagePath
        )
    }
  }

  private validateCrossCollectionStage(
    name: string,
    body: unknown,
    context: StageContext,
    path: string
  ): void {
    // { $unionWith: 'other_collection' } is valid shorthand.
    if (name === '$unionWith' && typeof body === 'string') {
      this.resolveCollection(context.database, body)
      return
    }

    const source = this.asDocument(body, path)
    const key = name === '$unionWith' ? 'coll' : 'from'
    const from = source[key]

    if (typeof from !== 'string') {
      throw new QueryValidationError(
        `${name} must name its source collection in "${key}"`,
        `${path}.${key}`
      )
    }

    const foreign = this.resolveCollection(context.database, from)
    const foreignContext: StageContext = {
      database: context.database,
      rules: foreign
    }

    const pipeline = source.pipeline

    if (pipeline !== undefined) {
      if (!Array.isArray(pipeline)) {
        throw new QueryValidationError(
          `The ${name} pipeline must be an array of stages`,
          `${path}.pipeline`
        )
      }

      this.validatePipeline(pipeline, foreignContext, `${path}.pipeline`)
    }

    for (const [field, side] of [
      ['localField', context],
      ['connectToField', context],
      ['foreignField', foreignContext],
      ['connectFromField', foreignContext]
    ] as const) {
      const value = source[field]

      if (typeof value === 'string') {
        this.assertFields([value], side, 'read', `${path}.${field}`)
      }
    }

    for (const field of ['let', 'startWith'] as const) {
      if (source[field] !== undefined) {
        this.assertFields(
          this.expressionFields(source[field]),
          context,
          'read',
          `${path}.${field}`
        )
      }
    }
  }

  private asDocument(value: unknown, path: string): Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new QueryValidationError('Expected a document', path)
    }

    return value as Record<string, unknown>
  }

  private filterFields(filter: unknown): string[] {
    const fields = new Set<string>()
    this.collectFilterFields(filter, fields)

    return [...fields]
  }

  private collectFilterFields(filter: unknown, out: Set<string>): void {
    if (
      filter === null ||
      typeof filter !== 'object' ||
      Array.isArray(filter)
    ) {
      return
    }

    for (const [key, value] of Object.entries(filter)) {
      if (LOGICAL_OPERATORS.has(key)) {
        if (Array.isArray(value)) {
          for (const clause of value) {
            this.collectFilterFields(clause, out)
          }
        }

        continue
      }

      if (key === '$expr') {
        this.collectExpressionFields(value, out)
        continue
      }

      if (key.startsWith('$')) {
        continue
      }

      out.add(key)
      this.collectOperandFields(key, value, out)
    }
  }

  private collectOperandFields(
    prefix: string,
    value: unknown,
    out: Set<string>
  ): void {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return
    }

    for (const [operator, operand] of Object.entries(value)) {
      if (operator === '$elemMatch') {
        const nested = new Set<string>()
        this.collectFilterFields(operand, nested)

        for (const field of nested) out.add(`${prefix}.${field}`)
        continue
      }

      if (operator === '$not') {
        this.collectOperandFields(prefix, operand, out)
      }
    }
  }

  private expressionFields(expression: unknown): string[] {
    const fields = new Set<string>()
    this.collectExpressionFields(expression, fields)

    return [...fields]
  }

  private collectExpressionFields(expression: unknown, out: Set<string>): void {
    if (typeof expression === 'string') {
      if (expression.startsWith('$') && !expression.startsWith('$$')) {
        out.add(expression.slice(1))
      }

      return
    }

    if (Array.isArray(expression)) {
      for (const item of expression) {
        this.collectExpressionFields(item, out)
      }

      return
    }

    if (expression === null || typeof expression !== 'object') {
      return
    }

    for (const [key, value] of Object.entries(expression)) {
      if (LITERAL_OPERATORS.has(key)) {
        continue
      }

      this.collectExpressionFields(value, out)
    }
  }

  private projectionFields(projection: unknown, path: string): string[] {
    const document = this.asDocument(projection, path)
    const fields = new Set<string>()

    for (const [key, value] of Object.entries(document)) {
      if (key.startsWith('$')) {
        continue
      }

      if (value === 1 || value === true) {
        fields.add(key)
        continue
      }

      if (value === 0 || value === false) {
        if (key === '_id') {
          continue
        }

        throw new QueryValidationError(
          `Exclusion projections are not allowed: list the fields to return instead of "${key}: 0"`,
          `${path}.${key}`
        )
      }

      this.collectExpressionFields(value, fields)
    }

    return [...fields]
  }

  private assertFields(
    fields: readonly string[],
    context: StageContext,
    kind: FieldKind,
    path: string
  ): void {
    const allowed =
      kind === 'filter'
        ? context.rules.filterableFields
        : kind === 'sort'
          ? context.rules.sortableFields
          : context.rules.allowedFields

    for (const field of fields) {
      if (this.isFieldAllowed(field, allowed)) continue

      throw new QueryValidationError(
        `The field "${field}" is not ${FIELD_KIND_LABEL[kind]} on this collection`,
        path
      )
    }
  }

  private isFieldAllowed(field: string, allowed: readonly string[]): boolean {
    const normalized = this.normalizeFieldPath(field)

    if (normalized === '') {
      return false
    }

    return allowed.some((candidate) => {
      const target = this.normalizeFieldPath(candidate)

      return (
        target !== '' &&
        (normalized === target || normalized.startsWith(`${target}.`))
      )
    })
  }

  private normalizeFieldPath(field: string): string {
    return field
      .split('.')
      .filter(
        (segment) => segment !== '' && segment !== '$' && !/^\d+$/.test(segment)
      )
      .join('.')
  }
}
