import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createMongoMcpServer, type MongoMcpDepsType } from './mcp-core.js'
import { shutdownGracefully } from './shutdown.js'

export async function startMcpServerStdio(
  deps: MongoMcpDepsType
): Promise<void> {
  const server = createMongoMcpServer(deps)
  const { mongo, logger } = deps

  await mongo.testConnection()

  shutdownGracefully(logger, () => mongo.close())
  await server.connect(new StdioServerTransport())

  logger.info('MCP server started on stdio')
}
