import 'server-only'
import {
  PRICE,
  summariseAuthority,
  type AuthorityProfile,
  type Micros,
  type ReferringDomainInput,
} from '@rnr/core'
import { and, eq, sql } from 'drizzle-orm'
import type { Database } from '../db.js'
import { domainCandidates, domainEnrichRuns, spendLedger } from '../schema.js'
import type { DataForSeoClient } from '../providers/dataforseo/client.js'
import { fetchBulkBacklinks } from '../providers/dataforseo/backlinks.js'
import { createDfsClientFromEnv } from '../providers/dataforseo/keyword-volume.js'

/**
 * Which high-authority sites still link to a candidate domain.
 *
 * ==================== WHY THIS IS TWO STEPS, NOT ONE ====================
 * `/backlinks/referring_domains/live` returns the list we actually want, and
 * costs $0.025 PER TARGET — measured off the account balance, not a rate card.
 * Asking it for every domain in a market is $2.96, against $0.002 for the
 * entire domain search that produced them. That is not a rounding error.
 *
 * So the bulk endpoints go first: one request covers up to 1000 targets and
 * returns referring-domain COUNTS. A domain with no backlinks cannot be holding
 * a BBB citation, and a live business is not an acquisition target, so neither
 * is worth $0.025 to confirm. Only what survives both filters is bought.
 *
 * On a real market that is roughly 12-18 domains rather than 118 — about $0.35.
 * =======================================================================
 */

/**
 * ==================== WHY BACKLINKS, NOT REFERRING_DOMAINS ====================
 * This used to call /backlinks/referring_domains/live, which returns the host
 * that links to a target and nothing else. The UI could therefore only offer a
 * SEARCH of that directory, and operators reported the links landing on
 * nothing -- a common business name returns a page of maybes.
 *
 * /backlinks/backlinks/live with mode=one_per_domain returns the same one row
 * per referring domain PLUS `url_from`: the actual page the citation is on.
 * Both endpoints cost $0.0242 per target, measured off the account balance on
 * 2026-08-10, so this is a straight swap with no cost change.
 *
 * It also returns `page_from_status_code` and `is_lost`, which is how a
 * citation that has since 404'd stops being offered as a link to click.
 * =============================================================================
 */
const BACKLINKS_ENDPOINT = '/backlinks/backlinks/live'

/** Referring domains to pull per target. Ranked desc, so the tail is the cheap part. */
export const REFERRING_DOMAIN_LIMIT = 100

export interface AuthorityAuditOptions {
  /**
   * Skip targets with fewer referring domains than this. Zero would buy a list
   * we already know is empty.
   */
  minReferringDomains?: number
  /** Hard ceiling on paid lookups, so one market cannot run away. */
  maxLookups?: number
  limit?: number
}

export interface AuthorityAuditRow {
  domain: string
  /** Referring-domain count from the cheap bulk pass. */
  referringDomains: number | null
  referringSubnets: number | null
  rank: number | null
  /** Null when the domain did not qualify for a paid lookup. */
  profile: AuthorityProfile | null
  /** Why it was or was not looked up, so a blank row is never a mystery. */
  note: string
}

export interface AuthorityAuditResult {
  rows: AuthorityAuditRow[]
  costMicros: Micros
  /** Paid per-domain lookups actually issued. */
  lookups: number
  /** Domains skipped by the pre-filter, and why. */
  skipped: { live: number; noBacklinks: number; overCap: number }
}

interface BacklinkItem {
  domain_from?: string
  url_from?: string | null
  rank?: number | null
  page_from_status_code?: number | null
  is_lost?: boolean | null
  dofollow?: boolean | null
}

