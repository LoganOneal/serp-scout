/**
 * @rnr/data -- providers, database, pipeline. SERVER ONLY.
 *
 * The `server-only` import in db.ts makes a client component that reaches into
 * this package fail at build time with a clear message, rather than typechecking
 * cleanly and then failing at bundle time with something unrelated-looking.
 *
 * Client components should import @rnr/core, which is pure and has no
 * dependencies at all.
 */

export * from './db.js'
export * from './query-timeout.js'
export * from './paths.js'
export * from './schema.js'
export * from './queue.js'
export * from './budget.js'
export * from './cache.js'
export * from './outcomes.js'
export * from './pipeline/run-scan.js'
export * from './providers/index.js'
export * from './providers/rdap.js'
export * from './providers/dataforseo/errors.js'
export { ENDPOINTS, ACCOUNT_ISSUE_PATTERN } from './providers/dataforseo/endpoints.js'
export { NICHE_SEEDS, type NicheSeed } from './seed/niches.js'
export * from './queries.js'

// --- Sites & CRM -------------------------------------------------------------
export * from './sites.js'
export * from './voice/jobs.js'
export * from './worker/drain.js'
export * from './voice/ingest.js'
export * from './voice/recordings.js'
export * from './voice/delivery.js'
export * from './voice/run-job.js'
export * from './voice/agents.js'
export * from './voice/agent-create.js'
export * from './voice/analysis-fields.js'
export * from './voice/outcomes.js'
export * from './serp/keywords.js'
export * from './serp/run-check.js'
export * from './serp/targets.js'
export * from './serp/markets.js'
export * from './serp/discovery-budget.js'
export * from './serp/resolve-discovery-geos.js'
export * from './serp/run-discovery.js'
export * from './serp/promote.js'
export * from './serp/discovery-queries.js'
export * from './serp/research-import.js'
export * from './serp/catalog-research.js'
export * from './serp/keyword-volume-cache.js'
export * from './serp/research-history.js'
export * from './serp/opportunity-screen.js'
export * from './serp/reddit-opportunity-export.js'
export {
  fetchKeywordVolumes,
  googleAdsConfigured,
  googleAdsGeoIdsForLocation,
  GOOGLE_ADS_GEO_US,
  type KeywordVolumeResult,
  type KeywordVolumeRow,
} from './providers/google-ads/keyword-volume.js'
export {
  fetchKeywordIdeas,
  KEYWORD_IDEAS_PAGE_SIZE,
  type KeywordIdea,
  type KeywordIdeasResult,
} from './providers/google-ads/keyword-ideas.js'
export {
  fetchDfsKeywordVolumes,
  fetchDfsKeywordVolumesFromEnv,
  createDfsClientFromEnv,
  DFS_VOLUME_LOCATION_US,
  type DfsKeywordVolumeResult,
  type DfsKeywordVolumeRow,
} from './providers/dataforseo/keyword-volume.js'
export * from './providers/voice.js'
export * from './providers/retell/signature.js'
export * from './providers/retell/contracts.js'
export { RetellClient, RetellError, type ImportNumberArgs } from './providers/retell/client.js'
export { TwilioClient, TwilioError, type NumberConfig } from './providers/twilio/client.js'
export { fixtureCall, FIXTURE_SCENARIOS, type FixtureScenario } from './providers/fixtures/voice.js'
export * from './domains/dns-triage.js'
export * from './domains/http-triage.js'
export * from './domains/rdap-record.js'
export * from './domains/wayback.js'
export * from './domains/enrich-pipeline.js'
export * from './domains/collect-businesses.js'
export * from './domains/run-enrich.js'
export * from './domains/queries.js'
export { ensureKeywordVolumesFromEnv } from './serp/keyword-volume-cache.js'
export * from './domains/authority-links.js'
export * from './domains/collect-from-serps.js'
export * from './domains/quality-gates.js'
export * from './domains/js-render.js'
export * from './serp/serp-winnability.js'
export * from './serp/raw-serp-cache.js'

// --- Keyword spaces: affiliate directory sites -------------------------------
export * from './spaces/sites.js'
export * from './spaces/entities.js'
export * from './spaces/research.js'
export * from './spaces/rankings.js'
export * from './spaces/difficulty.js'
export * from './hht-keywords/store.js'

