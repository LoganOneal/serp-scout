import 'server-only'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { type Micros } from '@rnr/core'
import type { Database } from '../db.js'
import { siteCompetitors, siteKeywordTargets, sites } from '../schema.js'
import { createDfsClientFromEnv } from '../providers/dataforseo/keyword-volume.js'
import {
  DEFAULT_LABS_LIMIT,
  LABS_LOCATION_US,
  PEER_MAX_SIZE_RATIO,
  classifyCompetitorPeers,
  fetchCompetitorDomains,
  fetchRankedKeywords,
} from '../providers/dataforseo/labs.js'
import { fetchSearchConsoleQueries } from '../providers/google/search-console.js'
import { recordDiscoveredKeywords } from './research.js'

/**
 * "Every keyword we rank for", from the free source first.
 *
 * ==================== ORDER IS THE POINT ====================
 * Search Console is complete, real and $0 for a domain we own. Labs is a paid
 * approximation whose per-row billing is unverified. So this tries Search
 * Console and only reaches for Labs when explicitly asked — never as an
 * automatic fallback, because a Search Console failure is a CONFIGURATION
 * problem to fix, not a reason to start spending.
 * ============================================================
 */

/**
 * ==================== SILENCE IS THE MEASUREMENT ====================
 * A source that returned its COMPLETE set has told us about every keyword it did
 * not mention: we do not rank for those. That is an answer, and a load-bearing
 * one — it is the whole difference between BUILD ("nothing ranks, and we
 * checked") and UNKNOWN ("nobody ever looked").
 *
 * Stamping only the rows a source RETURNED left every generated grid keyword
 * UNKNOWN forever, even after a clean pull. The first real run reported 350 of
 * 350 UNKNOWN with a screen of em dashes, which reads as a broken feature.
 *
 * Two guards, and both matter:
 *
 *  - Only when NOT truncated. A capped page has real keywords behind it, and
 *    claiming those were measured is the same error pointed the other way.
 *  - `position` stays NULL. It is `position_measured_at` that carries "we
 *    asked", exactly as the schema comment says.
 *
 * `positionSource` records WHICH source concluded it, because the two are not
 * equally strong: Search Console silence means we got no impressions, while an
 * exhausted vendor index means only that the vendor has nothing.
 * ===================================================================
 */
async function stampMeasuredAbsence(
  db: Database,
  siteId: number,
  source: string,
  truncated: boolean,
  returnedRows: number,
): Promise<string[]> {
  if (truncated) {
    return [
      `${source} returned a capped page (${returnedRows} rows) — there are more behind it. Keywords it ` +
        `did not mention are left UNKNOWN rather than assumed absent.`,
    ]
  }

  const now = new Date()
  const stamped = await db
    .update(siteKeywordTargets)
    .set({ positionMeasuredAt: now, positionSource: source, updatedAt: now })
    .where(
      and(
        eq(siteKeywordTargets.siteId, siteId),
        eq(siteKeywordTargets.active, true),
        isNull(siteKeywordTargets.positionMeasuredAt),
      ),
    )
    .returning({ id: siteKeywordTargets.id })

  if (stamped.length === 0) return []
  return [
    `${stamped.length} keyword(s) were absent from a COMPLETE ${source} result. That is measured ` +
      `absence — they can now be BUILD rather than UNKNOWN.`,
  ]
}

export interface RankingsPullResult {
  source: 'search_console' | 'labs_ranked' | 'none'
  keywordsFound: number
  inserted: number
  updated: number
  costMicros: Micros
  /** True when the source returned a capped page rather than the full set. */
  truncated: boolean
  notes: string[]
}

