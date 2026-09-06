# Demo environment

A disposable MongoDB with a fixture built to exercise this server's guarantees, not just to have rows in it. Every deliberate quirk in the
data is there to make one security property observable.

## Quick start

Run these from the **project root**, not from `demo/`.

```bash
npm run demo:up                    # start MongoDB and seed it
docker compose -f demo/docker-compose.yml logs mongo | grep seeded

cp demo/.env.example .env          # or export the variables yourself
npx tsx index.ts                   # start the MCP server on stdio

npm run demo:reset                 # wipe and reseed from scratch
npm run demo:down                  # stop
```

## What gets seeded

Database `demo`, four collections, deterministic on every reset:

| Collection  | Documents | Notes                                             |
| ----------- | --------: | ------------------------------------------------- |
| `customers` |         5 | Italian, Swedish and French, retail and wholesale |
| `products`  |         8 | Three categories, one deactivated                 |
| `orders`    |       120 | 1–3 line items each, five statuses                |
| `invoices`  |        48 | One per shipped or delivered order                |

Money is `Decimal128`, dates are real `Date` values, and the foreign
keys are `ObjectId`: `invoices.orderId → orders`,
`orders.customerId → customers`, `orders.items.productId → products`.

## Fields the config deliberately hides

These exist in the data and are absent from `allowedFields`. If a query ever returns one, the allowlist has a hole:

- `customers.iban`, `customers.vatNumber`, `customers.creditLimit`
- `products.cost` — the margin
- `invoices.internalNote`

`deleted` is hidden too, and is still what every `requiredFilter` keys on. That combination is the point: the scope filter reads a field the
caller can never see.

## What the fixture is built to prove

| Try this                                    | Expected                                |
| ------------------------------------------- | --------------------------------------- |
| `find` on `orders`, no projection           | Only the allowed fields come back       |
| `find` on `orders`, no filter               | 113 documents, not 120                  |
| `find` filtering on `customers.iban`        | Refused — not filterable                |
| `find` with projection `{ total: 0 }`       | Refused — exclusion projections         |
| `aggregate` with `$where` nested in `$or`   | Refused — server-side JavaScript        |
| `aggregate` ending in `$out`                | Refused — writes to a collection        |
| `$replaceRoot` with `$$ROOT`                | Refused — returns the whole document    |
| `$lookup` with `localField`/`foreignField`  | Refused — use the pipeline form         |
| `$lookup` into `orders` with a sub-pipeline | Allowed, and scoped on the foreign side |
| `aggregate` with no `$limit`                | 50 documents, `hasMore: true`           |
| An `_id` copied from a result into a filter | Finds that document                     |

That last row is the Extended JSON round trip. An `_id` comes back as `{"$oid": "…"}`; without the revival step on the way in it would reach
MongoDB as a plain sub-document and match nothing, silently.

### The soft-delete trap, on purpose

Twelve orders have no `deleted` field at all — they stand for records written before the flag existed. This is why every `requiredFilter`
uses `{ "$ne": true }` rather than `false`:

| Filter                           | Orders found |
| -------------------------------- | -----------: |
| none                             |          120 |
| `{ "deleted": false }`           |          101 |
| `{ "deleted": { "$ne": true } }` |          113 |

Seven orders are genuinely deleted. The other twelve would simply vanish under the naive filter, and nothing would tell you.

## Two things that will confuse you

**The seed only runs on an empty volume.** MongoDB executes `/docker-entrypoint-initdb.d` scripts once, at first start. Editing
`seed.js` and restarting the container does nothing — use `npm run demo:reset`, which removes the volume first.

**Paths are resolved against your working directory.** The server calls `resolve(MCP_CONFIG_PATH)`, so `./demo/mcp.config.json` works from the
project root and breaks from inside `demo/`. The npm scripts handle this; running commands by hand does not.

## Pointing an MCP client at it

Add this to your client's config, with **absolute** paths — the client does not start from your working directory:

```json
{
  "mcpServers": {
    "mongodb-demo": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/mcp-mongodb/index.ts"],
      "env": {
        "MONGODB_URI": "mongodb://mcp_reader:mcp_reader_pw@localhost:27017/demo?authSource=demo",
        "MONGODB_ALLOWED_DATABASES": "demo",
        "MCP_CONFIG_PATH": "/absolute/path/to/mcp-mongodb/demo/mcp.config.json"
      }
    }
  }
}
```

## Credentials

The seed creates `mcp_reader`, which holds the `read` role on `demo` and nothing else. That is the outermost defence in this design and the
one worth copying into production: a connection with no write right cannot write, whatever a bug in the validator might allow. Try it —
connect as `mcp_reader` in `mongosh` and attempt an insert.

`root` / `root_pw` and `mcp_reader_pw` are throwaway values for a container bound to localhost. Nothing here is a template for a
deployment, and the HTTP transport in particular needs a real `MCP_HTTP_AUTH_TOKEN` of at least 32 characters — it refuses to start
without one.
