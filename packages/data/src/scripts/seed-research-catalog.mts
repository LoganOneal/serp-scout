/**
 * Seed research catalog from fixed keyword + geo CSVs (names only — no import volumes).
 *
 * Usage:
 *   pnpm exec tsx packages/data/src/scripts/seed-research-catalog.mts
 *   pnpm exec tsx packages/data/src/scripts/seed-research-catalog.mts --kw path --geo path
 */
import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import postgres from 'postgres'
import {
  parseGoogleAdsSavedKeywordsStats,
  parseHomeServiceGeographiesCsv,
} from '@rnr/core'

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name)
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]!
  return fallback
}

const kwPath = resolve(
  arg(
    '--kw',
    'c:/Users/logan/Downloads/Saved Keywords Stats 2026-08-04 at 11_09_52.csv',
  ),
)
const geoPath = resolve(
  arg('--geo', 'c:/Users/logan/Downloads/home_service_geographies_200.csv'),
)

const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL missing')
  process.exit(1)
}

const kwBuf = readFileSync(kwPath)
const geoText = readFileSync(geoPath, 'utf8')

const kwParsed = parseGoogleAdsSavedKeywordsStats(kwBuf)
const geoParsed = parseHomeServiceGeographiesCsv(geoText)

console.log('Parsed keywords:', kwParsed.rows.length, 'skipped', kwParsed.skipped.length)
console.log('Parsed geos:', geoParsed.rows.length, 'skipped', geoParsed.skipped.length)
console.log(
  'Keyword sample (names only):',
  kwParsed.rows.slice(0, 8).map((r) => r.keyword),
)
console.log(
  'Geo sample:',
  geoParsed.rows.slice(0, 5).map((r) => `${r.market}, ${r.stateAbbr} code=${r.dataforseoLocationCode}`),
)

const sql = postgres(url, { max: 1 })

// Single seed import markers
const [kwImp] = await sql`
  insert into research_keyword_imports (source_filename, source_kind, row_count, skipped_count, date_range_raw)
  values (
    ${'seed:saved-keywords-stats'},
    ${'seed_names_only'},
    ${kwParsed.rows.length},
    ${kwParsed.skipped.length},
    ${kwParsed.dateRangeRaw}
  )
  returning id
`
const [geoImp] = await sql`
  insert into research_geo_imports (source_filename, source_kind, row_count, skipped_count)
  values (
    ${'seed:home_service_geographies_200'},
    ${'seed_names_only'},
    ${geoParsed.rows.length},
    ${geoParsed.skipped.length}
  )
  returning id
`
const kwImportId = kwImp!.id as number
const geoImportId = geoImp!.id as number

// Deactivate everything first so Screen only shows this seed set
await sql`update research_keywords set active = false, updated_at = now()`
await sql`update research_geos set active = false, updated_at = now()`

let kwIns = 0
let kwUpd = 0
for (const row of kwParsed.rows) {
  // Names only — never store CSV volume
  const res = await sql`
    insert into research_keywords (
      import_id, keyword, keyword_norm, seed_key, variant,
      avg_monthly_searches, competition, competition_index,
      top_of_page_bid_low_micros, top_of_page_bid_high_micros, top_of_page_bid_raw,
      in_account, monthly_series, niche_id, active, line_number, updated_at
    ) values (
      ${kwImportId}, ${row.keyword}, ${row.keywordNorm}, ${row.seedKey}, ${row.variant},
      null, null, null,
      null, null, null,
      null, null, null, true, ${row.lineNumber}, now()
    )
    on conflict (keyword_norm) do update set
      import_id = excluded.import_id,
      keyword = excluded.keyword,
      seed_key = excluded.seed_key,
      variant = excluded.variant,
      avg_monthly_searches = null,
      competition = null,
      competition_index = null,
      top_of_page_bid_low_micros = null,
      top_of_page_bid_high_micros = null,
      top_of_page_bid_raw = null,
      in_account = null,
      monthly_series = null,
      active = true,
      line_number = excluded.line_number,
      updated_at = now()
    returning (xmax = 0) as inserted
  `
  if (res[0]?.inserted) kwIns++
  else kwUpd++
}