/** One citation per referring domain, WITH the page it sits on. One billable request. */
export async function fetchReferringDomains(
  client: DataForSeoClient,
  target: string,
  limit = REFERRING_DOMAIN_LIMIT,
): Promise<{ referring: ReferringDomainInput[]; costMicros: Micros }> {
  const body = await client.post<Array<{ items?: BacklinkItem[] }>>(BACKLINKS_ENDPOINT, [
    {
      target,
      limit,
      /**
       * One row per referring domain rather than every individual link. Without
       * it a single directory with 400 pages pointing at the domain would fill
       * the whole limit and hide every other citation.
       */
      mode: 'one_per_domain',
      order_by: ['rank,desc'],
    },
  ])
  const items = body?.[0]?.items ?? []
  return {
    referring: items
      .map((i) => ({
        domain: (i.domain_from ?? '').trim().toLowerCase().replace(/^www\./, ''),
        rank: i.rank ?? null,
        // `backlinks` is a per-domain count on the old endpoint; one_per_domain
        // returns one row per domain, so the honest value is 1, not a guess.
        backlinks: 1,
        urlFrom: (i.url_from ?? '').trim() || null,
        pageStatus: i.page_from_status_code ?? null,
        isLost: i.is_lost === true,
      }))
      .filter((i) => i.domain.length > 0),
    costMicros: PRICE.backlinksReferringDomains,
  }
}

export interface AuditCandidate {
  domain: string
  /** The triage verdict. Only established candidates are worth paying for. */
  status: string
}

/**
 * Statuses that do not earn a $0.025 lookup.
 *
 * LIVE is obvious. UNKNOWN is the one that matters: triage never proved
 * anything about those domains, so buying their citation profile produces a
 * compelling-looking row -- BBB link, high authority -- for a site that may
 * simply have been unreadable. That is how quixservice.com, a live business
 * with 3 A records, reached the top of an acquisition list.
 */
const NOT_WORTH_BUYING = new Set(['LIVE', 'BROKEN', 'UNKNOWN'])

/**
 * Audit a market's candidate domains for high-authority citations.
 *
 * Returns a row for EVERY candidate, including the ones that were skipped, each
 * carrying the reason. A blank authority column has to be distinguishable from
 * "checked and found nothing" — otherwise the cost control quietly reads as a
 * finding.
 */
export async function auditAuthorityLinks(
  candidates: AuditCandidate[],
  opts: AuthorityAuditOptions = {},
): Promise<AuthorityAuditResult> {
  const minRefDomains = opts.minReferringDomains ?? 5
  const maxLookups = opts.maxLookups ?? 40

  const client = createDfsClientFromEnv()
  if (!client) {
    throw new Error('DataForSEO credentials are not configured; the authority audit cannot run.')
  }

  const targets = [...new Set(candidates.map((c) => c.domain))]
  if (targets.length === 0) {
    return {
      rows: [],
      costMicros: 0n,
      lookups: 0,
      skipped: { live: 0, noBacklinks: 0, overCap: 0 },
    }
  }

  // ---- Step 1: cheap counts for everything ----
  const bulk = await fetchBulkBacklinks(client, targets)
  const billedRows =
    bulk.billedRows.ranks + bulk.billedRows.refdomains + bulk.billedRows.spam
  let costMicros: Micros =
    PRICE.backlinksBulkRequest * BigInt(bulk.requestCount) +
    PRICE.backlinksBulkRow * BigInt(billedRows)

  const skipped = { live: 0, noBacklinks: 0, overCap: 0 }
  const rows: AuthorityAuditRow[] = []
  let lookups = 0

  /**
   * `referringMainDomains` over `referringDomains` throughout, per the rule
   * types.ts states: 400 referring domains that are 380 subdomains of one blog
   * network is not a 400-domain profile, and thresholding on the inflated
   * number would spend $0.025 on exactly the link farms worth skipping.
   */
  const linkCount = (domain: string): number | null => {
    const a = bulk.authorities.get(domain)
    return a?.referringMainDomains ?? a?.referringDomains ?? null
  }

  // Strongest first, so the lookup cap spends on the best candidates.
  const ordered = [...candidates].sort((a, b) => (linkCount(b.domain) ?? -1) - (linkCount(a.domain) ?? -1))

  for (const candidate of ordered) {
    const authority = bulk.authorities.get(candidate.domain)
    const referringDomains = linkCount(candidate.domain)
    const base = {
      domain: candidate.domain,
      referringDomains,
      referringSubnets: authority?.referringMainDomains ?? null,
      rank: authority?.rank ?? null,
    }

    if (NOT_WORTH_BUYING.has(candidate.status)) {
      skipped.live += 1
      rows.push({
        ...base,
        profile: null,
        note:
          candidate.status === 'LIVE'
            ? 'Live business — not an acquisition target'
            : candidate.status === 'BROKEN'
              ? 'Server erroring (5xx) — hosting is active, not an expired domain'
              : 'Triage did not complete — not established as a candidate',
      })
      continue
    }
    if (referringDomains == null || referringDomains < minRefDomains) {
      skipped.noBacklinks += 1
      rows.push({
        ...base,
        profile: null,
        note: `Only ${referringDomains ?? 0} referring domain(s); below the ${minRefDomains} threshold`,
      })
      continue
    }
    if (lookups >= maxLookups) {
      skipped.overCap += 1
      rows.push({
        ...base,
        profile: null,
        note: `Lookup cap of ${maxLookups} reached — not checked`,
      })
      continue
    }

    try {
      const { referring, costMicros: cost } = await fetchReferringDomains(client, candidate.domain)
      lookups += 1
      costMicros += cost
      const profile = summariseAuthority(referring)
      rows.push({
        ...base,
        profile,
        note:
          profile.matches.length === 0
            ? `Checked ${referring.length} referring domain(s); no authority citations`
            : `${profile.matches.length} authority citation(s) across ${profile.kinds.length} kind(s)`,
      })
    } catch (err) {
      // A failed lookup is not "no citations"; say so rather than imply a result.
      rows.push({
        ...base,
        profile: null,
        note: `Lookup failed: ${(err as Error).message.slice(0, 80)}`,
      })
    }
  }

  rows.sort((a, b) => (b.profile?.score ?? -1) - (a.profile?.score ?? -1))
  return { rows, costMicros, lookups, skipped }
}

