import 'server-only'
import {
  DEFAULT_HHT_OPP_COMPETITORS,
  DEFAULT_HHT_OPP_SCORE_WEIGHTS,
  normalizeCompetitorList,
  normalizeWeights,
  type HhtOppScoreWeights,
} from '@rnr/core'
import { desc, eq } from 'drizzle-orm'
import type { Database } from '../db.js'
import { hhtOppSettings } from '../schema.js'

export interface HhtOppSettingsRow {
  weights: HhtOppScoreWeights
  competitors: string[]
}

async function settingsRow(db: Database) {
  const rows = await db.select().from(hhtOppSettings).orderBy(desc(hhtOppSettings.id)).limit(1)
  return rows[0] ?? null
}

export async function getHhtOppScoreWeights(db: Database): Promise<HhtOppScoreWeights> {
  const row = await settingsRow(db)
  return normalizeWeights(row?.scoreWeights ?? DEFAULT_HHT_OPP_SCORE_WEIGHTS)
}

export async function getHhtOppCompetitors(db: Database): Promise<string[]> {
  const row = await settingsRow(db)
  const stored = normalizeCompetitorList(row?.competitorDomains ?? [])
  return stored.length ? stored : [...DEFAULT_HHT_OPP_COMPETITORS]
}

export async function getHhtOppSettings(db: Database): Promise<HhtOppSettingsRow> {
  return { weights: await getHhtOppScoreWeights(db), competitors: await getHhtOppCompetitors(db) }
}

export async function saveHhtOppScoreWeights(db: Database, weights: HhtOppScoreWeights): Promise<HhtOppScoreWeights> {
  const normalized = normalizeWeights(weights)
  const existing = await settingsRow(db)
  if (existing) {
    await db
      .update(hhtOppSettings)
      .set({ scoreWeights: normalized, updatedAt: new Date() })
      .where(eq(hhtOppSettings.id, existing.id))
  } else {
    await db.insert(hhtOppSettings).values({ scoreWeights: normalized, competitorDomains: [...DEFAULT_HHT_OPP_COMPETITORS] })
  }
  return normalized
}

export async function saveHhtOppCompetitors(db: Database, domains: Iterable<string>): Promise<string[]> {
  const competitors = normalizeCompetitorList(domains)
  const existing = await settingsRow(db)
  if (existing) {
    await db
      .update(hhtOppSettings)
      .set({ competitorDomains: competitors, updatedAt: new Date() })
      .where(eq(hhtOppSettings.id, existing.id))
  } else {
    await db.insert(hhtOppSettings).values({
      scoreWeights: DEFAULT_HHT_OPP_SCORE_WEIGHTS,
      competitorDomains: competitors,
    })
  }
  return competitors
}
