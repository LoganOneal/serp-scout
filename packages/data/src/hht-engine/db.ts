import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as engineSchema from './schema.js'

export type EngineDatabase = ReturnType<typeof drizzle<typeof engineSchema>>

let cached: { db: EngineDatabase; sql: postgres.Sql } | null = null

export function getEngineDatabase(env: NodeJS.ProcessEnv = process.env): EngineDatabase {
  const rawUrl = resolveEngineDatabaseUrl(env['DATABASE_URL'], null)
  const url = normalizePostgresUrl(rawUrl)
  if (!cached) {
    const sql = postgres(url, { max: 5 })
    cached = { db: drizzle(sql, { schema: engineSchema }), sql }
  }
  return cached.db
}

export async function executeEngineSql(statement: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const rawUrl = env['DATABASE_URL']?.trim()
  if (!rawUrl) throw new Error('DATABASE_URL is not set')
  const client = postgres(normalizePostgresUrl(rawUrl), { max: 1 })
  try {
    await client.unsafe(statement)
  } finally {
    await client.end()
  }
}

export async function closeEngineDatabase(): Promise<void> {
  if (!cached) return
  const current = cached
  cached = null
  await current.sql.end()
}

/**
 * A Cloud Environment injects DATABASE_URL directly. A generated `.env` must
 * not replace that value: an unquoted `#` in the password cuts the host off
 * the file while the injected value is still complete.
 *
 * Local passwords may contain URL-reserved characters. Preserve already
 * percent-encoded values and encode raw user-info characters before postgres-js
 * parses the connection string.
 */
export function resolveEngineDatabaseUrl(injected: string | undefined, fileValue: string | null): string {
  const fromEnv = injected?.trim()
  if (postgresUrlHost(fromEnv)) return fromEnv!
  const fromFile = fileValue?.trim()
  if (postgresUrlHost(fromFile)) return fromFile!
  throw new Error('DATABASE_URL is not set')
}

export function postgresUrlHost(raw: string | undefined | null): string | null {
  if (!raw || !/^postgres(?:ql)?:\/\//i.test(raw)) return null
  const at = raw.lastIndexOf('@')
  if (at < 0) return null
  const rest = raw.slice(at + 1)
  const slash = rest.indexOf('/')
  const hostPort = (slash === -1 ? rest : rest.slice(0, slash)).trim()
  return hostPort || null
}

export function normalizePostgresUrl(raw: string): string {
  if (!/^postgres(?:ql)?:\/\//i.test(raw)) return raw
  const schemeEnd = raw.indexOf('://') + 3
  const at = raw.lastIndexOf('@')
  const colon = raw.indexOf(':', schemeEnd)
  if (at <= schemeEnd || colon <= schemeEnd || colon >= at) return raw
  const password = raw.slice(colon + 1, at)
  const escaped = password
    .replace(/%(?![0-9a-f]{2})/gi, '%25')
    .replaceAll('#', '%23')
    .replaceAll('?', '%3F')
    .replaceAll('@', '%40')
    .replaceAll('/', '%2F')
  return `${raw.slice(0, colon + 1)}${escaped}${raw.slice(at)}`
}
