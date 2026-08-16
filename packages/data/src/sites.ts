import 'server-only'
import { and, count, desc, eq, gte, isNull, sql } from 'drizzle-orm'
import {
  normalizeDomain,
  promptFingerprint,
  toE164,
  type SiteStatus,
  type SiteVoiceContext,
  type WeeklyHours,
} from '@rnr/core'
import type { Database } from './db.js'
import {
  calls,
  leads,
  localities,
  niches,
  scanTargets,
  shortlistItems,
  sites,
  spendLedger,
  type Site,
} from './schema.js'

/** Sites, and the aggregates the list and dashboard need. */

export interface CreateSiteArgs {
  /** NULL when the cell is targeted before a domain is registered. */
  domain?: string | null
  localityId: number
  nicheId: number
  shortlistItemId?: number | null
  displayName?: string | null
  timezone?: string
  status?: SiteStatus
  hours?: WeeklyHours | null
  serviceAreaZips?: string[] | null
  dispatchFeeMicros?: bigint | null
  onCallNumber?: string | null
  leadAlertNumber?: string | null
  purchasedAt?: Date | null
  notes?: string | null
}

export class SiteValidationError extends Error {}

/**
 * Create a site.
 *
 * Normalises the domain rather than trusting the form: `sites.domain` is UNIQUE,
 * so a row created from "https://Foo.com/" can never be matched by a later lookup
 * for "foo.com" and shows up as a duplicate-key error nobody can explain.
 */
export async function createSite(db: Database, args: CreateSiteArgs): Promise<Site> {
  /**
   * A blank domain is allowed; a MALFORMED one is not.
   *
   * The cell is what is unique now, so targeting can begin before a domain exists. But an
   * unparseable string must still be refused rather than stored: `sites.domain` is unique, so
   * a row created from "https://Foo.com/" can never be matched by a later lookup for
   * "foo.com" and surfaces as a duplicate-key error nobody can explain.
   */
  const raw = args.domain?.trim()
  let domain: string | null = null
  if (raw !== undefined && raw !== '') {
    domain = normalizeDomain(raw)
    if (domain === null) {
      throw new SiteValidationError(
        `"${raw}" is not a domain. Expected something like kenoshaair.com, or leave it blank.`,
      )
    }
  }

  const onCall = args.onCallNumber ? toE164(args.onCallNumber) : null
  if (args.onCallNumber && onCall === null) {
    // Refused rather than stored as typed. A malformed on-call number is the
    // disaster-recovery target AND the emergency transfer target -- silently
    // keeping an unusable one means both fail at the worst possible moment.
    throw new SiteValidationError(`On-call number "${args.onCallNumber}" is not a valid US number.`)
  }
  const alert = args.leadAlertNumber ? toE164(args.leadAlertNumber) : null
  if (args.leadAlertNumber && alert === null) {
    throw new SiteValidationError(
      `Lead alert number "${args.leadAlertNumber}" is not a valid US number.`,
    )
  }

  const [row] = await db
    .insert(sites)
    .values({
      domain,
      localityId: args.localityId,
      nicheId: args.nicheId,
      shortlistItemId: args.shortlistItemId ?? null,
      displayName: args.displayName?.trim() || null,
      status: args.status ?? 'parked',
      timezone: args.timezone ?? 'America/Chicago',
      hours: args.hours ?? null,
      serviceAreaZips: args.serviceAreaZips ?? null,
      dispatchFeeMicros: args.dispatchFeeMicros ?? null,
      onCallNumber: onCall,
      leadAlertNumber: alert,
      purchasedAt: args.purchasedAt ?? null,
      notes: args.notes?.trim() || null,
    })
    .returning()

  const site = row!

  /**
   * The one-way sync, done exactly once.
   *
   * `sites.status` is authoritative from here on; `shortlist_items.state` is
   * research bookkeeping. Two state machines that both claim to describe the same
   * asset diverge silently, so this nudges the shortlist to 'building' on creation
   * and never touches it again.
   */
  if (site.shortlistItemId !== null) {
    await db
      .update(shortlistItems)
      .set({ state: 'building', buildStartedAt: sql`COALESCE(${shortlistItems.buildStartedAt}, now())` })
      .where(and(eq(shortlistItems.id, site.shortlistItemId), eq(shortlistItems.state, 'watching')))
  }

  return site
}