// ---------------------------------------------------------------------------

/**
 * Audit one domain-search run and persist the result on its candidate rows.
 *
 * Every audited row is written, including the skipped ones, so the UI can say
 * WHY a domain has no citations rather than leaving a blank the operator has to
 * interpret. Spend goes to the ledger at the moment it happens.
 */
export async function auditRunAuthorityLinks(
  db: Database,
  runId: number,
  opts: AuthorityAuditOptions = {},
): Promise<AuthorityAuditResult> {
  const rows = await db
    .select({
      domain: domainCandidates.domain,
      status: domainCandidates.status,
    })
    .from(domainCandidates)
    .where(eq(domainCandidates.runId, runId))

  if (rows.length === 0) {
    return { rows: [], costMicros: 0n, lookups: 0, skipped: { live: 0, noBacklinks: 0, overCap: 0 } }
  }

  const audit = await auditAuthorityLinks(
    rows.map((r) => ({ domain: r.domain, status: r.status })),
    opts,
  )

  const now = new Date()
  for (const r of audit.rows) {
    await db
      .update(domainCandidates)
      .set({
        authorityScore: r.profile?.score ?? null,
        authorityKinds: r.profile?.kinds ?? null,
        authorityMatches:
          r.profile?.matches.map((m) => ({
            domain: m.domain,
            kind: m.kind,
            reason: m.reason,
            rank: m.rank,
            // The page the citation actually sits on. Rows audited before this
            // was collected keep a null and fall back to a directory search.
            urlFrom: m.urlFrom,
            pageStatus: m.pageStatus,
            isLost: m.isLost,
          })) ?? null,
        authorityNote: r.note,
        authorityCheckedAt: now,
        domainRank: r.rank,
        // The bulk pass measured these for free; Majestic never filled them in.
        referringDomains: r.referringDomains,
        referringSubnets: r.referringSubnets,
      })
      .where(and(eq(domainCandidates.runId, runId), eq(domainCandidates.domain, r.domain)))
  }

  if (audit.costMicros > 0n) {
    await db.insert(spendLedger).values({
      endpoint: 'backlinks/referring_domains + bulk',
      costMicros: audit.costMicros,
      rows: audit.lookups,
      note: `domain_enrich_run=${runId} authority audit`,
    })
  }

  await db
    .update(domainEnrichRuns)
    .set({ costMicros: sql`${domainEnrichRuns.costMicros} + ${audit.costMicros}` })
    .where(eq(domainEnrichRuns.id, runId))

  return audit
}
