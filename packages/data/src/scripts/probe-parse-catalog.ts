import { readFileSync } from 'node:fs'
import { parseGoogleAdsSavedKeywordsStats, parseHomeServiceGeographiesCsv } from '@rnr/core'

const kwPath = process.argv[2]
const geoPath = process.argv[3]

if (!kwPath || !geoPath) {
  console.error('Usage: probe-parse-catalog <keywords.tsv|csv> <geos.csv>')
  process.exit(1)
}

const kwBytes = readFileSync(kwPath)
const pk = parseGoogleAdsSavedKeywordsStats(kwBytes)
console.log(
  'keywords',
  pk.rows.length,
  'skipped',
  pk.skipped.length,
  'title',
  pk.titleRaw?.slice(0, 60),
  'date',
  pk.dateRangeRaw?.slice(0, 40),
)
console.log(
  'sample',
  pk.rows.slice(0, 3).map((r) => ({
    k: r.keyword,
    v: r.avgMonthlySearches,
    var: r.variant,
  })),
)

const g = readFileSync(geoPath, 'utf8')
const pg = parseHomeServiceGeographiesCsv(g)
console.log('geos', pg.rows.length, 'skipped', pg.skipped.length)
console.log(
  'sample',
  pg.rows.slice(0, 3).map((r) => ({
    m: r.market,
    code: r.dataforseoLocationCode,
    rank: r.selectedRank,
  })),
)