export async function updateSite(
  db: Database,
  siteId: number,
  patch: Partial<{
    status: SiteStatus
    domain: string | null
    displayName: string | null
    trackingNumber: string | null
    twilioNumberSid: string | null
    retellAgentId: string | null
    previousRetellAgentId: string | null
    retellAgentVersion: number | null
    retellNumberImportedAt: Date | null
    promptFingerprint: string | null
    timezone: string
    hours: WeeklyHours | null
    serviceAreaZips: string[] | null
    dispatchFeeMicros: bigint | null
    onCallNumber: string | null
    leadAlertNumber: string | null
    notes: string | null
  }>,
): Promise<void> {
  const next: typeof patch = { ...patch }
  if (patch.domain !== undefined) {
    if (patch.domain === null || patch.domain.trim() === '') {
      next.domain = null
    } else {
      const d = normalizeDomain(patch.domain)
      if (d === null) {
        throw new SiteValidationError(
          `"${patch.domain}" is not a domain. Expected something like kenoshaair.com, or leave it blank.`,
        )
      }
      next.domain = d
    }
  }
  await db
    .update(sites)
    .set({ ...next, updatedAt: new Date() })
    .where(eq(sites.id, siteId))
}

/**
 * Resolve a site from the dialled number, for the inbound webhook ONLY.
 *
 * This runs while the phone is ringing -- Retell allows 10 seconds and then falls
 * back to the default agent with no variables at all -- so it is one indexed
 * lookup and nothing else. No aggregates, no lead history, no analytics write.
 *
 * Dropped sites are excluded: their numbers should not be answering as a business
 * that no longer operates.
 */
export async function resolveSiteByNumber(
  db: Database,
  toNumber: string,
): Promise<SiteVoiceContext | null> {
  const e164 = toE164(toNumber) ?? toNumber
  const rows = await db
    .select({
      siteId: sites.id,
      domain: sites.domain,
      displayName: sites.displayName,
      timezone: sites.timezone,
      hours: sites.hours,
      serviceAreaZips: sites.serviceAreaZips,
      dispatchFeeMicros: sites.dispatchFeeMicros,
      onCallNumber: sites.onCallNumber,
      localityName: localities.name,
      stateCode: localities.stateCode,
      nicheLabel: niches.label,
    })
    .from(sites)
    .innerJoin(localities, eq(sites.localityId, localities.id))
    .innerJoin(niches, eq(sites.nicheId, niches.id))
    .where(and(eq(sites.trackingNumber, e164), sql`${sites.status} <> 'dropped'`))
    .limit(1)

  const r = rows[0]
  if (!r) return null

  return {
    siteId: r.siteId,
    domain: r.domain,
    displayName: r.displayName,
    localityName: r.localityName,
    stateCode: r.stateCode,
    nicheLabel: r.nicheLabel,
    timezone: r.timezone,
    hours: r.hours ?? null,
    serviceAreaZips: r.serviceAreaZips ?? null,
    dispatchFeeMicros: r.dispatchFeeMicros ?? null,
    onCallNumber: r.onCallNumber,
  }
}

/** Mark that Retell has actually contacted us. Clears the "not connected" banner. */
export async function touchSiteWebhook(db: Database, siteId: number): Promise<void> {
  await db
    .update(sites)
    .set({
      firstWebhookAt: sql`COALESCE(${sites.firstWebhookAt}, now())`,
      lastWebhookAt: new Date(),
    })
    .where(eq(sites.id, siteId))
}

