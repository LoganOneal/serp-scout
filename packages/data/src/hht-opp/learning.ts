import 'server-only'
import { proposeStrategyRecommendations } from '@rnr/core'
import { desc, eq } from 'drizzle-orm'
import type { Database } from '../db.js'
import { hhtOppStrategyRecommendations } from '../schema.js'
import { hhtOppOutcomeStats } from './outcomes.js'
import { strategyYield } from './queries.js'

export async function generateHhtOppRecommendations(db: Database) {
  const [yields, outcomes] = await Promise.all([strategyYield(db), hhtOppOutcomeStats(db)])
  const proposed = proposeStrategyRecommendations({
    yields,
    outcomesByType: outcomes.byType,
    outcomesByStrategy: outcomes.byStrategy,
  })

  for (const rec of proposed) {
    const [existing] = await db
      .select({ id: hhtOppStrategyRecommendations.id })
      .from(hhtOppStrategyRecommendations)
      .where(eq(hhtOppStrategyRecommendations.summary, rec.summary))
      .limit(1)
    if (existing) {
      await db
        .update(hhtOppStrategyRecommendations)
        .set({ rationale: rec.rationale, evidence: rec.evidence, updatedAt: new Date() })
        .where(eq(hhtOppStrategyRecommendations.id, existing.id))
      continue
    }
    await db.insert(hhtOppStrategyRecommendations).values({
      summary: rec.summary,
      rationale: rec.rationale,
      evidence: rec.evidence,
      status: 'proposed',
    })
  }

  return listHhtOppRecommendations(db)
}

export async function listHhtOppRecommendations(db: Database) {
  return db.select().from(hhtOppStrategyRecommendations).orderBy(desc(hhtOppStrategyRecommendations.updatedAt)).limit(30)
}

export async function setHhtOppRecommendationStatus(
  db: Database,
  id: number,
  status: 'proposed' | 'approved' | 'dismissed',
): Promise<void> {
  await db
    .update(hhtOppStrategyRecommendations)
    .set({ status, updatedAt: new Date() })
    .where(eq(hhtOppStrategyRecommendations.id, id))
}