export async function pullRankings(
  db: Database,
  siteId: number,
  opts: {
    /** Days of Search Console history. 90 balances recency against sample size. */
    days?: number
    /** Opt in to the paid vendor. Never automatic. */
    allowLabs?: boolean
    labsLimit?: number
    live?: boolean
  } = {},
): Promise<RankingsPullResult> {
  const [site] = await db
    .select({ id: sites.id, domain: sites.domain })
    .from(sites)
    .where(eq(sites.id, siteId))
    .limit(1)

  if (!site) throw new Error(`No site ${siteId}`)
  if (!site.domain) {
    throw new Error(
      `Site ${siteId} has no domain. "What do we rank for" is not a question about a cell.`,
    )
  }

  const notes: string[] = []
  const days = opts.days ?? 90
  const end = new Date()
  const start = new Date(end.getTime() - days * 86_400_000)
  const now = (): Date => new Date()

  const gsc = await fetchSearchConsoleQueries({
    domain: site.domain,
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  })

  if (gsc.source === 'search_console') {
    const written = await recordDiscoveredKeywords(
      db,
      siteId,
      gsc.rows.map((r) => ({
        keyword: r.keyword,
        source: 'search_console',
        // Rounded only here, at the boundary where an integer column demands it.
        // The real 7.3 is what decided IMPROVE vs DEFEND upstream.
        position: Math.round(r.position),
        positionSource: 'search_console',
        impressions: r.impressions,
        clicks: r.clicks,
      })),
    )
    notes.push(...(await stampMeasuredAbsence(db, siteId, 'search_console', gsc.truncated, gsc.rows.length)))
    return {
      source: 'search_console',
      keywordsFound: gsc.rows.length,
      ...written,
      costMicros: 0n,
      truncated: gsc.truncated,
      notes: [`Property: ${gsc.siteUrl}. Free, complete, our own traffic.`, ...notes],
    }
  }

  notes.push(`Search Console unavailable: ${gsc.error}`)

  if (!opts.allowLabs) {
    /**
     * Deliberately not a fallback. Reaching for a paid vendor because a free and
     * better source was misconfigured spends money to paper over a five-minute
     * fix, and it produces worse data while doing it.
     */
    return {
      source: 'none',
      keywordsFound: 0,
      inserted: 0,
      updated: 0,
      costMicros: 0n,
      truncated: false,
      notes: [
        ...notes,
        'Not falling back to the paid vendor. Fix Search Console access, or pass allowLabs to spend deliberately.',
      ],
    }
  }

  if (opts.live === false) {
    return {
      source: 'none',
      keywordsFound: 0,
      inserted: 0,
      updated: 0,
      costMicros: 0n,
      truncated: false,
      notes: [...notes, 'Labs requested but live calls are disabled.'],
    }
  }

  const client = createDfsClientFromEnv()
  if (!client) {
    return {
      source: 'none',
      keywordsFound: 0,
      inserted: 0,
      updated: 0,
      costMicros: 0n,
      truncated: false,
      notes: [...notes, 'DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD not set.'],
    }
  }

  const labs = await fetchRankedKeywords(client, {
    target: site.domain,
    locationCode: LABS_LOCATION_US,
    limit: opts.labsLimit ?? DEFAULT_LABS_LIMIT,
  })

  const written = await recordDiscoveredKeywords(
    db,
    siteId,
    labs.keywords.map((k) => ({
      keyword: k.keyword,
      source: 'labs_ranked',
      position: k.position,
      positionSource: 'labs_ranked',
      rankingUrl: k.url,
    })),
  )

  notes.push(
    ...(await stampMeasuredAbsence(db, siteId, 'labs_ranked', labs.truncated, labs.rowsReturned)),
  )
  if (labs.truncated) {
    notes.push(
      `Vendor reports ${labs.totalCount} keywords and returned ${labs.rowsReturned}. This is a page, not the set.`,
    )
  }
  notes.push(
    'Positions are a vendor index, not our traffic — an exhausted vendor index is weaker evidence ' +
      'than Search Console silence. Where the two disagree, Search Console is right.',
  )

  return {
    source: 'labs_ranked',
    keywordsFound: labs.rowsReturned,
    ...written,
    costMicros: labs.costMicros,
    truncated: labs.truncated,
    notes,
  }
}

export interface CompetitorPullResult {
  found: number
  peers: number
  giants: number
  undecided: number
  costMicros: Micros
  notes: string[]
}

/**
 * Who competes with us, and which of them we could actually displace.
 *
 * The peer split is stored, not applied — every competitor is recorded, and the
 * gap step reads only peers. Dropping giants at fetch time would hide the
 * finding rather than record it: "our competitor set is entirely unreachable" is
 * a fact about the site, and one the plan pre-registered as the likely outcome
 * for a hotel-booking directory.
 */