// ---------------------------------------------------------------------------

export interface SiteListRow {
  site: Site
  localityName: string
  stateCode: string
  nicheLabel: string
  /** Trailing-30-day counts. */
  calls30d: number
  leads30d: number
  /**
   * Cost per lead, micros as a string (bigint cannot cross the RSC boundary).
   * NULL when there were no leads -- NOT zero and not infinity. A site with spend
   * and no leads has an undefined cost per lead, and rendering it as $0.00 would
   * read as the cheapest site on the page.
   */
  costPerLeadMicros: string | null
  /** p95 across the window, or null when no call reported latency. */
  latencyP95Ms: number | null
  /** Calls that ended under 10 seconds. The greeting-quality signal. */
  abandoned30d: number
}

const THIRTY_DAYS = sql`now() - interval '30 days'`

export async function listSites(db: Database): Promise<SiteListRow[]> {
  // One round trip. The aggregates are lateral subqueries rather than joins so a
  // site with 400 calls and 2 leads does not multiply rows and inflate both counts.
  const rows = await db
    .select({
      site: sites,
      localityName: localities.name,
      stateCode: localities.stateCode,
      nicheLabel: niches.label,
      calls30d: sql<number>`(
        SELECT count(*)::int FROM ${calls}
         WHERE ${calls}.site_id = ${sites}.id AND ${calls}.created_at >= ${THIRTY_DAYS}
      )`,
      abandoned30d: sql<number>`(
        SELECT count(*)::int FROM ${calls}
         WHERE ${calls}.site_id = ${sites}.id AND ${calls}.created_at >= ${THIRTY_DAYS}
           AND ${calls}.duration_ms IS NOT NULL AND ${calls}.duration_ms < 10000
      )`,
      leads30d: sql<number>`(
        SELECT count(*)::int FROM ${leads}
         WHERE ${leads}.site_id = ${sites}.id AND ${leads}.created_at >= ${THIRTY_DAYS}
      )`,
      spend30dMicros: sql<string>`(
        SELECT COALESCE(sum(cost_micros), 0)::text FROM ${spendLedger}
         WHERE ${spendLedger}.site_id = ${sites}.id AND ${spendLedger}.created_at >= ${THIRTY_DAYS}
      )`,
      latencyP95Ms: sql<number | null>`(
        SELECT max(latency_e2e_p95_ms)::int FROM ${calls}
         WHERE ${calls}.site_id = ${sites}.id AND ${calls}.created_at >= ${THIRTY_DAYS}
      )`,
    })
    .from(sites)
    .innerJoin(localities, eq(sites.localityId, localities.id))
    .innerJoin(niches, eq(sites.nicheId, niches.id))
    .orderBy(desc(sites.createdAt))

  return rows.map((r) => ({
    site: r.site,
    localityName: r.localityName,
    stateCode: r.stateCode,
    nicheLabel: r.nicheLabel,
    calls30d: r.calls30d,
    abandoned30d: r.abandoned30d,
    leads30d: r.leads30d,
    latencyP95Ms: r.latencyP95Ms,
    costPerLeadMicros:
      r.leads30d > 0 ? (BigInt(r.spend30dMicros) / BigInt(r.leads30d)).toString() : null,
  }))
}

export interface SiteDetail {
  site: Site
  localityName: string
  stateCode: string
  localitySlug: string
  nicheSlug: string
  nicheLabel: string
  /** The frozen prediction, when this site came from a scan. */
  prediction: {
    shortlistItemId: number
    verdictAtSave: string
    difficultyAtSave: number | null
    weightCoveredAtSave: number
    emdDomain: string
    /**
     * Modelled monthly rent from the scan that produced this cell, micros as a string
     * (bigint cannot cross the RSC boundary).
     *
     * NULL when the scan could not model it -- which is NOT zero. A site whose rent was
     * never modelled has no prediction to falsify, and rendering that as $0 would make
     * every realised dollar look like an overperformance.
     */
    modelledRentMicros: string | null
  } | null
}

