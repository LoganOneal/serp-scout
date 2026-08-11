/** Corpus coverage summary. `pnpm stats` */
import 'dotenv/config'
import { sql } from 'drizzle-orm'
import { closeDb, db } from '../db.js'

async function main(): Promise<void> {
  const d = db()

  const byKind = await d.execute<{ kind: string; total: number; resolved: number }>(sql`
    SELECT kind, COUNT(*)::int AS total, COUNT(provider_location_code)::int AS resolved
      FROM localities GROUP BY kind ORDER BY kind`)
  console.log('\nkind        total   resolved')
  for (const r of byKind as unknown as Array<{ kind: string; total: number; resolved: number }>) {
    const pct = r.total ? ((r.resolved / r.total) * 100).toFixed(1) : '0.0'
    console.log(`  ${r.kind.padEnd(8)} ${String(r.total).padStart(6)} ${String(r.resolved).padStart(10)}  ${pct}%`)
  }

  const bands = await d.execute<{ band: string; total: number; resolved: number }>(sql`
    SELECT CASE WHEN population >= 250000 THEN '250k+'
                WHEN population >= 25000  THEN '25k-250k'
                WHEN population IS NULL   THEN 'unknown'
                ELSE 'under 25k' END AS band,
           COUNT(*)::int AS total,
           COUNT(provider_location_code)::int AS resolved
      FROM localities WHERE kind = 'city' GROUP BY 1 ORDER BY 1`)
  console.log('\ncity population bands   total   resolved')
  for (const r of bands as unknown as Array<{ band: string; total: number; resolved: number }>) {
    const pct = r.total ? ((r.resolved / r.total) * 100).toFixed(1) : '0.0'
    console.log(`  ${r.band.padEnd(20)} ${String(r.total).padStart(6)} ${String(r.resolved).padStart(10)}  ${pct}%`)
  }

  const methods = await d.execute<{ resolution_method: string; n: number }>(sql`
    SELECT resolution_method, COUNT(*)::int AS n FROM localities
     WHERE resolution_method IS NOT NULL GROUP BY 1 ORDER BY 2 DESC`)
  const methodRows = methods as unknown as Array<{ resolution_method: string; n: number }>
  if (methodRows.length > 0) {
    console.log('\nresolution method')
    for (const r of methodRows) console.log(`  ${String(r.n).padStart(6)}  ${r.resolution_method}`)
  }

  // The localities big enough that failing to resolve them is a real loss.
  const bigUnresolved = await d.execute<{
    kind: string
    name: string
    state_code: string
    population: number
    unmatched_reason: string
  }>(sql`
    SELECT kind, name, state_code, population, unmatched_reason
      FROM localities
     WHERE provider_location_code IS NULL AND population >= ${Number(process.argv[2] ?? 100_000)}
       AND kind = COALESCE(${process.argv[3] ?? null}, kind)
     ORDER BY population DESC LIMIT 30`)
  const bigRows = bigUnresolved as unknown as Array<{
    kind: string
    name: string
    state_code: string
    population: number
    unmatched_reason: string
  }>
  if (bigRows.length > 0) {
    console.log('\nUNRESOLVED localities over 100k -- these are real losses:')
    for (const r of bigRows) {
      console.log(
        `  ${r.kind.padEnd(6)} ${`${r.name}, ${r.state_code}`.padEnd(30)} pop ${r.population.toLocaleString().padStart(10)}`,
      )
      console.log(`         ${r.unmatched_reason?.slice(0, 130)}`)
    }
  } else {
    console.log('\nEvery locality over 100k resolved.')
  }

  const bySource = await d.execute<{ location_source: string; n: number }>(sql`
    SELECT COALESCE(location_source, '(unresolved)') AS location_source, COUNT(*)::int AS n
      FROM localities GROUP BY 1 ORDER BY 2 DESC`)
  console.log('\nlocation code source')
  for (const r of bySource as unknown as Array<{ location_source: string; n: number }>) {
    const note =
      r.location_source === 'dataforseo'
        ? '  (authoritative -- cleared for live spend)'
        : r.location_source === 'google_geotargets'
          ? '  (UNVERIFIED -- live scans will refuse)'
          : ''
    console.log(`  ${String(r.n).padStart(6)}  ${r.location_source}${note}`)
  }

  const niche = await d.execute<{ n: number }>(sql`SELECT COUNT(*)::int AS n FROM niches WHERE active`)
  console.log(`\nactive niches: ${(niche as unknown as Array<{ n: number }>)[0]?.n ?? 0}`)

  const scannable = await d.execute<{ slug: string; name: string; state_code: string; population: number }>(sql`
    SELECT slug, name, state_code, population FROM localities
     WHERE provider_location_code IS NOT NULL
     ORDER BY population DESC NULLS LAST LIMIT 10`)
  console.log('\nscannable localities (largest first):')
  for (const r of scannable as unknown as Array<{
    slug: string
    name: string
    state_code: string
    population: number | null
  }>) {
    console.log(`  ${r.slug.padEnd(24)} ${r.name}, ${r.state_code}  pop ${r.population?.toLocaleString() ?? '?'}`)
  }

  await closeDb()
}

main().catch(async (e) => {
  console.error(e)
  await closeDb()
  process.exit(1)
})
