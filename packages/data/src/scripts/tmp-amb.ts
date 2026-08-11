import 'dotenv/config'
import { listRunKeywords, resolveRunKeywordPath } from '../serp/discovery-queries.js'
import { db, closeDb, rawSql } from '../db.js'
async function main() {
  const s = rawSql()
  // A multi-market run is where a bare keyword slug genuinely collides.
  const multi: any = await s`
    select m.run_id, count(distinct m.location_code)::int as markets, count(*)::int as metrics
    from discovery_serp_metrics m group by 1 having count(distinct m.location_code) > 1
    order by 2 desc limit 1`
  if (multi.length === 0) { console.log('no multi-market run to test'); await closeDb(); return }
  const runId = multi[0].run_id
  console.log(`run ${runId}: ${multi[0].markets} markets, ${multi[0].metrics} metrics`)
  const idx = await listRunKeywords(db(), runId)
  const qualified = idx.filter((k) => k.path.includes('/'))
  console.log(`keywords needing a market-qualified path: ${qualified.length}/${idx.length}`)
  for (const k of qualified.slice(0, 3)) console.log(`  ${k.keyword} -> ${k.path}`)
  const bare = qualified[0]
  if (bare) {
    const kwOnly = bare.path.split('/').slice(1).join('/')
    const amb = await resolveRunKeywordPath(db(), { runId, segments: [kwOnly] })
    console.log(`\nbare "${kwOnly}" resolves to: ${amb.kind}` +
      (amb.kind === 'ambiguous' ? ` (${amb.options.length} markets)` : ''))
    const full = await resolveRunKeywordPath(db(), { runId, segments: bare.path.split('/') })
    console.log(`qualified "${bare.path}" resolves to: ${full.kind}`)
  }
  await closeDb()
}
main().catch((e) => { console.error('ERR', e?.message ?? e); process.exit(1) })