export async function getSiteDetail(db: Database, siteId: number): Promise<SiteDetail | null> {
  const rows = await db
    .select({
      site: sites,
      localityName: localities.name,
      localitySlug: localities.slug,
      stateCode: localities.stateCode,
      nicheSlug: niches.slug,
      nicheLabel: niches.label,
      shortlistItemId: shortlistItems.id,
      verdictAtSave: shortlistItems.verdictAtSave,
      difficultyAtSave: shortlistItems.difficultyAtSave,
      weightCoveredAtSave: shortlistItems.weightCoveredAtSave,
      emdDomain: shortlistItems.emdDomain,
      modelledRentMicros: scanTargets.rentMicros,
    })
    .from(sites)
    .innerJoin(localities, eq(sites.localityId, localities.id))
    .innerJoin(niches, eq(sites.nicheId, niches.id))
    .leftJoin(shortlistItems, eq(sites.shortlistItemId, shortlistItems.id))
    // The scan row the shortlist froze. Nullable all the way down: a shortlist item can
    // outlive its scan target (ON DELETE SET NULL), and that is a missing measurement
    // rather than a zero.
    .leftJoin(scanTargets, eq(shortlistItems.scanTargetId, scanTargets.id))
    .where(eq(sites.id, siteId))
    .limit(1)

  const r = rows[0]
  if (!r) return null

  return {
    site: r.site,
    localityName: r.localityName,
    localitySlug: r.localitySlug,
    stateCode: r.stateCode,
    nicheSlug: r.nicheSlug,
    nicheLabel: r.nicheLabel,
    prediction:
      r.shortlistItemId === null
        ? null
        : {
            shortlistItemId: r.shortlistItemId,
            verdictAtSave: r.verdictAtSave!,
            difficultyAtSave: r.difficultyAtSave,
            weightCoveredAtSave: r.weightCoveredAtSave!,
            emdDomain: r.emdDomain!,
            modelledRentMicros: r.modelledRentMicros?.toString() ?? null,
          },
  }
}

export interface SiteStats {
  calls: number
  answered: number
  abandonedUnder10s: number
  leads: number
  qualifiedLeads: number
  /** NULL when no lead ever had urgency established -- not zero. */
  emergencies: number | null
  spendMicros: string
  costPerLeadMicros: string | null
  latencyP50Ms: number | null
  latencyP95Ms: number | null
  /** Calls we could not attribute to any site. Site-scoped stats exclude them. */
  unattributed: number
}

