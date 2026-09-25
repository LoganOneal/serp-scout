import 'server-only'
import { eq, sql } from 'drizzle-orm'
import {
  generateHhtPxKeywords,
  hhtPxGeographyKey,
  initialHhtPxGeographies,
  HHT_PX_KEYWORD_TEMPLATES,
} from '@rnr/core'
import type { Database } from '../db.js'
import { hhtPxGeographies, hhtPxKeywordTemplates, hhtPxKeywords } from '../schema.js'

function chunks<T>(rows: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size))
  return out
}

export async function seedHhtPxGeographies(database: Database): Promise<number> {
  const seeds = initialHhtPxGeographies()
  for (const batch of chunks(seeds, 50)) {
    await database
      .insert(hhtPxGeographies)
      .values(
        batch.map((geo) => ({
          name: geo.name,
          queryName: geo.queryName,
          normalizedName: geo.normalizedName,
          state: geo.state,
          stateCode: geo.stateCode ?? '',
          type: geo.type,
          hhtSlug: geo.hhtSlug,
          hotelCount: geo.hotelCount,
          privateHotTubCount: geo.privateHotTubCount,
          sharedHotTubCount: geo.sharedHotTubCount,
          editorsChoiceCount: geo.editorsChoiceCount,
          active: geo.active,
          priority: geo.priority,
        })),
      )
      .onConflictDoUpdate({
        target: [hhtPxGeographies.type, hhtPxGeographies.normalizedName, hhtPxGeographies.stateCode],
        set: {
          name: sql`excluded.name`,
          queryName: sql`excluded.query_name`,
          state: sql`excluded.state`,
          hhtSlug: sql`excluded.hht_slug`,
          hotelCount: sql`excluded.hotel_count`,
          privateHotTubCount: sql`excluded.private_hot_tub_count`,
          sharedHotTubCount: sql`excluded.shared_hot_tub_count`,
          editorsChoiceCount: sql`excluded.editors_choice_count`,
          active: sql`excluded.active`,
          priority: sql`excluded.priority`,
          updatedAt: new Date(),
        },
      })
  }

  const rows = await database.select().from(hhtPxGeographies)
  const byKey = new Map(rows.map((row) => [`${row.type}:${row.normalizedName}:${row.stateCode ?? ''}`, row]))
  for (const seed of seeds) {
    if (!seed.parentNormalizedName) continue
    const child = byKey.get(hhtPxGeographyKey({ ...seed, stateCode: seed.stateCode ?? '' }))
    const parent = rows.find(
      (row) => row.type === 'state' && row.normalizedName === seed.parentNormalizedName,
    )
    if (!child || !parent || child.parentGeoId === parent.id) continue
    await database
      .update(hhtPxGeographies)
      .set({ parentGeoId: parent.id, updatedAt: new Date() })
      .where(eq(hhtPxGeographies.id, child.id))
  }
  return rows.length
}

export async function seedHhtPxTemplates(database: Database): Promise<number> {
  for (const batch of chunks([...HHT_PX_KEYWORD_TEMPLATES], 80)) {
    await database
      .insert(hhtPxKeywordTemplates)
      .values(
        batch.map((row) => ({
          template: row.template,
          cluster: row.cluster,
          variantGroup: row.variantGroup,
          priority: row.priority,
          expectedLinkability: row.expectedLinkability,
          geographic: row.geographic,
          enabled: row.enabled,
        })),
      )
      .onConflictDoUpdate({
        target: [hhtPxKeywordTemplates.template],
        set: {
          cluster: sql`excluded.cluster`,
          variantGroup: sql`excluded.variant_group`,
          priority: sql`excluded.priority`,
          expectedLinkability: sql`excluded.expected_linkability`,
          geographic: sql`excluded.geographic`,
          enabled: sql`excluded.enabled`,
        },
      })
  }
  return (await database.select({ id: hhtPxKeywordTemplates.id }).from(hhtPxKeywordTemplates)).length
}

export async function generateHhtPxKeywordRows(database: Database): Promise<{ inserted: number; total: number }> {
  const [geos, templates] = await Promise.all([
    database.select().from(hhtPxGeographies),
    database.select().from(hhtPxKeywordTemplates),
  ])
  const geoSeeds = geos.map((geo) => ({
    name: geo.name,
    queryName: geo.queryName,
    normalizedName: geo.normalizedName,
    state: geo.state,
    stateCode: geo.stateCode,
    type: geo.type,
    parentNormalizedName: null,
    hhtSlug: geo.hhtSlug,
    hotelCount: geo.hotelCount,
    privateHotTubCount: geo.privateHotTubCount,
    sharedHotTubCount: geo.sharedHotTubCount,
    editorsChoiceCount: geo.editorsChoiceCount,
    active: geo.active,
    priority: geo.priority,
  }))
  const generated = generateHhtPxKeywords(
    templates.map((row) => ({
      template: row.template,
      cluster: row.cluster,
      variantGroup: row.variantGroup,
      priority: row.priority,
      expectedLinkability: row.expectedLinkability,
      geographic: row.geographic,
      enabled: row.enabled,
    })),
    geoSeeds,
  )

  const geoIdByKey = new Map(
    geos.map((geo) => [hhtPxGeographyKey({ type: geo.type, normalizedName: geo.normalizedName, stateCode: geo.stateCode }), geo.id]),
  )
  const templateIdByPhrase = new Map(templates.map((row) => [row.template, row.id]))
  const existing = await database.select({ keywordNorm: hhtPxKeywords.keywordNorm, geographyId: hhtPxKeywords.geographyId }).from(hhtPxKeywords)
  const existingKeys = new Set(existing.map((row) => `${row.keywordNorm}|${row.geographyId ?? 'national'}`))

  const fresh = generated.filter((row) => !existingKeys.has(`${row.keywordNorm}|${row.geographyKey ? geoIdByKey.get(row.geographyKey) ?? 'national' : 'national'}`))
  let inserted = 0
  for (const batch of chunks(fresh, 200)) {
    const values = batch.map((row) => ({
      geographyId: row.geographyKey ? geoIdByKey.get(row.geographyKey) ?? null : null,
      templateId: templateIdByPhrase.get(row.template) ?? null,
      keyword: row.keyword,
      keywordNorm: row.keywordNorm,
      cluster: row.cluster,
      variantGroup: row.variantGroup,
      source: row.source,
      priority: row.priority,
      expectedLinkability: row.expectedLinkability,
      promoted: row.source === 'template',
    }))
    if (values.length === 0) continue
    await database.insert(hhtPxKeywords).values(values).onConflictDoNothing()
    inserted += values.length
  }
  const total = (await database.select({ id: hhtPxKeywords.id }).from(hhtPxKeywords)).length
  return { inserted, total }
}
