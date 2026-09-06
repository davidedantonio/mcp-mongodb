/**
 * Operations allowed when write operations are disabled. Anything else
 * is treated as a write.
 */
export const READ_OPERATIONS: ReadonlySet<string> = new Set([
  'find',
  'aggregate',
  'countDocuments',
  'distinct'
])

/**
 * Operators that run JavaScript inside the mongod process. These are
 * refused even when write operations are enabled: they are remote code
 * execution, not a write, and no configuration flag should turn them on.
 */
export const JAVASCRIPT_OPERATORS: ReadonlySet<string> = new Set([
  '$where',
  '$function',
  '$accumulator',
  '$eval',
  '$code'
])

/**
 * Aggregation stages that persist their output to a collection.
 */
export const WRITE_STAGES: ReadonlySet<string> = new Set(['$out', '$merge'])

/**
 * Read-only aggregation stages. Deliberately excludes the introspection
 * stages ($collStats, $indexStats, $currentOp, $listSessions,
 * $planCacheStats, $shardedDataDistribution...): they leak cluster
 * topology and other tenants' activity while technically being reads.
 */
export const ALLOWED_STAGES: ReadonlySet<string> = new Set([
  '$addFields',
  '$bucket',
  '$bucketAuto',
  '$count',
  '$densify',
  '$documents',
  '$facet',
  '$fill',
  '$graphLookup',
  '$group',
  '$limit',
  '$lookup',
  '$match',
  '$project',
  '$redact',
  '$replaceRoot',
  '$replaceWith',
  '$sample',
  '$set',
  '$setWindowFields',
  '$skip',
  '$sort',
  '$sortByCount',
  '$unionWith',
  '$unset',
  '$unwind'
])

/**
 * Stages that read a second collection. Their target has to be checked
 * against the collection allowlist too, otherwise $lookup is a hole
 * straight through it.
 */
export const CROSS_COLLECTION_STAGES: ReadonlySet<string> = new Set([
  '$lookup',
  '$unionWith',
  '$graphLookup'
])

/**
 * System variables that hand back the entire document and therefore
 * defeat any field-level allowlist. $$NOW, $$REMOVE and user variables
 * bound by $let / $map are fine and stay allowed.
 */
export const FORBIDDEN_VARIABLES: ReadonlySet<string> = new Set([
  '$$ROOT',
  '$$CURRENT'
])

/**
 * Keys that poison Object.prototype when a query document is merged
 * into another object downstream. JSON.parse creates these as real own
 * properties, so they survive into the command.
 */
export const PROTOTYPE_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype'
])

/**
 * Filter-level operators whose operands are complete sub-filters rather
 * than values, so field collection has to recurse into them.
 */
export const LOGICAL_OPERATORS: ReadonlySet<string> = new Set([
  '$and',
  '$or',
  '$nor'
])

/**
 * Expression operators that stop field collection: their operand is a
 * value to be taken literally, not a field reference.
 */
export const LITERAL_OPERATORS: ReadonlySet<string> = new Set([
  '$literal',
  '$regex',
  '$options'
])