export async function pullCompetitors(
  db: Database,
  siteId: number,
  opts: { limit?: number; live?: boolean; ourRankedKeywords?: number | null } = {},
): Promise<CompetitorPullResult> {
  const [site] = await db
    .select({ id: sites.id, domain: sites.domain })
    .from(sites)
    .where(eq(sites.id, siteId))
    .limit(1)

  if (!site?.domain) throw new Error(`Site ${siteId} has no domain`)

  if (opts.live === false) {
    return { found: 0, peers: 0, giants: 0, undecided: 0, costMicros: 0n, notes: ['live disabled'] }
  }

  const client = createDfsClientFromEnv()
  if (!client) {
    return {
      found: 0,
      peers: 0,
      giants: 0,
      undecided: 0,
      costMicros: 0n,
      notes: ['DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD not set'],
    }
  }

  const result = await fetchCompetitorDomains(client, {
    target: site.domain,
    limit: opts.limit ?? 20,
  })

  const classified = classifyCompetitorPeers(result.competitors, opts.ourRankedKeywords ?? null)
  const now = new Date()
  let peers = 0
  let giants = 0
  let undecided = 0

  for (const c of classified) {
    if (c.peer === true) peers += 1
    else if (c.peer === false) giants += 1
    else undecided += 1

    await db
      .insert(siteCompetitors)
      .values({
        siteId,
        domain: c.domain,
        source: 'labs_competitors',
        intersections: c.intersections,
        rankedKeywords: c.rankedKeywords,
        peer: c.peer,
        peerReason: c.peerReason,
      })
      .onConflictDoUpdate({
        target: [siteCompetitors.siteId, siteCompetitors.domain],
        set: {
          intersections: c.intersections,
          rankedKeywords: c.rankedKeywords,
          peer: c.peer,
          peerReason: c.peerReason,
          updatedAt: now,
        },
      })
  }

  const notes: string[] = []
  if (peers === 0 && giants > 0) {
    notes.push(
      `All ${giants} competitor(s) found are more than ${PEER_MAX_SIZE_RATIO}x our size. A keyword gap ` +
        `against these is a list of things we cannot rank for — this is a result about the site, ` +
        `not an empty response.`,
    )
  }
  if (undecided > 0) {
    notes.push(
      `${undecided} competitor(s) could not be sized. They are NOT counted as peers — an unmeasured competitor is not a confirmed one.`,
    )
  }

  return { found: classified.length, peers, giants, undecided, costMicros: result.costMicros, notes }
}

/** Peers only. The gap step must never read the giants. */
export async function listPeerCompetitors(
  db: Database,
  siteId: number,
): Promise<Array<{ domain: string; intersections: number | null }>> {
  return db
    .select({ domain: siteCompetitors.domain, intersections: siteCompetitors.intersections })
    .from(siteCompetitors)
    .where(
      and(
        eq(siteCompetitors.siteId, siteId),
        eq(siteCompetitors.active, true),
        eq(siteCompetitors.peer, true),
      ),
    )
    .orderBy(desc(siteCompetitors.intersections))
}

/**
 * Keywords a peer ranks for that we do not.
 *
 * Runs `fetchRankedKeywords` against the peer rather than the intersection
 * endpoint: it is the same shape, the row cap is explicit, and the "do we
 * already have it" test happens locally against `site_keyword_targets` for free
 * — so the gap costs one request per peer regardless of how much overlap there
 * turns out to be.
 */
export async function pullCompetitorGap(
  db: Database,
  siteId: number,
  opts: { maxPeers?: number; limitPerPeer?: number; live?: boolean } = {},
): Promise<{ peersQueried: number; discovered: number; costMicros: Micros; notes: string[] }> {
  if (opts.live === false) {
    return { peersQueried: 0, discovered: 0, costMicros: 0n, notes: ['live disabled'] }
  }
  const client = createDfsClientFromEnv()
  if (!client) return { peersQueried: 0, discovered: 0, costMicros: 0n, notes: ['no credentials'] }

  const peers = (await listPeerCompetitors(db, siteId)).slice(0, opts.maxPeers ?? 3)
  if (peers.length === 0) {
    return {
      peersQueried: 0,
      discovered: 0,
      costMicros: 0n,
      notes: [
        'No peer competitors. Either none were found, or every competitor is out of our weight class — ' +
          'run pullCompetitors and read its notes before concluding there is no gap.',
      ],
    }
  }

  let costMicros = 0n
  let discovered = 0
  const notes: string[] = []

  for (const peer of peers) {
    const labs = await fetchRankedKeywords(client, {
      target: peer.domain,
      locationCode: LABS_LOCATION_US,
      limit: opts.limitPerPeer ?? DEFAULT_LABS_LIMIT,
      // Only what they rank WELL for. A keyword their page 4 holds is not a gap.
      maxPosition: 20,
    })
    costMicros += labs.costMicros
    if (labs.truncated) {
      notes.push(`${peer.domain}: capped at ${labs.rowsReturned} of ${labs.totalCount} — sampled, not complete.`)
    }

    const written = await recordDiscoveredKeywords(
      db,
      siteId,
      labs.keywords.map((k) => ({ keyword: k.keyword, source: 'competitor_gap' })),
    )
    discovered += written.inserted
  }

  return { peersQueried: peers.length, discovered, costMicros, notes }
}
