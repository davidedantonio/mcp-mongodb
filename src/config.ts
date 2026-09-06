import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { z } from 'zod'
import { ConfigSchema, type ConfigType, type EnvType } from './types.js'
import { assertSafeDocument } from './validator.js'

export function validate<T>(
  schema: z.ZodType<T>,
  input: unknown,
  label: string
): T {
  const result = schema.safeParse(input)

  if (!result.success) {
    // Show all paths, without print the secret values
    const paths = result.error.issues.map(
      (issue) => issue.path.map(String).join('.') || '(root)'
    )

    throw new Error(`${label}: check ${[...new Set(paths)].join(', ')}`)
  }

  return result.data
}

export async function loadConfig(env: EnvType): Promise<ConfigType> {
  if (env.MCP_CONFIG_PATH === undefined) {
    // No config path provided, return default config
    return { version: 1, databases: {} }
  }

  const path = resolve(env.MCP_CONFIG_PATH)
  let content: string

  try {
    content = await readFile(path, 'utf-8')
  } catch (error) {
    throw new Error(`Failed to read config file at ${path}: ${error}`)
  }

  let rawConfig: unknown

  try {
    rawConfig = JSON.parse(content)
  } catch (error) {
    throw new Error(`Failed to parse config file at ${path}: ${error}`)
  }

  const config = validate(ConfigSchema, rawConfig, 'No valid config file')
  const allowedDatabases = new Set(env.MONGODB_ALLOWED_DATABASES)

  for (const dbName of Object.keys(config.databases)) {
    if (!allowedDatabases.has(dbName)) {
      throw new Error(
        `Database "${dbName}" is not allowed. Allowed databases: ${[
          ...allowedDatabases
        ].join(', ')}`
      )
    }
  }

  assertRequiredFieldsAreSafe(config)
  return config
}

function assertRequiredFieldsAreSafe(config: ConfigType): void {
  for (const [dbName, database] of Object.entries(config.databases)) {
    for (const [name, rules] of Object.entries(database.collections)) {
      try {
        assertSafeDocument(rules.requiredFilter)
      } catch (error) {
        throw new Error(
          `Invalid requiredFilter for ${dbName}.${name}: ${error instanceof Error ? error.message : 'Unsafe value'}`
        )
      }
    }
  }
}
