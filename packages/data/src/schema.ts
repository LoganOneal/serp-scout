import type {
  AdsMatchType,
  AdsPlanStatus,
  AffiliateScopeKind,
  BuildState,
  ContactConfidence,
  CallIngestState,
  KeywordSpace,
  KeywordVerdict,
  OutreachMessageStatus,
  PaidVerdict,
  ProspectVerdict,
  SiteKind,
  SupplyIngestMode,
  SupplyIngestStatus,
  SupplyResolveStatus,
  DeliveryChannel,
  DeliveryStatus,
  LeadCapturedVia,
  LeadDisposition,
  LeadSource,
  LocalityKind,
  SiteStatus,
  Verdict,
  VoiceJobKind,
  VoiceJobStatus,
  WeeklyHours,
} from '@rnr/core'
import { sql } from 'drizzle-orm'
import {
  type AnyPgColumn,
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

/**
 * Schema.
 *
 * Three encodings here carry the project's central rule -- null is not zero --
 * into the database itself, where it cannot be undone by a careless query:
 *
 *  - `scan_targets.difficulty` is NULLABLE. Null means "could not be scored" and
 *    must render as an em dash, never sort as easiest.
 *  - `outcomes.position` is NULLABLE while `checked_at` is NOT NULL. The row
 *    EXISTING is the measurement; a null position is a checked miss.
 *  - `domain_authority.resolved` distinguishes "measured, and it is low" from
 *    "the API had nothing", so the negative cache does not masquerade as data.
 */

const now = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()

/**
 * A defaulted NOT NULL timestamp with a column name you choose.
 *
 * ==================== WHY THIS EXISTS ====================
 * `now()` above hardcodes the column name `created_at`, which is right for the
 * ~30 tables that want exactly that and a silent trap for any table that does
 * not. Writing `startedAt: now()` declares a column called `created_at` — the
 * TypeScript field name is the lie, the SQL name is the truth, and nothing
 * surfaces until an INSERT fails at runtime with "column created_at does not
 * exist".
 *
 * That cost three separate debugging rounds while building link outreach
 * (`started_at`, `first_seen_at`, `added_at`). Use this whenever the column is
 * not literally `created_at`.
 * =========================================================
 */
const timestampCol = (name: string) =>
  timestamp(name, { withTimezone: true }).notNull().defaultNow()

/**
 * Zero default for a micros column.
 *
 * A literal `0n` default is correct TypeScript and breaks drizzle-kit, which
 * JSON.stringify()s the schema snapshot to diff it and cannot serialize a
 * BigInt. Expressed as SQL instead, so the column still defaults to 0 and the
 * value still arrives as a bigint at runtime.
 */
const zeroMicros = sql`0`

// ---------------------------------------------------------------------------

export const localities = pgTable(
  'localities',
  {
    id: serial('id').primaryKey(),
    /**
     * The ONLY natural key. See @rnr/core geography/slug.ts: (kind, state, name)
     * is not unique -- two Wilmingtons in Illinois, three Oakwoods in Ohio, 17
     * collisions overall -- so a unique index on it rejects real places.
     */
    slug: text('slug').notNull(),
    kind: text('kind').$type<LocalityKind>().notNull(),
    name: text('name').notNull(),
    /** Verbatim Census name, kept so a wrong resolution can be audited. */
    rawName: text('raw_name').notNull(),
    stateCode: text('state_code').notNull(),
    stateName: text('state_name').notNull(),
    /** Place FIPS / county FIPS / CBSA code. */
    fips: text('fips').notNull(),
    countyFips: text('county_fips'),
    countyName: text('county_name'),
    population: integer('population'),
    lat: doublePrecision('lat'),
    lon: doublePrecision('lon'),
    landAreaSqMi: doublePrecision('land_area_sq_mi'),
    /**
     * NULL = unresolved. An unresolved locality is excluded from scanning and is
     * never widened to a broader provider code -- a statewide SERP answering a
     * city query is well-formed and undetectably wrong.
     */
    providerLocationCode: integer('provider_location_code'),
    providerLocationName: text('provider_location_name'),
    /** Which candidate name form matched, for audit. */
    resolutionMethod: text('resolution_method'),
    /**
     * WHERE the location code came from: 'dataforseo' or 'google_geotargets'.
     *
     * Only 'dataforseo' is authoritative about what the provider will accept.
     * Google's geo target constants are free, keyless and complete, and their
     * codes are documented to be the same criterion IDs -- but that equivalence
     * is unverified, and a wrong code returns a well-formed SERP for the wrong
     * city with nothing downstream able to tell. runScan therefore refuses to
     * spend money on a code from any source but 'dataforseo'.
     */
    locationSource: text('location_source'),
    unmatchedReason: text('unmatched_reason'),
    /** Precomputed lowercase "name statecode statename" for the type-ahead. */
    searchText: text('search_text').notNull(),
    createdAt: now(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    slugUq: uniqueIndex('localities_slug_uq').on(t.slug),
    // Safe uniqueness: FIPS within a kind really is unique.
    kindFipsUq: uniqueIndex('localities_kind_fips_uq').on(t.kind, t.fips),
    // Deliberately NO unique index on (kind, state_code, name).
    searchIdx: index('localities_search_idx').on(t.searchText),
    popIdx: index('localities_population_idx').on(t.population),
    resolvedIdx: index('localities_resolved_idx').on(t.providerLocationCode),
  }),
)

// ---------------------------------------------------------------------------

export const niches = pgTable(
  'niches',
  {
    id: serial('id').primaryKey(),
    slug: text('slug').notNull(),
    label: text('label').notNull(),
    /** The searched noun phrase: "tree service" -> "kenosha tree service". */
    keywordNoun: text('keyword_noun').notNull(),
    /** Concatenated for the EMD: "treeservice" -> kenoshatreeservice.com */
    emdToken: text('emd_token').notNull(),
    /** Curated substrings meaning "this domain is about this niche". */
    domainStems: jsonb('domain_stems').$type<string[]>().notNull(),
    /**
     * Phrases meaning "this SEARCH belongs to this niche".
     *
     * Distinct from domainStems, which are domain-shaped ("garagedoor").
     * These are phrase-shaped ("hail damage", "tub to shower") and exist as
     * DATA so a coverage gap is a row rather than a code change -- the
     * previous matcher required the whole keyword_noun as a substring, so
     * "roofers" never reached the roofing niche.
     */
    keywordAliases: jsonb('keyword_aliases').$type<string[]>().notNull().default([]),
    category: text('category').notNull(),
    /** PRIOR. Monthly searches per 1,000 residents. */
    demandPerCapitaPer1k: doublePrecision('demand_per_capita_per_1k').notNull(),
    /** PRIOR. Modelled rent per monthly search, micros. */
    valuePerSearchMicros: bigint('value_per_search_micros', { mode: 'bigint' }).notNull(),
    rentFloorMicros: bigint('rent_floor_micros', { mode: 'bigint' }).notNull(),
    rentCeilingMicros: bigint('rent_ceiling_micros', { mode: 'bigint' }).notNull(),
    /**
     * Lead-sell economics (rank-and-rent lead boards / Reddit comments).
     * Separate from valuePerSearchMicros (site rent prior).
     */
    avgTicketMicros: bigint('avg_ticket_micros', { mode: 'bigint' }),
    /** Commission rate in basis points (1000 = 10%). */
    leadCommissionRateBps: integer('lead_commission_rate_bps'),
    /** What we charge for a sold lead: ticket × commission (or flat CPA override). */
    leadValueMicros: bigint('lead_value_micros', { mode: 'bigint' }),
    economicsSource: text('economics_source'),
    /** Google Ads measured national demand for keyword_noun (not CSV import). */
    gadsAvgMonthlySearches: integer('gads_avg_monthly_searches'),
    gadsCompetitionIndex: integer('gads_competition_index'),
    gadsCompetition: text('gads_competition'),
    gadsTopOfPageBidLowMicros: bigint('gads_top_of_page_bid_low_micros', { mode: 'bigint' }),
    gadsTopOfPageBidHighMicros: bigint('gads_top_of_page_bid_high_micros', { mode: 'bigint' }),
    gadsKeyword: text('gads_keyword'),
    gadsMeasuredAt: timestamp('gads_measured_at', { withTimezone: true }),
    active: boolean('active').notNull().default(true),
    createdAt: now(),
  },
  (t) => ({
    slugUq: uniqueIndex('niches_slug_uq').on(t.slug),
    activeIdx: index('niches_active_idx').on(t.active),
  }),
)

// ---------------------------------------------------------------------------

export type ScanRunStatus =
  | 'pending'
  | 'claimed'
  | 'running'
  | 'done'
  | 'failed'
  | 'budget_exceeded'

/**
 * THIS TABLE IS THE QUEUE. There is no Redis.
 *
 * The previous build had a web action that wrote a pending row and a queue
 * helper that enqueued jobs, but no dispatcher connecting them -- so the button
 * silently did nothing and rows sat pending forever. With Postgres as the only
 * queue there is no second system to forget to poll: the worker claims directly
 * from here with `UPDATE ... WHERE status='pending' ... FOR UPDATE SKIP LOCKED
 * RETURNING`, which also makes double-dispatch impossible.
 */
export const scanRuns = pgTable(
  'scan_runs',
  {
    id: serial('id').primaryKey(),
    localityId: integer('locality_id')
      .notNull()
      .references(() => localities.id, { onDelete: 'cascade' }),
    status: text('status').$type<ScanRunStatus>().notNull().default('pending'),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    /** Worker identity, so a stuck claim can be attributed. */
    claimedBy: text('claimed_by'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    /** Integer micros. Checked BEFORE each purchase. */
    budgetCapMicros: bigint('budget_cap_micros', { mode: 'bigint' }).notNull(),
    spendMicros: bigint('spend_micros', { mode: 'bigint' }).notNull().default(zeroMicros),
    nicheCount: integer('niche_count'),
    /**
     * Persisted per run, not read from the environment at display time. A fixture
     * run must keep announcing itself in the UI long after LIVE_CALLS_ENABLED
     * changed -- otherwise synthetic markets become indistinguishable from real
     * ones, in a tool people spend money from.
     */
    usedFixtures: boolean('used_fixtures').notNull().default(true),
    error: text('error'),
    createdAt: now(),
  },
  (t) => ({
    // The claim query's index: pending rows, oldest first.
    claimIdx: index('scan_runs_claim_idx').on(t.status, t.createdAt),
    localityIdx: index('scan_runs_locality_idx').on(t.localityId),
  }),
)

// ---------------------------------------------------------------------------

export const scanTargets = pgTable(
  'scan_targets',
  {
    id: serial('id').primaryKey(),
    scanRunId: integer('scan_run_id')
      .notNull()
      .references(() => scanRuns.id, { onDelete: 'cascade' }),
    localityId: integer('locality_id')
      .notNull()
      .references(() => localities.id, { onDelete: 'cascade' }),
    nicheId: integer('niche_id')
      .notNull()
      .references(() => niches.id, { onDelete: 'cascade' }),
    keyword: text('keyword').notNull(),

    /** NULLABLE. Null = nothing could be measured. Renders as em dash, never 0. */
    difficulty: integer('difficulty'),
    /** Fraction of component weight actually measured, 0..1. Shown in the UI. */
    weightCovered: doublePrecision('weight_covered').notNull(),
    /** Every component including the unmeasured ones, with notes. */
    components: jsonb('components').notNull(),

    verdict: text('verdict').$type<Verdict>().notNull(),
    /** Named reasons, never an opaque downgrade. */
    blockers: jsonb('blockers').notNull(),
    /** All seven 30-day gates, pass or fail, for the audit view. */
    gates: jsonb('gates').notNull(),

    /** NULLABLE. Null = no population, so no estimate. Not zero. */
    volumeEst: integer('volume_est'),
    /** Always true today -- city-level volume cannot be purchased. */
    volumeEstimated: boolean('volume_estimated').notNull().default(true),
    /** NULLABLE micros. Null = unknown, which is not the same as worthless. */
    rentMicros: bigint('rent_micros', { mode: 'bigint' }),

    slotsOpen: integer('slots_open').notNull(),
    platformHeldSlots: integer('platform_held_slots').notNull(),
    /**
     * doublePrecision, not integer: the median of an even-length list is
     * genuinely fractional (27.5). Rounding on the way in would quietly alter a
     * measured value to fit the column, so the column widens instead and the UI
     * rounds for display.
     */
    medianRefDomains: doublePrecision('median_ref_domains'),
    linkDataMeasured: boolean('link_data_measured').notNull(),

    emdDomain: text('emd_domain').notNull(),
    /** THREE states: true / false / null. Null must never read as available. */
    emdAvailable: boolean('emd_available'),
    emdAvailabilityMethod: text('emd_availability_method'),
    emdAvailabilityDetail: text('emd_availability_detail'),

    /** The ten classified results, so the detail view is auditable. */
    results: jsonb('results').notNull(),
    mapPack: jsonb('map_pack'),
    createdAt: now(),
  },
  (t) => ({
    runNicheUq: uniqueIndex('scan_targets_run_niche_uq').on(t.scanRunId, t.nicheId),
    runIdx: index('scan_targets_run_idx').on(t.scanRunId, t.difficulty),
  }),
)

// ---------------------------------------------------------------------------

export const shortlistItems = pgTable(
  'shortlist_items',
  {
    id: serial('id').primaryKey(),
    localityId: integer('locality_id')
      .notNull()
      .references(() => localities.id, { onDelete: 'cascade' }),
    nicheId: integer('niche_id')
      .notNull()
      .references(() => niches.id, { onDelete: 'cascade' }),
    scanTargetId: integer('scan_target_id').references(() => scanTargets.id, {
      onDelete: 'set null',
    }),

    /**
     * ==================== FROZEN AT DECISION TIME ====================
     * Calibration compares outcomes against what the model said WHEN THE
     * DECISION WAS MADE. Joining to a live score instead compares today's
     * thresholds against yesterday's build, so every band validates itself:
     * change a constant in priors.ts and the historical predictions silently
     * change to match, and the hit rate can never fall.
     * ================================================================
     */
    difficultyAtSave: integer('difficulty_at_save'),
    verdictAtSave: text('verdict_at_save').$type<Verdict>().notNull(),
    weightCoveredAtSave: doublePrecision('weight_covered_at_save').notNull(),
    emdAvailableAtSave: boolean('emd_available_at_save'),

    emdDomain: text('emd_domain').notNull(),
    state: text('state').$type<BuildState>().notNull().default('watching'),
    /** Set when state becomes 'building'. Drives outcome check scheduling. */
    buildStartedAt: timestamp('build_started_at', { withTimezone: true }),
    notes: text('notes'),
    savedAt: timestamp('saved_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: now(),
  },
  (t) => ({
    cellUq: uniqueIndex('shortlist_items_cell_uq').on(t.localityId, t.nicheId),
    stateIdx: index('shortlist_items_state_idx').on(t.state),
  }),
)

// ---------------------------------------------------------------------------

export const outcomes = pgTable(
  'outcomes',
  {
    id: serial('id').primaryKey(),
    shortlistItemId: integer('shortlist_item_id')
      .notNull()
      .references(() => shortlistItems.id, { onDelete: 'cascade' }),
    /** 7 | 14 | 30 | 60 | 90 */
    dayOffset: integer('day_offset').notNull(),
    /** NOT NULL: the row existing is what makes this a measurement. */
    checkedAt: timestamp('checked_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * ==================== NULL MEANS CHECKED AND NOWHERE ====================
     * It is a MEASUREMENT, not a gap. Treating it as missing data drops every
     * failed build out of the denominator, and every band then reports an
     * excellent hit rate computed only over its successes.
     * =======================================================================
     */
    position: integer('position'),
    keyword: text('keyword').notNull(),
    locationCode: integer('location_code').notNull(),
    costMicros: bigint('cost_micros', { mode: 'bigint' }).notNull().default(zeroMicros),
    createdAt: now(),
  },
  (t) => ({
    itemDayUq: uniqueIndex('outcomes_item_day_uq').on(t.shortlistItemId, t.dayOffset),
  }),
)

// ---------------------------------------------------------------------------

/** One row per purchase, so the run total is auditable rather than merely tracked. */
export const spendLedger = pgTable(
  'spend_ledger',
  {
    id: serial('id').primaryKey(),
    scanRunId: integer('scan_run_id').references(() => scanRuns.id, { onDelete: 'cascade' }),
    /**
     * Voice spend. Retell reports `call_cost.combined_cost` in CENTS; it arrives
     * here as micros via centsToMicros so a phone call reconciles through exactly
     * the same path as a DataForSEO purchase.
     *
     * Nullable and mutually exclusive with scanRunId in practice, not in the
     * schema -- a CHECK constraint here would buy nothing and block a future
     * charge that legitimately belongs to both.
     */
    siteId: integer('site_id').references(() => sites.id, { onDelete: 'set null' }),
    /**
     * Discovery research spend. Same mutual-null pattern as scan/site: a row
     * belongs to the purchase path that paid for it. on_promote commentability
     * may set both site_id and discovery_run_id (audit trail only for the latter).
     */
    /**
     * ==================== A LEDGER MUST NOT FORGET ====================
     * This was ON DELETE CASCADE, so deleting a run deleted its spend lines --
     * and deleting runs is a normal thing to do here ("delete a run to
     * re-research the same selection"). The money had already left the
     * DataForSEO account, so the books quietly reset while the balance did not:
     * $51 of lifetime spend showed up as $2.72 of ledger.
     *
     * SET NULL keeps the line and drops only the association. The note carries
     * the run id in text, so a deleted run's spend is still attributable.
     * ===============================================================
     */
    discoveryRunId: integer('discovery_run_id').references(() => discoveryRuns.id, {
      onDelete: 'set null',
    }),
    endpoint: text('endpoint').notNull(),
    costMicros: bigint('cost_micros', { mode: 'bigint' }).notNull(),
    rows: integer('rows'),
    note: text('note'),
    createdAt: now(),
  },
  (t) => ({
    runIdx: index('spend_ledger_run_idx').on(t.scanRunId),
    siteIdx: index('spend_ledger_site_idx').on(t.siteId),
    discoveryRunIdx: index('spend_ledger_discovery_run_idx').on(t.discoveryRunId),
  }),
)

// ---------------------------------------------------------------------------
// Caches
// ---------------------------------------------------------------------------

export const serpSnapshots = pgTable(
  'serp_snapshots',
  {
    id: serial('id').primaryKey(),
    keyword: text('keyword').notNull(),
    locationCode: integer('location_code').notNull(),
    /** 'organic' | 'maps' */
    seType: text('se_type').notNull(),
    payload: jsonb('payload').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    costMicros: bigint('cost_micros', { mode: 'bigint' }).notNull().default(zeroMicros),
    /** 'live' | 'fixture' -- so a cache hit cannot launder a fixture into a real run. */
    source: text('source').notNull(),
  },
  (t) => ({
    keyUq: uniqueIndex('serp_snapshots_key_uq').on(t.keyword, t.locationCode, t.seType),
    expiryIdx: index('serp_snapshots_expiry_idx').on(t.expiresAt),
  }),
)

export const domainAuthority = pgTable(
  'domain_authority',
  {
    target: text('target').primaryKey(),
    rank: integer('rank'),
    referringDomains: integer('referring_domains'),
    referringDomainsNofollow: integer('referring_domains_nofollow'),
    referringMainDomains: integer('referring_main_domains'),
    spamScore: integer('spam_score'),
    /** Which of the three endpoints answered. Empty = nothing measured. */
    sources: jsonb('sources').$type<string[]>().notNull(),
    /**
     * FALSE = the API had no data for this domain: the 14-day NEGATIVE cache.
     * Small local sites with no measurable link profile are the COMMON case on
     * these SERPs, not the edge case, and without negative caching they are
     * re-requested and re-paid for on every scan forever.
     */
    resolved: boolean('resolved').notNull(),
    measuredAt: timestamp('measured_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => ({
    expiryIdx: index('domain_authority_expiry_idx').on(t.expiresAt),
  }),
)

export const domainAvailability = pgTable(
  'domain_availability',
  {
    domain: text('domain').primaryKey(),
    /** NULLABLE three-state. Null = could not tell. Never treat as available. */
    available: boolean('available'),
    method: text('method').notNull(),
    httpStatus: integer('http_status'),
    detail: text('detail'),
    checkedAt: timestamp('checked_at', { withTimezone: true }).notNull().defaultNow(),
    /** Short TTL: unlike link profiles, this changes overnight. */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => ({
    expiryIdx: index('domain_availability_expiry_idx').on(t.expiresAt),
  }),
)

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Sites & CRM
// ---------------------------------------------------------------------------

/**
 * A domain you bought, and the revenue it produces.
 *
 * This is the table that turns `calls` into outcome data for the rent model.
 * `shortlist_items` already freezes what the model PREDICTED at decision time;
 * without a row here carrying locality, niche and a link back to that prediction,
 * actual call volume can never falsify it and modelled rent stays a prior forever.
 */
export const sites = pgTable(
  'sites',
  {
    id: serial('id').primaryKey(),
    /**
     * Lowercased, no scheme, no www. See @rnr/core normalizeDomain.
     *
     * ==================== NULLABLE: THE CELL COMES FIRST ====================
     * A locality+niche is targeted before a domain is bought -- you start monitoring
     * keywords and posting comments while still deciding what to register. Requiring a
     * domain up front forced a placeholder row, and a placeholder domain is worse than
     * no domain: it is unique, so it silently claims the name.
     *
     * The CELL is what is unique here, not the domain. See sites_active_cell_uq in
     * scripts/db-extras.ts.
     * =====================================================================
     */
    domain: text('domain'),

    /**
     * What kind of property this is, and therefore which models apply to it.
     *
     * ==================== WHY THIS COLUMN EXISTS ====================
     * `local_lead_gen` is the original product: one locality x one niche, money
     * from phone calls. `affiliate` is a directory site that spans hundreds of
     * localities (hotelhottubs.com) or none at all (borenhealth.com), and earns
     * per referred purchase.
     *
     * It is a GATE, not a label. Three models -- assessEmd, assessAcquiredDomain
     * and the population demand estimate -- are correct for local services and
     * return confident, OPTIMISTIC nonsense on an affiliate keyword. See
     * @rnr/core localModelsApply.
     * ===============================================================
     */
    kind: text('kind').$type<SiteKind>().notNull().default('local_lead_gen'),

    /**
     * ==================== NULLABLE SINCE AFFILIATE SITES ====================
     * These were NOT NULL, and for `local_lead_gen` they still are in practice --
     * they are what make the list sortable and what let call volume roll up into
     * calibration.
     *
     * They cannot be NOT NULL any more because `borenhealth.com` has no locality
     * and no niche: peptides are not geographic and the niche corpus is 41 home
     * services. `hotelhottubs.com` has the opposite problem -- ~300 localities
     * and one domain, which `sites_domain_uq` correctly refuses to express as
     * 300 rows.
     *
     * The cell uniqueness that used to be implied by NOT NULL is now enforced by
     * a partial index scoped to kind='local_lead_gen' in scripts/db-extras.ts.
     * =====================================================================
     */
    localityId: integer('locality_id').references(() => localities.id, { onDelete: 'restrict' }),
    nicheId: integer('niche_id').references(() => niches.id, { onDelete: 'restrict' }),

    /**
     * How this site's target keywords are generated. NULL for local cells, which
     * derive theirs from the niche.
     *
     * Shape is @rnr/core KeywordSpace: geoMode, audienceScope, serpLocationCode,
     * dimensions, patterns, volumeFloor. `audienceScope` has NO DEFAULT on
     * purpose -- both current affiliate sites happen to be country:US for
     * entirely different reasons, and two sites agreeing is not evidence that
     * agreement is automatic.
     */
    keywordSpace: jsonb('keyword_space').$type<KeywordSpace>(),

    /**
     * Affiliate economics. Operator inputs and a network measurement -- NOT
     * derivable from anything this tool can buy, which is why they live here as
     * plain nullable columns rather than as priors on a niche row.
     *
     * `affiliateConversionRateBps` in particular must stay null until affiliate
     * network data is imported. A plausible 2% here would make every keyword
     * look valued when none of them are measured.
     */
    affiliateOrderValueMicros: bigint('affiliate_order_value_micros', { mode: 'bigint' }),
    affiliateCommissionRateBps: integer('affiliate_commission_rate_bps'),
    affiliateConversionRateBps: integer('affiliate_conversion_rate_bps'),
    /** Named sets from @rnr/core VERTICAL_PLATFORM_DOMAINS, e.g. ['travel']. */
    platformVerticals: jsonb('platform_verticals').$type<string[]>(),

    /** NULL when the domain did not come from a scan. Set on the common path. */
    shortlistItemId: integer('shortlist_item_id').references(() => shortlistItems.id, {
      onDelete: 'set null',
    }),

    /** AUTHORITATIVE over shortlist_items.state once this row exists. See SiteStatus. */
    status: text('status').$type<SiteStatus>().notNull().default('parked'),
    /** What the agent calls the business out loud. NULL falls back to "our office". */
    displayName: text('display_name'),

    /** E.164. NULL = no number wired up yet, which is NOT "zero calls". */
    trackingNumber: text('tracking_number'),
    twilioNumberSid: text('twilio_number_sid'),
    /** NULL = never imported into Retell. Distinct from "imported, none arrived". */
    retellNumberImportedAt: timestamp('retell_number_imported_at', { withTimezone: true }),
    retellAgentId: text('retell_agent_id'),
    /**
     * The agent this site used before the last switch. NULL = never switched.
     *
     * Kept so "switch back" is one click while the mistake is still on the phone. A
     * switch does not delete the old agent -- it stays live and billable in Retell --
     * so rollback is a PATCH, and the only thing that could make it hard is forgetting
     * which agent to go back to.
     */
    previousRetellAgentId: text('previous_retell_agent_id'),
    /**
     * First webhook from a call this system did NOT generate.
     *
     * ==================== A FIXTURE IS NOT A CONNECTION ====================
     * `first_webhook_at` is set by the "Send test event" button as well as by a real
     * caller, because both arrive through the same verified route. That made a site
     * look connected while its number had never been attached to the trunk -- which
     * is exactly what San Jose looked like for an afternoon before anyone dialled it.
     *
     * The fixture still proves something real (signature, routing, ingest, lead write)
     * and is still worth recording. It just is not evidence that a phone works, so it
     * gets a different column and the setup wizard reads THIS one.
     * =====================================================================
     */
    firstRealCallAt: timestamp('first_real_call_at', { withTimezone: true }),
    retellAgentVersion: integer('retell_agent_version'),
    /**
     * Fingerprint of the prompt in @rnr/core when it was last pushed to Retell.
     * Compared against the live one so "did I push after editing" is answerable.
     */
    promptFingerprint: text('prompt_fingerprint'),

    timezone: text('timezone').notNull().default('America/Chicago'),
    /** Missing/null day = CLOSED. Never "open 24h" -- see @rnr/core hours.ts. */
    hours: jsonb('hours').$type<WeeklyHours>(),
    serviceAreaZips: jsonb('service_area_zips').$type<string[]>(),
    dispatchFeeMicros: bigint('dispatch_fee_micros', { mode: 'bigint' }),
    /** Emergency transfer target, and the Twilio disaster-recovery fallback. */
    onCallNumber: text('on_call_number'),
    leadAlertNumber: text('lead_alert_number'),

    /**
     * ============ NULL = RETELL HAS NEVER CONTACTED US FOR THIS SITE ============
     * Drives a permanent banner. This is the repo's founding bug in a new costume:
     * a number whose webhook URL was never configured produces real calls, sends
     * nothing, and renders as `0 calls` -- and zero calls is indistinguishable
     * from never-connected on any dashboard that does not track this.
     * ==========================================================================
     */
    firstWebhookAt: timestamp('first_webhook_at', { withTimezone: true }),
    lastWebhookAt: timestamp('last_webhook_at', { withTimezone: true }),

    purchasedAt: timestamp('purchased_at', { withTimezone: true }),
    notes: text('notes'),
    createdAt: now(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    /**
     * Still unique, and NULL-tolerant: Postgres treats NULLs as distinct, so any number
     * of not-yet-bought cells coexist while a real domain can still only be claimed once.
     */
    domainUq: uniqueIndex('sites_domain_uq').on(t.domain),
    /**
     * NOT unique. History must survive a number being reassigned between sites,
     * so uniqueness is enforced only over live sites, in a partial index added by
     * the migration script (drizzle-kit cannot express a WHERE clause here).
     */
    trackingIdx: index('sites_tracking_idx').on(t.trackingNumber),
    cellIdx: index('sites_cell_idx').on(t.localityId, t.nicheId),
    statusIdx: index('sites_status_idx').on(t.status),
  }),
)

export const calls = pgTable(
  'calls',
  {
    id: serial('id').primaryKey(),
    /** Retell's id. UNIQUE: this is the idempotency key for its 3x webhook retries. */
    retellCallId: text('retell_call_id').notNull(),

    /**
     * FROZEN from metadata.site_id at ring time, never re-derived from toNumber.
     *
     * Resolving by phone number at report time silently reattributes every
     * historical call the moment a number moves between sites -- the same class
     * of error that `difficulty_at_save` exists to prevent on the research side.
     *
     * NULL + unattributedReason = the inbound webhook did not resolve. Visible in
     * its own view, never dropped and never guessed.
     */
    siteId: integer('site_id').references(() => sites.id, { onDelete: 'set null' }),
    unattributedReason: text('unattributed_reason'),

    direction: text('direction').notNull().default('inbound'),
    fromNumber: text('from_number'),
    toNumber: text('to_number'),
    agentId: text('agent_id'),

    /**
     * Created on `call_started`, NOT on `call_ended`.
     *
     * A caller who hangs up at four seconds is a MEASUREMENT: abandon rate is how
     * you learn the greeting is too slow or too obviously synthetic. Create the
     * row at end-of-call and every abandoned call vanishes and the funnel looks
     * perfect.
     */
    startedAt: timestamp('started_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    durationMs: integer('duration_ms'),
    disconnectionReason: text('disconnection_reason'),
    /** How far the webhook sequence got. Not an outcome. */
    ingestState: text('ingest_state').$type<CallIngestState>().notNull().default('started'),
    /**
     * True for a call created by `voice:simulate`, the "Send test event" button, or
     * the e2e suite -- detected from the call-id prefix at ingest.
     *
     * ==================== WHY THIS COLUMN EXISTS ====================
     * A simulated call produces a real lead row, which enqueues a real delivery job.
     * With LIVE_CALLS_ENABLED=true that job texts the contractor's actual phone about
     * a caller who does not exist. Testing the dashboard should not page a human.
     * ==============================================================
     */
    simulated: boolean('simulated').notNull().default(false),

    transcript: text('transcript'),
    transcriptObject: jsonb('transcript_object'),
    /** Raw post-call analysis, kept whole so a mis-extraction is auditable. */
    analysis: jsonb('analysis'),
    userSentiment: text('user_sentiment'),
    /** NULLABLE three-state. NULL = not analyzed yet, which is not "unsuccessful". */
    callSuccessful: boolean('call_successful'),
    inVoicemail: boolean('in_voicemail'),

    /**
     * Retell reports per-call latency percentiles. Persisted because "callers
     * cannot tell it is an AI" is a claim that needs a number, and p95 -- not p50
     * -- is the one that generates complaints.
     */
    latencyE2eP50Ms: integer('latency_e2e_p50_ms'),
    latencyE2eP90Ms: integer('latency_e2e_p90_ms'),
    latencyE2eP95Ms: integer('latency_e2e_p95_ms'),
    latencyLlmP50Ms: integer('latency_llm_p50_ms'),
    latencyTtsP50Ms: integer('latency_tts_p50_ms'),

    costMicros: bigint('cost_micros', { mode: 'bigint' }),

    /** Retell's S3 link. Expires; not a source of truth. See recordings.ts. */
    recordingUrlUpstream: text('recording_url_upstream'),
    /** NULL = we do not have the audio. The UI must never render a play button. */
    recordingPath: text('recording_path'),
    recordingBytes: integer('recording_bytes'),
    recordingFetchedAt: timestamp('recording_fetched_at', { withTimezone: true }),
    /** Why we don't have it. Both NULL = not attempted yet. */
    recordingMissingReason: text('recording_missing_reason'),

    createdAt: now(),
  },
  (t) => ({
    retellUq: uniqueIndex('calls_retell_call_id_uq').on(t.retellCallId),
    siteTimeIdx: index('calls_site_time_idx').on(t.siteId, t.startedAt),
    createdIdx: index('calls_created_idx').on(t.createdAt),
  }),
)

export const leads = pgTable(
  'leads',
  {
    id: serial('id').primaryKey(),
    siteId: integer('site_id').references(() => sites.id, { onDelete: 'set null' }),
    callId: integer('call_id').references(() => calls.id, { onDelete: 'set null' }),
    source: text('source').$type<LeadSource>().notNull().default('call'),

    name: text('name'),
    phone: text('phone'),
    email: text('email'),
    addressLine: text('address_line'),
    city: text('city'),
    zip: text('zip'),

    problem: text('problem'),
    systemType: text('system_type'),
    systemAgeYears: integer('system_age_years'),

    /**
     * ============ NULL IS NOT FALSE, AND THIS ONE CAN HURT SOMEONE ============
     * NULL = the agent never established urgency. Rendering that as "routine" is
     * how a no-heat call at 11pm in January gets queued for Tuesday. The tool
     * parser in @rnr/core coerces "unknown"/"maybe"/absent to NULL for exactly
     * this reason, and it is tested.
     * ========================================================================
     */
    isEmergency: boolean('is_emergency'),
    /** Named hazard when triage fired, for the audit trail. */
    hazard: text('hazard'),
    /** NULL = zip never validated. An unvalidated zip is not an in-area zip. */
    inServiceArea: boolean('in_service_area'),
    /** NULL = never determined. A known renter cannot authorise work; unknown can. */
    isOwner: boolean('is_owner'),
    isCommercial: boolean('is_commercial'),
    /** NULLABLE and sorts LAST, exactly like scan_targets.difficulty. */
    qualified: boolean('qualified'),

    /**
     * Which fields the agent actually asked and confirmed, independent of value.
     * "address is null" and "address was never asked" are different bugs and only
     * one of them is the agent's fault.
     */
    capturedFields: jsonb('captured_fields')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** 'tool' = mid-call, authoritative. 'analysis' = post-call backfill. */
    capturedVia: text('captured_via').$type<LeadCapturedVia>().notNull().default('tool'),
    /**
     * Set when post-call analysis disagreed with the mid-call tool. The tool wins;
     * this records the disagreement, because a recurring conflict on one field is
     * a prompt bug and this is the only place it becomes visible.
     */
    reconcileConflict: jsonb('reconcile_conflict'),

    appointmentAt: timestamp('appointment_at', { withTimezone: true }),
    notes: text('notes'),
    createdAt: now(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    /** One lead per call. The mid-call tool upserts against this. */
    callUq: uniqueIndex('leads_call_uq').on(t.callId),
    siteTimeIdx: index('leads_site_time_idx').on(t.siteId, t.createdAt),
    emergencyIdx: index('leads_emergency_idx').on(t.isEmergency),
  }),
)

/**
 * Append-only webhook log. Insert FIRST, process second.
 *
 * A handler that throws still leaves the payload here, so every ingest bug is
 * replayable instead of lost -- the same argument as `spend_ledger` storing a row
 * per purchase rather than a running total.
 */
export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: serial('id').primaryKey(),
    provider: text('provider').notNull().default('retell'),
    eventType: text('event_type').notNull(),
    retellCallId: text('retell_call_id'),
    siteId: integer('site_id').references(() => sites.id, { onDelete: 'set null' }),
    payload: jsonb('payload').notNull(),
    /**
     * Recorded, not enforced by discarding. A payload that failed verification is
     * evidence -- of a misconfigured secret, or of someone probing the endpoint --
     * and dropping it silently loses both.
     */
    signatureValid: boolean('signature_valid').notNull(),
    /** NULL = handled cleanly. Set = the handler threw. */
    handlerError: text('handler_error'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    /** Retell's documented idempotency key: event type + call id. */
    dedupeUq: uniqueIndex('webhook_events_dedupe_uq').on(t.eventType, t.retellCallId),
    callIdx: index('webhook_events_call_idx').on(t.retellCallId),
    receivedIdx: index('webhook_events_received_idx').on(t.receivedAt),
  }),
)

/**
 * THIS TABLE IS THE QUEUE, exactly like `scan_runs`. There is still no Redis.
 *
 * Claimed with the same `FOR UPDATE SKIP LOCKED` pattern by the same single
 * consumer (`pnpm worker`), so there is no second system to forget to poll.
 */
export const voiceJobs = pgTable(
  'voice_jobs',
  {
    id: serial('id').primaryKey(),
    kind: text('kind').$type<VoiceJobKind>().notNull(),
    callId: integer('call_id').references(() => calls.id, { onDelete: 'cascade' }),
    leadId: integer('lead_id').references(() => leads.id, { onDelete: 'cascade' }),
    status: text('status').$type<VoiceJobStatus>().notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    /** Backoff. The claim query only takes rows whose time has come. */
    runAfter: timestamp('run_after', { withTimezone: true }).notNull().defaultNow(),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    claimedBy: text('claimed_by'),
    lastError: text('last_error'),
    createdAt: now(),
  },
  (t) => ({
    claimIdx: index('voice_jobs_claim_idx').on(t.status, t.runAfter),
    /** One live job of a kind per target, so retries cannot fan out. */
    kindCallUq: uniqueIndex('voice_jobs_kind_call_uq').on(t.kind, t.callId),
  }),
)

/**
 * One row per delivery ATTEMPT, mirroring `spend_ledger`.
 *
 * Whether the contractor actually received the lead becomes reconcilable rather
 * than assumed. A lead captured perfectly and never delivered is a lost lead, and
 * a summary counter on the lead row would hide it.
 */
export const leadDeliveries = pgTable(
  'lead_deliveries',
  {
    id: serial('id').primaryKey(),
    leadId: integer('lead_id')
      .notNull()
      .references(() => leads.id, { onDelete: 'cascade' }),
    channel: text('channel').$type<DeliveryChannel>().notNull(),
    target: text('target').notNull(),
    status: text('status').$type<DeliveryStatus>().notNull().default('pending'),
    attempt: integer('attempt').notNull().default(1),
    providerId: text('provider_id'),
    error: text('error'),
    /** NULL until the provider confirmed. Not defaulted to now(). */
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: now(),
  },
  (t) => ({
    leadIdx: index('lead_deliveries_lead_idx').on(t.leadId),
    statusIdx: index('lead_deliveries_status_idx').on(t.status),
  }),
)

/**
 * What became of a lead.
 *
 * ==================== THE ROW EXISTING IS THE MEASUREMENT ====================
 * Modelled on `outcomes`: no row means NOBODY HAS FOLLOWED UP, which is not the same
 * fact as "we called and it went nowhere". That is why `disposition` is NOT NULL with
 * no 'unknown' member -- a nullable disposition would let the two collapse, and then a
 * close rate computed over all leads would silently punish the follow-up you never did
 * rather than the market.
 *
 * So close rate is computed only over leads that HAVE a row, and the UI shows coverage
 * beside it -- the same treatment `weightCovered` gets next to every difficulty score.
 * ==========================================================================
 */
export const leadOutcomes = pgTable(
  'lead_outcomes',
  {
    id: serial('id').primaryKey(),
    /** UNIQUE: one current disposition per lead, updated in place. */
    leadId: integer('lead_id')
      .notNull()
      .references(() => leads.id, { onDelete: 'cascade' }),
    disposition: text('disposition').$type<LeadDisposition>().notNull(),
    /**
     * NULLABLE. A booked job whose value was never recorded is not a $0 job -- summing
     * it as zero would understate the site and make the rent model look wrong for a
     * bookkeeping reason. `closeRate` reports how many wins are missing a value so the
     * total reads as the floor it is.
     */
    jobValueMicros: bigint('job_value_micros', { mode: 'bigint' }),
    notes: text('notes'),
    /** Free text -- who recorded it. No user table to reference yet. */
    recordedBy: text('recorded_by'),
    /** NOT NULL: same as outcomes.checked_at. The row is the measurement. */
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: now(),
  },
  (t) => ({
    leadUq: uniqueIndex('lead_outcomes_lead_uq').on(t.leadId),
    dispositionIdx: index('lead_outcomes_disposition_idx').on(t.disposition),
  }),
)

/**
 * The last known state of a Retell agent, pulled from the API or uploaded as JSON.
 *
 * ==================== RETELL OWNS THE CONVERSATION ====================
 * A Conversation Flow agent is a hand-built graph of nodes. This repo stores a
 * SNAPSHOT of it and audits the integration contract around it -- webhook URL, the
 * save_lead function, analysis fields -- and never overwrites the conversation.
 *
 * The snapshot is what makes drift visible: edit the flow in the builder, pull
 * again, and the diff is on screen instead of being discovered by a customer.
 * =====================================================================
 */
export const retellAgents = pgTable(
  'retell_agents',
  {
    agentId: text('agent_id').primaryKey(),
    agentName: text('agent_name'),
    /** 'conversation-flow' | 'retell-llm' | 'custom-llm' */
    responseEngineType: text('response_engine_type'),
    conversationFlowId: text('conversation_flow_id'),
    version: integer('version'),
    isPublished: boolean('is_published'),
    voiceId: text('voice_id'),
    language: text('language'),
    /** NULL = no webhook configured, which means this CRM receives NOTHING. */
    webhookUrl: text('webhook_url'),
    postCallAnalysisFields: jsonb('post_call_analysis_fields').$type<string[]>(),
    dataStorageSetting: text('data_storage_setting'),
    nodeCount: integer('node_count'),
    toolNames: jsonb('tool_names').$type<string[]>(),
    /** Whole payloads, kept so a parse gap is recoverable rather than lost. */
    remoteAgent: jsonb('remote_agent'),
    remoteFlow: jsonb('remote_flow'),
    /** 'api' | 'upload' -- an uploaded JSON is a claim about Retell, not a reading of it. */
    source: text('source').notNull().default('api'),
    pulledAt: timestamp('pulled_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: now(),
  },
  (t) => ({
    pulledIdx: index('retell_agents_pulled_idx').on(t.pulledAt),
  }),
)


// ---------------------------------------------------------------------------
// SERP monitoring
// ---------------------------------------------------------------------------

/**
 * Keywords for a cell, imported from a Semrush export.
 *
 * Scoped to a site (= a locality+niche cell) because that is the unit you buy a domain for
 * and post comments under. Volume/difficulty/position are Semrush's numbers AT IMPORT TIME
 * and are never refreshed here -- they are context for choosing what to watch, not
 * measurements this system makes. All nullable: an export that omits a column must not
 * imply a zero.
 */
export const serpKeywords = pgTable(
  'serp_keywords',
  {
    id: serial('id').primaryKey(),
    siteId: integer('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    keyword: text('keyword').notNull(),
    /** NULL = the export did not report it. Not "no searches". */
    volume: integer('volume'),
    difficulty: integer('difficulty'),
    cpcMicros: bigint('cpc_micros', { mode: 'bigint' }),
    /** What Semrush said OUR position was when the file was exported. Historical. */
    semrushPosition: integer('semrush_position'),
    semrushUrl: text('semrush_url'),
    /** Groups an import so a bad file can be identified and undone. */
    importBatch: text('import_batch').notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: now(),
  },
  (t) => ({
    siteKeywordUq: uniqueIndex('serp_keywords_site_keyword_uq').on(t.siteId, t.keyword),
    activeIdx: index('serp_keywords_active_idx').on(t.siteId, t.active),
  }),
)

/**
 * A URL watched for a keyword -- in practice a Reddit thread you commented on.
 *
 * THIS TABLE IS THE QUEUE. `next_check_at` is claimed with FOR UPDATE SKIP LOCKED exactly
 * like `scan_runs`, so there is still no Redis and no second system to forget to poll.
 */
export const serpTargets = pgTable(
  'serp_targets',
  {
    id: serial('id').primaryKey(),
    keywordId: integer('keyword_id')
      .notNull()
      .references(() => serpKeywords.id, { onDelete: 'cascade' }),
    /** The thread URL as pasted, kept verbatim for audit. */
    url: text('url').notNull(),
    platform: text('platform').notNull().default('reddit'),
    /** Parsed from the permalink. Base-36, e.g. 1e8w3qh. */
    redditPostId: text('reddit_post_id'),
    /**
     * The full permalink to OUR comment, as pasted.
     *
     * Identity is by permalink rather than by username: it pins one specific comment, which
     * is what "did my comment lose its place" is actually asking about.
     */
    commentPermalink: text('comment_permalink'),
    /** Parsed from the permalink. NULL = watching the post's ranking only. */
    commentId: text('comment_id'),
    label: text('label'),
    active: boolean('active').notNull().default(true),
    /** The queue column. Due when <= now(). */
    nextCheckAt: timestamp('next_check_at', { withTimezone: true }).notNull().defaultNow(),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    claimedBy: text('claimed_by'),
    createdAt: now(),
  },
  (t) => ({
    keywordUrlUq: uniqueIndex('serp_targets_keyword_url_uq').on(t.keywordId, t.url),
    claimIdx: index('serp_targets_claim_idx').on(t.active, t.nextCheckAt),
  }),
)

/**
 * One measurement. Append-only.
 *
 * ==================== THE ROW EXISTING IS THE MEASUREMENT ====================
 * Same encoding as `outcomes`: `serp_position` NULL means WE RAN THE SEARCH AND THE THREAD
 * WAS NOT THERE, which is the "post is not showing up" signal -- not missing data.
 *
 * `comment_present` is the three-state one, and it is the column this whole feature can get
 * dangerously wrong: NULL means we could not measure (Reddit blocked us, or the tree was
 * truncated), FALSE means we loaded a complete thread and the comment is gone. Only FALSE
 * may raise "your comment was removed". Reddit answers 403 to server IPs, so NULL will be
 * common and must stay silent.
 * ==========================================================================
 */
export const serpChecks = pgTable(
  'serp_checks',
  {
    id: serial('id').primaryKey(),
    targetId: integer('target_id')
      .notNull()
      .references(() => serpTargets.id, { onDelete: 'cascade' }),
    /** NOT NULL. The row is the measurement. */
    checkedAt: timestamp('checked_at', { withTimezone: true }).notNull().defaultNow(),

    /** Did the SERP call actually happen? False => serpPosition says nothing. */
    serpMeasured: boolean('serp_measured').notNull().default(false),
    /** NULL + serpMeasured = checked and not in the top 100. */
    serpPosition: integer('serp_position'),
    /**
     * Position inside the Discussions and Forums pack (1-based), when the thread
     * appears there. Distinct from organic serpPosition — pack-only threads have
     * this set and serpPosition null.
     */
    serpPackPosition: integer('serp_pack_position'),
    /**
     * Where the thread was found: 'organic' | 'discussions_and_forums' | 'both' | null.
     * null + serpMeasured means measured and absent from both surfaces.
     */
    serpSourceKind: text('serp_source_kind'),
    /** Our own site's position for the same keyword -- free from the same response. */
    ourDomainPosition: integer('our_domain_position'),

    /** 1-based ordinal among top-level comments. NULL = unmeasured. */
    commentRank: integer('comment_rank'),
    /** Denominator, so an ordinal is interpretable. */
    commentTotal: integer('comment_total'),
    /** THREE-STATE. See the table comment. */
    commentPresent: boolean('comment_present'),

    /** 'dataforseo_serp' | 'dataforseo_page' | 'fixture' -- provenance for every number. */
    measuredVia: text('measured_via'),
    /** Why something is NULL. The reason is as important as the value. */
    error: text('error'),
    costMicros: bigint('cost_micros', { mode: 'bigint' }).notNull().default(zeroMicros),
    createdAt: now(),
  },
  (t) => ({
    targetTimeIdx: index('serp_checks_target_time_idx').on(t.targetId, t.checkedAt),
  }),
)

// ---------------------------------------------------------------------------
// Reddit SERP discovery research (niche × geo grid)
// ---------------------------------------------------------------------------

/**
 * One bulk research run: import niches + geos, purchase SERPs, extract Reddit hits.
 *
 * Jobs are claimed individually; the run row is locked only for atomic spend
 * reservation and terminal transitions. Status set is wider than scan_runs
 * (includes cancelled / budget_exceeded). Sticky terminal only when phase = complete.
 */
export type DiscoveryRunStatus =
  | 'pending'
  | 'running'
  | 'done'
  | 'failed'
  | 'budget_exceeded'
  | 'cancelled'

export type DiscoveryRunPhase = 'serp' | 'commentability' | 'complete'

export type DiscoveryCommentabilityMode = 'none' | 'on_promote' | 'after_discovery'

export type DiscoveryGeoResolveStatus = 'resolved' | 'unresolved' | 'unscannable_source'

export type DiscoveryJobKind = 'serp' | 'commentability'

/**
 * `awaiting` belongs to the queued-SERP path: the task is posted and paid for,
 * and we are waiting on DataForSEO. It is deliberately distinct from `claimed`
 * so the redrive sweeper cannot mistake a task that is merely slow for a worker
 * that died and re-post it -- which would pay twice.
 */
export type DiscoveryJobStatus =
  | 'pending'
  | 'claimed'
  | 'awaiting'
  | 'done'
  | 'failed'
  | 'skipped'

export type DiscoveryHitSourceKind = 'organic' | 'discussions_and_forums'

export type DiscoveryRunSource = 'legacy_csv' | 'catalog' | 'market_cell'

export const discoveryRuns = pgTable(
  'discovery_runs',
  {
    id: serial('id').primaryKey(),
    status: text('status').$type<DiscoveryRunStatus>().notNull().default('pending'),
    /** serp | commentability | complete — probes cannot reserve spend after terminal. */
    phase: text('phase').$type<DiscoveryRunPhase>().notNull().default('serp'),
    /** legacy_csv | catalog | market_cell — market panel filters on market_cell. */
    source: text('source').$type<DiscoveryRunSource>().notNull().default('legacy_csv'),
    /** Snapshot: desktop | mobile | desktop,mobile */
    devices: text('devices').notNull().default('desktop'),
    /**
     * Paid extras, OFF by default.
     *
     * ==================== WHY OFF IS THE RIGHT DEFAULT ====================
     * Both are per-cell purchases layered on top of the SERP, and on a wide
     * screen they cost more than the SERPs they annotate: at 50 keywords x 50
     * markets the SERPs are $5.00 while volume adds $4.50 and maps $5.00.
     *
     * Neither earns that at screening time. National Google Ads volume is
     * already on `niches` from `pnpm enrich:niche-gads` and is what the Screen
     * list displays, so per-market volume duplicates data we own for free. And
     * nothing scores off the maps fields -- they populate one display column.
     *
     * Turn them on for the shortlist, where a per-cell $0.09 buys a decision.
     * ===================================================================
     */
    /**
     * Buy SERPs through the queue rather than live: $0.0006 vs $0.0020, a 70%
     * saving, in exchange for results arriving in minutes rather than seconds.
     * Off by default so a run started to answer a question right now still does.
     */
    useQueuedSerp: boolean('use_queued_serp').notNull().default(false),
    /**
     * ON by default: volume is free now.
     *
     * It was off because DataForSEO charged $0.09 per market. That path is
     * gone -- Google Ads or null, both free -- and leaving it off cost the Vol
     * column, the Reddit-volume estimate and the likely_30d winnability band,
     * which needs a measured volume, in exchange for saving nothing.
     */
    fetchVolume: boolean('fetch_volume').notNull().default(true),
    fetchMaps: boolean('fetch_maps').notNull().default(false),
    includeNearMe: boolean('include_near_me').notNull().default(true),
    /**
     * Also measure "<keyword> <city>" alongside the city-free keyword.
     *
     * OFF by default because it doubles the SERP count for the run. It exists
     * because the two queries return genuinely different pages: the city-free
     * keyword at a location_code is the rank-and-rent signal (who holds the
     * local slots), while the geo-explicit string is where city-specific
     * discussion lives -- "plumber" in New York City returns r/AusRenovation
     * and r/roanoke, which are page-1 facts but not New York leads.
     */
    includeGeoExplicit: boolean('include_geo_explicit').notNull().default(false),
    geoTierFilter: text('geo_tier_filter'),
    estimatedCostMicros: bigint('estimated_cost_micros', { mode: 'bigint' }),
    selectionNote: text('selection_note'),
    budgetCapMicros: bigint('budget_cap_micros', { mode: 'bigint' }).notNull(),
    /** Updated only via atomic reservation SQL. */
    spendMicros: bigint('spend_micros', { mode: 'bigint' }).notNull().default(zeroMicros),
    usedFixtures: boolean('used_fixtures').notNull().default(true),
    nicheCount: integer('niche_count').notNull().default(0),
    geoCount: integer('geo_count').notNull().default(0),
    /** Purchasable SERP jobs only (no rows for unresolved geos). */
    jobCount: integer('job_count').notNull().default(0),
    jobsDone: integer('jobs_done').notNull().default(0),
    jobsFailed: integer('jobs_failed').notNull().default(0),
    jobsSkipped: integer('jobs_skipped').notNull().default(0),
    hitCount: integer('hit_count').notNull().default(0),
    commentabilityMode: text('commentability_mode')
      .$type<DiscoveryCommentabilityMode>()
      .notNull()
      .default('on_promote'),
    label: text('label'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    error: text('error'),
    createdAt: now(),
  },
  (t) => ({
    statusIdx: index('discovery_runs_status_idx').on(t.status, t.createdAt),
  }),
)

export const discoveryNiches = pgTable(
  'discovery_niches',
  {
    id: serial('id').primaryKey(),
    runId: integer('run_id')
      .notNull()
      .references(() => discoveryRuns.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    slug: text('slug'),
    /** Soft-matched to seed niches; required non-null before promote. */
    nicheId: integer('niche_id').references(() => niches.id, { onDelete: 'set null' }),
    keywordPrimary: text('keyword_primary').notNull(),
    keywordNearMe: text('keyword_near_me').notNull(),
    nearMeSynthesised: boolean('near_me_synthesised').notNull().default(false),
    importBatch: text('import_batch').notNull(),
    lineNumber: integer('line_number'),
    createdAt: now(),
  },
  (t) => ({
    runIdx: index('discovery_niches_run_idx').on(t.runId),
    // Case-sensitive unique; expression unique on lower(keyword_primary) is in db-extras.
    runKeywordUq: uniqueIndex('discovery_niches_run_keyword_uq').on(t.runId, t.keywordPrimary),
  }),
)

export const discoveryGeos = pgTable(
  'discovery_geos',
  {
    id: serial('id').primaryKey(),
    runId: integer('run_id')
      .notNull()
      .references(() => discoveryRuns.id, { onDelete: 'cascade' }),
    rawName: text('raw_name').notNull(),
    rawState: text('raw_state'),
    rawPopulation: integer('raw_population'),
    rawKind: text('raw_kind'),
    localityId: integer('locality_id').references(() => localities.id, { onDelete: 'set null' }),
    providerLocationCode: integer('provider_location_code'),
    locationSource: text('location_source'),
    resolveStatus: text('resolve_status').$type<DiscoveryGeoResolveStatus>().notNull(),
    unmatchedReason: text('unmatched_reason'),
    /** How many locality rows matched before disambiguation. */
    candidateCount: integer('candidate_count'),
    importBatch: text('import_batch').notNull(),
    lineNumber: integer('line_number'),
    createdAt: now(),
  },
  (t) => ({
    runIdx: index('discovery_geos_run_idx').on(t.runId),
    resolveIdx: index('discovery_geos_resolve_idx').on(t.runId, t.resolveStatus),
  }),
)

/**
 * THE discovery queue. Claimed with FOR UPDATE SKIP LOCKED like scan_runs /
 * serp_targets. kind=serp purchases organic; kind=commentability probes a hit
 * while the run is still phase=commentability.
 */
export const discoveryJobs = pgTable(
  'discovery_jobs',
  {
    id: serial('id').primaryKey(),
    runId: integer('run_id')
      .notNull()
      .references(() => discoveryRuns.id, { onDelete: 'cascade' }),
    discoveryNicheId: integer('discovery_niche_id').references(() => discoveryNiches.id, {
      onDelete: 'cascade',
    }),
    discoveryGeoId: integer('discovery_geo_id').references(() => discoveryGeos.id, {
      onDelete: 'cascade',
    }),
    localityId: integer('locality_id').references(() => localities.id, { onDelete: 'set null' }),
    kind: text('kind').$type<DiscoveryJobKind>().notNull().default('serp'),
    /** Verbatim purchased string for SERP jobs; unused for commentability. */
    keyword: text('keyword'),
    keywordVariant: text('keyword_variant'),
    /** desktop | mobile */
    device: text('device').notNull().default('desktop'),
    /** windows | android | ios */
    os: text('os').notNull().default('windows'),
    depth: integer('depth').notNull().default(10),
    researchKeywordId: integer('research_keyword_id').references(() => researchKeywords.id, {
      onDelete: 'set null',
    }),
    researchGeoId: integer('research_geo_id').references(() => researchGeos.id, {
      onDelete: 'set null',
    }),
    /**
     * Set on kind=commentability — which hit to probe.
     * Lazy ref: discovery_hits also points at discovery_jobs (circular).
     */
    discoveryHitId: integer('discovery_hit_id').references((): AnyPgColumn => discoveryHits.id, {
      onDelete: 'set null',
    }),
    status: text('status').$type<DiscoveryJobStatus>().notNull().default('pending'),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    claimedBy: text('claimed_by'),
    costMicros: bigint('cost_micros', { mode: 'bigint' }).notNull().default(zeroMicros),
    error: text('error'),
    measuredVia: text('measured_via'),
    /** 0 = measured, no Reddit on page 1. */
    redditHitCount: integer('reddit_hit_count').notNull().default(0),
    /** Raw DFS items for re-extract without re-buy. */
    rawItems: jsonb('raw_items').$type<Array<Record<string, unknown>>>(),
    /**
     * DataForSEO task id while status = 'awaiting'.
     *
     * Losing this loses a SERP we have already paid for: task_get is only
     * addressable by id, and DataForSEO discards results after a few days.
     */
    queuedTaskId: text('queued_task_id'),
    queuedPostedAt: timestamp('queued_posted_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: now(),
  },
  (t) => ({
    claimIdx: index('discovery_jobs_claim_idx').on(t.status, t.id),
    runStatusIdx: index('discovery_jobs_run_status_idx').on(t.runId, t.status),
  }),
)

export const discoveryHits = pgTable(
  'discovery_hits',
  {
    id: serial('id').primaryKey(),
    jobId: integer('job_id')
      .notNull()
      .references(() => discoveryJobs.id, { onDelete: 'cascade' }),
    runId: integer('run_id')
      .notNull()
      .references(() => discoveryRuns.id, { onDelete: 'cascade' }),
    localityId: integer('locality_id').references(() => localities.id, { onDelete: 'set null' }),
    discoveryNicheId: integer('discovery_niche_id').references(() => discoveryNiches.id, {
      onDelete: 'cascade',
    }),
    /** Denorm from discovery_niches at insert time. */
    nicheId: integer('niche_id').references(() => niches.id, { onDelete: 'set null' }),
    keyword: text('keyword').notNull(),
    redditUrl: text('reddit_url').notNull(),
    redditPostId: text('reddit_post_id').notNull(),
    subreddit: text('subreddit'),
    title: text('title'),
    sourceKind: text('source_kind').$type<DiscoveryHitSourceKind>().notNull(),
    organicPosition: integer('organic_position'),
    rankAbsolute: integer('rank_absolute'),
    packPosition: integer('pack_position'),
    domain: text('domain').notNull(),
    /** THREE-STATE: true open, false closed, null unmeasured. Never alert on false alone. */
    commentable: boolean('commentable'),
    commentableDetail: text('commentable_detail'),
    commentableCheckedAt: timestamp('commentable_checked_at', { withTimezone: true }),
    promotedSiteId: integer('promoted_site_id').references(() => sites.id, { onDelete: 'set null' }),
    promotedKeywordId: integer('promoted_keyword_id').references(() => serpKeywords.id, {
      onDelete: 'set null',
    }),
    promotedTargetId: integer('promoted_target_id').references(() => serpTargets.id, {
      onDelete: 'set null',
    }),
    createdAt: now(),
  },
  (t) => ({
    jobPostSourceUq: uniqueIndex('discovery_hits_job_post_source_uq').on(
      t.jobId,
      t.redditPostId,
      t.sourceKind,
    ),
    runIdx: index('discovery_hits_run_idx').on(t.runId),
    localityNicheIdx: index('discovery_hits_locality_niche_idx').on(t.localityId, t.nicheId),
  }),
)

/**
 * One row per completed SERP research job: ads/local-above-organic, related, counts.
 * Separate from organic serp_snapshots (scoring).
 */
export const discoverySerpMetrics = pgTable(
  'discovery_serp_metrics',
  {
    id: serial('id').primaryKey(),
    jobId: integer('job_id')
      .notNull()
      .references(() => discoveryJobs.id, { onDelete: 'cascade' }),
    runId: integer('run_id')
      .notNull()
      .references(() => discoveryRuns.id, { onDelete: 'cascade' }),
    localityId: integer('locality_id').references(() => localities.id, { onDelete: 'set null' }),
    nicheId: integer('niche_id').references(() => niches.id, { onDelete: 'set null' }),
    researchKeywordId: integer('research_keyword_id').references(() => researchKeywords.id, {
      onDelete: 'set null',
    }),
    researchGeoId: integer('research_geo_id').references(() => researchGeos.id, {
      onDelete: 'set null',
    }),
    keyword: text('keyword').notNull(),
    keywordVariant: text('keyword_variant'),
    device: text('device').notNull(),
    os: text('os').notNull(),
    locationCode: integer('location_code').notNull(),
    firstOrganicRankAbsolute: integer('first_organic_rank_absolute'),
    adsAboveOrganicCount: integer('ads_above_organic_count').notNull().default(0),
    localProfilesAboveOrganicCount: integer('local_profiles_above_organic_count')
      .notNull()
      .default(0),
    organicCount: integer('organic_count').notNull().default(0),
    paidCount: integer('paid_count').notNull().default(0),
    localPackCount: integer('local_pack_count').notNull().default(0),
    discussionsPackPresent: boolean('discussions_pack_present').notNull().default(false),
    redditHitCount: integer('reddit_hit_count').notNull().default(0),
    relatedSearches: jsonb('related_searches').$type<string[]>(),
    itemTypes: jsonb('item_types').$type<string[]>(),
    /** Map / local_pack map chrome present on SERP. */
    mapPresent: boolean('map_present').notNull().default(false),
    mapRankAbsolute: integer('map_rank_absolute'),
    /** Local Services Ads (≠ paid search ads). */
    lsaCount: integer('lsa_count').notNull().default(0),
    lsaAboveOrganicCount: integer('lsa_above_organic_count').notNull().default(0),
    lsaRankAbsolute: integer('lsa_rank_absolute'),
    /** GBP / maps_search listing slots. */
    localBusinessCount: integer('local_business_count').notNull().default(0),
    localBusinessAboveOrganicCount: integer('local_business_above_organic_count')
      .notNull()
      .default(0),
    localPackRankAbsolute: integer('local_pack_rank_absolute'),
    forumsCount: integer('forums_count').notNull().default(0),
    forumsRankAbsolute: integer('forums_rank_absolute'),
    /** Best Reddit hit rank_absolute on this SERP (organic or pack). */
    bestRedditRankAbsolute: integer('best_reddit_rank_absolute'),
    /** paid search ads above organic + LSA above organic. */
    sponsoredAboveOrganicCount: integer('sponsored_above_organic_count').notNull().default(0),
    /**
     * Local search volume (DataForSEO Keywords Data @ location_code) for exact keyword.
     * Null = not fetched / no data.
     */
    avgMonthlySearches: integer('avg_monthly_searches'),
    /** dataforseo_google_ads | google_ads | fixture | skipped | null */
    volumeSource: text('volume_source'),
    /** e.g. dataforseo location_code=1013462 */
    volumeGeoTarget: text('volume_geo_target'),
    /** 12-mo series [{year,month,searchVolume}] from Keywords Data. */
    monthlySearches: jsonb('monthly_searches').$type<
      Array<{ year: number; month: number; searchVolume: number }>
    >(),
    /** City-scoped paid competition 0–100 from Keywords Data. */
    serpCompetitionIndex: integer('serp_competition_index'),
    serpCompetition: text('serp_competition'),
    /** CPC micros (USD) from Keywords Data at location. */
    cpcMicros: bigint('cpc_micros', { mode: 'bigint' }),
    lowTopOfPageBidMicros: bigint('low_top_of_page_bid_micros', { mode: 'bigint' }),
    highTopOfPageBidMicros: bigint('high_top_of_page_bid_micros', { mode: 'bigint' }),
    /** Top organic domains [{domain, rankAbsolute}]. */
    topOrganicDomains: jsonb('top_organic_domains').$type<
      Array<{ domain: string; rankAbsolute: number }>
    >(),
    /** Local pack leaders [{title, domain, rating, reviewsCount, rankAbsolute}]. */
    gbpLeaders: jsonb('gbp_leaders').$type<
      Array<{
        title: string
        domain: string | null
        rating: number | null
        reviewsCount: number | null
        rankAbsolute: number | null
      }>
    >(),
    hasAiOverview: boolean('has_ai_overview').notNull().default(false),
    hasPeopleAlsoAsk: boolean('has_people_also_ask').notNull().default(false),
    /**
     * Maps SERP (once per niche×city when this job ran it).
     * Null maps_entry_count = this row did not fetch Maps.
     */
    mapsEntryCount: integer('maps_entry_count'),
    mapsDomains: jsonb('maps_domains').$type<string[]>(),
    mapsKeyword: text('maps_keyword'),

    // ---- SERP winnability (computed from discovery_jobs.raw_items) ----
    /**
     * 0-100 from scoreDifficulty. NULL = not computed, never "easy".
     * A zero here would sort to the top of an easiest-first table.
     */
    difficulty: integer('difficulty'),
    /** How much of the difficulty model was actually measurable, 0-1. */
    weightCovered: doublePrecision('weight_covered'),
    difficultyComponents: jsonb('difficulty_components'),
    /** Slots not held by a committed local operator -- room for a new site. */
    slotsOpen: integer('slots_open'),
    platformHeldSlots: integer('platform_held_slots'),
    /** Fractional by nature -- a median over an even-length list. */
    medianRefDomains: doublePrecision('median_ref_domains'),
    minRefDomains: integer('min_ref_domains'),
    exactMatchHomepagesTop5: integer('exact_match_homepages_top5'),
    localBusinessesTop5Dedicated: integer('local_businesses_top5_dedicated'),
    /** False when the backlinks pass could not measure the defenders. */
    linkDataMeasured: boolean('link_data_measured'),
    /**
     * Two verdicts. Registering a fresh exact-match domain is gated on that
     * domain being available; acquiring one is not, and the two answers
     * routinely differ. That difference is the decision.
     */
    verdictEmd: text('verdict_emd'),
    blockersEmd: jsonb('blockers_emd'),
    verdictAcquired: text('verdict_acquired'),
    blockersAcquired: jsonb('blockers_acquired'),
    emdDomain: text('emd_domain'),
    emdAvailable: boolean('emd_available'),
    winnabilityComputedAt: timestamp('winnability_computed_at', { withTimezone: true }),
    measuredAt: timestamp('measured_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: now(),
  },
  (t) => ({
    jobUq: uniqueIndex('discovery_serp_metrics_job_uq').on(t.jobId),
    cellDeviceIdx: index('discovery_serp_metrics_cell_device_idx').on(
      t.localityId,
      t.nicheId,
      t.device,
      t.measuredAt,
    ),
    catalogIdx: index('discovery_serp_metrics_catalog_idx').on(
      t.researchKeywordId,
      t.researchGeoId,
      t.device,
    ),
  }),
)

// ---------------------------------------------------------------------------
// Research catalog (import-first; no spend)
// ---------------------------------------------------------------------------

export const researchKeywordImports = pgTable('research_keyword_imports', {
  id: serial('id').primaryKey(),
  sourceFilename: text('source_filename').notNull(),
  sourceKind: text('source_kind').notNull(),
  rowCount: integer('row_count').notNull().default(0),
  skippedCount: integer('skipped_count').notNull().default(0),
  dateRangeRaw: text('date_range_raw'),
  createdAt: now(),
})

export const researchKeywords = pgTable(
  'research_keywords',
  {
    id: serial('id').primaryKey(),
    importId: integer('import_id')
      .notNull()
      .references(() => researchKeywordImports.id, { onDelete: 'cascade' }),
    keyword: text('keyword').notNull(),
    keywordNorm: text('keyword_norm').notNull(),
    seedKey: text('seed_key').notNull(),
    variant: text('variant').notNull().default('primary'),
    avgMonthlySearches: doublePrecision('avg_monthly_searches'),
    competition: text('competition'),
    competitionIndex: doublePrecision('competition_index'),
    topOfPageBidLowMicros: bigint('top_of_page_bid_low_micros', { mode: 'bigint' }),
    topOfPageBidHighMicros: bigint('top_of_page_bid_high_micros', { mode: 'bigint' }),
    topOfPageBidRaw: text('top_of_page_bid_raw'),
    inAccount: text('in_account'),
    monthlySeries: jsonb('monthly_series').$type<Record<string, number | null>>(),
    nicheId: integer('niche_id').references(() => niches.id, { onDelete: 'set null' }),
    active: boolean('active').notNull().default(true),
    lineNumber: integer('line_number'),
    createdAt: now(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    keywordNormUq: uniqueIndex('research_keywords_norm_uq').on(t.keywordNorm),
    activeVolIdx: index('research_keywords_active_vol_idx').on(t.active, t.avgMonthlySearches),
  }),
)

export const researchGeoImports = pgTable('research_geo_imports', {
  id: serial('id').primaryKey(),
  sourceFilename: text('source_filename').notNull(),
  sourceKind: text('source_kind').notNull(),
  rowCount: integer('row_count').notNull().default(0),
  skippedCount: integer('skipped_count').notNull().default(0),
  createdAt: now(),
})

export const researchGeos = pgTable(
  'research_geos',
  {
    id: serial('id').primaryKey(),
    importId: integer('import_id')
      .notNull()
      .references(() => researchGeoImports.id, { onDelete: 'cascade' }),
    market: text('market').notNull(),
    state: text('state'),
    stateAbbr: text('state_abbr'),
    population2025: integer('population_2025'),
    selectedRank: integer('selected_rank'),
    testTier: text('test_tier'),
    dataforseoLocationCode: integer('dataforseo_location_code'),
    dataforseoLocationName: text('dataforseo_location_name'),
    dataforseoLocationType: text('dataforseo_location_type'),
    naturalQueryModifier: text('natural_query_modifier'),
    disambiguatedQueryModifier: text('disambiguated_query_modifier'),
    recommendedExplicitModifier: text('recommended_explicit_modifier'),
    extra: jsonb('extra').$type<Record<string, unknown>>(),
    localityId: integer('locality_id').references(() => localities.id, { onDelete: 'set null' }),
    locationSource: text('location_source'),
    resolveStatus: text('resolve_status').$type<DiscoveryGeoResolveStatus>().notNull(),
    unmatchedReason: text('unmatched_reason'),
    active: boolean('active').notNull().default(true),
    lineNumber: integer('line_number'),
    createdAt: now(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    codeIdx: index('research_geos_code_idx').on(t.dataforseoLocationCode),
    rankIdx: index('research_geos_rank_idx').on(t.active, t.selectedRank),
  }),
)

// --- Keyword spaces: entities, and per-site keyword targets ------------------

/**
 * A named set of things a keyword pattern can be built over.
 *
 * ==================== WHY LOCALITIES ARE NOT IN HERE ====================
 * `kind: 'locality'` is RESERVED and reads `research_geos` instead of
 * `research_entities`. The geo corpus already carries FIPS, population, lat/lon
 * and resolved provider location codes, all of it ingested from Census bulk
 * files. Copying 300 city names into a second table to make the model look
 * uniform would create two sources of truth for the same place, and the one
 * without the location code would eventually be the one somebody joined on.
 * =====================================================================
 */
export const researchEntitySets = pgTable('research_entity_sets', {
  id: serial('id').primaryKey(),
  slug: text('slug').notNull(),
  /** 'product' | 'brand' | 'venue_type' | 'topic' | ... Free text on purpose. */
  kind: text('kind').notNull(),
  label: text('label').notNull(),
  notes: text('notes'),
  createdAt: now(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const researchEntities = pgTable(
  'research_entities',
  {
    id: serial('id').primaryKey(),
    setId: integer('set_id')
      .notNull()
      .references(() => researchEntitySets.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    /** The string substituted into a pattern. "BPC-157", not "bpc-157". */
    label: text('label').notNull(),
    /**
     * Alternate surface forms: `BPC 157`, `BPC157`.
     *
     * Load-bearing for matching what already ranks BACK onto an entity. Without
     * them the join under-reports our own coverage, and under-reported coverage
     * reads as an opportunity -- so we would build a page that already exists.
     */
    aliases: jsonb('aliases').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    /**
     * Per-entity extras the value model needs and no column could hold across
     * verticals: a $600 peptide and a $40 one are not worth the same click.
     */
    attributes: jsonb('attributes').$type<Record<string, unknown>>(),
    /** Lower sorts first. What `DimensionSpec.limit` truncates against. */
    priority: integer('priority').notNull().default(0),
    active: boolean('active').notNull().default(true),
    createdAt: now(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    setSlugUq: uniqueIndex('research_entities_set_slug_uq').on(t.setId, t.slug),
    activeIdx: index('research_entities_active_idx').on(t.setId, t.active, t.priority),
  }),
)

/**
 * One keyword this site targets, with everything measured about it.
 *
 * ==================== WHY NOT serp_keywords ====================
 * `serp_keywords` is explicitly an IMPORT-TIME SNAPSHOT -- "Semrush's numbers at
 * import time, never refreshed here, context for choosing what to watch, not
 * measurements this system makes". This table is the opposite: it is refreshed,
 * it is the measurement, and it carries a verdict.
 * ==============================================================
 *
 * Every measured column is nullable and pairs with a `*MeasuredAt`, because the
 * difference between "we looked and there is nothing" and "we never looked" is
 * the whole decision on this screen. `assessKeyword` reads
 * `positionMeasuredAt !== null` rather than `position !== null` for exactly that
 * reason: Search Console silence and never having asked Search Console are the
 * same null and completely different facts.
 */
export const siteKeywordTargets = pgTable(
  'site_keyword_targets',
  {
    id: serial('id').primaryKey(),
    siteId: integer('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    /** The shared catalog row, when this keyword is also in it. */
    keywordId: integer('keyword_id').references(() => researchKeywords.id, {
      onDelete: 'set null',
    }),
    keyword: text('keyword').notNull(),
    keywordNorm: text('keyword_norm').notNull(),
    /** The pattern that generated it, or the source that discovered it. */
    seedKey: text('seed_key'),
    patternLabel: text('pattern_label'),
    /** dimension -> entity slug. Traces a grid row back to what produced it. */
    entities: jsonb('entities').$type<Record<string, string>>(),

    // --- Demand (free, at the space's audienceScope) -------------------------
    /** NULL = never measured. A measured 0 is a 0 and is NOT this. */
    volume: integer('volume'),
    /** `us/en`, `worldwide/en`. Says what was actually asked for. */
    volumeScope: text('volume_scope'),
    volumeMeasuredAt: timestamp('volume_measured_at', { withTimezone: true }),
    competitionIndex: doublePrecision('competition_index'),
    cpcMicros: bigint('cpc_micros', { mode: 'bigint' }),
    /**
     * Google's top-of-page bid RANGE. Two columns, never collapsed to one.
     *
     * `cpcMicros` above is deliberately NULL on the Google Ads path, because
     * Google publishes a range and the two do not map — cpc/high ran 0.07x-1.16x
     * and cpc/low 0.79x-2.59x against cached DataForSEO rows. Carrying the range
     * as a range is what gives paid search a cost term without inventing one.
     * Break-even is computed at BOTH ends; only the high end may qualify a
     * keyword, because the low end is roughly what it costs to lose the auction.
     */
    bidLowMicros: bigint('bid_low_micros', { mode: 'bigint' }),
    bidHighMicros: bigint('bid_high_micros', { mode: 'bigint' }),
    /** 12-month series. Free, already returned, and load-bearing for travel. */
    monthlySeries: jsonb('monthly_series').$type<Array<{ year: number; month: number; searchVolume: number }>>(),

    // --- Our ranking ---------------------------------------------------------
    position: integer('position'),
    /** 'search_console' = our traffic. 'labs_ranked' = a vendor's index. */
    positionSource: text('position_source'),
    /** NOT NULL whenever we asked, even if the answer was "nothing". */
    positionMeasuredAt: timestamp('position_measured_at', { withTimezone: true }),
    rankingUrl: text('ranking_url'),
    /** Search Console only. No vendor can supply these. */
    impressions: integer('impressions'),
    clicks: integer('clicks'),

    // --- Competition ---------------------------------------------------------
    difficulty: integer('difficulty'),
    difficultyMeasuredAt: timestamp('difficulty_measured_at', { withTimezone: true }),
    hasAiOverview: boolean('has_ai_overview'),

    // --- Decision ------------------------------------------------------------
    verdict: text('verdict').$type<KeywordVerdict>(),
    verdictReason: text('verdict_reason'),
    /** Which signals were null and needed. Non-empty implies verdict UNKNOWN. */
    verdictMissing: jsonb('verdict_missing').$type<string[]>(),
    /** NULL whenever any economics input was unset. Never a fallback number. */
    monthlyValueMicros: bigint('monthly_value_micros', { mode: 'bigint' }),

    /**
     * How this keyword was found. Extend the vocabulary, not the schema:
     * `grid`, `search_console`, `labs_ranked`, `competitor_gap`, `related_search`.
     */
    sources: jsonb('sources').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    active: boolean('active').notNull().default(true),
    createdAt: now(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    siteKeywordUq: uniqueIndex('site_keyword_targets_site_norm_uq').on(t.siteId, t.keywordNorm),
    verdictIdx: index('site_keyword_targets_verdict_idx').on(t.siteId, t.verdict, t.volume),
    volumeIdx: index('site_keyword_targets_volume_idx').on(t.siteId, t.active, t.volume),
  }),
)

/**
 * A domain that competes with one of our sites, and how it was found.
 *
 * Kept separate from `domain_authority` because that table is a 90-day cache of
 * link metrics keyed by domain, with no notion of who it competes with.
 */
export const siteCompetitors = pgTable(
  'site_competitors',
  {
    id: serial('id').primaryKey(),
    siteId: integer('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    domain: text('domain').notNull(),
    /** 'labs_competitors' = the vendor named it. 'serp' = we saw it hold slots. */
    source: text('source').notNull(),
    /** How many keywords we and they both rank for. NULL = not measured. */
    intersections: integer('intersections'),
    /** Their organic keyword count, as the vendor reports it. */
    rankedKeywords: integer('ranked_keywords'),
    referringDomains: integer('referring_domains'),
    /**
     * Is this a PEER, or a giant?
     *
     * The pre-registered expectation in the plan is that hotelhottubs.com's
     * competitor set is Booking, Expedia and TripAdvisor, and that a keyword gap
     * against those is a list of things we cannot rank for dressed as
     * opportunity. NULL = we have not decided; false = explicitly excluded.
     */
    peer: boolean('peer'),
    peerReason: text('peer_reason'),
    active: boolean('active').notNull().default(true),
    createdAt: now(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    siteDomainUq: uniqueIndex('site_competitors_site_domain_uq').on(t.siteId, t.domain),
  }),
)

// --- Link prospecting and outreach -------------------------------------------

/**
 * One mining run over a set of competitors.
 *
 * `competitors` is plural because the §0.2 marketplace signal needs it: with one
 * competitor every prospect has a count of 1 and the signal carries no
 * information. Three or more is where "links to 4 of our competitors" starts
 * meaning something.
 */
export const linkProspectRuns = pgTable(
  'link_prospect_runs',
  {
    id: serial('id').primaryKey(),
    siteId: integer('site_id').references(() => sites.id, { onDelete: 'set null' }),
    competitors: jsonb('competitors').$type<string[]>().notNull(),
    status: text('status').notNull().default('running'),

    referringDomainsFound: integer('referring_domains_found').notNull().default(0),
    excludedCount: integer('excluded_count').notNull().default(0),
    qualifiedCount: integer('qualified_count').notNull().default(0),
    /** Non-zero means this run is a SAMPLE of the prospect set, not the set. */
    droppedToCap: integer('dropped_to_cap').notNull().default(0),
    costMicros: bigint('cost_micros', { mode: 'bigint' }).notNull().default(0n),
    notes: jsonb('notes').$type<string[]>(),

    // NOT the now() helper — that hardcodes the column name `created_at`, and
    // this table's timestamp is `started_at`.
    startedAt: timestampCol('started_at'),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    error: text('error'),
  },
  (t) => ({
    siteIdx: index('link_prospect_runs_site_idx').on(t.siteId, t.status),
  }),
)

export const linkProspects = pgTable(
  'link_prospects',
  {
    id: serial('id').primaryKey(),
    runId: integer('run_id')
      .notNull()
      .references(() => linkProspectRuns.id, { onDelete: 'cascade' }),
    domain: text('domain').notNull(),

    /**
     * DataForSEO `rank`, 0-1000. **NOT Moz DA and NOT Semrush AS** — this
     * project holds neither, they correlate only loosely, and a column named
     * `da` would be a number we cannot compute wearing a name operators
     * recognise.
     */
    dfsRank: integer('dfs_rank'),
    referringDomains: integer('referring_domains'),
    spamScore: integer('spam_score'),
    /**
     * THE FIRST GATE. Authority metrics are manufacturable — a PBN buys expired
     * domains and its rank looks fine. Ranking for queries humans actually type
     * is not cheaply fakeable. Null = never measured, which is not zero.
     */
    rankedKeywords: integer('ranked_keywords'),
    organicEtv: doublePrecision('organic_etv'),

    /** The §0.2 signal, denormalised from linkProspectSources so it can sort. */
    competitorLinkCount: integer('competitor_link_count').notNull().default(0),
    alreadyLinked: boolean('already_linked').notNull().default(false),

    verdict: text('verdict').$type<ProspectVerdict>(),
    verdictReason: text('verdict_reason'),
    warnings: jsonb('warnings').$type<string[]>(),

    qualityMultiplier: doublePrecision('quality_multiplier'),
    maxBidMicros: bigint('max_bid_micros', { mode: 'bigint' }),
    linksNeeded: integer('links_needed'),

    createdAt: now(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    runDomainUq: uniqueIndex('link_prospects_run_domain_uq').on(t.runId, t.domain),
    verdictIdx: index('link_prospects_verdict_idx').on(t.runId, t.verdict, t.maxBidMicros),
  }),
)

/** One row per (prospect, competitor). The GROUP BY that produces §0.2. */
export const linkProspectSources = pgTable(
  'link_prospect_sources',
  {
    id: serial('id').primaryKey(),
    prospectId: integer('prospect_id')
      .notNull()
      .references(() => linkProspects.id, { onDelete: 'cascade' }),
    competitor: text('competitor').notNull(),
    /** The page the link sits on — provenance for a surprising prospect. */
    urlFrom: text('url_from'),
    firstSeenAt: timestampCol('first_seen_at'),
  },
  (t) => ({
    uq: uniqueIndex('link_prospect_sources_uq').on(t.prospectId, t.competitor),
  }),
)

/**
 * Who to email, and how confident we are that they exist.
 *
 * `evidence` holds a VERBATIM quote from the page. It is what makes "the agent
 * never invents a contact" checkable after the fact rather than a promise in a
 * comment.
 */
export const linkContacts = pgTable(
  'link_contacts',
  {
    id: serial('id').primaryKey(),
    prospectId: integer('prospect_id')
      .notNull()
      .references(() => linkProspects.id, { onDelete: 'cascade' }),
    email: text('email'),
    name: text('name'),
    role: text('role'),
    confidence: text('confidence').$type<ContactConfidence>().notNull(),
    evidence: text('evidence'),
    sourceUrl: text('source_url'),
    guestPostTerms: text('guest_post_terms'),
    statedPriceMicros: bigint('stated_price_micros', { mode: 'bigint' }),

    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    bounceState: text('bounce_state'),
    createdAt: now(),
  },
  (t) => ({
    prospectIdx: index('link_contacts_prospect_idx').on(t.prospectId, t.confidence),
  }),
)

export const outreachCampaigns = pgTable('outreach_campaigns', {
  id: serial('id').primaryKey(),
  siteId: integer('site_id')
    .notNull()
    .references(() => sites.id, { onDelete: 'cascade' }),
  runId: integer('run_id').references(() => linkProspectRuns.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  status: text('status').notNull().default('draft'),

  /**
   * Sender identity and postal address are CAN-SPAM requirements, not optional
   * metadata: accurate sender information and a valid physical address are
   * mandatory on commercial email, as is a working opt-out.
   */
  fromName: text('from_name'),
  fromEmail: text('from_email'),
  postalAddress: text('postal_address'),

  dailySendCap: integer('daily_send_cap').notNull().default(25),
  notes: text('notes'),
  createdAt: now(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const outreachMessages = pgTable(
  'outreach_messages',
  {
    id: serial('id').primaryKey(),
    campaignId: integer('campaign_id')
      .notNull()
      .references(() => outreachCampaigns.id, { onDelete: 'cascade' }),
    contactId: integer('contact_id')
      .notNull()
      .references(() => linkContacts.id, { onDelete: 'cascade' }),
    subject: text('subject').notNull(),
    body: text('body').notNull(),
    status: text('status').$type<OutreachMessageStatus>().notNull().default('draft'),
    blockedReason: text('blocked_reason'),
    /** Each personalisation fact with where it came from. No unsourced claims. */
    personalisation: jsonb('personalisation').$type<Record<string, string>>(),
    externalId: text('external_id'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    repliedAt: timestamp('replied_at', { withTimezone: true }),
    outcome: text('outcome'),
    createdAt: now(),
  },
  (t) => ({
    campaignContactUq: uniqueIndex('outreach_messages_campaign_contact_uq').on(
      t.campaignId,
      t.contactId,
    ),
    statusIdx: index('outreach_messages_status_idx').on(t.campaignId, t.status),
  }),
)

/**
 * Do-not-contact, checked before EVERY send on email and on domain.
 *
 * Built before drafting rather than after. Retrofitting a suppression check is
 * how a "please stop" gets emailed a second time, and CAN-SPAM gives 10
 * business days to honour an opt-out — a window that assumes the list exists.
 */
export const outreachSuppressions = pgTable('outreach_suppressions', {
  id: serial('id').primaryKey(),
  email: text('email'),
  domain: text('domain'),
  reason: text('reason').notNull(),
  addedAt: timestampCol('added_at'),
})

// --- Affiliate economics -----------------------------------------------------

/**
 * Commission as a contract: exact, known, and effective-dated.
 *
 * `entitySlug === null` is the site default. A renegotiated rate must not
 * retroactively rewrite last month's plan, so resolution picks the row in force
 * at plan time and `ads_plans` freezes what it used.
 */
export const affiliateCommissionRates = pgTable('affiliate_commission_rates', {
  id: serial('id').primaryKey(),
  siteId: integer('site_id')
    .notNull()
    .references(() => sites.id, { onDelete: 'cascade' }),
  /** NULL = the site default row. */
  entitySlug: text('entity_slug'),
  commissionRateBps: integer('commission_rate_bps').notNull(),
  effectiveFrom: text('effective_from').notNull(),
  note: text('note'),
  createdAt: now(),
})

/**
 * The only place conversion data enters.
 *
 * ==================== NO COLUMN FOR A BARE RATE ====================
 * `clicks` and `orders` are NOT NULL, and there is deliberately nowhere to put
 * a percentage on its own. A conversion rate typed in as a number loses the one
 * thing that makes it usable — "3% from 40 clicks" and "3% from 40,000" are
 * different facts, and everything downstream treats them differently.
 *
 * Rates are DERIVED by summing across rows, never stored: averaging rates would
 * weight a 40-click week equally with a 40,000-click one.
 * ==================================================================
 */
export const affiliateObservations = pgTable(
  'affiliate_observations',
  {
    id: serial('id').primaryKey(),
    siteId: integer('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    scopeKind: text('scope_kind').$type<AffiliateScopeKind>().notNull(),
    /** Entity slug / pattern label / keyword_norm. NULL only for scope 'site'. */
    scopeRef: text('scope_ref'),
    periodStart: text('period_start').notNull(),
    /** Shown wherever a rate is shown. Stale data is identical to fresh otherwise. */
    periodEnd: text('period_end').notNull(),
    clicks: integer('clicks').notNull(),
    orders: integer('orders').notNull(),
    /** Gross sale value. NULL when the report omits it — then AOV is underivable. */
    saleValueMicros: bigint('sale_value_micros', { mode: 'bigint' }),
    /** What landed. Over sale value this is the EFFECTIVE commission. */
    commissionMicros: bigint('commission_micros', { mode: 'bigint' }),
    source: text('source').notNull().default('manual'),
    enteredBy: text('entered_by'),
    note: text('note'),
    createdAt: now(),
  },
  (t) => ({
    scopeIdx: index('affiliate_observations_scope_idx').on(t.siteId, t.scopeKind, t.scopeRef),
  }),
)

// --- Paid search -------------------------------------------------------------

/**
 * A Google Ads campaign we have designed and NOT launched.
 *
 * ==================== PERSISTED BEFORE IT CAN BE LAUNCHED ====================
 * A plan is a row before it is an API call, so what was launched — and against
 * which economics — is reconstructable from the database rather than from
 * whoever ran the command. `orderValueMicros`, `commissionRateBps` and
 * `achievedConversionBps` are FROZEN copies of the site's values at plan time:
 * the site's numbers will change, and a plan must still be able to explain the
 * break-even figures it reported.
 *
 * `launchedAt` NULL is the normal state, and currently the only state anything
 * in this repo produces. See @rnr/data launchPlan for the gates.
 */
export const adsPlans = pgTable(
  'ads_plans',
  {
    id: serial('id').primaryKey(),
    siteId: integer('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    status: text('status').$type<AdsPlanStatus>().notNull().default('draft'),

    orderValueMicros: bigint('order_value_micros', { mode: 'bigint' }),
    commissionRateBps: integer('commission_rate_bps'),
    /** MEASURED from the affiliate network. Null = every verdict is UNKNOWN. */
    achievedConversionBps: integer('achieved_conversion_bps'),

    /** Required, never defaulted. An uncapped campaign is an uncapped bill. */
    dailyBudgetMicros: bigint('daily_budget_micros', { mode: 'bigint' }).notNull(),
    locationCode: integer('location_code').notNull(),
    languageCode: text('language_code').notNull().default('en'),

    /** Google's own forecast. NULL = never asked, not "forecast zero". */
    forecastClicks: doublePrecision('forecast_clicks'),
    forecastImpressions: doublePrecision('forecast_impressions'),
    forecastCostMicros: bigint('forecast_cost_micros', { mode: 'bigint' }),
    forecastAvgCpcMicros: bigint('forecast_avg_cpc_micros', { mode: 'bigint' }),
    forecastFetchedAt: timestamp('forecast_fetched_at', { withTimezone: true }),

    /** The measurement design, decided before launch. See @rnr/core experiment.ts. */
    experimentArms: jsonb('experiment_arms').$type<Array<{ cluster: string; arm: string }>>(),
    experimentFeasible: boolean('experiment_feasible'),
    experimentVerdict: text('experiment_verdict'),

    googleCampaignResource: text('google_campaign_resource'),
    launchedAt: timestamp('launched_at', { withTimezone: true }),
    launchedBy: text('launched_by'),

    notes: text('notes'),
    createdAt: now(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    siteIdx: index('ads_plans_site_idx').on(t.siteId, t.status),
  }),
)

export const adsPlanKeywords = pgTable(
  'ads_plan_keywords',
  {
    id: serial('id').primaryKey(),
    planId: integer('plan_id')
      .notNull()
      .references(() => adsPlans.id, { onDelete: 'cascade' }),
    keywordTargetId: integer('keyword_target_id').references(() => siteKeywordTargets.id, {
      onDelete: 'set null',
    }),
    keyword: text('keyword').notNull(),
    matchType: text('match_type').$type<AdsMatchType>().notNull().default('EXACT'),
    /** Themed grouping — the grid's pattern_label gives this for free. */
    adGroup: text('ad_group').notNull(),

    volume: integer('volume'),
    organicPosition: integer('organic_position'),
    /** Which published band applied. Recorded so a verdict can be argued with. */
    incrementalityBand: text('incrementality_band'),
    incrementalityBps: integer('incrementality_bps'),

    bidLowMicros: bigint('bid_low_micros', { mode: 'bigint' }),
    bidHighMicros: bigint('bid_high_micros', { mode: 'bigint' }),
    maxCpcMicros: bigint('max_cpc_micros', { mode: 'bigint' }),

    /** The product: what this keyword must convert at to break even. */
    requiredConversionBpsLow: integer('required_conversion_bps_low'),
    requiredConversionBpsHigh: integer('required_conversion_bps_high'),
    marginRatio: doublePrecision('margin_ratio'),

    verdict: text('verdict').$type<PaidVerdict>(),
    verdictReason: text('verdict_reason'),
    warnings: jsonb('warnings').$type<string[]>(),

    allocatedClicks: doublePrecision('allocated_clicks'),
    allocatedBudgetMicros: bigint('allocated_budget_micros', { mode: 'bigint' }),
    allocationPot: text('allocation_pot'),

    experimentArm: text('experiment_arm'),
    experimentCluster: text('experiment_cluster'),

    createdAt: now(),
  },
  (t) => ({
    planKeywordUq: uniqueIndex('ads_plan_keywords_plan_keyword_uq').on(
      t.planId,
      t.keyword,
      t.matchType,
    ),
    verdictIdx: index('ads_plan_keywords_verdict_idx').on(t.planId, t.verdict),
  }),
)

// ---------------------------------------------------------------------------

export type Locality = typeof localities.$inferSelect
export type NicheRow = typeof niches.$inferSelect
export type AdsPlan = typeof adsPlans.$inferSelect
export type AdsPlanKeyword = typeof adsPlanKeywords.$inferSelect
export type AffiliateObservation = typeof affiliateObservations.$inferSelect
export type LinkProspectRun = typeof linkProspectRuns.$inferSelect
export type LinkProspect = typeof linkProspects.$inferSelect
export type LinkContact = typeof linkContacts.$inferSelect
export type OutreachCampaign = typeof outreachCampaigns.$inferSelect
export type OutreachMessage = typeof outreachMessages.$inferSelect
export type AffiliateCommissionRate = typeof affiliateCommissionRates.$inferSelect
export type ResearchEntitySet = typeof researchEntitySets.$inferSelect
export type ResearchEntity = typeof researchEntities.$inferSelect
export type SiteKeywordTarget = typeof siteKeywordTargets.$inferSelect
export type SiteCompetitor = typeof siteCompetitors.$inferSelect
export type ScanRun = typeof scanRuns.$inferSelect
export type ScanTarget = typeof scanTargets.$inferSelect
export type ShortlistItem = typeof shortlistItems.$inferSelect
export type Outcome = typeof outcomes.$inferSelect
/**
 * Keyword volume, cached by (keyword, location).
 *
 * ==================== WHY A CACHE TABLE EXISTS AT ALL ====================
 * /keywords_data/google_ads/search_volume/live is billed PER REQUEST ($0.09)
 * and accepts up to 1000 keywords in one. The discovery runner asks for volume
 * one keyword at a time from separate serverless invocations, so there was
 * nowhere to put a batch result and every cell paid full freight: a 50 keyword
 * x 50 market run made 2,500 requests ($225) for data that fits in 50.
 *
 * This table is that "somewhere". A run's first job at a location fetches every
 * keyword in the run for that location in ONE request and fills the cache; the
 * other 49 jobs read it for free. Because the key is (keyword, location) and not
 * (run, keyword, location), the next run over the same markets pays nothing.
 *
 * Volume moves slowly, so rows are reused until VOLUME_CACHE_TTL_DAYS.
 * =====================================================================
 */
export const keywordVolumeCache = pgTable(
  'keyword_volume_cache',
  {
    id: serial('id').primaryKey(),
    /** Lower-cased exact query, as sent to DataForSEO. */
    keyword: text('keyword').notNull(),
    /** DataForSEO geotarget. Volume is per-location; this is half the key. */
    locationCode: integer('location_code').notNull(),
    languageCode: text('language_code').notNull().default('en'),
    avgMonthlySearches: integer('avg_monthly_searches'),
    competitionIndex: integer('competition_index'),
    competition: text('competition'),
    cpcMicros: bigint('cpc_micros', { mode: 'bigint' }),
    lowTopOfPageBidMicros: bigint('low_top_of_page_bid_micros', { mode: 'bigint' }),
    highTopOfPageBidMicros: bigint('high_top_of_page_bid_micros', { mode: 'bigint' }),
    monthlySearches: jsonb('monthly_searches').$type<
      Array<{ year: number; month: number; searchVolume: number }>
    >(),
    /** dataforseo_google_ads | google_ads | fixture */
    source: text('source').notNull(),
    /** e.g. "location_code=1023191" — what we actually asked for. */
    geoTarget: text('geo_target'),
    /**
     * A miss is worth caching too. DataForSEO returns no row for a keyword with
     * no data, and without this we would re-buy that silence every run.
     */
    hasData: boolean('has_data').notNull().default(true),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    keyIdx: uniqueIndex('keyword_volume_cache_key_idx').on(
      t.keyword,
      t.locationCode,
      t.languageCode,
    ),
    freshIdx: index('keyword_volume_cache_fresh_idx').on(t.locationCode, t.fetchedAt),
  }),
)

/**
 * ENRICH MODE — one deep-dive over a niche + locality, hunting acquirable
 * domains among the businesses that rank there.
 */
export const domainEnrichRuns = pgTable(
  'domain_enrich_runs',
  {
    id: serial('id').primaryKey(),
    status: text('status').notNull().default('pending'),
    niche: text('niche').notNull(),
    /** Human label for the market, e.g. "Tucson, AZ". */
    locality: text('locality').notNull(),
    /** DataForSEO / Google criteria ID the Maps request was issued against. */
    locationCode: integer('location_code').notNull(),
    radiusKm: integer('radius_km').notNull().default(25),
    maxResults: integer('max_results').notNull().default(200),
    includeClosed: boolean('include_closed').notNull().default(true),
    businessesFound: integer('businesses_found').notNull().default(0),
    uniqueDomains: integer('unique_domains').notNull().default(0),
    /** Listings dropped because the website was a platform we cannot acquire. */
    skippedPlatform: integer('skipped_platform').notNull().default(0),
    /** Listings that carried no parseable website at all. */
    skippedNoDomain: integer('skipped_no_domain').notNull().default(0),
    /**
     * Spend in micros. Stage 1 is the only stage that costs anything unless a
     * Majestic key is configured, so this is usually one Maps request.
     */
    costMicros: bigint('cost_micros', { mode: 'bigint' }).notNull().default(sql`0`),
    /** Which optional paid stages were enabled for this run. */
    paidOptions: jsonb('paid_options').$type<Record<string, boolean>>(),
    /**
     * Narrows the free SERP harvest to one niche. NULL harvests the whole
     * market, which finds more domains -- triage is free, so breadth costs
     * nothing but time, and provenance records which query surfaced each one.
     */
    nicheId: integer('niche_id'),
    /** Domains harvested from already-purchased SERP data (free). */
    domainsFromSerps: integer('domains_from_serps').notNull().default(0),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => ({
    statusIdx: index('domain_enrich_runs_status_idx').on(t.status, t.createdAt),
  }),
)

export const domainCandidates = pgTable(
  'domain_candidates',
  {
    id: serial('id').primaryKey(),
    runId: integer('run_id')
      .notNull()
      .references(() => domainEnrichRuns.id, { onDelete: 'cascade' }),
    domain: text('domain').notNull(),
    /** AVAILABLE | PENDING_DELETE | REDEMPTION | EXPIRING_SOON | PARKED_DEAD | ACQUIRED_301 | LIVE */
    status: text('status').notNull(),
    /** Why the classifier landed here, so a disputed row can be argued with. */
    reason: text('reason').notNull(),
    /** 0-100 ranking aid. Not a valuation. */
    score: doublePrecision('score').notNull().default(0),
    scoreComponents: jsonb('score_components').$type<Record<string, number>>(),
    /**
     * Signals that were unavailable when this row was scored. A domain scoring
     * low because Majestic was never configured is a different thing from one
     * scoring low on complete data, and the UI must be able to tell them apart.
     */
    scoreMissing: jsonb('score_missing').$type<string[]>(),
    /** Every listing that pointed here; >1 means a roll-up or shared template. */
    /**
     * Every listing that pointed here, WITH its Google Business Profile fields.
     *
     * `is_claimed`, `rating` and `review_count` are the GBP takeover signals --
     * an unclaimed profile carrying real review history ranks in the map pack
     * with no domain authority at all. They were read from every map listing
     * and discarded before this column was written; jsonb means widening the
     * shape needs no migration.
     */
    businesses: jsonb('businesses').$type<
      Array<{
        name: string
        website: string | null
        placeId?: string | null
        cid?: string | null
        isClaimed?: boolean | null
        rating?: number | null
        reviewCount?: number | null
      }>
    >(),
    businessCount: integer('business_count').notNull().default(1),

    // ---- Stage 3d, RDAP. All nullable: the registry may not have answered. ----
    registrar: text('registrar'),
    registeredAt: timestamp('registered_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    /** Domain age is a primary value driver, so it is stored, not recomputed. */
    ageYears: doublePrecision('age_years'),
    daysToExpiry: integer('days_to_expiry'),
    rdapStatuses: jsonb('rdap_statuses').$type<string[]>(),

    // ---- Stages 3a-3c, raw triage evidence kept for audit ----
    httpOutcome: text('http_outcome'),
    httpStatus: integer('http_status'),
    redirectedTo: text('redirected_to'),
    parkingNameserver: text('parking_nameserver'),

    // ---- Stage 5a, Majestic. Null until a key is configured. ----
    trustFlow: integer('trust_flow'),
    citationFlow: integer('citation_flow'),
    referringDomains: integer('referring_domains'),
    referringSubnets: integer('referring_subnets'),
    topics: jsonb('topics').$type<Array<{ name: string; percent: number }>>(),

    /**
     * Where this domain was seen. A domain found in the organic SERP is a
     * different proposition from one found only in a map pack.
     */
    sources: jsonb('sources').$type<string[]>(),
    /** Best organic rank_absolute observed. Null = never seen ranking. */
    serpRank: integer('serp_rank'),
    seenKeyword: text('seen_keyword'),
    /**
     * Paid quality gates. NULL means NOT CHECKED -- never "clean". These are
     * optional stages an operator turns on per run, so a null here is the
     * common case and must not read as a passing grade.
     */
    spamScore: integer('spam_score'),
    rankedKeywords: integer('ranked_keywords'),
    qualityCheckedAt: timestamp('quality_checked_at', { withTimezone: true }),

    // ---- Authority citations (backlinks index) ----
    /** Weighted breadth of authority citations. Null = never audited. */
    authorityScore: integer('authority_score'),
    authorityKinds: jsonb('authority_kinds').$type<string[]>(),
    authorityMatches: jsonb('authority_matches').$type<
      Array<{
        domain: string
        kind: string
        reason: string
        rank: number | null
        /**
         * The page the citation is on. NULL on rows audited before this was
         * collected -- the UI falls back to a directory search for those, which
         * is what every row used to get and what operators found unclickable.
         * jsonb, so widening the shape needs no migration.
         */
        urlFrom?: string | null
        pageStatus?: number | null
        isLost?: boolean
      }>
    >(),
    /**
     * Why this row has (or has not) an authority profile.
     *
     * The audit deliberately skips domains the cost pre-filter rules out, so an
     * empty `authorityMatches` has three possible meanings -- never audited,
     * skipped to save $0.025, or audited and genuinely clean. This says which.
     */
    authorityNote: text('authority_note'),
    authorityCheckedAt: timestamp('authority_checked_at', { withTimezone: true }),
    /** DataForSEO domain rank 0-1000, from the cheap bulk pass. */
    domainRank: integer('domain_rank'),

    // ---- Stage 5b, Wayback ----
    firstSnapshotAt: timestamp('first_snapshot_at', { withTimezone: true }),
    lastContentSnapshotAt: timestamp('last_content_snapshot_at', { withTimezone: true }),
    totalSnapshots: integer('total_snapshots'),
    yearsOfContent: integer('years_of_content'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    runDomainIdx: uniqueIndex('domain_candidates_run_domain_idx').on(t.runId, t.domain),
    rankIdx: index('domain_candidates_rank_idx').on(t.runId, t.score),
    statusIdx: index('domain_candidates_status_idx').on(t.runId, t.status),
  }),
)

// --- Supply: the read model of what a directory site has to sell -------------

/**
 * A connected supply feed. See @rnr/supply-feed and docs/plan-supply.md.
 *
 * ==================== PULL, NEVER PUSH ====================
 * The site owns supply. Nothing in this package writes back to it, and adding a
 * write path would create two catalogues that disagree — precisely the failure
 * already documented on `SiteStatus`: two state machines describing one asset
 * diverge silently. Here the divergence is a page that 404s.
 * ==========================================================
 */
export const supplySources = pgTable(
  'supply_sources',
  {
    id: serial('id').primaryKey(),
    siteId: integer('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    /** Where @rnr/supply-feed is mounted. No trailing slash. */
    baseUrl: text('base_url').notNull(),
    /**
     * The NAME of the env var holding the bearer token — never the token.
     *
     * A secret in a database row is a secret in every backup, every pg_dump and
     * every screenshot of a debugging session.
     */
    tokenEnvVar: text('token_env_var').notNull().default('SUPPLY_FEED_TOKEN'),
    /** Which dimension a listing's location resolves against. Null = no geography. */
    entityKind: text('entity_kind').default('locality'),
    schemaVersion: integer('schema_version'),
    /** The last manifest, verbatim. The baseline a partial sync is detected against. */
    lastManifest: jsonb('last_manifest').$type<Record<string, unknown>>(),
    lastPulledAt: timestamp('last_pulled_at', { withTimezone: true }),
    active: boolean('active').notNull().default(true),
    notes: text('notes'),
    createdAt: now(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    siteUrlUq: uniqueIndex('supply_sources_site_url_uq').on(t.siteId, t.baseUrl),
  }),
)

export const supplySuppliers = pgTable(
  'supply_suppliers',
  {
    id: serial('id').primaryKey(),
    sourceId: integer('source_id')
      .notNull()
      .references(() => supplySources.id, { onDelete: 'cascade' }),
    siteId: integer('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    /** Theirs. We never mint one — a synthesised key duplicates on re-order. */
    externalId: text('external_id').notNull(),
    name: text('name').notNull(),

    /** Verbatim as published, so a wrong resolution can be audited. Cf. localities.rawName. */
    rawCity: text('raw_city'),
    rawRegion: text('raw_region'),
    rawCountry: text('raw_country'),

    /**
     * ==================== NULL IS 'UNKNOWN', NOT 'NOWHERE' ====================
     * An unresolved supplier contributes to NO locality's coverage and must
     * never be read as a zero for one. `resolveStatus` says which happened, so
     * "we have no listings in Boise" and "we could not work out where these
     * listings are" never render the same — the first is a reason not to build a
     * page, the second is a reason to fix an importer.
     * =========================================================================
     */
    entityKind: text('entity_kind'),
    entitySlug: text('entity_slug'),
    localityId: integer('locality_id').references(() => localities.id, { onDelete: 'set null' }),
    resolveStatus: text('resolve_status')
      .$type<SupplyResolveStatus>()
      .notNull()
      .default('unresolved'),
    resolveMethod: text('resolve_method'),
    unresolvedReason: text('unresolved_reason'),

    createdAt: now(),
    lastSeenAt: timestampCol('last_seen_at'),
  },
  (t) => ({
    sourceExternalUq: uniqueIndex('supply_suppliers_source_external_uq').on(t.sourceId, t.externalId),
    entityIdx: index('supply_suppliers_entity_idx').on(t.siteId, t.entityKind, t.entitySlug),
    resolveIdx: index('supply_suppliers_resolve_idx').on(t.sourceId, t.resolveStatus),
  }),
)

export const supplyItems = pgTable(
  'supply_items',
  {
    id: serial('id').primaryKey(),
    sourceId: integer('source_id')
      .notNull()
      .references(() => supplySources.id, { onDelete: 'cascade' }),
    siteId: integer('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    supplierId: integer('supplier_id')
      .notNull()
      .references(() => supplySuppliers.id, { onDelete: 'cascade' }),
    externalId: text('external_id').notNull(),

    title: text('title').notNull(),
    url: text('url').notNull(),
    affiliateUrl: text('affiliate_url'),
    attributes: jsonb('attributes').$type<Record<string, string | number | boolean>>(),
    /** Integer micros, always. A float price becomes a median that authorises ad spend. */
    priceMicros: bigint('price_micros', { mode: 'bigint' }),
    currency: text('currency'),
    /**
     * NULLABLE ON PURPOSE.
     *
     * The publisher omitting `available` means UNKNOWN. Counting unknown as
     * bookable is how a sold-out city keeps its BUILD verdict, so `available =
     * true` is the only thing the coverage gate counts.
     */
    available: boolean('available'),
    images: jsonb('images').$type<string[]>(),

    /**
     * ==================== TWO CLOCKS, DELIBERATELY APART ====================
     * `sourceUpdatedAt` is THEIRS: when the row last changed on their site.
     * `lastSeenAt` is OURS: when we last confirmed it exists.
     * Collapsing them loses the ability to tell *stale* from *unchanged*.
     * =======================================================================
     */
    sourceUpdatedAt: timestamp('source_updated_at', { withTimezone: true }),
    firstSeenAt: timestampCol('first_seen_at'),
    lastSeenAt: timestampCol('last_seen_at'),
    /**
     * SOFT delete, never a DELETE.
     *
     * A feed outage that returned an empty page would otherwise erase the
     * catalogue, and `supply_coverage` would report a portfolio-wide supply gap
     * that never existed — turning an ops blip into a decision to stop building.
     */
    goneAt: timestamp('gone_at', { withTimezone: true }),
  },
  (t) => ({
    sourceExternalUq: uniqueIndex('supply_items_source_external_uq').on(t.sourceId, t.externalId),
    supplierIdx: index('supply_items_supplier_idx').on(t.supplierId, t.goneAt),
    siteIdx: index('supply_items_site_idx').on(t.siteId, t.goneAt, t.available),
  }),
)

/**
 * The materialised join everything else reads.
 *
 * Recomputed per ingest rather than per query: the keyword board, the ads
 * planner and every agent call read it, and recomputing a 195-locality aggregate
 * on each of those is waste.
 */
export const supplyCoverage = pgTable(
  'supply_coverage',
  {
    id: serial('id').primaryKey(),
    siteId: integer('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    entityKind: text('entity_kind').notNull(),
    entitySlug: text('entity_slug').notNull(),

    supplierCount: integer('supplier_count').notNull().default(0),
    itemCount: integer('item_count').notNull().default(0),
    /** What the gate reads. NOT itemCount — see supplyItems.available. */
    availableItemCount: integer('available_item_count').notNull().default(0),
    minPriceMicros: bigint('min_price_micros', { mode: 'bigint' }),
    medianPriceMicros: bigint('median_price_micros', { mode: 'bigint' }),

    /** Ours. A locality unseen for 30 days reads as stale, never as absent. */
    lastSeenAt: timestampCol('last_seen_at'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uq: uniqueIndex('supply_coverage_uq').on(t.siteId, t.entityKind, t.entitySlug),
    availableIdx: index('supply_coverage_available_idx').on(t.siteId, t.availableItemCount),
  }),
)

export const supplyIngestRuns = pgTable(
  'supply_ingest_runs',
  {
    id: serial('id').primaryKey(),
    sourceId: integer('source_id')
      .notNull()
      .references(() => supplySources.id, { onDelete: 'cascade' }),
    siteId: integer('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    status: text('status').$type<SupplyIngestStatus>().notNull().default('running'),
    /**
     * A soft-delete sweep is only valid on a FULL walk. An incremental pull
     * legitimately omits everything unchanged, so sweeping after one would mark
     * the entire unchanged catalogue as gone.
     */
    mode: text('mode').$type<SupplyIngestMode>().notNull().default('full'),

    pagesFetched: integer('pages_fetched').notNull().default(0),
    itemsPulled: integer('items_pulled').notNull().default(0),
    itemsUpserted: integer('items_upserted').notNull().default(0),
    itemsMarkedGone: integer('items_marked_gone').notNull().default(0),
    suppliersUpserted: integer('suppliers_upserted').notNull().default(0),
    /** The number that makes a coverage map's optimism measurable. */
    unresolvedSuppliers: integer('unresolved_suppliers').notNull().default(0),
    /** From the publisher's manifest. Compared against itemsPulled. */
    manifestTotalItems: integer('manifest_total_items'),
    manifestInvalidItems: integer('manifest_invalid_items'),
    entitiesCovered: integer('entities_covered').notNull().default(0),

    notes: jsonb('notes').$type<string[]>(),
    startedAt: timestampCol('started_at'),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    error: text('error'),
  },
  (t) => ({
    sourceIdx: index('supply_ingest_runs_source_idx').on(t.sourceId, t.startedAt),
  }),
)

export type Site = typeof sites.$inferSelect
export type NewSite = typeof sites.$inferInsert
export type SupplySource = typeof supplySources.$inferSelect
export type SupplySupplier = typeof supplySuppliers.$inferSelect
export type SupplyItemRow = typeof supplyItems.$inferSelect
export type SupplyCoverageRow = typeof supplyCoverage.$inferSelect
export type SupplyIngestRun = typeof supplyIngestRuns.$inferSelect
export type Call = typeof calls.$inferSelect
export type Lead = typeof leads.$inferSelect
export type WebhookEvent = typeof webhookEvents.$inferSelect
export type VoiceJob = typeof voiceJobs.$inferSelect
export type LeadDelivery = typeof leadDeliveries.$inferSelect
export type RetellAgent = typeof retellAgents.$inferSelect
export type LeadOutcome = typeof leadOutcomes.$inferSelect
export type SerpKeyword = typeof serpKeywords.$inferSelect
export type SerpTarget = typeof serpTargets.$inferSelect
export type SerpCheck = typeof serpChecks.$inferSelect
export type DiscoveryRun = typeof discoveryRuns.$inferSelect
export type DiscoveryNiche = typeof discoveryNiches.$inferSelect
export type DiscoveryGeo = typeof discoveryGeos.$inferSelect
export type DiscoveryJob = typeof discoveryJobs.$inferSelect
export type DiscoveryHit = typeof discoveryHits.$inferSelect
export type DiscoverySerpMetric = typeof discoverySerpMetrics.$inferSelect
export type ResearchKeyword = typeof researchKeywords.$inferSelect
export type ResearchGeo = typeof researchGeos.$inferSelect
export type KeywordVolumeCacheRow = typeof keywordVolumeCache.$inferSelect
export type DomainEnrichRun = typeof domainEnrichRuns.$inferSelect
export type DomainCandidateRow = typeof domainCandidates.$inferSelect
export type NewDomainCandidate = typeof domainCandidates.$inferInsert