export async function getSiteStats(db: Database, siteId: number, days = 30): Promise<SiteStats> {
  const since = sql`now() - (${days} || ' days')::interval`

  const [row] = await db
    .select({
      calls: sql<number>`count(*)::int`,
      answered: sql<number>`count(*) FILTER (WHERE duration_ms >= 10000)::int`,
      abandoned: sql<number>`count(*) FILTER (WHERE duration_ms IS NOT NULL AND duration_ms < 10000)::int`,
      p50: sql<number | null>`percentile_disc(0.5) WITHIN GROUP (ORDER BY latency_e2e_p50_ms)::int`,
      p95: sql<number | null>`max(latency_e2e_p95_ms)::int`,
    })
    .from(calls)
    .where(and(eq(calls.siteId, siteId), gte(calls.createdAt, since as never)))

  const [leadRow] = await db
    .select({
      total: sql<number>`count(*)::int`,
      qualified: sql<number>`count(*) FILTER (WHERE qualified IS TRUE)::int`,
      // COUNT of true, plus a separate count of "was it ever established", so the
      // caller can tell "no emergencies" from "urgency was never asked about".
      emergencies: sql<number>`count(*) FILTER (WHERE is_emergency IS TRUE)::int`,
      urgencyKnown: sql<number>`count(*) FILTER (WHERE is_emergency IS NOT NULL)::int`,
    })
    .from(leads)
    .where(and(eq(leads.siteId, siteId), gte(leads.createdAt, since as never)))

  const [spendRow] = await db
    .select({ total: sql<string>`COALESCE(sum(cost_micros), 0)::text` })
    .from(spendLedger)
    .where(and(eq(spendLedger.siteId, siteId), gte(spendLedger.createdAt, since as never)))

  const [unattributedRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(calls)
    .where(isNull(calls.siteId))

  const leadCount = leadRow?.total ?? 0
  const spendMicros = spendRow?.total ?? '0'

  return {
    calls: row?.calls ?? 0,
    answered: row?.answered ?? 0,
    abandonedUnder10s: row?.abandoned ?? 0,
    leads: leadCount,
    qualifiedLeads: leadRow?.qualified ?? 0,
    // Null when nothing was ever established, so the tile renders an em dash
    // instead of a 0 that claims there were no emergencies.
    emergencies: (leadRow?.urgencyKnown ?? 0) === 0 ? null : (leadRow?.emergencies ?? 0),
    spendMicros,
    costPerLeadMicros:
      leadCount > 0 ? (BigInt(spendMicros) / BigInt(leadCount)).toString() : null,
    latencyP50Ms: row?.p50 ?? null,
    latencyP95Ms: row?.p95 ?? null,
    unattributed: unattributedRow?.n ?? 0,
  }
}

// ---------------------------------------------------------------------------

export interface CallListRow {
  call: typeof calls.$inferSelect
  lead: typeof leads.$inferSelect | null
}

export async function listCallsForSite(
  db: Database,
  siteId: number,
  limit = 100,
): Promise<CallListRow[]> {
  const rows = await db
    .select({ call: calls, lead: leads })
    .from(calls)
    .leftJoin(leads, eq(leads.callId, calls.id))
    .where(eq(calls.siteId, siteId))
    .orderBy(desc(calls.createdAt))
    .limit(limit)
  return rows.map((r) => ({ call: r.call, lead: r.lead }))
}

/**
 * Calls whose site could not be resolved.
 *
 * Surfaced in its own view rather than hidden: an unattributed call means the
 * inbound webhook failed or a number is not registered, and the whole point of
 * keeping it is that the failure is visible instead of silent.
 */
export async function listUnattributedCalls(db: Database, limit = 50) {
  return db
    .select()
    .from(calls)
    .where(isNull(calls.siteId))
    .orderBy(desc(calls.createdAt))
    .limit(limit)
}

export async function listLeadsForSite(db: Database, siteId: number, limit = 200) {
  return db
    .select()
    .from(leads)
    .where(eq(leads.siteId, siteId))
    .orderBy(
      // Emergencies first, then unqualified-unknown LAST -- the same ordering rule
      // as scan_targets.difficulty: a null must never sort as the best row.
      sql`${leads.isEmergency} IS TRUE DESC`,
      sql`${leads.qualified} IS NULL`,
      desc(leads.createdAt),
    )
    .limit(limit)
}

export async function getSiteById(db: Database, siteId: number): Promise<Site | null> {
  const rows = await db.select().from(sites).where(eq(sites.id, siteId)).limit(1)
  return rows[0] ?? null
}

export async function getSiteByDomain(db: Database, domain: string): Promise<Site | null> {
  const d = normalizeDomain(domain)
  if (d === null) return null
  const rows = await db.select().from(sites).where(eq(sites.domain, d)).limit(1)
  return rows[0] ?? null
}

/** Shortlist rows not yet turned into a site, for the create form's link field. */
export async function listUnbuiltShortlistItems(db: Database) {
  return db
    .select({
      id: shortlistItems.id,
      emdDomain: shortlistItems.emdDomain,
      localityId: shortlistItems.localityId,
      nicheId: shortlistItems.nicheId,
      localityName: localities.name,
      stateCode: localities.stateCode,
      nicheLabel: niches.label,
      verdictAtSave: shortlistItems.verdictAtSave,
    })
    .from(shortlistItems)
    .innerJoin(localities, eq(shortlistItems.localityId, localities.id))
    .innerJoin(niches, eq(shortlistItems.nicheId, niches.id))
    .leftJoin(sites, eq(sites.shortlistItemId, shortlistItems.id))
    .where(isNull(sites.id))
    .orderBy(desc(shortlistItems.savedAt))
    .limit(200)
}

/**
 * `listActiveNiches` lives in serp/discovery-queries.ts.
 *
 * There were two, and because index.ts re-exports both modules with `export *` that was a
 * build failure, not a duplicate: "Module './sites.js' has already exported a member named
 * 'listActiveNiches'". The surviving one returns keywordNoun as well and is the one the
 * research page imports; this copy had no callers.
 */

/** Does the prompt Retell holds still match the one in this repo? */
export function promptIsCurrent(site: Site): boolean | null {
  if (site.promptFingerprint === null) return null
  return site.promptFingerprint === promptFingerprint()
}

export { count }

// ---------------------------------------------------------------------------
// Cell-keyed access
// ---------------------------------------------------------------------------

/**
 * A locality+niche cell, whether or not it is being targeted yet.
 *
 * ==================== KEYED BY THE CELL, NOT BY A SITE ID ====================
 * A cell has research (scan_targets) and possibly a decision (shortlist_items) BEFORE it has
 * a site row -- so a page keyed by site id cannot show a cell you have only scanned. Both
 * slugs are already unique (localities_slug_uq, niches_slug_uq), so the pair addresses the
 * cell directly.
 * ==========================================================================
 */
export interface CellDetail {
  localityId: number
  localitySlug: string
  localityName: string
  stateCode: string
  /**
   * Google's geotarget name for this locality (DataForSEO `location_name`).
   * NULL when unresolved. Required to build a UULE link Google will honour --
   * see buildLocalSerpLinks in @rnr/core.
   */
  providerLocationName: string | null
  /** Market centroid — drives the coordinate UULE on Live SERP links. */
  lat: number | null
  lon: number | null
  population: number | null
  nicheId: number
  nicheSlug: string
  nicheLabel: string
  /** Searched noun for Reddit discovery keywords, e.g. "hvac". */
  keywordNoun: string
  /** NULL until you start targeting. Everything CRM-side hangs off this. */
  site: Site | null
  /** The frozen decision, if this cell was ever shortlisted. */
  shortlist: {
    id: number
    verdictAtSave: string
    difficultyAtSave: number | null
    weightCoveredAtSave: number
    emdDomain: string
    emdAvailableAtSave: boolean | null
    state: string
    savedAt: Date
  } | null
  /** The most recent measurement, from whichever scan run last covered this cell. */
  latestScan: {
    scanTargetId: number
    scanRunId: number
    difficulty: number | null
    weightCovered: number
    verdict: string
    volumeEst: number | null
    rentMicros: string | null
    slotsOpen: number
    createdAt: Date
  } | null
}

export async function getCellDetail(
  db: Database,
  args: { localitySlug: string; nicheSlug: string },
): Promise<CellDetail | null> {
  const [base] = await db
    .select({
      localityId: localities.id,
      localitySlug: localities.slug,
      localityName: localities.name,
      stateCode: localities.stateCode,
      providerLocationName: localities.providerLocationName,
      lat: localities.lat,
      lon: localities.lon,
      population: localities.population,
      nicheId: niches.id,
      nicheSlug: niches.slug,
      nicheLabel: niches.label,
      keywordNoun: niches.keywordNoun,
    })
    .from(localities)
    .innerJoin(niches, eq(niches.slug, args.nicheSlug))
    .where(eq(localities.slug, args.localitySlug))
    .limit(1)

  if (base === undefined) return null

  // The live site for this cell, if any. Dropped rows are excluded so a re-targeted cell
  // shows its current site rather than its abandoned one.
  const [site] = await db
    .select()
    .from(sites)
    .where(
      and(
        eq(sites.localityId, base.localityId),
        eq(sites.nicheId, base.nicheId),
        sql`${sites.status} <> 'dropped'`,
      ),
    )
    .limit(1)

  const [shortlist] = await db
    .select()
    .from(shortlistItems)
    .where(
      and(eq(shortlistItems.localityId, base.localityId), eq(shortlistItems.nicheId, base.nicheId)),
    )
    .limit(1)

  // Latest measurement for this cell across all runs of this locality.
  const [scan] = await db
    .select({
      scanTargetId: scanTargets.id,
      scanRunId: scanTargets.scanRunId,
      difficulty: scanTargets.difficulty,
      weightCovered: scanTargets.weightCovered,
      verdict: scanTargets.verdict,
      volumeEst: scanTargets.volumeEst,
      rentMicros: scanTargets.rentMicros,
      slotsOpen: scanTargets.slotsOpen,
      createdAt: scanTargets.createdAt,
    })
    .from(scanTargets)
    .where(and(eq(scanTargets.localityId, base.localityId), eq(scanTargets.nicheId, base.nicheId)))
    .orderBy(desc(scanTargets.createdAt))
    .limit(1)

  return {
    ...base,
    site: site ?? null,
    shortlist:
      shortlist === undefined
        ? null
        : {
            id: shortlist.id,
            verdictAtSave: shortlist.verdictAtSave,
            difficultyAtSave: shortlist.difficultyAtSave,
            weightCoveredAtSave: shortlist.weightCoveredAtSave,
            emdDomain: shortlist.emdDomain,
            emdAvailableAtSave: shortlist.emdAvailableAtSave,
            state: shortlist.state,
            savedAt: shortlist.savedAt,
          },
    latestScan:
      scan === undefined
        ? null
        : { ...scan, rentMicros: scan.rentMicros?.toString() ?? null },
  }
}

/** The cell URL for a site, so /sites/:id can redirect to it. */
export async function cellPathForSite(db: Database, siteId: number): Promise<string | null> {
  const [row] = await db
    .select({ localitySlug: localities.slug, nicheSlug: niches.slug })
    .from(sites)
    .innerJoin(localities, eq(sites.localityId, localities.id))
    .innerJoin(niches, eq(sites.nicheId, niches.id))
    .where(eq(sites.id, siteId))
    .limit(1)
  return row === undefined ? null : `/portfolio/${row.localitySlug}/${row.nicheSlug}`
}

/** Shortlisted cells with no site yet -- the "decided but not started" section of /markets. */
export async function listShortlistedUntargeted(db: Database) {
  return db
    .select({
      shortlistId: shortlistItems.id,
      localitySlug: localities.slug,
      localityName: localities.name,
      stateCode: localities.stateCode,
      nicheSlug: niches.slug,
      nicheLabel: niches.label,
      emdDomain: shortlistItems.emdDomain,
      verdictAtSave: shortlistItems.verdictAtSave,
      difficultyAtSave: shortlistItems.difficultyAtSave,
      savedAt: shortlistItems.savedAt,
    })
    .from(shortlistItems)
    .innerJoin(localities, eq(shortlistItems.localityId, localities.id))
    .innerJoin(niches, eq(shortlistItems.nicheId, niches.id))
    .leftJoin(
      sites,
      and(
        eq(sites.localityId, shortlistItems.localityId),
        eq(sites.nicheId, shortlistItems.nicheId),
        sql`${sites.status} <> 'dropped'`,
      ),
    )
    .where(isNull(sites.id))
    .orderBy(desc(shortlistItems.savedAt))
    .limit(100)
}
