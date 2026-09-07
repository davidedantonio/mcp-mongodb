#!/usr/bin/env node

import process from 'node:process'

import { loadConfig, validate } from './src/config.js'
import { QueryEnforcer } from './src/enforcer.js'
import { createLogger } from './src/logger.js'
import type { MongoMcpDepsType } from './src/mcp-core.js'
import { MongoConnection } from './src/mongo.js'
import { ResponseRenderer } from './src/response.js'
import { EnvSchema } from './src/types.js'
import { QueryValidator } from './src/validator.js'

async function main(): Promise<void> {
  console.log(process.env)
  const env = validate(EnvSchema, process.env, 'Invalid environment variables')
  const config = await loadConfig(env)
  const logger = createLogger({
    level: env.LOG_LEVEL,
    name: 'mongodb-mcp-server'
  })

  const deps: MongoMcpDepsType = {
    env,
    config,
    logger,
    mongo: new MongoConnection(env, logger.child({ component: 'mongo' })),
    validator: new QueryValidator({
      allowedDatabases: env.MONGODB_ALLOWED_DATABASES,
      config,
      logger: logger.child({ component: 'validator' })
    }),
    enforcer: new QueryEnforcer({
      config,
      env,
      logger: logger.child({ component: 'enforcer' })
    }),
    renderer: new ResponseRenderer(env, logger.child({ component: 'renderer' }))
  }

  if (env.MCP_TRANSPORT === 'http') {
    const { startMcpServerHttp } = await import('./src/mcp-server-http.js')
    await startMcpServerHttp(deps)
    return
  }

  const { startMcpServerStdio } = await import('./src/mcp-server-stdio.js')
  await startMcpServerStdio(deps)
  return
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
