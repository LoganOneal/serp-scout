import 'server-only'
import { sql } from 'drizzle-orm'
import type { Database } from '../db.js'
import { hhtOppOpportunities, hhtOppOutreachEvents } from '../schema.js'
import { updateHhtOppStatus } from './queries.js'

export interface OutreachInput {
  opportunityId: number
  dateSent?: Date | null
  channel?: string | null
  reply?: boolean | null
  positiveReply?: boolean | null
  priceQuoted?: number | null
  linkAcquired?: boolean | null
  linkUrl?: string | null
  targetHhtUrl?: string | null
  finalCost?: number | null
  linkAttribute?: string | null
  liveDate?: Date | null
  notes?: string | null
}

export async function recordHhtOppOutreach(db: Database, input: OutreachInput): Promise<number> {
  const inserted = await db
    .insert(hhtOppOutreachEvents)
    .values({
      opportunityId: input.opportunityId,
      dateSent: input.dateSent ?? null,
      channel: input.channel ?? null,
      reply: input.reply ?? null,
      positiveReply: input.positiveReply ?? null,
      priceQuoted: input.priceQuoted ?? null,
      linkAcquired: input.linkAcquired ?? null,
      linkUrl: input.linkUrl ?? null,
      targetHhtUrl: input.targetHhtUrl ?? null,
      finalCost: input.finalCost ?? null,
      linkAttribute: input.linkAttribute ?? null,
      liveDate: input.liveDate ?? null,
      notes: input.notes ?? null,
    })
    .returning({ id: hhtOppOutreachEvents.id })

  if (input.dateSent) await updateHhtOppStatus(db, input.opportunityId, 'CONTACTED')
  if (input.linkAcquired) await updateHhtOppStatus(db, input.opportunityId, 'PLACED')
  return inserted[0]!.id
}

export async function listHhtOppOutreach(db: Database, opportunityId?: number) {
  if (opportunityId) {
    return db.select().from(hhtOppOutreachEvents).where(sql`${hhtOppOutreachEvents.opportunityId} = ${opportunityId}`)
  }
  return db.select().from(hhtOppOutreachEvents).limit(200)
}

export async function hhtOppOutcomeStats(db: Database) {
  const byType = await db
    .select({
      key: hhtOppOpportunities.opportunityType,
      sent: sql<number>`count(*) filter (where ${hhtOppOutreachEvents.dateSent} is not null)::int`,
      replies: sql<number>`count(*) filter (where ${hhtOppOutreachEvents.reply} = true)::int`,
      acquired: sql<number>`count(*) filter (where ${hhtOppOutreachEvents.linkAcquired} = true)::int`,
      avgCost: sql<number | null>`avg(${hhtOppOutreachEvents.finalCost}) filter (where ${hhtOppOutreachEvents.finalCost} is not null)`,
      avgAuthority: sql<number | null>`null`,
    })
    .from(hhtOppOutreachEvents)
    .innerJoin(hhtOppOpportunities, sql`${hhtOppOpportunities.id} = ${hhtOppOutreachEvents.opportunityId}`)
    .groupBy(hhtOppOpportunities.opportunityType)

  const byStrategy = await db
    .select({
      key: hhtOppOpportunities.discoveredByStrategy,
      sent: sql<number>`count(*) filter (where ${hhtOppOutreachEvents.dateSent} is not null)::int`,
      replies: sql<number>`count(*) filter (where ${hhtOppOutreachEvents.reply} = true)::int`,
      acquired: sql<number>`count(*) filter (where ${hhtOppOutreachEvents.linkAcquired} = true)::int`,
      avgCost: sql<number | null>`avg(${hhtOppOutreachEvents.finalCost}) filter (where ${hhtOppOutreachEvents.finalCost} is not null)`,
    })
    .from(hhtOppOutreachEvents)
    .innerJoin(hhtOppOpportunities, sql`${hhtOppOpportunities.id} = ${hhtOppOutreachEvents.opportunityId}`)
    .groupBy(hhtOppOpportunities.discoveredByStrategy)

  return {
    byType: byType.map((row) => ({ ...row, replyRate: row.sent ? row.replies / row.sent : 0, acquireRate: row.sent ? row.acquired / row.sent : 0 })),
    byStrategy: byStrategy.map((row) => ({
      ...row,
      replyRate: row.sent ? row.replies / row.sent : 0,
      acquireRate: row.sent ? row.acquired / row.sent : 0,
    })),
  }
}
