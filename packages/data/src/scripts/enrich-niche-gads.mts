/**
 * Measure Google Ads national volume + competition for every active niche
 * (and optionally all primary research_keywords).
 *
 *   pnpm enrich:niche-gads
 *   pnpm enrich:niche-gads --keywords
 */
import 'dotenv/config'
import { and, eq } from 'drizzle-orm'
import { closeDb, db } from '../db.js'
import { niches, researchKeywords } from '../schema.js'
import {
  fetchKeywordVolumes,
  GOOGLE_ADS_GEO_US,
} from '../providers/google-ads/keyword-volume.js'

const alsoKeywords = process.argv.includes('--keywords')

async function main(): Promise<void> {
  const database = db()
  const nicheRows = await database
    .select()
    .from(niches)
    .where(eq(niches.active, true))

  console.log(`Enriching ${nicheRows.length} niches via Google Ads (US national)…`)

  const nicheKws = nicheRows.map((n) => n.keywordNoun)
  const nicheVol = await fetchKeywordVolumes(nicheKws, {
    live: true,
    geoTargetCriteriaIds: [GOOGLE_ADS_GEO_US],
  })
  console.log('niches source:', nicheVol.source, nicheVol.error ?? '')

  const byKw = new Map(
    nicheVol.rows.map((r) => [r.keyword.toLowerCase(), r] as const),
  )

  let nOk = 0
  for (const n of nicheRows) {
    const hit = byKw.get(n.keywordNoun.toLowerCase())
    await database
      .update(niches)
      .set({
        gadsAvgMonthlySearches: hit?.avgMonthlySearches ?? null,
        gadsCompetitionIndex: hit?.competitionIndex ?? null,
        gadsTopOfPageBidLowMicros: hit?.lowTopOfPageBidMicros ?? null,
        gadsTopOfPageBidHighMicros: hit?.highTopOfPageBidMicros ?? null,
        gadsKeyword: n.keywordNoun,
        gadsMeasuredAt: new Date(),
        gadsCompetition:
          hit?.competitionIndex == null
            ? null
            : hit.competitionIndex >= 67
              ? 'HIGH'
              : hit.competitionIndex >= 33
                ? 'MEDIUM'
                : 'LOW',
      })
      .where(eq(niches.id, n.id))
    if (hit?.avgMonthlySearches != null) nOk++
    console.log(
      `  ${n.slug.padEnd(28)} vol=${String(hit?.avgMonthlySearches ?? '—').padStart(7)} comp=${String(hit?.competitionIndex ?? '—').padStart(3)}`,
    )
  }
  console.log(`Niches with volume: ${nOk}/${nicheRows.length}`)

  if (alsoKeywords) {
    // Prefer unmeasured first so retries after 429 make progress.
    const kws = await database
      .select({
        id: researchKeywords.id,
        keyword: researchKeywords.keyword,
        avgMonthlySearches: researchKeywords.avgMonthlySearches,
      })
      .from(researchKeywords)
      .where(and(eq(researchKeywords.active, true), eq(researchKeywords.variant, 'primary')))

    const pending = kws.filter((k) => k.avgMonthlySearches == null)
    const already = kws.length - pending.length
    console.log(
      `\nEnriching ${pending.length} primary catalog keywords (skipping ${already} already measured)…`,
    )

    const CHUNK = 40
    const DELAY_MS = 2500
    let kOk = already
    let failedChunks = 0

    for (let i = 0; i < pending.length; i += CHUNK) {
      const chunk = pending.slice(i, i + CHUNK)
      const n = Math.floor(i / CHUNK) + 1
      const totalChunks = Math.ceil(pending.length / CHUNK)
      process.stdout.write(`  chunk ${n}/${totalChunks} (${chunk.length} kw)… `)

      let vol = await fetchKeywordVolumes(
        chunk.map((k) => k.keyword),
        { live: true, geoTargetCriteriaIds: [GOOGLE_ADS_GEO_US] },
      )

      // One retry after 429 / rate limit.
      if (vol.source === 'skipped' && /429|exhausted|quota|rate/i.test(vol.error ?? '')) {
        console.log('rate limited, wait 15s…')
        await sleep(15_000)
        vol = await fetchKeywordVolumes(
          chunk.map((k) => k.keyword),
          { live: true, geoTargetCriteriaIds: [GOOGLE_ADS_GEO_US] },
        )
      }

      if (vol.source !== 'google_ads') {
        failedChunks++
        console.log('FAIL batch, retry one-by-one…', (vol.error ?? vol.source).slice(0, 80))
        // Bad keyword in batch → isolate per keyword so the rest still save.
        let soloOk = 0
        for (const k of chunk) {
          const solo = await fetchKeywordVolumes([k.keyword], {
            live: true,
            geoTargetCriteriaIds: [GOOGLE_ADS_GEO_US],
          })
          const hit = solo.rows[0]
          if (solo.source === 'google_ads' && hit) {
            await database
              .update(researchKeywords)
              .set({
                avgMonthlySearches: hit.avgMonthlySearches,
                competitionIndex: hit.competitionIndex,
                topOfPageBidLowMicros: hit.lowTopOfPageBidMicros,
                topOfPageBidHighMicros: hit.highTopOfPageBidMicros,
                competition:
                  hit.competitionIndex == null
                    ? null
                    : hit.competitionIndex >= 67
                      ? 'HIGH'
                      : hit.competitionIndex >= 33
                        ? 'MEDIUM'
                        : 'LOW',
                updatedAt: new Date(),
              })
              .where(eq(researchKeywords.id, k.id))
            if (hit.avgMonthlySearches != null) {
              soloOk++
              kOk++
            }
          } else {
            console.log(`    skip "${k.keyword}": ${(solo.error ?? 'no data').slice(0, 60)}`)
          }
          await sleep(200)
        }
        console.log(`  solo recovered ${soloOk}/${chunk.length}`)
        await sleep(DELAY_MS)
        continue
      }

      const map = new Map(vol.rows.map((r) => [r.keyword.toLowerCase(), r] as const))
      let chunkOk = 0
      for (const k of chunk) {
        const hit = map.get(k.keyword.toLowerCase())
        await database
          .update(researchKeywords)
          .set({
            avgMonthlySearches: hit?.avgMonthlySearches ?? null,
            competitionIndex: hit?.competitionIndex ?? null,
            topOfPageBidLowMicros: hit?.lowTopOfPageBidMicros ?? null,
            topOfPageBidHighMicros: hit?.highTopOfPageBidMicros ?? null,
            competition:
              hit?.competitionIndex == null
                ? null
                : hit.competitionIndex >= 67
                  ? 'HIGH'
                  : hit.competitionIndex >= 33
                    ? 'MEDIUM'
                    : 'LOW',
            updatedAt: new Date(),
          })
          .where(eq(researchKeywords.id, k.id))
        if (hit?.avgMonthlySearches != null) {
          chunkOk++
          kOk++
        }
      }
      console.log(`ok ${chunkOk}/${chunk.length}`)
      if (i + CHUNK < pending.length) await sleep(DELAY_MS)
    }

    console.log(`Catalog keywords with volume: ${kOk}/${kws.length} (${failedChunks} failed chunks)`)
  }

  await closeDb()
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

main().catch(async (e) => {
  console.error(e)
  await closeDb()
  process.exit(1)
})
