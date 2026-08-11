/**
 * Constraints drizzle-kit cannot express, applied idempotently.
 *
 *   pnpm db:extras     (run after pnpm db:push)
 *
 * ==================== WHY THIS FILE EXISTS ====================
 * `drizzle-kit push` diffs the TypeScript schema against the database, and the
 * schema DSL has no way to write a partial index (`... WHERE status <> 'dropped'`).
 *
 * The gap is not cosmetic. `resolveSiteByNumber` looks a site up by
 * `tracking_number` and takes `.limit(1)`. If two live sites shared a number, that
 * query would pick one ARBITRARILY -- so every call to that number would be
 * attributed to whichever row Postgres happened to return, and the wrong contractor
 * would get the lead. A plain unique index cannot be used instead, because history
 * has to survive a number being reassigned from a dropped site to a new one.
 * =============================================================
 */
import 'dotenv/config'
import { sql } from 'drizzle-orm'
import { closeDb, db } from '../db.js'

interface Extra {
  name: string
  why: string
  ddl: string
}

const EXTRAS: Extra[] = [
  {
    name: 'sites_active_tracking_number_uq',
    why: 'One ACTIVE site per tracking number, while keeping history for dropped sites.',
    ddl: `
      CREATE UNIQUE INDEX IF NOT EXISTS sites_active_tracking_number_uq
        ON sites (tracking_number)
        WHERE tracking_number IS NOT NULL AND status <> 'dropped'
    `,
  },
  {
    name: 'sites_active_cell_uq',
    why: 'One website per locality+niche, while keeping history for dropped cells.',
    ddl: `
      CREATE UNIQUE INDEX IF NOT EXISTS sites_active_cell_uq
        ON sites (locality_id, niche_id)
        WHERE status <> 'dropped'
    `,
  },
  {
    name: 'voice_jobs_kind_lead_uq',
    why: 'One live delivery job per lead, so webhook retries cannot fan out into duplicate texts.',
    ddl: `
      CREATE UNIQUE INDEX IF NOT EXISTS voice_jobs_kind_lead_uq
        ON voice_jobs (kind, lead_id)
        WHERE lead_id IS NOT NULL AND status IN ('pending', 'claimed')
    `,
  },
  {
    name: 'calls_unattributed_idx',
    why: 'The unattributed view scans for site_id IS NULL; a partial index keeps it cheap.',
    ddl: `
      CREATE INDEX IF NOT EXISTS calls_unattributed_idx
        ON calls (created_at DESC)
        WHERE site_id IS NULL
    `,
  },
  {
    name: 'leads_open_idx',
    why: 'Emergencies and never-qualified leads are the two rows an operator hunts for.',
    ddl: `
      CREATE INDEX IF NOT EXISTS leads_open_idx
        ON leads (site_id, created_at DESC)
        WHERE is_emergency IS TRUE OR qualified IS NULL
    `,
  },
  {
    name: 'discovery_niches_run_keyword_lower_uq',
    why: 'Dedupe discovery niche keywords case-insensitively within a run (CSV casing varies).',
    ddl: `
      CREATE UNIQUE INDEX IF NOT EXISTS discovery_niches_run_keyword_lower_uq
        ON discovery_niches (run_id, lower(keyword_primary))
    `,
  },
  {
    name: 'discovery_jobs_pending_claim_idx',
    why: 'Claim path only cares about pending jobs; partial index keeps the queue scan tiny.',
    ddl: `
      CREATE INDEX IF NOT EXISTS discovery_jobs_pending_claim_idx
        ON discovery_jobs (id)
        WHERE status = 'pending'
    `,
  },
  {
    name: 'research_geos_code_uq',
    why: 'Upsert geos by pre-resolved DataForSEO location code.',
    ddl: `
      CREATE UNIQUE INDEX IF NOT EXISTS research_geos_code_uq
        ON research_geos (dataforseo_location_code)
        WHERE dataforseo_location_code IS NOT NULL
    `,
  },
]

async function main(): Promise<void> {
  const database = db()
  console.log(`Applying ${EXTRAS.length} constraint(s) drizzle-kit cannot express.\n`)

  for (const extra of EXTRAS) {
    try {
      await database.execute(sql.raw(extra.ddl))
      console.log(`  ok    ${extra.name}`)
      console.log(`        ${extra.why}`)
    } catch (e) {
      const message = (e as Error).message ?? String(e)
      // A duplicate-value failure is REAL DATA telling you two live sites already
      // share a number. Reported loudly rather than swallowed, because the
      // mis-attribution it implies is already happening.
      console.error(`  FAIL  ${extra.name}: ${message}`)
      if (/duplicate key|could not create unique index/i.test(message)) {
        console.error(
          '        This is not a schema problem -- the data already violates it.\n' +
            '        Find the duplicates before retrying:\n' +
            "          SELECT tracking_number, count(*) FROM sites\n" +
            "           WHERE tracking_number IS NOT NULL AND status <> 'dropped'\n" +
            '           GROUP BY 1 HAVING count(*) > 1;',
        )
      }
      await closeDb()
      process.exit(1)
    }
  }

  console.log('\nDone.')
  await closeDb()
}

main().catch(async (e) => {
  console.error(e)
  await closeDb()
  process.exit(1)
})
