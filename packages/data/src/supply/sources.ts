import 'server-only'
import { eq } from 'drizzle-orm'
import type { Database } from '../db.js'
import { supplySources, type SupplySource } from '../schema.js'
import { SupplyClient } from './client.js'

export class SupplySourceError extends Error {}

export interface ConnectSourceArgs {
  siteId: number
  baseUrl: string
  /**
   * The NAME of the env var, not the token.
   *
   * A secret stored in a row is a secret in every backup, every `pg_dump`, and
   * every screenshot of a debugging session. The row records where to find it.
   */
  tokenEnvVar?: string
  /** 'locality' | 'entity_set:<slug>' | null. See buildResolver. */
  entityKind?: string | null
  notes?: string | null
}

export async function connectSupplySource(
  db: Database,
  args: ConnectSourceArgs,
): Promise<SupplySource> {
  const baseUrl = args.baseUrl.trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(baseUrl)) {
    throw new SupplySourceError(`"${args.baseUrl}" is not an absolute http(s) URL.`)
  }
  /**
   * http is refused outright rather than warned about. The bearer token travels
   * on every request; over http it travels in plaintext to every hop between
   * here and the site, and a warning nobody reads is not a mitigation.
   */
  if (baseUrl.toLowerCase().startsWith('http://') && !/^https?:\/\/(localhost|127\.0\.0\.1)/i.test(baseUrl)) {
    throw new SupplySourceError(
      `Refusing to connect over plain http — the bearer token would cross the network in ` +
        `plaintext on every request. Use https (localhost is exempt).`,
    )
  }

  const values = {
    siteId: args.siteId,
    baseUrl,
    tokenEnvVar: args.tokenEnvVar?.trim() || 'SUPPLY_FEED_TOKEN',
    entityKind: args.entityKind === undefined ? 'locality' : args.entityKind,
    notes: args.notes?.trim() || null,
  }

  const [row] = await db
    .insert(supplySources)
    .values(values)
    .onConflictDoUpdate({
      target: [supplySources.siteId, supplySources.baseUrl],
      set: {
        tokenEnvVar: values.tokenEnvVar,
        entityKind: values.entityKind,
        notes: values.notes,
        active: true,
        updatedAt: new Date(),
      },
    })
    .returning()

  if (!row) throw new SupplySourceError(`failed to connect ${baseUrl}`)
  return row
}

export async function listSupplySources(db: Database, siteId?: number): Promise<SupplySource[]> {
  const q = db.select().from(supplySources)
  return siteId === undefined ? q : q.where(eq(supplySources.siteId, siteId))
}

export async function getSupplySource(db: Database, id: number): Promise<SupplySource | null> {
  const [row] = await db.select().from(supplySources).where(eq(supplySources.id, id)).limit(1)
  return row ?? null
}

export interface SourceCheckResult {
  ok: boolean
  detail: string
  schemaVersion: number | null
  totalItems: number | null
  totalSuppliers: number | null
  invalidItems: number | null
}

/**
 * Reach the feed and report what it says, without writing anything.
 *
 * Free, and the first thing to run after connecting a source: it separates the
 * four things that all look like "no supply" from each other — unreachable,
 * unauthorised, no token configured on their side, and a genuinely empty
 * catalogue.
 */
export async function checkSupplySource(
  db: Database,
  id: number,
  opts: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv } = {},
): Promise<SourceCheckResult> {
  const source = await getSupplySource(db, id)
  if (!source) throw new SupplySourceError(`No supply source #${id}`)

  const env = opts.env ?? process.env
  const token = env[source.tokenEnvVar]?.trim()
  const empty = { schemaVersion: null, totalItems: null, totalSuppliers: null, invalidItems: null }

  if (!token) {
    return {
      ok: false,
      detail: `${source.tokenEnvVar} is not set here. Nothing was requested.`,
      ...empty,
    }
  }

  const client = new SupplyClient({
    baseUrl: source.baseUrl,
    token,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  })

  try {
    const m = await client.manifest()
    return {
      ok: true,
      detail:
        `${m.totalItems} item(s) across ${m.totalSuppliers} supplier(s)` +
        (m.invalidItems ? `, ${m.invalidItems} refused by the feed's own validation` : '') +
        (m.lastModified ? `, last modified ${m.lastModified}` : ''),
      schemaVersion: m.schemaVersion ?? null,
      totalItems: m.totalItems ?? null,
      totalSuppliers: m.totalSuppliers ?? null,
      invalidItems: m.invalidItems ?? null,
    }
  } catch (e) {
    return { ok: false, detail: (e as Error).message, ...empty }
  }
}