let geoIns = 0
let geoUpd = 0
for (const row of geoParsed.rows) {
  // Match locality by provider location code when present
  let localityId: number | null = null
  if (row.dataforseoLocationCode != null) {
    const loc = await sql`
      select id from localities
      where provider_location_code = ${row.dataforseoLocationCode}
      limit 1
    `
    localityId = (loc[0]?.id as number | undefined) ?? null
  }
  if (localityId == null && row.stateAbbr) {
    const loc = await sql`
      select id from localities
      where lower(name) = ${row.market.toLowerCase()}
        and state_code = ${row.stateAbbr}
      limit 1
    `
    localityId = (loc[0]?.id as number | undefined) ?? null
  }

  const resolveStatus =
    row.dataforseoLocationCode != null ? 'resolved' : localityId != null ? 'resolved' : 'unresolved'
  const locationSource = row.dataforseoLocationCode != null ? 'csv_preresolved' : null

  // Upsert by market + state_abbr (no unique constraint — find then insert/update)
  const existing = await sql`
    select id from research_geos
    where lower(market) = ${row.market.toLowerCase()}
      and coalesce(state_abbr, '') = ${row.stateAbbr ?? ''}
    limit 1
  `
  if (existing.length === 0) {
    await sql`
      insert into research_geos (
        import_id, market, state, state_abbr, population_2025, selected_rank, test_tier,
        dataforseo_location_code, dataforseo_location_name, dataforseo_location_type,
        natural_query_modifier, disambiguated_query_modifier, recommended_explicit_modifier,
        locality_id, location_source, resolve_status, unmatched_reason, active, line_number, updated_at
      ) values (
        ${geoImportId}, ${row.market}, ${row.state}, ${row.stateAbbr}, ${row.population2025},
        ${row.selectedRank}, ${row.testTier},
        ${row.dataforseoLocationCode}, ${row.dataforseoLocationName}, ${row.dataforseoLocationType},
        ${row.naturalQueryModifier}, ${row.disambiguatedQueryModifier}, ${row.recommendedExplicitModifier},
        ${localityId}, ${locationSource}, ${resolveStatus}, null, true, ${row.lineNumber}, now()
      )
    `
    geoIns++
  } else {
    await sql`
      update research_geos set
        import_id = ${geoImportId},
        state = ${row.state},
        population_2025 = ${row.population2025},
        selected_rank = ${row.selectedRank},
        test_tier = ${row.testTier},
        dataforseo_location_code = ${row.dataforseoLocationCode},
        dataforseo_location_name = ${row.dataforseoLocationName},
        dataforseo_location_type = ${row.dataforseoLocationType},
        natural_query_modifier = ${row.naturalQueryModifier},
        disambiguated_query_modifier = ${row.disambiguatedQueryModifier},
        recommended_explicit_modifier = ${row.recommendedExplicitModifier},
        locality_id = coalesce(${localityId}, locality_id),
        location_source = coalesce(${locationSource}, location_source),
        resolve_status = ${resolveStatus},
        active = true,
        line_number = ${row.lineNumber},
        updated_at = now()
      where id = ${existing[0]!.id}
    `
    geoUpd++
  }
}

const [kwActive] = await sql`select count(*)::int as n from research_keywords where active`
const [geoActive] =
  await sql`select count(*)::int as n from research_geos where active and dataforseo_location_code is not null`

console.log('Keywords inserted', kwIns, 'updated', kwUpd, 'active', kwActive?.n)
console.log('Geos inserted', geoIns, 'updated', geoUpd, 'purchasable active', geoActive?.n)
console.log('Done. Import volumes cleared; measure via Google Ads on deep dive.')

await sql.end()
