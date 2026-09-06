import { EJSON } from 'bson'

export function reviveBson<T>(value: T): T {
  return EJSON.deserialize(value as Record<string, unknown>) as T
}

export function renderBson(value: unknown, space = 2): string {
  return EJSON.stringify(value, undefined, space, { relaxed: true })
}
