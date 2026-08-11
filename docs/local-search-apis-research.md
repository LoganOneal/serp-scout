# Local search data APIs — research notes

**Purpose:** Inventory of **DataForSEO** and **Google Ads** APIs that expose local-search-relevant data for rank-and-rent research (niche × market screening, deep dive SERPs, demand, competition, map pack, lead economics).

**Audience:** Product + eng. Use this when choosing data sources for volume, SERP layout, local pack density, and geo targeting.

**Last researched:** 2026-08-05  
**Related code:** `packages/data/src/providers/dataforseo/*`, `packages/data/src/providers/google-ads/*`, `docs/market-opportunity-funnel.md`

---

## Mental model: what “local search data” means here

| Layer | Question we ask | Not the same as |
|--------|-----------------|-----------------|
| **Demand / volume** | How many monthly searches for this service (optionally *in this city*)? | Map pack listings |
| **SERP layout** | Ads above organic? Local pack? Discussions? Reddit? | Business profile details |
| **Local pack / Maps** | Who ranks in the 3-pack / Maps for this query @ location? | Keyword search volume |
| **Competition economics** | CPC, competition index, bids | Organic difficulty alone |
| **Geo identity** | Which `location_code` / criteria ID is “Phoenix, AZ”? | IP geolocation of the API caller |

**Critical trap:** Google **Maps / local pack** endpoints do **not** return search volume. Volume comes from **Google Ads Keyword Planner metrics** (direct Google Ads API or DataForSEO Keywords Data wrapping the same family of metrics).

---

## What we use today (baseline)

| Need | Current source | Endpoint / path in repo |
|------|----------------|-------------------------|
| Organic SERP (desktop/mobile) | DataForSEO | `/serp/google/organic/live/advanced` |
| Map pack (scan pipeline) | DataForSEO | `/serp/google/maps/live/advanced` |
| Local search volume (deep dive) | DataForSEO Keywords Data | `/keywords_data/google_ads/search_volume/live` + `location_code` |
| SERP locations catalog | DataForSEO | `/serp/google/locations` |
| Account preflight | DataForSEO | `/appendix/user_data` |
| Legacy / optional volume | Google Ads API | `KeywordPlanIdeaService.GenerateKeywordHistoricalMetrics` |
| Geo criteria list (CSV / resolver) | Google geotargets + DFS | Localities `provider_location_code` |

---

# Part 1 — DataForSEO