// --- Affiliate economics -----------------------------------------------------
export * from './economics/store.js'

// --- Paid search -------------------------------------------------------------
export * from './ads/plan.js'
export * from './ads/launch.js'
export {
  fetchCampaignForecast,
  type ForecastKeyword,
  type ForecastResult,
} from './providers/google-ads/forecast.js'
export {
  submitCampaign,
  buildCampaignOperations,
  validateCampaignPlan,
  type CampaignPlan,
  type AdGroupPlan,
  type ResponsiveSearchAd,
  type MutationResult,
} from './providers/google-ads/campaigns.js'
export {
  googleAdsMutationsEnabled,
  assertMutationsAllowed,
  GoogleAdsMutationBlocked,
} from './providers/google-ads/client.js'
export {
  AFFILIATE_SITE_SEEDS,
  ENTITY_SET_SEEDS,
  type AffiliateSiteSeed,
} from './seed/affiliate-sites.js'
export {
  fetchRankedKeywords,
  fetchCompetitorDomains,
  classifyCompetitorPeers,
  LABS_LOCATION_US,
  DEFAULT_LABS_LIMIT,
  PEER_MAX_SIZE_RATIO,
  type RankedKeyword,
  type RankedKeywordsResult,
  type CompetitorDomain,
  type CompetitorsResult,
} from './providers/dataforseo/labs.js'
export {
  fetchSearchConsoleQueries,
  searchConsoleConfigured,
  siteUrlCandidates,
  GSC_ROW_LIMIT,
  type GscQueryRow,
  type GscResult,
} from './providers/google/search-console.js'

// --- Link prospecting and outreach -------------------------------------------
export * from './links/mine.js'
export * from './links/contacts.js'
export * from './links/outreach.js'

// --- HotelHotTubs backlink research -----------------------------------------
export * from './hht-bl/config.js'
export * from './hht-bl/semrush.js'
export * from './hht-bl/jobs.js'
export * from './hht-bl/import.js'
export * from './hht-bl/crawl.js'
export * from './hht-bl/analysis.js'
export * from './hht-bl/processing.js'
export * from './hht-bl/scoring.js'
export * from './hht-bl/dashboard.js'
export * from './hht-bl/export.js'
export * from './hotel-bl/import.js'
export * from './hotel-bl/scoring.js'
export * from './hotel-bl/crawl.js'
export * from './hotel-bl/pipeline.js'
export * from './hotel-bl/dashboard.js'
export * from './hotel-bl/updates.js'
export * from './hotel-bl/validation.js'
export {
  fetchTrafficEstimates,
  TRAFFIC_BATCH_MAX,
  type TrafficEstimate,
  type TrafficEstimationResult,
} from './providers/dataforseo/traffic.js'

// --- Supply: the read model of what a directory site has to sell -------------
export * from './supply/sources.js'
export * from './supply/client.js'
export * from './supply/resolve.js'
export * from './supply/ingest.js'
export * from './supply/coverage.js'
export * from './supply/query.js'

// --- Opportunity Miner -------------------------------------------------------
export { createSemrushClient, semrushApiKey, SemrushUnavailable } from './opportunity-miner/semrush/client.js'
export { seedQueue, expandNamedKeyword, discoverKeyword, omLive } from './opportunity-miner/discovery.js'
export { clusterMarkets } from './opportunity-miner/cluster.js'
export { scoreAllMarkets } from './opportunity-miner/score.js'
export { analyzeDomain, discoverSerpAndAds } from './opportunity-miner/domains.js'
export { runDaily, runSeed, drainQueue } from './opportunity-miner/run.js'
export { exportOpportunitiesCsv } from './opportunity-miner/export.js'
export { ingestSemrushHarvest, ingestSemrushHarvestFile } from './opportunity-miner/harvest.js'
export {
  listOpportunityMarkets,
  getMarketDetail,
  minerStats,
  listAnomalies,
  updateMarketReview,
  type MarketListFilters,
} from './opportunity-miner/queries.js'
export { materializeSeeds, loadDictionaries } from './opportunity-miner/seeds.js'
