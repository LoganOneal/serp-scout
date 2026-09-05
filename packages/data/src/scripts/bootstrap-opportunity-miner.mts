/**
 * Load the first Semrush MCP harvest (roofing / baby names / headshots)
 * so the dashboard is not empty before a live API key exists.
 */
import 'dotenv/config'
import { closeDb, db } from '../db.js'
import { ingestSemrushHarvest } from '../opportunity-miner/harvest.js'
import { classifySearchDomain } from '@rnr/core'
import { addEdge, findKeywordId, upsertDomain, upsertKeyword } from '../opportunity-miner/store.js'
import { omAds, omKeywordDomains } from '../schema.js'
import { clusterMarkets } from '../opportunity-miner/cluster.js'
import { scoreAllMarkets } from '../opportunity-miner/score.js'

const ROOFING_RELATED = `Keyword;Search Volume;CPC;Competition;Number of Results;Trends;Intent;Keyword Difficulty Index
roof estimate;5400;28.97;0.78;127;0.35,0.81,0.81,0.81,0.81,1.00,0.81,0.81,0.54,0.54,0.66,0.66;0;46
roofing estimate;4400;28.97;0.78;136;0.36,1.00,0.81,0.66,0.81,1.00,0.81,1.00,0.43,0.54,0.54,0.54;0;51
roofing estimates;4400;28.97;0.78;144;0.36,1.00,0.66,0.54,0.66,1.00,0.81,0.81,0.43,0.43,0.43,0.54;1;53
roof quote;2900;57.1;0.79;147;0.24,0.53,0.66,0.53,0.66,1.00,0.66,0.66,0.24,0.29,0.29,0.29;1;33
free roof estimates;2400;39.57;0.81;134;0.36,1.00,0.81,0.54,0.54,1.00,0.54,0.81,0.29,0.36,0.43,0.29;0;18
roofing quote;1600;57.1;0.79;142;0.34,0.55,0.55,0.65,0.55,0.82,0.55,0.55,0.34,0.55,0.55,0.55;1;39
roofing estimator;1300;10.39;0.75;132;0.36,0.44,0.36,0.20,0.20,0.24,0.16,1.00,0.66,0.36,0.27,0.44;0;35
roofing software;1000;17.54;0.18;128;0.62,0.81,0.81,0.62,0.62,0.81,0.81,1.00,0.62,0.62,0.55,0.62;0;39
instant roof estimate;880;9.87;0.74;141;0.24,0.54,0.36,0.41,0.41,0.41,0.24,0.30,0.20,0.41,0.54,0.66;1;29
roof estimate calculator;880;9.13;0.79;115;0.30,0.36,0.36,0.30,0.30,0.36,0.36,0.24,0.30,0.79,0.66,0.66;1;41`

const HEADSHOT_RELATED = `Keyword;Search Volume;CPC;Competition;Trends;Intent;Keyword Difficulty Index
free ai headshot generator;9900;1.66;0.75;0.66,0.54,0.54,0.54,0.54,0.29,0.29,0.36,0.29,0.19,0.29,0.19;1;58
ai headshot;6600;2.74;0.67;0.44,0.44,0.44,0.66,0.44,0.29,0.29,0.44,0.29,0.29,0.36,0.36;1;64
ai headshots;5400;2.74;0.67;0.19,0.16,0.19,0.13,0.16,0.13,0.10,0.16,0.13,0.13,0.19,0.16;1;68
headshot generator;5400;2.47;0.73;0.66,0.81,0.81,0.81,0.66,0.44,0.35,0.54,0.44,0.54,0.66,0.54;0;64
ai headshot generator free;4400;1.91;0.74;0.66,0.66,0.66,0.81,0.81,0.44,0.35,0.54,0.35,0.29,0.44,0.35;1;57
free headshot generator;4400;1.75;0.77;0.81,0.81,0.81,0.66,0.66,0.54,0.43,0.66,0.54,0.43,0.54,0.43;1;59
ai professional headshot;3600;2.5;0.69;0.44,0.44,0.36,0.19,0.12,0.16,0.12,0.19,0.12,0.16,0.16,0.12;0;55
best ai headshot generator;2900;3.73;0.59;0.36,0.29,0.29,0.24,0.13,0.24,0.24,0.36,0.24,0.24,0.44,0.44;0;57`

const SERP = [
  { position: 1, domain: 'roofr.com', url: 'https://roofr.com/' },
  { position: 2, domain: 'x.build', url: 'https://x.build/roofing-estimating-software' },
  { position: 3, domain: 'reddit.com', url: 'https://www.reddit.com/r/Roofing/comments/1dt1bil/roofing_estimating_software/' },
  { position: 4, domain: 'roofsnap.com', url: 'https://roofsnap.com/' },
  { position: 5, domain: 'stackct.com', url: 'https://www.stackct.com/roofing-estimating-software/' },
  { position: 6, domain: 'jobnimbus.com', url: 'https://www.jobnimbus.com/guides/roof-estimating-software' },
  { position: 7, domain: 'myquoteiq.com', url: 'https://myquoteiq.com/top-10-roofing-estimating-software-in-2026/' },
  { position: 8, domain: 'youtube.com', url: 'https://www.youtube.com/watch?v=B8yWykEcnq0' },
  { position: 9, domain: 'acculynx.com', url: 'https://acculynx.com/features/roof-estimating-software/' },
]

