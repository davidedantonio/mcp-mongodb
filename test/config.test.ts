import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { loadConfig, validate } from './../src/config.js'
import { EnvSchema, type EnvType } from './../src/types.js'

let dir: string

const write = async (name: string, body: unknown): Promise<string> => {
  const path = join(dir, name)
  await writeFile(path, typeof body === 'string' ? body : JSON.stringify(body))
  return path
}

const envFor = (configPath?: string): EnvType =>
  EnvSchema.parse({
    MONGODB_URI: 'mongodb://localhost:27017',
    MONGODB_ALLOWED_DATABASES: 'demo,other',
    ...(configPath === undefined ? {} : { MCP_CONFIG_PATH: configPath })
  })

const collection = {
  allowedFields: ['_id', 'name'],
  filterableFields: ['name'],
  sortableFields: [],
  requiredFilter: { deleted: { $ne: true } }
}

const configFor = (databases: Record<string, unknown>) => ({
  version: 1,
  databases
})

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mcp-mongodb-config-'))
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('validate', () => {
  it('returns the parsed value when the input is good', () => {
    expect(validate(z.object({ a: z.number() }), { a: 1 }, 'label')).toEqual({
      a: 1
    })
  })

  it('names the failing paths without echoing their values', () => {
    const schema = z.object({ token: z.string().min(40) })

    expect(() => validate(schema, { token: 'hunter2' }, 'Bad config')).toThrow(
      /Bad config: check token/
    )
    expect(() =>
      validate(schema, { token: 'hunter2' }, 'Bad config')
    ).not.toThrow(/hunter2/)
  })

  it('lists each failing path once', () => {
    const schema = z.object({ a: z.string(), b: z.string() })

    expect(() => validate(schema, {}, 'X')).toThrow(/check a, b/)
  })
})

describe('loadConfig', () => {
  it('exposes nothing when no config path is set', async () => {
    const config = await loadConfig(envFor())

    expect(config).toEqual({ version: 1, databases: {} })
  })

  it('fails when the configured path does not exist', async () => {
    await expect(loadConfig(envFor(join(dir, 'missing.json')))).rejects.toThrow(
      /Failed to read config file/
    )
  })

  it('fails on malformed JSON', async () => {
    const path = await write('broken.json', '{ not json')

    await expect(loadConfig(envFor(path))).rejects.toThrow(/Failed to parse/)
  })

  it('loads a valid config', async () => {
    const path = await write(
      'good.json',
      configFor({ demo: { collections: { customers: collection } } })
    )
    const config = await loadConfig(envFor(path))

    expect(Object.keys(config.databases)).toEqual(['demo'])
  })

  it('refuses a database the environment does not allow', async () => {
    const path = await write(
      'stranger.json',
      configFor({ admin: { collections: { customers: collection } } })
    )

    await expect(loadConfig(envFor(path))).rejects.toThrow(/is not allowed/)
  })

  it('refuses server-side JavaScript in a requiredFilter', async () => {
    const path = await write(
      'js.json',
      configFor({
        demo: {
          collections: {
            customers: { ...collection, requiredFilter: { $where: 'true' } }
          }
        }
      })
    )

    await expect(loadConfig(envFor(path))).rejects.toThrow(/JavaScript/)
  })

  it('names the collection whose requiredFilter is unsafe', async () => {
    const path = await write(
      'js-named.json',
      configFor({
        demo: {
          collections: {
            customers: collection,
            orders: { ...collection, requiredFilter: { $where: 'true' } }
          }
        }
      })
    )

    await expect(loadConfig(envFor(path))).rejects.toThrow(/demo\.orders/)
  })

  it('refuses a write stage hidden in a requiredFilter', async () => {
    const path = await write(
      'out.json',
      configFor({
        demo: {
          collections: {
            customers: { ...collection, requiredFilter: { $out: 'stolen' } }
          }
        }
      })
    )

    await expect(loadConfig(envFor(path))).rejects.toThrow(/writes/)
  })

  it('accepts an ordinary scope filter', async () => {
    const path = await write(
      'scoped.json',
      configFor({
        demo: {
          collections: {
            customers: {
              ...collection,
              requiredFilter: { tenantId: 'acme', deleted: { $ne: true } }
            }
          }
        }
      })
    )

    await expect(loadConfig(envFor(path))).resolves.toBeDefined()
  })
})
