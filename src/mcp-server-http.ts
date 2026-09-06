import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import http from 'node:http'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createMongoMcpServer, type MongoMcpDepsType } from './mcp-core.js'
import { shutdownGracefully } from './shutdown.js'

export interface RunningHttpServerType {
  port: number
  close: () => Promise<void>
}

export async function startMcpServerHttp(
  deps: MongoMcpDepsType
): Promise<RunningHttpServerType> {
  const { mongo, env, logger } = deps

  if (env.MCP_HTTP_AUTH_TOKEN === undefined) {
    throw new Error(
      'MCP_HTTP_AUTH_TOKEN is required for HTTP server authentication'
    )
  }

  await mongo.testConnection()

  const sessions = new Map<string, StreamableHTTPServerTransport>()

  const sessionFor = (
    req: http.IncomingMessage
  ): StreamableHTTPServerTransport | undefined => {
    const id = req.headers['mcp-session-id']

    return typeof id === 'string' ? sessions.get(id) : undefined
  }

  const openSession = async (): Promise<StreamableHTTPServerTransport> => {
    const server = createMongoMcpServer(deps)

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableDnsRebindingProtection: env.MCP_HTTP_ALLOWED_HOSTS !== undefined,
      ...(env.MCP_HTTP_ALLOWED_HOSTS !== undefined
        ? { allowedHosts: env.MCP_HTTP_ALLOWED_HOSTS }
        : {}),
      onsessioninitialized: (id: string) => {
        sessions.set(id, transport)
        logger.debug({ sessionId: id, open: sessions.size }, 'Session opened')
      },
      onsessionclosed: (id: string) => {
        sessions.delete(id)
        logger.debug({ sessionId: id, open: sessions.size }, 'Session closed')
      }
    })

    transport.onclose = () => {
      if (transport.sessionId !== undefined) {
        sessions.delete(transport.sessionId)
      }
    }

    await server.connect(transport)
    return transport
  }

  const expected = createHash('sha256').update(env.MCP_HTTP_AUTH_TOKEN).digest()

  const nodeServer = http.createServer(async (req, res) => {
    void handleRequest(req, res)
  })

  async function handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    if (req.url === undefined || !req.url.startsWith('/mcp')) {
      reply(res, 404, 'Not Found')
      return
    }

    if (!authorized(req, expected)) {
      res.setHeader('WWW-Authenticate', 'Bearer')
      reply(res, 401, 'Unauthorized')
      return
    }

    if (req.method === 'GET' || req.method === 'DELETE') {
      const session = sessionFor(req)

      if (session === undefined) {
        reply(res, 404, 'Unknown session')
        return
      }

      await session.handleRequest(req, res)
      return
    }

    if (req.method !== 'POST') {
      return reply(res, 405, 'Method Not Allowed')
    }

    let raw: string

    try {
      raw = await readBody(req, env.MCP_HTTP_MAX_BODY_BYTES)
    } catch {
      res.setHeader('Connection', 'close')
      reply(res, 413, 'Request Entity Too Large')
      return
    }

    let body: unknown
    try {
      body = raw.length > 0 ? JSON.parse(raw) : undefined
    } catch {
      body = undefined
    }

    const session = sessionFor(req) ?? (await openSession())
    await session.handleRequest(req, res, body)
  }

  await new Promise<void>((resolve) => {
    nodeServer.listen(env.MCP_HTTP_PORT, () => resolve())
  })

  const address = nodeServer.address()
  const port =
    typeof address === 'object' && address !== null
      ? address.port
      : env.MCP_HTTP_PORT

  const close = async (): Promise<void> => {
    for (const session of sessions.values()) {
      await session.close()
    }

    sessions.clear()

    await new Promise<void>((resolve) => nodeServer.close(() => resolve()))
    await mongo.close()
  }

  shutdownGracefully(logger, close)

  logger.info(
    {
      port,
      dnsRebindingProtection: env.MCP_HTTP_ALLOWED_HOSTS !== undefined
    },
    'MCP server is ready to accept requests on /mcp'
  )

  return { port, close }
}

function authorized(req: http.IncomingMessage, expected: Buffer): boolean {
  const header = req.headers?.authorization

  if (header === undefined || !header.startsWith('Bearer ')) {
    return false
  }

  const presented = createHash('sha256').update(header.slice(7)).digest()
  return timingSafeEqual(presented, expected)
}

function readBody(req: http.IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0

    req.on('data', (chunk: Buffer) => {
      size += chunk.length

      if (size > limit) {
        req.pause()
        reject(new Error(`Request body exceeds limit of ${limit} bytes`))
        return
      }

      chunks.push(chunk)
    })

    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf-8'))
    })

    req.on('error', (err) => {
      reject(err)
    })
  })
}

function reply(
  res: http.ServerResponse,
  statusCode: number,
  message: string
): void {
  res.statusCode = statusCode
  res.end(message)
}
