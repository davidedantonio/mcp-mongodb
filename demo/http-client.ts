import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const url = new URL(process.env.MCP_HTTP_URL ?? 'http://127.0.0.1:3000/mcp')
const token = process.env.MCP_HTTP_AUTH_TOKEN

if (token === undefined || token.length < 32) {
  console.error(
    'Set MCP_HTTP_AUTH_TOKEN to the same value the server was started with.'
  )
  process.exit(1)
}

const heading = (text: string): void => {
  console.log(`\n\x1b[1m${text}\x1b[0m`)
}

const payload = (result: unknown): Record<string, unknown> => {
  const content = (result as { content?: { text: string }[] }).content

  return JSON.parse(content?.[0]?.text ?? '{}') as Record<string, unknown>
}

heading('Without a token')
const anonymous = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{}'
})

console.log(
  `  ${anonymous.status} ${anonymous.statusText}`,
  `· WWW-Authenticate: ${anonymous.headers.get('www-authenticate')}`
)

const client = new Client({ name: 'mcp-mongodb-demo', version: '1.0.0' })

await client.connect(
  new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { authorization: `Bearer ${token}` } }
  })
)

heading('Connected')

const { tools } = await client.listTools()

for (const tool of tools) {
  console.log(`  ${tool.name.padEnd(10)} ${tool.title ?? ''}`)
}

heading('Exposed collections')

const catalogue = await client.readResource({ uri: 'mongodb://collections' })
const first = catalogue.contents[0]
const entries =
  first !== undefined && 'text' in first
    ? (JSON.parse(String(first.text)) as {
      database: string
      collection: string
    }[])
    : []

for (const entry of entries) {
  console.log(`  ${entry.database}.${entry.collection}`)
}

const target = entries[0]

if (target === undefined) {
  console.error('\nThe server exposes nothing: check MCP_CONFIG_PATH.')
  await client.close()
  process.exit(1)
}

heading(`find on ${target.database}.${target.collection}`)

const found = payload(
  await client.callTool({
    name: 'find',
    arguments: {
      database: target.database,
      collection: target.collection,
      limit: 2
    }
  })
)

console.log(
  `  returned ${found.returned}, hasMore ${found.hasMore}`,
  found.nextSkip === undefined ? '' : `, nextSkip ${found.nextSkip}`
)
console.log(
  `  fields: ${[
    ...new Set(
      (found.documents as Record<string, unknown>[]).flatMap((d) =>
        Object.keys(d)
      )
    )
  ].join(', ')}`
)

heading('A query the server refuses')

const refused = await client.callTool({
  name: 'find',
  arguments: {
    database: target.database,
    collection: target.collection,
    filter: { $where: 'this.total > 0' }
  }
})

const body = payload(refused)

console.log(`  isError: ${(refused as { isError?: boolean }).isError}`)
console.log(`  ${body.error}`)
console.log(`  path: ${body.path}`)

await client.close()
console.log()
