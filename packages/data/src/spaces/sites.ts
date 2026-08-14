import 'server-only'
import { eq } from 'drizzle-orm'
import {
  normalizeDomain,
  validateKeywordSpace,
  type KeywordSpace,
  type SiteStatus,
} from '@rnr/core'
import type { Database } from '../db.js'
import { sites, type Site } from '../schema.js'

/**
 * Create or update an affiliate directory site.
 *
 * ==================== WHY NOT createSite ====================
 * `createSite` requires a localityId and a nicheId, provisions telephony fields,
 * and syncs a shortlist item to 'building'. None of that means anything for a
 * site that earns per referred purchase and takes no calls.
 *
 * Sharing the `sites` table is still right — `spend_ledger`, `serp_keywords` and
 * every budget path key off `sites.id`, and forking the table would fork the
 * ledger, which this repo has already learned not to do. Sharing the CREATE
 * FUNCTION would not be: it would mean two sets of required arguments behind one
 * signature, half of them meaningless on any given call.
 * ===========================================================
 */

export class AffiliateSiteError extends Error {}

export interface UpsertAffiliateSiteArgs {
  domain: string
  displayName?: string | null
  status?: SiteStatus
  keywordSpace: KeywordSpace
  /** Named sets from @rnr/core VERTICAL_PLATFORM_DOMAINS, e.g. ['travel']. */
  platformVerticals?: string[]
  /** Operator input. What a referred purchase is worth. */
  orderValueMicros?: bigint | null
  /** Operator input. Basis points; 1000 = 10%. */
  commissionRateBps?: number | null
  /**
   * MEASURED from the affiliate network.
   *
   * Leave null until real data is imported. A plausible 2% makes every keyword
   * carry a value estimate, and a screen full of confident numbers derived from
   * a guess is worse than a screen of em dashes.
   */
  conversionRateBps?: number | null
  notes?: string | null
}

export async function upsertAffiliateSite(
  db: Database,
  args: UpsertAffiliateSiteArgs,
): Promise<Site> {
  const domain = normalizeDomain(args.domain.trim())
  if (!domain) {
    throw new AffiliateSiteError(
      `"${args.domain}" is not a domain. An affiliate site is defined by its domain — unlike a ` +
        `local cell, there is nothing else to identify it by.`,
    )
  }

  const errors = validateKeywordSpace(args.keywordSpace)
  if (errors.length > 0) {
    throw new AffiliateSiteError(
      `Keyword space for ${domain} is invalid:\n  - ${errors.join('\n  - ')}`,
    )
  }

  const values = {
    domain,
    kind: 'affiliate' as const,
    // Explicitly null, not omitted. borenhealth.com has no locality and no niche
    // and saying so is the point of migration 0022.
    localityId: null,
    nicheId: null,
    keywordSpace: args.keywordSpace,
    platformVerticals: args.platformVerticals ?? null,
    displayName: args.displayName?.trim() || null,
    status: args.status ?? 'live',
    affiliateOrderValueMicros: args.orderValueMicros ?? null,
    affiliateCommissionRateBps: args.commissionRateBps ?? null,
    affiliateConversionRateBps: args.conversionRateBps ?? null,
    notes: args.notes?.trim() || null,
  }

  const [row] = await db
    .insert(sites)
    .values(values)
    .onConflictDoUpdate({
      target: sites.domain,
      set: {
        kind: values.kind,
        keywordSpace: values.keywordSpace,
        platformVerticals: values.platformVerticals,
        displayName: values.displayName,
        status: values.status,
        affiliateOrderValueMicros: values.affiliateOrderValueMicros,
        affiliateCommissionRateBps: values.affiliateCommissionRateBps,
        affiliateConversionRateBps: values.affiliateConversionRateBps,
        notes: values.notes,
        updatedAt: new Date(),
      },
    })
    .returning()

  if (!row) throw new AffiliateSiteError(`failed to upsert ${domain}`)
  return row
}

export async function findSiteByDomain(db: Database, domain: string): Promise<Site | null> {
  const normalised = normalizeDomain(domain.trim())
  if (!normalised) return null
  const [row] = await db.select().from(sites).where(eq(sites.domain, normalised)).limit(1)
  return row ?? null
}
