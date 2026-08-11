import 'dotenv/config'
import { extractRedditHitsFromDfsResult, extractSerpLayoutMetrics } from '@rnr/core'
import { closeDb, rawSql } from '../db.js'

/**
 * Re-derive Reddit and discussion-pack metrics from SERPs we already own.
 *
 * ==================== FREE. NO PROVIDER CALLS. ====================
 * `discovery_jobs.raw_items` holds the complete payload of every completed
 * sweep SERP, so a parser fix can be applied retroactively without re-buying
 * anything. The parser was blind to Google's `perspectives` module, which is
 * the renamed Discussions-and-forums pack, and that is where 96% of the Reddit
 * threads on these SERPs were sitting.
 *
 * Writes only the four fields the fix can affect. Everything else on the
 * metrics row was measured correctly and is left alone.
 * =================================================================
 *
 * Run: pnpm backfill:perspectives         (dry run, prints the delta)
 *      pnpm backfill:perspectives --apply
 */
async function main() {
  const apply = process.argv.includes('--apply')
  const s = rawSql()

  const rows: any = await s`
    SELECT m.id, m.keyword, m.location_code, m.device,
           m.reddit_hit_count, m.best_reddit_rank_absolute,
           m.forums_count, m.discussions_pack_present,
           m.job_id, m.run_id, m.locality_id, m.niche_id,
           j.discovery_niche_id, j.raw_items
    FROM discovery_serp_metrics m
    JOIN discovery_jobs j ON j.id = m.job_id
    WHERE j.raw_items IS NOT NULL
    ORDER BY m.id`

  console.log(`Scanning ${rows.length} metric rows with stored SERP payloads…\n`)

  let changed = 0
  let redditBefore = 0
  let redditAfter = 0
  let packsGained = 0
  const samples: string[] = []

  for (const r of rows) {
    const items = (r.raw_items ?? []) as Array<Record<string, unknown>>
    const hits = extractRedditHitsFromDfsResult({ items })
    const layout = extractSerpLayoutMetrics(items)

    const bestRank = hits.reduce<number | null>((best, h) => {
      if (h.rankAbsolute == null) return best
      return best == null || h.rankAbsolute < best ? h.rankAbsolute : best
    }, null)

    redditBefore += r.reddit_hit_count ?? 0
    redditAfter += hits.length

    const differs =
      hits.length !== (r.reddit_hit_count ?? 0) ||
      bestRank !== (r.best_reddit_rank_absolute ?? null) ||
      layout.forumsCount !== (r.forums_count ?? 0) ||
      layout.discussionsPackPresent !== r.discussions_pack_present

    if (!differs) continue
    changed += 1
    if (layout.discussionsPackPresent && !r.discussions_pack_present) packsGained += 1
    if (samples.length < 10) {
      samples.push(
        `  ${String(r.keyword).padEnd(28)} loc=${r.location_code} ${r.device.padEnd(7)} ` +
          `reddit ${r.reddit_hit_count}→${hits.length}  forums ${r.forums_count}→${layout.forumsCount}`,
      )
    }

    if (apply) {
      await s`
        UPDATE discovery_serp_metrics
        SET reddit_hit_count = ${hits.length},
            best_reddit_rank_absolute = ${bestRank},
            forums_count = ${layout.forumsCount},
            forums_rank_absolute = ${layout.forumsRankAbsolute},
            discussions_pack_present = ${layout.discussionsPackPresent}
        WHERE id = ${r.id}`

      /**
       * The job's own counter is bookkeeping -- product code reads the metrics
       * row -- but leaving it stale is what made this bug take an hour to find:
       * the job said 0 while its stored payload plainly held 13 Reddit threads.
       */
      await s`UPDATE discovery_jobs SET reddit_hit_count = ${hits.length} WHERE id = ${r.job_id}`

      /**
       * discovery_hits is what the Reddit-volume estimate reads, so updating
       * the counter alone would leave the headline metric at zero while the
       * count column claimed otherwise. Inserted with the same conflict target
       * the live pipeline uses, so re-running is idempotent and threads found
       * by the old parser are left untouched.
       */
      for (const h of hits) {
        await s`
          INSERT INTO discovery_hits
            (job_id, run_id, locality_id, discovery_niche_id, niche_id, keyword,
             reddit_url, reddit_post_id, subreddit, title, source_kind,
             organic_position, rank_absolute, pack_position, domain, commentable)
          VALUES
            (${r.job_id}, ${r.run_id}, ${r.locality_id}, ${r.discovery_niche_id},
             ${r.niche_id}, ${r.keyword}, ${h.url}, ${h.postId}, ${h.subreddit},
             ${h.title}, ${h.sourceKind}, ${h.organicPosition}, ${h.rankAbsolute},
             ${h.packPosition}, ${h.domain}, NULL)
          ON CONFLICT (job_id, reddit_post_id, source_kind) DO NOTHING`
      }
    }
  }

  console.log('Sample of changed rows:')
  for (const line of samples) console.log(line)
  console.log(
    `\n${changed} of ${rows.length} rows change.\n` +
      `Reddit hits total: ${redditBefore} → ${redditAfter} (+${redditAfter - redditBefore})\n` +
      `Rows newly reporting a discussion pack: ${packsGained}\n`,
  )
  console.log(apply ? 'APPLIED.' : 'Dry run. Re-run with --apply to write.')
  await closeDb()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
