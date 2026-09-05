import { sql } from 'drizzle-orm'
import type { Database } from '../../db.js'
import { omSemrushCache } from '../../schema.js'

export async function readOmCache(db: Database, cacheKey: string): Promise<unknown | null> {
  const rows = await db
    .select({ payload: omSemrushCache.payload })
    .from(omSemrushCache)
    .where(sql`${omSemrushCache.cacheKey} = ${cacheKey} AND ${omSemrushCache.expiresAt} > now()`)
    .limit(1)
  return rows[0]?.payload ?? null
}

export async function writeOmCache(
  db: Database,
  args: { cacheKey: string; report: string; payload: unknown; ttlDays: number },
): Promise<void> {
  const expiresAt = new Date(Date.now() + args.ttlDays * 86_400_000)
  await db
    .insert(omSemrushCache)
    .values({
      cacheKey: args.cacheKey,
      report: args.report,
      payload: args.payload,
      expiresAt,
    })
    .onConflictDoUpdate({
      target: omSemrushCache.cacheKey,
      set: { payload: args.payload, report: args.report, fetchedAt: new Date(), expiresAt },
    })
}

export async function dropExpiredOmCache(db: Database): Promise<number> {
  const res = await db.delete(omSemrushCache).where(sql`${omSemrushCache.expiresAt} <= now()`)
  return Number((res as { count?: number }).count ?? 0)
}

export async function cacheStats(db: Database): Promise<{ rows: number }> {
  const rows = await db.select({ n: sql<number>`count(*)` }).from(omSemrushCache)
  return { rows: Number(rows[0]?.n ?? 0) }
}
