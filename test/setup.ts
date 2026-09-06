import { loadConfig, validate } from './../src/config.js'
import { QueryEnforcer } from './../src/enforcer.js'
import { createLogger } from './../src/logger.js'
import type { MongoMcpDepsType } from './../src/mcp-core.js'
import { MongoConnection } from './../src/mongo.js'
import { ResponseRenderer } from './../src/response.js'
import { EnvSchema } from './../src/types.js'
import { QueryValidator } from './../src/validator.js'

export const INTEGRATION_ENV = {
  MONGODB_URI:
    process.env.MONGODB_URI ??
    'mongodb://mcp_reader:mcp_reader_pw@localhost:27017/demo?authSource=demo',
  MONGODB_ALLOWED_DATABASES: process.env.MONGODB_ALLOWED_DATABASES ?? 'demo',
  MCP_CONFIG_PATH: process.env.MCP_CONFIG_PATH ?? 'demo/mcp.config.json',
  LOG_LEVEL: 'silent' as const
}

export async function buildDeps(): Promise<MongoMcpDepsType> {
  const env = validate(EnvSchema, INTEGRATION_ENV, 'Invalid integration env')
  const config = await loadConfig(env)
  const logger = createLogger({ level: 'silent' })

  return {
    env,
    config,
    logger,
    mongo: new MongoConnection(env, logger),
    validator: new QueryValidator({
      allowWriteOps: false,
      allowedDatabases: env.MONGODB_ALLOWED_DATABASES,
      config,
      logger
    }),
    enforcer: new QueryEnforcer({ config, env, logger }),
    renderer: new ResponseRenderer(env, logger)
  }
}

// True when the demo database is up and seeded
export async function mongoIsUp(): Promise<boolean> {
  try {
    const deps = await buildDeps()
    await deps.mongo.testConnection()
    await deps.mongo.close()
    return true
  } catch {
    return false
  }
}
