/**
 * @rnr/supply-feed — publish a directory site's supply as a read-only feed.
 *
 * ==================== SUPPLY IS A GATE, NOT A DISPLAY FEATURE ====================
 * The system that consumes this feed generates keyword targets from a grid: 195
 * localities x 5 patterns = 975 keywords for a hotel directory, produced with no
 * knowledge of whether the site has one listing in Boise or none. Without this
 * feed it will happily decide to BUILD a page for a locality with no inventory,
 * and BUY Google Ads clicks that land on an empty result set.
 *
 * What you publish here is what stops that. Which is also why the manifest's
 * `totalItems` matters more than it looks: a sync that silently pulls 4,000 of
 * 5,231 items would mark 1,231 listings as gone and turn their localities into
 * supply gaps overnight.
 * ================================================================================
 *
 * ONE-DIRECTIONAL, ALWAYS. Your site owns supply; the consumer holds a read
 * model and says when it last refreshed. There is no write path in this package
 * and adding one would create two catalogues that disagree — the same failure
 * this project already paid for with `sites.status` vs `shortlist_items.state`.
 */

export { createSupplyFeed, DEFAULT_LIMIT, MAX_LIMIT, DEFAULT_RATE_LIMIT_PER_MINUTE } from './feed.js'
export type { SupplyFeed } from './feed.js'

export { toRouteHandlers, toExpressHandler } from './adapters.js'
export type { RouteHandlers, ExpressLikeRequest, ExpressLikeResponse } from './adapters.js'

export { validateItem, partitionItems } from './validate.js'
export type { ValidationResult, ValidationOk, ValidationFail, PartitionResult } from './validate.js'

export { safeEqual, bearerFrom, authenticate, RateLimiter } from './auth.js'
export type { AuthOutcome } from './auth.js'

export { SUPPLY_SCHEMA_VERSION } from './types.js'
export type {
  SupplyItem,
  SupplyLocation,
  SupplyManifest,
  SupplyCounts,
  SupplyFeedConfig,
  SupplyErrorBody,
  FetchPageArgs,
  FetchPageResult,
} from './types.js'
