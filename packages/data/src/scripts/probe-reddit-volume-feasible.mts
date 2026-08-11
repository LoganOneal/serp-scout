import 'dotenv/config'
import postgres from 'postgres'
const sql = postgres(process.env['DIRECT_DATABASE_URL']?.trim() || process.env['DATABASE_URL']!, { max: 1, prepare: false })

const [c] = await sql<Array<any>>`
  SELECT count(*)::int hits,
         count(h.organic_position)::int with_org_pos,
         count(h.rank_absolute)::int with_abs,
         count(m.avg_monthly_searches)::int with_volume
    FROM discovery_hits h
    LEFT JOIN discovery_serp_metrics m ON m.job_id = h.job_id`
console.log(`hits ${c.hits} · organic_position ${c.with_org_pos} · rank_absolute ${c.with_abs} · volume ${c.with_volume}`)

const sample = await sql<Array<any>>`
  SELECT h.keyword, h.subreddit, h.organic_position, h.rank_absolute,
         m.avg_monthly_searches AS vol, l.name AS locality, n.slug AS niche
    FROM discovery_hits h
    JOIN discovery_serp_metrics m ON m.job_id = h.job_id
    LEFT JOIN localities l ON l.id = h.locality_id
    LEFT JOIN niches n ON n.id = h.niche_id
   WHERE m.avg_monthly_searches IS NOT NULL
   ORDER BY m.avg_monthly_searches DESC LIMIT 10`
console.log('\nhits WITH volume (computable today):')
for (const s2 of sample)
  console.log(`  vol ${String(s2.vol).padStart(5)} · org #${String(s2.organic_position ?? '—').padStart(2)} abs #${String(s2.rank_absolute ?? '—').padStart(2)} · r/${String(s2.subreddit ?? '?').padEnd(16)} ${String(s2.niche ?? '?').padEnd(22)} ${s2.locality ?? '?'}`)

const cover = await sql<Array<any>>`
  SELECT n.slug AS niche, l.name AS locality, count(*)::int hits,
         count(m.avg_monthly_searches)::int with_vol
    FROM discovery_hits h
    JOIN discovery_serp_metrics m ON m.job_id = h.job_id
    LEFT JOIN localities l ON l.id = h.locality_id
    LEFT JOIN niches n ON n.id = h.niche_id
   GROUP BY 1,2 ORDER BY hits DESC LIMIT 8`
console.log('\ncoverage by niche x locality:')
for (const x of cover) console.log(`  ${String(x.niche ?? '?').padEnd(24)} ${String(x.locality ?? '?').padEnd(16)} ${x.hits} hits, ${x.with_vol} with volume`)
await sql.end()
