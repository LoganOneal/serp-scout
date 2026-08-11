import 'dotenv/config'
import postgres from 'postgres'
const sql = postgres(process.env['DIRECT_DATABASE_URL']?.trim() || process.env['DATABASE_URL']!, { max: 1, prepare: false })
const r = await sql<Array<any>>`
  SELECT m.keyword, l.name AS locality, m.difficulty, m.slots_open, m.platform_held_slots,
         m.median_ref_domains, m.min_ref_domains, m.local_businesses_top5_dedicated,
         m.verdict_acquired, m.link_data_measured, m.top_organic_domains
    FROM discovery_serp_metrics m
    LEFT JOIN localities l ON l.id = m.locality_id
   WHERE m.difficulty IS NOT NULL
   ORDER BY m.difficulty ASC LIMIT 6`
for (const x of r) {
  console.log(`\n${x.keyword} — ${x.locality ?? '?'}`)
  console.log(
    `  difficulty ${x.difficulty} · slotsOpen ${x.slots_open}/10 · platform ${x.platform_held_slots} · ` +
      `medianRD ${x.median_ref_domains} · minRD ${x.min_ref_domains} · committed top5 ${x.local_businesses_top5_dedicated}`,
  )
  console.log(`  verdict(acquired) ${x.verdict_acquired} · linkData ${x.link_data_measured}`)
  console.log(`  defenders: ${(x.top_organic_domains ?? []).map((d: any) => d.domain).join(', ')}`)
}
await sql.end()
