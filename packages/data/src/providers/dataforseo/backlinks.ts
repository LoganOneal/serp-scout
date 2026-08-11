import type { AuthoritySource, DomainAuthority } from '@rnr/core'
import { normaliseDomain } from '@rnr/core'
import type { DataForSeoClient } from './client.js'
import { BULK_TARGET_LIMIT, ENDPOINTS } from './endpoints.js'

/**
 * Link data for a set of domains.
 *
 * ======================== WHY THREE CALLS, NOT ONE ========================
 * `/backlinks/bulk_ranks/live` returns `{target, rank}` and nothing else. It
 * does not return referring domains. It does not return backlink counts. The
 * name and every instinct say otherwise, and it does not.
 *
 * Reading `referring_domains` off the ranks response produces `undefined` ->
 * `null` for every domain in the corpus. Nothing throws. The 0.40-weight
 * authorityWall component silently drops out of every score, the model
 * renormalises around the hole exactly as designed, and the only visible symptom
 * is a coverage percentage nobody was looking at. This survived for months.
 *
 * So: three endpoints, fanned out in parallel, merged on `target`.
 * ~$0.099 for 250 domains (3 x [$0.024 request + 250 x $0.000036]).
 *
 * The regression guard is a NEGATIVE contract test asserting that a real
 * bulk_ranks payload has no referring_domains key. A test written against our
 * own beliefs would agree with whatever we already believe -- which is precisely
 * how this bug survived. See backlinks.contract.test.ts.
 * =========================================================================
 */

interface BulkRanksRow {
  target: string
  rank: number
  // NOTHING ELSE. Do not add optional fields here hoping they arrive.
}

interface BulkReferringDomainsRow {
  target: string
  referring_domains: number
  referring_domains_nofollow: number
  referring_main_domains: number
  referring_main_domains_nofollow?: number
  referring_pages?: number
}

interface BulkSpamScoreRow {
  target: string
  spam_score: number
}

interface BulkResult<Row> {
  items?: Row[] | null
  items_count?: number
  target?: string
}

function rowsOf<Row>(result: unknown): Row[] {
  if (!Array.isArray(result)) return []
  const out: Row[] = []
  for (const block of result as Array<BulkResult<Row>>) {
    if (block?.items) out.push(...block.items)
  }
  return out
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

export interface BulkBacklinksOutcome {
  /** Keyed by lowercased domain. Only targets the API actually answered for. */
  authorities: Map<string, DomainAuthority>
  /**
   * Targets the API returned NO data for. These are negative-cached: small local
   * sites with no measurable link profile are the COMMON case on these SERPs, not
   * the edge case, and without negative caching they are re-requested (and
   * re-paid for) on every scan forever.
   */
  unresolved: string[]
  /** Rows billed per endpoint, for the spend ledger. */
  billedRows: { ranks: number; refdomains: number; spam: number }
  requestCount: number
}

/**
 * Fetch and merge all three bulk endpoints for a set of targets.
 *
 * Each endpoint is allowed to fail independently: if spam score is unavailable
 * but referring domains came back, the resulting DomainAuthority has
 * `sources: ['refdomains']` and a null spamScore, and the scorer omits the spam
 * half of linkQuality rather than treating it as clean. Partial data is recorded
 * as partial, never completed with defaults.
 */
export async function fetchBulkBacklinks(
  client: DataForSeoClient,
  targets: string[],
): Promise<BulkBacklinksOutcome> {
  const unique = [...new Set(targets.map((t) => normaliseDomain(t)).filter(Boolean))]
  const authorities = new Map<string, DomainAuthority>()
  const billedRows = { ranks: 0, refdomains: 0, spam: 0 }
  let requestCount = 0

  if (unique.length === 0) {
    return { authorities, unresolved: [], billedRows, requestCount }
  }

  const ensure = (target: string): DomainAuthority => {
    const key = normaliseDomain(target)
    let a = authorities.get(key)
    if (!a) {
      a = {
        target: key,
        rank: null,
        referringDomains: null,
        referringDomainsNofollow: null,
        referringMainDomains: null,
        spamScore: null,
        sources: [],
      }
      authorities.set(key, a)
    }
    return a
  }
  const addSource = (a: DomainAuthority, s: AuthoritySource) => {
    if (!a.sources.includes(s)) a.sources.push(s)
  }

  for (const batch of chunk(unique, BULK_TARGET_LIMIT)) {
    const payload = [{ targets: batch }]

    // Fanned out in parallel, and settled independently so one endpoint failing
    // degrades that field only rather than losing the whole batch.
    const [ranks, refdomains, spam] = await Promise.allSettled([
      client.post<unknown>(ENDPOINTS.BACKLINKS_BULK_RANKS, payload),
      client.post<unknown>(ENDPOINTS.BACKLINKS_BULK_REFERRING_DOMAINS, payload),
      client.post<unknown>(ENDPOINTS.BACKLINKS_BULK_SPAM_SCORE, payload),
    ])
    requestCount += 3

    if (ranks.status === 'fulfilled') {
      const rows = rowsOf<BulkRanksRow>(ranks.value)
      billedRows.ranks += rows.length
      for (const r of rows) {
        if (!r?.target) continue
        const a = ensure(r.target)
        a.rank = numeric(r.rank)
        addSource(a, 'ranks')
      }
    }

    if (refdomains.status === 'fulfilled') {
      const rows = rowsOf<BulkReferringDomainsRow>(refdomains.value)
      billedRows.refdomains += rows.length
      for (const r of rows) {
        if (!r?.target) continue
        const a = ensure(r.target)
        a.referringDomains = numeric(r.referring_domains)
        a.referringDomainsNofollow = numeric(r.referring_domains_nofollow)
        a.referringMainDomains = numeric(r.referring_main_domains)
        addSource(a, 'refdomains')
      }
    }

    if (spam.status === 'fulfilled') {
      const rows = rowsOf<BulkSpamScoreRow>(spam.value)
      billedRows.spam += rows.length
      for (const r of rows) {
        if (!r?.target) continue
        const a = ensure(r.target)
        a.spamScore = numeric(r.spam_score)
        addSource(a, 'spam')
      }
    }

    // If EVERY endpoint failed, that is not "these domains have no links" -- it
    // is a measurement failure, and it must propagate rather than be recorded as
    // a corpus of zero-authority (i.e. trivially beatable) competitors.
    if (
      ranks.status === 'rejected' &&
      refdomains.status === 'rejected' &&
      spam.status === 'rejected'
    ) {
      throw refdomains.reason
    }
  }

  // A target we asked about but got nothing back for: unresolved, not zero.
  const unresolved = unique.filter((t) => {
    const a = authorities.get(t)
    return !a || a.sources.length === 0
  })
  for (const t of unresolved) authorities.delete(t)

  return { authorities, unresolved, billedRows, requestCount }
}

/**
 * Coerce a numeric field. `null`/`undefined`/non-numeric all become null --
 * never 0. Zero referring domains is the strongest "beatable" signal the model
 * has, so a missing value rendered as 0 turns an unknown domain into a jackpot.
 */
function numeric(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  return null
}
