import { describe, expect, it } from 'vitest'
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
} from './../src/operators.js'

describe('operator lists', () => {
  it('never allows a stage that writes', () => {
    for (const stage of WRITE_STAGES) {
      expect(ALLOWED_STAGES.has(stage)).toBe(false)
    }
  })

  it('allows every cross-collection stage it knows how to scope', () => {
    for (const stage of CROSS_COLLECTION_STAGES) {
      expect(ALLOWED_STAGES.has(stage)).toBe(true)
    }
  })

  it('never allows a JavaScript operator as a stage', () => {
    for (const operator of JAVASCRIPT_OPERATORS) {
      expect(ALLOWED_STAGES.has(operator)).toBe(false)
    }
  })

  it('excludes the introspection stages', () => {
    for (const stage of [
      '$collStats',
      '$indexStats',
      '$currentOp',
      '$listSessions',
      '$listLocalSessions',
      '$planCacheStats',
      '$shardedDataDistribution'
    ]) {
      expect(ALLOWED_STAGES.has(stage)).toBe(false)
    }
  })

  it('spells every stage and operator with its leading $', () => {
    const named = [
      ...ALLOWED_STAGES,
      ...WRITE_STAGES,
      ...CROSS_COLLECTION_STAGES,
      ...JAVASCRIPT_OPERATORS,
      ...LOGICAL_OPERATORS,
      ...LITERAL_OPERATORS
    ]

    for (const name of named) {
      expect(name.startsWith('$')).toBe(true)
    }
  })

  it('spells system variables with $$', () => {
    for (const variable of FORBIDDEN_VARIABLES) {
      expect(variable.startsWith('$$')).toBe(true)
    }
  })

  it('covers the four read operations and nothing else', () => {
    expect([...READ_OPERATIONS].sort()).toEqual([
      'aggregate',
      'countDocuments',
      'distinct',
      'find'
    ])
  })

  it('blocks the keys that reach Object.prototype', () => {
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      expect(PROTOTYPE_KEYS.has(key)).toBe(true)
    }
  })

  it('refuses the JavaScript operators Extended JSON can revive', () => {
    expect(JAVASCRIPT_OPERATORS.has('$code')).toBe(true)
    expect(JAVASCRIPT_OPERATORS.has('$where')).toBe(true)
    expect(JAVASCRIPT_OPERATORS.has('$function')).toBe(true)
    expect(JAVASCRIPT_OPERATORS.has('$accumulator')).toBe(true)
  })
})
