# mcp-mongodb

[<!-- ![npm version](https://img.shields.io/npm/v/mcp-mongodb.svg)](https://www.npmjs.com/package/mcp-mongodb)

[![CI](https://github.com/davidedantonio/mcp-mongodb/actions/workflows/ci.yml/badge.svg)](https://github.com/davidedantonio/mcp-mongodb/actions/workflows/ci.yml)

[![codecov](https://codecov.io/gh/davidedantonio/mcp-mongodb/branch/main/graph/badge.svg)](https://codecov.io/gh/davidedantonio/mcp-mongodb)
[![node](https://img.shields.io/node/v/mcp-mongodb.svg)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/mcp-mongodb.svg)](./LICENSE)
-->

A [Model Context Protocol](https://modelcontextprotocol.io) server that exposes MongoDB collections to LLM clients — read-only by construction, and only the
fields you declare.

Most database bridges hand a model a connection and hope the prompt holds. This one starts from nothing: a collection that is not in the config does not exist,
a field that is not in `allowedFields` never leaves the database, the query surface is a closed set of four operations, and no environment variable turns
writes on.

```jsonc
// A query the model sends
{ "database": "shop", "collection": "orders", "filter": { "status": "paid" } }

// What actually reaches MongoDB
{
  "filter":     { "$and": [ { "deleted": { "$ne": true } }, { "status": "paid" } ] },
  "projection": { "_id": 1, "number": 1, "status": 1, "total": 1 },
  "limit":      50,
  "maxTimeMS":  10000
}
```

The scope filter, the projection, the page size and the deadline were not asked for. They cannot be removed.

---

## Contents

- [Quick start](#quick-start)
- [Installation](#installation)
- [Configuration](#configuration)
- [Tools](#tools)
- [Resources](#resources)
- [Connecting a client](#connecting-a-client)
- [How a query is handled](#how-a-query-is-handled)
- [What is always refused](#what-is-always-refused)
- [The demo environment](#the-demo-environment)
- [Development](#development)
- [Architecture](#architecture)
- [Security notes](#security-notes)

---

## Quick start

```bash
git clone https://github.com/davidedantonio/mcp-mongodb.git
cd mcp-mongodb
npm install

# A throwaway MongoDB with a realistic fixture
npm run demo:up

# Start the server on the stdio transport
npx tsx --env-file=.env index.ts
```

To see it answer queries without wiring up a client first:

```bash
npm run demo:http # with the server running on MCP_TRANSPORT=http
```

## Installation

### As a package

```bash
npm install -g mcp-mongodb
mcp-mongodb # reads its configuration from the environment
```

Or without installing, which is how MCP clients usually launch it:

```bash
npx mcp-mongodb
```

### As a container

```bash
docker build -t mcp-mongodb .

docker run --rm \
  -e MONGODB_URI='mongodb://reader:password@mongo:27017/shop?authSource=shop' \
  -e MONGODB_ALLOWED_DATABASES=shop \
  -e MCP_CONFIG_PATH=/etc/mcp/config.json \
  -e MCP_TRANSPORT=http \
  -e MCP_HTTP_AUTH_TOKEN="$TOKEN" \
  -v "$PWD/config.json:/etc/mcp/config.json:ro" \
  -p 3000:3000 \
  mcp-mongodb
```

The image carries no configuration. Mount it and point `MCP_CONFIG_PATH` at it — the same image then serves every environment without a rebuild.

### Requirements

Node.js 22 or later, and a MongoDB you can reach. Use a read-only user; see
[Security notes](#security-notes).

## Configuration

### Environment

| Variable                     | Default    | Meaning                                                      |
| ---------------------------- | ---------- | ------------------------------------------------------------ |
| `MONGODB_URI`                | _required_ | Connection string. Use a read-only user.                     |
| `MONGODB_ALLOWED_DATABASES`  | _required_ | Comma-separated. A database not listed here is unreachable.  |
| `MONGODB_CONNECT_TIMEOUT_MS` | `5000`     | Must be lower than the query timeout.                        |
| `MONGODB_QUERY_TIMEOUT_MS`   | `10000`    | Becomes `maxTimeMS` on every query.                          |
| `MCP_CONFIG_PATH`            | —          | Path to the config file. **Without it, nothing is exposed.** |
| `MCP_TRANSPORT`              | `stdio`    | `stdio` or `http`.                                           |
| `MCP_DEFAULT_PAGE_SIZE`      | `50`       | Page size when the caller does not ask for one.              |
| `MCP_MAX_PAGE_SIZE`          | `200`      | Ceiling the caller cannot raise.                             |
| `MCP_MAX_RESPONSE_BYTES`     | `262144`   | A context budget, not a disk one.                            |
| `MCP_HTTP_PORT`              | `3000`     | HTTP transport only.                                         |
| `MCP_HTTP_AUTH_TOKEN`        | —          | **Required** for the HTTP transport, minimum 32 characters.  |
| `MCP_HTTP_ALLOWED_HOSTS`     | —          | Comma-separated. Enables DNS-rebinding protection.           |
| `MCP_HTTP_MAX_BODY_BYTES`    | `1048576`  | Request body ceiling.                                        |
| `LOG_LEVEL`                  | `info`     | `debug`, `info`, `warn`, `error`, `silent`.                  |

The server reads its environment and nothing else — it does not load a `.env`
file on its own. Node can do that for you:

```bash
node --env-file=.env lib/index.js
```

MCP clients pass the variables in their own configuration, and containers get them from the orchestrator. A `.env` is a convenience for running it by hand.

### The config file

Every collection you want reachable gets an entry. Three separate lists, because reading, filtering and sorting are three different permissions:

```json
{
  "version": 1,
  "databases": {
    "shop": {
      "collections": {
        "orders": {
          "allowedFields": [
            "_id",
            "number",
            "customerCode",
            "status",
            "placedAt",
            "total"
          ],
          "filterableFields": [
            "_id",
            "number",
            "customerCode",
            "status",
            "placedAt"
          ],
          "sortableFields": ["placedAt", "total"],
          "requiredFilter": { "deleted": { "$ne": true } }
        }
      }
    }
  }
}
```

**`allowedFields`** — the only fields that can ever be returned. A query with no projection gets exactly these, never the whole document. This is also the list
the server projects on, server-side, so unreadable fields never cross the wire.

**`filterableFields`** and **`sortableFields`** must be subsets of `allowedFields`, and both default to empty. A field is not filterable just
because it is readable: `total` might be safe to display and expensive to filter on without an index.

**`requiredFilter`** is `$and`-ed into every query and cannot be overridden — not by a filter naming the same field, not by an aggregation stage. It may key on
fields that are **not** in `allowedFields`, which is how you scope by a tenant identifier without exposing it.

> **Prefer `{ "$ne": true }` over `false` for soft-delete flags.** In MongoDB
> `{ deleted: false }` matches only documents where the field exists and is
> `false`. Records written before the flag existed have no field at all and
> silently vanish. `{ "$ne": true }` matches `false`, `null` and absent.

The whole file is validated at startup, including a scan of every `requiredFilter` for dangerous operators — a mistake there fails the boot with a
path, not the first query with a driver error.

## Tools

Four tools, one per operation. Each tool's description is generated from your config, so the model is told which fields it may use instead of guessing:

```
Find documents in a MongoDB collection.

Available collections:
shop.orders
  readable:   _id, number, customerCode, status, placedAt, total
  filterable: _id, number, customerCode, status, placedAt
  sortable:   placedAt, total
```

### `find`

| Argument                 | Type    | Notes                                         |
| ------------------------ | ------- | --------------------------------------------- |
| `database`, `collection` | string  | Required.                                     |
| `filter`                 | object  | Over filterable fields only.                  |
| `projection`             | object  | Inclusions only. `{ "field": 0 }` is refused. |
| `sort`                   | object  | `1` or `-1`, over sortable fields only.       |
| `limit`                  | integer | Clamped to `MCP_MAX_PAGE_SIZE`.               |
| `skip`                   | integer | For paging with `nextSkip`.                   |

### `aggregate`

Takes a `pipeline`. Read-only stages only; the scope filter and the projection are prepended, and a page limit is appended.

### `count`

Takes a `filter` and returns `{ "count": n }`, scoped like everything else.

### `distinct`

Takes a `field` and an optional `filter`.

### What comes back

Extended JSON with a pagination envelope, so BSON types survive the trip and can be sent straight back in a filter:

```json
{
  "documents": [
    {
      "_id": { "$oid": "6a9d192c31f0a4f251d920bb" },
      "number": "ORD-2026-0103",
      "placedAt": { "$date": "2026-08-01T09:00:00Z" },
      "total": { "$numberDecimal": "11768.04" }
    }
  ],
  "returned": 1,
  "hasMore": true,
  "nextSkip": 1
}
```

That `$oid` can go straight back into `filter` and it will match — the server revives Extended JSON on the way in as well as rendering it on the way out.

A refusal comes back as an error payload with a `path`, so the model can correct itself rather than retry the same query:

```json
{
  "error": "The field \"iban\" is not filterable on this collection",
  "path": "filter"
}
```

## Resources

| URI                                            | Contents                                                                         |
| ---------------------------------------------- | -------------------------------------------------------------------------------- |
| `mongodb://collections`                        | Every database and collection the server exposes.                                |
| `mongodb://collection/{database}/{collection}` | Readable, filterable and sortable fields, plus whether the collection is scoped. |

Both are built from the config and never touch the cluster: they cannot fail, cannot be slow, and cannot become a second way to read what the tools refuse.
The per-collection resource reports `scoped: true` but never the contents of `requiredFilter` — that is where tenant identifiers live.

## Connecting a client

All examples use absolute paths. A client starts the server as a subprocess from its own working directory, not from your project, so relative paths will not
resolve.

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, `%APPDATA%\Claude\claude_desktop_config.json` on Windows:

```json
{
  "mcpServers": {
    "mongodb": {
      "command": "npx",
      "args": ["-y", "mcp-mongodb"],
      "env": {
        "MONGODB_URI": "mongodb://reader:password@localhost:27017/shop?authSource=shop",
        "MONGODB_ALLOWED_DATABASES": "shop",
        "MCP_CONFIG_PATH": "/absolute/path/to/config.json"
      }
    }
  }
}
```

Restart the app after editing.

### Claude Code

From your terminal, outside a session. Note the `--` separator: everything after it is the command to run.

```bash
claude mcp add mongodb \
  --env MONGODB_URI='mongodb://reader:password@localhost:27017/shop?authSource=shop' \
  --env MONGODB_ALLOWED_DATABASES=shop \
  --env MCP_CONFIG_PATH=/absolute/path/to/config.json \
  -- npx -y mcp-mongodb

claude mcp list      # ✔ Connected
```

Add `--scope user` for all your projects, or `--scope project` to write it to `.mcp.json` and share it with the team. Keep credentials out of a committed
`.mcp.json`.

### VS Code and Cursor

`.vscode/mcp.json` — the top-level key is `servers`, not `mcpServers`:

```json
{
  "servers": {
    "mongodb": {
      "command": "npx",
      "args": ["-y", "mcp-mongodb"],
      "env": {
        "MONGODB_URI": "mongodb://reader:password@localhost:27017/shop?authSource=shop",
        "MONGODB_ALLOWED_DATABASES": "shop",
        "MCP_CONFIG_PATH": "/absolute/path/to/config.json"
      }
    }
  }
}
```

Cursor uses the same shape at `.cursor/mcp.json`. Both support `${input:...}` variables for secrets rather than literals in the file.

### MCP Inspector

The fastest way to see raw requests and responses while developing:

```bash
npx @modelcontextprotocol/inspector npx tsx index.ts
```

### HTTP transport

For a server other machines reach over the network:

```bash
MCP_TRANSPORT=http \
MCP_HTTP_PORT=3000 \
MCP_HTTP_AUTH_TOKEN="$(openssl rand -hex 32)" \
MCP_HTTP_ALLOWED_HOSTS='mcp.internal.example.com' \
npx mcp-mongodb
```

The endpoint is `/mcp` and every request needs `Authorization: Bearer <token>`. **The server refuses to start without `MCP_HTTP_AUTH_TOKEN`**: over stdio the
client is whoever launched the process, but an open HTTP port in front of a database is not a state you should reach by forgetting something.

Set `MCP_HTTP_ALLOWED_HOSTS` too. It turns on DNS-rebinding protection, without which a browser on someone else's machine can resolve a hostname to `127.0.0.1`
and reach your port through their network.

TLS is not terminated here — put it behind a reverse proxy.

In Claude Code:

```bash
claude mcp add --transport http mongodb https://mcp.internal.example.com/mcp \
  --header "Authorization: Bearer $TOKEN"
```

## How a query is handled

Five steps, in this order, for every tool call:

|     | Step         | What it does                                                                                                                                 |
| --- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Parse**    | Arguments become a typed command. Four operations, closed set.                                                                               |
| 2   | **Validate** | Operators, stages, joined collections and every field path are checked against the allowlists. Anything not explicitly permitted is refused. |
| 3   | **Enforce**  | The required filter is `$and`-ed in, the projection is built from `allowedFields`, the page size is clamped, a deadline is attached.         |
| 4   | **Execute**  | The driver receives a plan that is already safe. It makes no decisions.                                                                      |
| 5   | **Render**   | Extended JSON, trimmed to the byte budget, with `hasMore` so the model can page.                                                             |

Step 2 only ever **rejects**. Step 3 only ever **rewrites**. Keeping them apart is what makes the second one possible to reason about: a projection that is
merely validated is no projection at all when the caller sends none.

## What is always refused

- **Server-side JavaScript**: `$where`, `$function`, `$accumulator`, `$code` — anywhere in the command, however deeply nested
- **`$out` and `$merge`**, regardless of any setting: a write belongs in an explicit write operation, not appended to a read pipeline
- **Exclusion projections** such as `{ "secret": 0 }`, which return everything _except_ the named field — the exact inverse of an allowlist
- **`$$ROOT` and `$$CURRENT`**, which hand back the whole document
- **`$lookup` in `localField`/`foreignField` form into a scoped collection** — that form has no pipeline, so there is nowhere to inject the foreign
  collection's scope. The pipeline form is required and gets scoped properly.
- **`$graphLookup` into a scoped collection**, whose recursive traversal cannot be constrained at all
- **Introspection stages**: `$collStats`, `$indexStats`, `$currentOp`, `$planCacheStats` and friends, which leak cluster topology
- **Prototype-polluting keys**: `__proto__`, `constructor`, `prototype`

The stage list is an allowlist, not a denylist: a stage added by a future MongoDB release is refused until someone adds it deliberately.

## The demo environment

`demo/` holds a disposable MongoDB with a fixture built to make each guarantee observable. See [demo/README.md](./demo/README.md) for the details.

```bash
npm run demo:up # MongoDB, seeded, plus a read-only user
npm run demo:reset # wipe the volume and reseed
npm run demo:down
```

The fixture is deterministic: 5 customers, 8 products, 120 orders, 48 invoices. Twelve orders deliberately have no `deleted` field, so `{ deleted: false }` finds
101 where `{ "$ne": true }` finds 113 — the soft-delete trap, reproducible.

## Development

```bash
npm test # unit tests
npm run test:watch
npm run test:coverage
npm run test:integration # needs `npm run demo:up`

npm run typecheck
npm run lint
npm run lint:fix

npm run build # emits lib/
```

Unit tests live beside the source in `test/` and touch nothing external. The integration suite runs against the demo fixture and **skips itself** when the
database is not reachable: a missing environment is a missing environment, not a broken build.

Coverage is measured over `src/` and `index.ts` only — counting the tests and the demo would inflate the number without saying anything about the code that ships.
`mongo.ts` is covered by the integration suite, so the figure is low when it is skipped.

## Architecture

| Module                                           | Responsibility                                                                                            |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `index.ts`                                       | Composition root. The only place that reads the environment, opens the config file and builds the logger. |
| `src/mcp-core.ts`                                | Registers the tools and resources. Reads no environment, creates no logger, starts no transport.          |
| `src/validator.ts`                               | Decides whether a command is allowed. Only ever rejects.                                                  |
| `src/enforcer.ts`                                | Turns an allowed command into an execution plan. The only place permitted to add constraints.             |
| `src/mongo.ts`                                   | Runs the plan. Makes no decisions.                                                                        |
| `src/response.ts`                                | Extended JSON, the byte budget, the pagination envelope.                                                  |
| `src/bson.ts`                                    | Both directions of the BSON boundary.                                                                     |
| `src/operators.ts`                               | Every allowlist, as data, in one place.                                                                   |
| `src/config.ts`, `src/types.ts`, `src/logger.ts` | Schemas, validation and structured logging to stderr.                                                     |

`createMongoMcpServer(deps)` takes its dependencies rather than building them, which is what makes the whole query layer testable without a cluster.

## Security notes

**The database user is the first line of defence, not this code.** Give it the `read` role on the exposed databases and nothing more. A connection with no write
privilege cannot write, whatever a bug in this repository might allow.

**Field allowlisting protects fields, not content.** If a free-text field is readable because it needs to be, and someone typed an IBAN into it, that IBAN
comes out — the server did exactly its job. The same goes for a `$regex` over a permitted field used to extract data a character at a time.

**Logging goes to stderr only**, because under the stdio transport stdout is the JSON-RPC channel. The connection string, tokens and authorization headers are
redacted. Driver errors are logged in full and reduced to a generic message before they reach the model: a `MongoServerError` can carry hostnames and
replica-set topology.

**What this server does not do yet**: per-caller identity (the scope filter is static, taken from the config, not from who is asking), an audit trail, and rate
limiting. If you are pointing it at data that matters, read those three lines twice.

## License

MIT © Davide D'Antonio
