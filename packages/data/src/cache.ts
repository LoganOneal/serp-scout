import 'server-only'
import { inArray, sql } from 'drizzle-orm'
import type { AvailabilityResult } from './providers/rdap.js'
import type { DomainAuthority, MapPackSnapshot, SerpSnapshot } from '@rnr/core'
import { TTL_DAYS } from '@rnr/core'
import type { Database } from './db.js'
import { domainAuthority, domainAvailability, serpSnapshots } from './schema.js'

/**
 * Cache reads and writes.
 *
 * Everything here is cache-FIRST except outcome rank checks, which deliberately
 * are not -- see checkOutcomeRank in outcomes.ts. A cached snapshot predates the
 * built site by definition, so serving it to a rank check records every build as
 * never having ranked.
 */

const daysFromNow = (days: number): Date => new Date(Date.now() + days * 86_400_000)

// ---------------------------------------------------------------------------
// SERP snapshots
// ---------------------------------------------------------------------------

export async function readSerpCache(
  db: Database,
  key: { keyword: string; locationCode: number; seType: 'organic' | 'maps' },
): Promise<{ payload: unknown; source: string } | null> {
  const rows = await db
    .select({ payload: serpSnapshots.payload, source: serpSnapshots.source })
    .from(serpSnapshots)
    .where(
      sql`${serpSnapshots.keyword} = ${key.keyword}
          AND ${serpSnapshots.locationCode} = ${key.locationCode}
          AND ${serpSnapshots.seType} = ${key.seType}
          AND ${serpSnapshots.expiresAt} > now()`,
    )
    .limit(1)
  return rows[0] ?? null
}

export async function writeSerpCache(
  db: Database,
  args: {
    keyword: string
    locationCode: number
    seType: 'organic' | 'maps'
    payload: SerpSnapshot | MapPackSnapshot
    costMicros: bigint
    source: 'live' | 'fixture'
  },
): Promise<void> {
  await db
    .insert(serpSnapshots)
    .values({
      keyword: args.keyword,
      locationCode: args.locationCode,
      seType: args.seType,
      payload: args.payload as unknown as object,
      expiresAt: daysFromNow(TTL_DAYS.serpSnapshot),
      costMicros: args.costMicros,
      source: args.source,
    })
    .onConflictDoUpdate({
      target: [serpSnapshots.keyword, serpSnapshots.locationCode, serpSnapshots.seType],
      set: {
        payload: args.payload as unknown as object,
        fetchedAt: new Date(),
        expiresAt: daysFromNow(TTL_DAYS.serpSnapshot),
        costMicros: args.costMicros,
        source: args.source,
      },
    })
}

// ---------------------------------------------------------------------------
// Domain authority, with the negative cache
// ---------------------------------------------------------------------------

export interface AuthorityCacheRead {
  /** Domains with real measurements. */
  hits: Map<string, DomainAuthority>
  /**
   * Domains known to have NO data, still inside the negative-cache window.
   * These must NOT be re-requested, and must NOT be treated as zero-authority.
   */
  knownUnresolved: Set<string>
  /** Domains we have nothing fresh for. These are what to actually buy. */
  misses: string[]
}

export async function readAuthorityCache(
  db: Database,
  targets: string[],
): Promise<AuthorityCacheRead> {
  const unique = [...new Set(targets.map((t) => t.toLowerCase()))].filter(Boolean)
  const hits = new Map<string, DomainAuthority>()
  const knownUnresolved = new Set<string>()
  if (unique.length === 0) return { hits, knownUnresolved, misses: [] }

  const rows = await db
    .select()
    .from(domainAuthority)
    .where(sql`${domainAuthority.target} IN ${sql`(${sql.join(unique.map((u) => sql`${u}`), sql`, `)})`}
               AND ${domainAuthority.expiresAt} > now()`)

  for (const r of rows) {
    if (!r.resolved) {
      knownUnresolved.add(r.target)
      continue
    }
    hits.set(r.target, {
      target: r.target,
      rank: r.rank,
      referringDomains: r.referringDomains,
      referringDomainsNofollow: r.referringDomainsNofollow,
      referringMainDomains: r.referringMainDomains,
      spamScore: r.spamScore,
      sources: (r.sources ?? []) as DomainAuthority['sources'],
    })
  }

  const misses = unique.filter((t) => !hits.has(t) && !knownUnresolved.has(t))
  return { hits, knownUnresolved, misses }
}