Base: `https://api.dataforseo.com/v3`  
Auth: HTTP Basic (`DATAFORSEO_LOGIN` / `DATAFORSEO_PASSWORD`)  
Docs hub: [dataforseo.com/apis](https://dataforseo.com/apis) · Local SEO use cases: [dataforseo.com/solutions/local-seo](https://dataforseo.com/solutions/local-seo)

**Convention:** Prefer **Live** for interactive research; **task_post + task_get** is cheaper for bulk offline drains. Always check **task-level** `status_code === 20000` (HTTP 200 alone is not success).

---

## 1. SERP API — organic Google (local *search results page*)

### 1.1 Live organic advanced  
**Path:** `POST /serp/google/organic/live/advanced`  
**Also:** `task_post` / `task_get/advanced` (async, lower cost)

**Geo inputs (pick one style):**
- `location_code` — preferred (city/DMA/state from locations catalog)
- `location_name` — e.g. `Phoenix,Arizona,United States`
- `location_coordinate` — `"lat,lon"` or `"lat,lon,radius_m"` for pin + radius

**Other useful params:**
- `keyword`, `language_code` (`en`)
- `device` (`desktop` | `mobile`), `os`
- `depth` (10 page-1 vs 100 deep)

**Local-relevant fields in response items (by `type`):**

| Item type | Local relevance |
|-----------|-----------------|
| `organic` | Classic blue links; Reddit domains; rank absolute |
| `paid` / ads | Ads above the fold → paid heat / arbitrage signal |
| `local_pack` | **3-pack** in main SERP: title, rating, reviews count, address, phone, domain, map pin |
| `maps` / map-related | Map UI blocks (variant naming by SE version) |
| `local_services` | Google Local Services Ads (LSA) — plumbers etc. |
| `people_also_ask` | Query expansion |
| `related_searches` | Long-tail ideas |
| `discussions_and_forums` | Reddit / forum pack (our discovery signal) |
| `knowledge_graph` | Brand / entity presence |
| `ai_overview` | (when present) changes above-the-fold real estate |

**Product fit:** Core deep-dive unit. We already extract Reddit hits, ads↑, local↑, organic counts.  
**Does not provide:** Search volume, CPC, competition index.

**Rough cost:** ~$0.002 / live advanced call (verify on pricing page).

---

## 1.2 Google Maps SERP (map pack / Maps results)

### Path: `POST /serp/google/maps/live/advanced`  
Docs: [Google Maps SERP](https://dataforseo.com/apis/serp-api/google-maps-api) · [overview](https://docs.dataforseo.com/v3/serp-google-maps-overview/)

**What it is:** Ranked **Maps “search this area”** style results for a keyword + location (not classic organic HTML).

**Typical returned data per place:**
- Rank / position in Maps results  
- Business name, category  
- Rating, reviews count  
- Address, phone, website/domain  
- Place ID / CID-style identifiers (when present)  
- Coordinates  
- Hours / snippets (when available)

**Geo:** `location_code`, name, or coordinates (often required for “search this area” semantics).

**Product fit:**
- Density of competitors in pack  
- “Is this a local query?” (empty maps + no pack → weak local intent)  
- Domain set for EMD / competitor audits  
- Lead-gen niches: who dominates Maps for “roofer near me” @ city  

**Does not provide:** Keyword search volume.

**Rough cost:** ~$0.002 / live (same order as organic live).

**In repo:** `ENDPOINTS.SERP_MAPS_LIVE`, `fetchMapPack`, used heavily in scan/difficulty.

---

## 1.3 Google Local Finder SERP

### Path: `POST /serp/google/local_finder/live/advanced` (and task variants)  
Blog: [Local Finder API](https://dataforseo.com/blog/streamline-local-seo-efforts-with-google-local-finder-api)

**What it is:** Google’s **Local Finder** UI (expanded local results beyond the 3-pack — more listings, filters such as day/time in some modes).

**Useful for:**
- Deeper local competitor lists than organic `local_pack` alone  
- Time-of-day filters (e.g. open Monday) where supported  

**Product fit:** Optional second pass when 3-pack is sparse but Local Finder is rich; rank-and-rent “who would we outrank in local UI?”.

**Not volume.**

---

## 1.4 Other SERP surfaces (secondary local relevance)

| Endpoint family | Relevance |
|-----------------|-----------|
| Bing organic / local | Alternate engine; lower priority for US home services |
| YouTube / News / Images | Weak for local lead-gen screening |
| Autocomplete | Keyword ideation only |

---

## 1.5 SERP locations catalog

### Path: `GET /serp/google/locations`  
**Also related:** language lists under SERP docs.

**Returns:** Large catalog of `location_code`, `location_name`, type (Country / State / City / …), country ISO.

**Product fit:** Resolve city → code for organic, maps, **and** (when codes align) Keywords Data volume.  
**Trap:** `/serp/google/organic/locations` is **invalid**; use `/serp/google/locations` only (documented in our `endpoints.ts`).

**Cost:** Free.

---

## 2. Keywords Data API (demand, CPC, competition — local-scoped)

Hub: [Keyword Data API](https://dataforseo.com/apis/keyword-data-api) · [Google Ads via DFS](https://dataforseo.com/apis/google-ads-api)

These wrap **Google Ads Keyword Planner–style metrics**, with optional **location**.

### 2.1 Search volume (primary volume source for local markets)

**Path:** `POST /keywords_data/google_ads/search_volume/live`  
Docs: [search_volume live](https://docs.dataforseo.com/v3/keywords_data-google_ads-search_volume-live/)

**Request highlights:**
- `keywords[]` — up to 1000 per request  
- `location_code` **or** `location_name` **or** `location_coordinate`  
  - Omit location → **worldwide** (usually wrong for local products)  
  - City codes (e.g. Phoenix `1013462`) → **city-scoped** volume  
  - Invalid city code → task error `40501` → fall back to US `2840`  
- `language_code` (`en`)  
- `search_partners`  
- `date_from` / `date_to` for history window  

**Response per keyword (local-relevant):**
| Field | Meaning |
|-------|---------|
| `search_volume` | Avg monthly searches for that geo |
| `monthly_searches[]` | Year/month/volume history (~12–48 months depending on range) |
| `competition` | LOW / MEDIUM / HIGH |
| `competition_index` | 0–100 |
| `cpc` | Avg CPC (USD) |
| `low_top_of_page_bid` / `high_top_of_page_bid` | Bid estimates |
| `location_code` | Echo of targeting |

**Product fit:** **Canonical local demand** for niche × market cells.  
**In repo:** `fetchDfsKeywordVolumes*` → `volume_source = dataforseo_google_ads`.

**Ops notes:**
- Charged **per request** (1–1000 keywords same price tier) → batch by location  
- Live Google Ads endpoints: **~12 requests/minute** account limit  
- Some keywords return null volume (Ads policy / thin data)

**Rough cost:** On order of **$0.05–$0.075 per request** (confirm live pricing; example responses show ~$0.075).

---

### 2.2 Keywords for keywords / keywords for site / ad traffic

| Endpoint | Local use |
|----------|-----------|
| `keywords_data/google_ads/keywords_for_keywords/live` | Expand seed noun → buy-intent cluster with volume @ location |
| `keywords_data/google_ads/keywords_for_site/live` | Competitor domain → keywords (national or geo if supported) |
| `keywords_data/google_ads/ad_traffic_by_keywords/live` | Impressions/clicks estimates for bids (campaign planning) |

**Product fit:** Screen “what keywords does this niche expand to?” with **local volume** without hand-seeding every head.

---

### 2.3 Keywords Data locations & languages

**Paths:**
- `GET /keywords_data/google_ads/locations`  
- `GET /keywords_data/google_ads/languages`  
- Status endpoints for data freshness  

**Important:** Keywords Data location catalogs may **not** be 1:1 with SERP locations. Always validate city codes (we saw some DFS-only codes fail volume with `40501` while Google geotarget IDs work).

**Product fit:** Prefer codes that work for **both** SERP and volume, or maintain a mapping table.

---

### 2.4 Google Trends (via Keywords Data)

**Paths:** Trends explore / subcategory endpoints under Keywords Data.

**Returns:** Interest over time, related queries — **relative**, not absolute monthly volume.

**Product fit:** Seasonality (“roofing” peaks after storms); secondary to absolute volume.

---

### 2.5 Labs (DataForSEO Labs — SEO database metrics)

Examples: keyword overview, ranked keywords, SERP competitors, relevant pages.

**Local caveats:**
- Many Labs metrics are **national or database-scoped**, not pin-accurate city SERP  
- `dataforseo_labs/locations_and_languages` is **not** a full city volume catalog (see `endpoints.ts` trap comment)

**Product fit:** Domain difficulty, competitor keyword sets at country level; **not** a substitute for local organic SERP or city volume.

---

## 3. Business Data API (GBP / listings / reviews)

Hub: [Business Data API](https://dataforseo.com/apis/business-data-api)

### 3.1 Google My Business Info  
**Path family:** `business_data/google/my_business_info/*`  
Docs: [live info](https://docs.dataforseo.com/v3/business_data-google-my-business-info-live/)

**Returns (examples):** category, attributes, phone, domain, address, hours, photos count, rating, `cid`, place identity, services.

**Product fit:** Profile completeness of competitors in a market; “rent to who?” CRM enrichment.

### 3.2 Google Reviews  
**Path family:** `business_data/google/reviews/*` (and extended reviews)

**Returns:** Review text, rating, time, reviewer metadata.

**Product fit:** Reputation arbitrage (weak review competitors); not ranking position.

### 3.3 Business Listings / categories aggregation  
**Product fit:** “How many roofers in this city?” category counts for market saturation estimates.

### 3.4 Hotels  
Low relevance for home-services rank-and-rent.

---

## 4. Backlinks API (domain competition)

**Paths:** bulk ranks, referring domains, spam score, etc.

**Product fit:** After shortlist, score candidate domains / competitor strength.  
**Local caveat:** Backlinks are **domain-global**, not city-local.

**In repo:** bulk backlinks in scan pipeline; price = per request + per row.

---

## 5. On-Page API

**Path:** `/on_page/instant_pages` (and crawl variants)

**Product fit:** Fetch page HTML when Reddit/other sites block datacenter IPs (SERP monitoring comment order).  
**Not** local ranking data.

---

## 6. Appendix / account

| Path | Use |
|------|-----|
| `/appendix/user_data` | Balance, rate limits, preflight before spend |
| Errors `402xx` | Account paused / payment — abort runs (never treat as empty SERP) |

---

# Part 2 — Google Ads API (direct)

Docs: [Keyword planning historical metrics](https://developers.google.com/google-ads/api/docs/keyword-planning/generate-historical-metrics)  
Geo list: [Geo targets](https://developers.google.com/google-ads/api/reference/data/geotargets)

**Auth:** OAuth2 refresh token + developer token + customer / login-customer IDs (`GOOGLE_ADS_*` env).

---

## 1. GenerateKeywordHistoricalMetrics (volume + bids)

**Service:** `KeywordPlanIdeaService.GenerateKeywordHistoricalMetrics`  
**REST shape (approx):**  
`POST https://googleads.googleapis.com/{version}/customers/{customerId}:generateKeywordHistoricalMetrics`

**Request:**
- `keywords[]`  
- `geoTargetConstants[]` — e.g. `geoTargetConstants/2840` (US), `geoTargetConstants/1013462` (city)  
- `language` — `languageConstants/1000` (English)  
- `keywordPlanNetwork` — `GOOGLE_SEARCH` vs partners  

**Response metrics (per keyword):**
| Field | Local relevance |
|-------|-----------------|
| `avgMonthlySearches` | Demand @ geo |
| `monthlySearchVolumes[]` | Seasonality |
| `competition` / `competitionIndex` | Paid competition |
| `lowTopOfPageBidMicros` / `highTopOfPageBidMicros` | Lead economics / CPC priors |
| `averageCpcMicros` (when requested) | CPC |

**Product fit:** Same *kind* of data as DFS Keywords Data search_volume.  
**Why we de-prioritized for deep dive:** Second credential stack; city criteria mismatches; DFS already holds SERP geo + volume under one vendor.

**In repo:** `packages/data/src/providers/google-ads/keyword-volume.ts` (still available).

---

## 2. Keyword ideas / forecasts

| Method | Local use |
|--------|-----------|
| `GenerateKeywordIdeas` | Seed → ideas with geo-scoped metrics |
| `GenerateForecastMetrics` | Forward-looking clicks/impr. (needs plan / bids) |

**Product fit:** Niche expansion and campaign planning; heavier than historical metrics alone.

---

## 3. Geo target constants

**GAQL / resources:** `geo_target_constant`  
**CSV:** Google’s geotargets dump (Country, Region, City, Postal, DMA, …)

**Fields of interest:** criteria ID, name, canonical name, parent, target type, status.

**Product fit:**
- Map Census places → Ads criteria IDs  
- Align with DataForSEO when codes match  
- UULE canonical names (`City,State,United States`) for browser SERP verification  

**Note:** Same numeric ID often works as DFS `location_code` for US cities, but **not guaranteed** for every code family — validate.

---

## 4. What Google Ads API does **not** give you

- Live organic SERP HTML / ranks  
- Map pack / Local Finder listings  
- Reddit discussions pack  
- GBP reviews (use Business Profile API or DataForSEO Business Data)

---

# Part 3 — Side-by-side comparison

| Data need | DataForSEO | Google Ads API | Recommendation for this product |
|-----------|------------|----------------|----------------------------------|
| City organic SERP | ✅ Organic advanced | ❌ | **DFS organic** |
| Local 3-pack in SERP | ✅ `local_pack` item | ❌ | **DFS organic** |
| Maps rankings | ✅ Maps SERP | ❌ | **DFS maps** |
| Expanded local list | ✅ Local Finder | ❌ | Optional DFS |
| City search volume | ✅ Keywords Data + `location_code` | ✅ Historical metrics + geo | **DFS volume** (single vendor); Ads as fallback |
| National volume | ✅ location 2840 | ✅ geo 2840 | Either |
| CPC / competition | ✅ same volume endpoints | ✅ same metrics family | DFS or Ads |
| Monthly seasonality | ✅ `monthly_searches` | ✅ monthly volumes | Either |
| Keyword expansion | ✅ keywords_for_keywords | ✅ GenerateKeywordIdeas | DFS or Ads |
| GBP / reviews | ✅ Business Data | ❌ (different Google APIs) | DFS if needed later |
| Backlinks | ✅ Backlinks API | ❌ | DFS |
| Geo catalog | ✅ SERP + KW locations | ✅ geotargets CSV | Merge carefully |
| Account health | ✅ user_data | Ads API errors | Both |

---

# Part 4 — Recommended data stack for rank-and-rent

### Tier A — must-have (current + keep)

1. **Organic SERP @ city** — layout, Reddit, ads↑, local↑  
2. **Search volume @ city** — Keywords Data `search_volume` + same `location_code`  
3. **Locations resolution** — DFS locations + Google geotargets for IDs  
4. **Account preflight** — refuse spend when paused  

### Tier B — high value for local lead-gen

5. **Maps SERP @ city** — competitor density / local-intent check (already in scan)  
6. **Local Finder** — deeper local competitor lists when 3-pack is thin  
7. **Keywords for keywords @ city** — automated buy-intent expansion with volume  
8. **Monthly searches** — seasonality on Screen / deep dive  

### Tier C — later / promote stage

9. **Business Data (GBP info + reviews)** — rent-to contractor scoring  
10. **Backlinks bulk** — domain acquisition shortlist  
11. **Direct Google Ads forecasts** — if we sell ads management, not only SEO rental  

### Explicit non-goals / wrong sources

| Don’t use for… | Why |
|----------------|-----|
| Map pack as “volume” | No search volume field |
| Labs national metrics as city demand | Wrong geo granularity |
| Population × national volume hacks | We already rejected this for scoring honesty |
| Worldwide volume (omit location) | Inflates demand; mis-ranks markets |

---

# Part 5 — Suggested metric dictionary (product language)

| UI label | Source API | Field(s) | Geo scope |
|----------|------------|----------|-----------|
| Vol / mo | DFS Keywords Data search_volume | `search_volume` | Market `location_code` |
| Comp | same | `competition_index` | Market |
| CPC / bid | same | `cpc`, top-of-page bids | Market |
| Ads↑ | DFS organic | paid *search* ads above first organic (**excludes LSA**) | Market + device |
| LSA↑ | DFS organic `local_services*` | Local Services Ads count / above organic / rank | Market + device |
| GBP↑ | DFS organic `local_pack` / nested `maps_search` | Google Business listing slots above organic / total | Market + device |
| Map | DFS organic | map / local_pack present + `map_rank_absolute` | Market + device |
| Forums | DFS organic `discussions_and_forums` | thread count + pack rank | Market + device |
| 1st org # | DFS organic | first true organic `rank_absolute` (all sponsored + GBP above it) | Market + device |
| Reddit # | DFS organic + discussions | best Reddit `rank_absolute` | Market + device |
| Maps competitors (deep) | DFS maps SERP | entry count / domains | Market |
| Ticket / lead $ | Internal priors | niches economics | Niche (not geo) |

---

# Part 6 — Cost & rate-limit sketch (order of magnitude)

Always re-check [DataForSEO pricing](https://dataforseo.com/pricing) and Ads API quotas.

| Call type | Order of cost | Rate notes |
|-----------|---------------|------------|
| Organic live advanced | ~$0.002 | Primary deep-dive cost driver |
| Maps live | ~$0.002 | Optional extra per keyword×geo |
| Keywords search_volume live | ~$0.05–0.075 / request | Batch keywords; ~12 live Ads req/min |
| Locations / user_data | Free | Cache locations |
| Google Ads historical metrics | Ads API free tier / standard quotas | OAuth + developer token |

**Deep dive cost formula (current product):**  
≈ `(keywords × markets × devices) × organic_live`  
+ `(unique keyword×location batches) × search_volume`  

---

# Part 7 — Open questions / follow-ups

1. **Canonical location_code table** — which IDs work for both organic and Keywords Data for all 200 research geos?  
2. **Should Screen niche national volume stay on seed GAds enrich** or move fully to DFS US `2840`?  
3. **Maps on every deep-dive job** vs organic-only + maps on promote?  
4. **Local Services Ads** item types in organic — worth scoring for home services?  
5. **Postal-code volume** — finer than city but thinner data and more spend  

---

## References

- DataForSEO Local SEO: https://dataforseo.com/solutions/local-seo  
- DataForSEO Maps SERP: https://dataforseo.com/apis/serp-api/google-maps-api  
- DataForSEO Local Pack feature: https://dataforseo.com/serp-feature/local-pack  
- DataForSEO Local Finder: https://dataforseo.com/blog/streamline-local-seo-efforts-with-google-local-finder-api  
- DataForSEO Keywords Data / Google Ads: https://dataforseo.com/apis/keyword-data-api · https://docs.dataforseo.com/v3/keywords_data-google_ads-search_volume-live/  
- DataForSEO Business Data: https://dataforseo.com/apis/business-data-api  
- Google Ads historical metrics: https://developers.google.com/google-ads/api/docs/keyword-planning/generate-historical-metrics  
- Google Ads geotargets: https://developers.google.com/google-ads/api/reference/data/geotargets  
- Browser local SERP verification (UULE): see `packages/core/src/serp/local-serp-url.ts` and Valentin’s UULE notes  

---

## Changelog

| Date | Note |
|------|------|
| 2026-08-05 | Initial research inventory; align with DFS local volume cutover from direct Google Ads for deep dive |
