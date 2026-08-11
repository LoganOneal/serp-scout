/** Idempotent niche seed. `pnpm seed:niches` */
import 'dotenv/config'
import { closeDb, db } from '../db.js'
import { niches } from '../schema.js'
import {
  NICHE_SEEDS,
  nicheAvgTicketMicros,
  nicheCommissionBps,
  nicheLeadValueMicros,
} from '../seed/niches.js'

async function main(): Promise<void> {
  const database = db()
  let inserted = 0
  let updated = 0

  for (const seed of NICHE_SEEDS) {
    const row = {
      slug: seed.slug,
      label: seed.label,
      keywordNoun: seed.keywordNoun,
      emdToken: seed.emdToken,
      domainStems: seed.domainStems,
      category: seed.category,
      demandPerCapitaPer1k: seed.demandPerCapitaPer1k,
      valuePerSearchMicros: seed.valuePerSearchMicros,
      rentFloorMicros: seed.rentFloorMicros,
      rentCeilingMicros: seed.rentCeilingMicros,
      avgTicketMicros: nicheAvgTicketMicros(seed),
      leadCommissionRateBps: nicheCommissionBps(seed),
      leadValueMicros: nicheLeadValueMicros(seed),
      economicsSource: 'prior' as const,
      active: true,
    }
    const result = await database
      .insert(niches)
      .values(row)
      .onConflictDoUpdate({ target: niches.slug, set: row })
      .returning({ id: niches.id, createdAt: niches.createdAt })
    // Rough heuristic for reporting only.
    const created = result[0]?.createdAt
    if (created && Date.now() - created.getTime() < 5_000) inserted++
    else updated++
  }

  console.log(`Seeded ${NICHE_SEEDS.length} niches (${inserted} new, ${updated} updated).`)
  console.log(
    '\nEvery demand and rent number in seed/niches.ts is a PRIOR awaiting calibration.\n' +
      'Volume is modelled from population -- city-level search volume cannot be\n' +
      'purchased from any configured provider.\n',
  )
  await closeDb()
}

main().catch(async (e) => {
  console.error(e)
  await closeDb()
  process.exit(1)
})