const ADS = [
  { domain: 'getjobber.com', date: '20260815', title: 'Roofer Estimating Software', text: 'Quote, Schedule & Get Paid Faster Through the Jobber App.' },
  { domain: 'buildertrend.com', date: '20260815', title: 'Buildertrend Estimating', text: 'Create fast, accurate estimates with our all-in-one construction management.' },
  { domain: 'getexterio.com', date: '20260815', title: 'Estimating Built for Roofers', text: 'Build accurate roofing estimates in minutes and send proposals customers sign on the spot.' },
  { domain: 'leaptodigital.com', date: '20260515', title: 'Roofing estimating software', text: 'Assign roofing photos to job quotes for stronger trust.' },
  { domain: 'estimatingedge.com', date: '20260515', title: '#1 Roofing Estimating Software', text: 'End-to-end commercial takeoff and estimating software for roofers.' },
]

async function main() {
  const database = db()
  await ingestSemrushHarvest(database, {
    report: 'phrase_this',
    phrase: 'roofing estimating software',
    payload: 'Keyword;Search Volume;CPC;Competition;Number of Results;Trends;Intent;Keyword Difficulty Index\nroofing estimating software;590;20.6;0.24;129;0.24,0.45,0.45,0.30,0.36,0.45,0.67,0.67,0.45,0.36,0.45,0.45;0;20',
  })
  await ingestSemrushHarvest(database, {
    report: 'phrase_this',
    phrase: 'ai baby name generator',
    payload: 'Keyword;Search Volume;CPC;Competition;Number of Results;Trends;Intent;Keyword Difficulty Index\nai baby name generator;210;0;0;103;0.24,0.20,0.16,0.13,0.13,0.13,0.16,0.20,0.13,0.13,0.08,0.13;0;30',
  })
  await ingestSemrushHarvest(database, {
    report: 'phrase_this',
    phrase: 'ai headshot generator',
    payload: 'Keyword;Search Volume;CPC;Competition;Number of Results;Trends;Intent;Keyword Difficulty Index\nai headshot generator;22200;2.68;0.59;130;0.36,0.36,0.30,0.30,0.30,0.24,0.20,0.30,0.24,0.16,0.30,0.24;0;67',
  })
  await ingestSemrushHarvest(database, { report: 'phrase_related', phrase: 'roofing estimating software', payload: ROOFING_RELATED })
  await ingestSemrushHarvest(database, { report: 'phrase_related', phrase: 'ai headshot generator', payload: HEADSHOT_RELATED })
  await ingestSemrushHarvest(database, {
    report: 'phrase_related',
    phrase: 'ai baby name generator',
    payload: 'Keyword;Search Volume;CPC;Competition;Trends;Intent;Keyword Difficulty Index\nbaby name generator;18100;0.54;0.12;0.81,0.81,0.66,0.66,0.54,0.54,0.66,0.81,0.54,0.54,0.44,0.44;0;18\nai name generator;4400;0.31;0.08;0.44,0.36,0.36,0.29,0.24,0.24,0.29,0.36,0.24,0.24,0.19,0.19;0;22',
  })

  const seed = await findKeywordId(database, 'roofing estimating software')
  if (seed) {
    for (const row of SERP) {
      const domainId = await upsertDomain(database, row.domain, { classification: classifySearchDomain(row.domain) })
      await database
        .insert(omKeywordDomains)
        .values({ keywordId: seed, domainId, rankingType: 'organic', position: row.position, url: row.url })
        .onConflictDoNothing()
    }
    for (const row of ADS) {
      const domainId = await upsertDomain(database, row.domain, { classification: classifySearchDomain(row.domain) })
      await database
        .insert(omKeywordDomains)
        .values({ keywordId: seed, domainId, rankingType: 'paid', position: 1 })
        .onConflictDoNothing()
      await database.insert(omAds).values({
        domainId,
        keywordId: seed,
        adTitle: row.title,
        adText: row.text,
        dateSeen: row.date,
      })
    }
    for (const kw of ['roofing estimate', 'roofing quote', 'roofing software']) {
      const id = await findKeywordId(database, kw)
      if (id) await addEdge(database, { sourceKeywordId: seed, targetKeywordId: id, relationType: 'related', depth: 1, seedFamily: 'software' })
    }
  }

  await upsertKeyword(database, { keyword: 'invoice generator', country: 'us', sourceType: 'seed' })
  const clustered = await clusterMarkets(database, 'us')
  const scored = await scoreAllMarkets(database)
  console.log({ clustered, scored })
  await closeDb()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
