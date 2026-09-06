import type { Logger } from 'pino'
import { renderBson } from './bson.js'
import type { QueryResultType } from './mongo.js'
import {
  type EnvType,
  type ExecutionPlanType,
  QueryExecutionError,
  QueryValidationError
} from './types.js'

export type McpTextResponseType = {
  content: { type: 'text'; text: string }[]
  isError?: boolean
}

export class ResponseRenderer {
  private readonly logger: Logger
  private readonly env: EnvType

  constructor(env: EnvType, logger: Logger) {
    this.logger = logger
    this.env = env
  }

  render(
    result: QueryResultType,
    plan: ExecutionPlanType
  ): McpTextResponseType {
    switch (result.kind) {
      case 'count':
        return this.text(renderBson({ count: result.count }))

      case 'values':
        return this.fit(
          (kept) => ({
            values: result.values.slice(0, kept),
            returned: Math.min(kept, result.values.length),
            hasMore: result.hasMore || kept < result.values.length
          }),
          result.values.length
        )

      case 'documents':
        return this.fit((kept) => {
          const documents = result.documents.slice(0, kept)
          const truncated = kept < result.documents.length

          return {
            documents,
            returned: documents.length,
            hasMore: result.hasMore || truncated,
            ...(plan.operation === 'find'
              ? { nextSkip: plan.skip + documents.length }
              : {}),
            ...(truncated
              ? {
                truncated: true,
                note:
                  documents.length === 0
                    ? 'A single document exceeds the maximum response size. Narrow the projection'
                    : 'Response truncated to fit the maximum response size. Request fewer fields or smaller limit'
              }
              : {})
          }
        }, result.documents.length)
    }
  }

  error(error: unknown): McpTextResponseType {
    if (error instanceof QueryValidationError) {
      return this.text(
        renderBson({
          error: error.message,
          ...(error.path === undefined ? {} : { path: error.path })
        }),
        true
      )
    }

    if (error instanceof QueryExecutionError) {
      return this.text(renderBson({ error: error.message }), true)
    }

    this.logger.error(
      { err: error },
      'Unexpected error while handling a tool call'
    )

    return this.text(renderBson({ error: 'Unexpected server error' }), true)
  }

  private fit(
    build: (kept: number) => unknown,
    total: number
  ): McpTextResponseType {
    let kept = total
    let text = renderBson(build(kept))

    while (kept > 0 && this.oversized(text)) {
      const size = Buffer.byteLength(text, 'utf-8')
      const ratio = this.env.MCP_MAX_RESPONSE_BYTES / size

      kept = Math.max(0, Math.min(kept - 1, Math.floor(kept * ratio)))
      text = renderBson(build(kept))
    }

    if (kept < total) {
      this.logger.warn(
        { total, kept, maxBytes: this.env.MCP_MAX_RESPONSE_BYTES },
        'Response truncated to fit within max bytes'
      )
    }

    return this.text(text)
  }

  private oversized(text: string): boolean {
    return Buffer.byteLength(text, 'utf-8') > this.env.MCP_MAX_RESPONSE_BYTES
  }

  private text(text: string, isError = false): McpTextResponseType {
    return {
      content: [{ type: 'text', text }],
      ...(isError ? { isError: true } : {})
    }
  }
}