export async function writeAuthorityCache(
  db: Database,
  args: { authorities: Map<string, DomainAuthority>; unresolved: string[] },
): Promise<void> {
  const rows = [
    ...[...args.authorities.values()].map((a) => ({
      target: a.target,
      rank: a.rank,
      referringDomains: a.referringDomains,
      referringDomainsNofollow: a.referringDomainsNofollow,
      referringMainDomains: a.referringMainDomains,
      spamScore: a.spamScore,
      sources: a.sources,
      resolved: true,
      measuredAt: new Date(),
      expiresAt: daysFromNow(TTL_DAYS.domainAuthority),
    })),
    // The NEGATIVE cache. Short TTL, and `resolved: false` so a reader can never
    // mistake "we asked and there was nothing" for "this domain has no links".
    ...args.unresolved.map((target) => ({
      target: target.toLowerCase(),
      rank: null,
      referringDomains: null,
      referringDomainsNofollow: null,
      referringMainDomains: null,
      spamScore: null,
      sources: [] as string[],
      resolved: false,
      measuredAt: new Date(),
      expiresAt: daysFromNow(TTL_DAYS.domainAuthorityUnresolved),
    })),
  ]
  if (rows.length === 0) return

  for (const row of rows) {
    await db
      .insert(domainAuthority)
      .values(row)
      .onConflictDoUpdate({ target: domainAuthority.target, set: row })
  }
}

// ---------------------------------------------------------------------------
// Domain availability
// ---------------------------------------------------------------------------

export async function readAvailabilityCache(
  db: Database,
  domains: string[],
): Promise<Map<string, AvailabilityResult>> {
  const unique = [...new Set(domains.map((d) => d.toLowerCase()))].filter(Boolean)
  const out = new Map<string, AvailabilityResult>()
  if (unique.length === 0) return out

  const rows = await db
    .select()
    .from(domainAvailability)
    .where(
      sql`${domainAvailability.domain} IN ${sql`(${sql.join(unique.map((u) => sql`${u}`), sql`, `)})`}
          AND ${domainAvailability.expiresAt} > now()`,
    )

  for (const r of rows) {
    out.set(r.domain, {
      domain: r.domain,
      available: r.available,
      method: (r.method as AvailabilityResult['method']) ?? 'none',
      httpStatus: r.httpStatus,
      detail: r.detail ?? '',
    })
  }
  return out
}

export async function writeAvailabilityCache(
  db: Database,
  results: Iterable<AvailabilityResult>,
): Promise<void> {
  for (const r of results) {
    const row = {
      domain: r.domain.toLowerCase(),
      available: r.available,
      method: r.method,
      httpStatus: r.httpStatus,
      detail: r.detail,
      checkedAt: new Date(),
      // Short TTL. Unlike link profiles, availability changes overnight --
      // someone else registers it, or a registration lapses.
      expiresAt: daysFromNow(TTL_DAYS.domainAvailability),
    }
    await db
      .insert(domainAvailability)
      .values(row)
      .onConflictDoUpdate({ target: domainAvailability.domain, set: row })
  }
}

/** Housekeeping. Safe to run any time; expired rows are never read. */
export async function purgeExpired(db: Database): Promise<void> {
  await db.delete(serpSnapshots).where(sql`${serpSnapshots.expiresAt} < now() - interval '30 days'`)
  await db
    .delete(domainAuthority)
    .where(sql`${domainAuthority.expiresAt} < now() - interval '30 days'`)
  await db
    .delete(domainAvailability)
    .where(sql`${domainAvailability.expiresAt} < now() - interval '30 days'`)
}

export { inArray }
