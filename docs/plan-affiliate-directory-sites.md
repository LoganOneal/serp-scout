# Plan: affiliate directory sites — one keyword engine for two site shapes

| Field | Value |
|---|---|
| **Date** | 2026-08-13 |
| **Status** | ✅ **Built and run 2026-08-13.** §8 records what was measured and what is still blocked. Live spend **$0.1764** |
| **Goal** | Put `hotelhottubs.com` and `borenhealth.com` in the portfolio, pull every keyword they rank for, and generate the next ones to target — on a model general enough that local rank-and-rent is the same engine |
| **Depends on** | `bulk-market-research-import.md` (the catalog tables), `market-opportunity-funnel.md` (the screen → deep-dive shape) |
| **Assumes** | We have Google Search Console access to both domains. **Confirm before building §3.1** — it is the largest single lever here and everything downstream is priced against it |

---

## 0. The reframing this plan turns on

A property in this tool is not a site. It is a **cell** — one `locality` × one
`niche`, welded in as two `NOT NULL` foreign keys on `sites` plus a partial
unique index on the pair (`schema.ts:507`, `db-extras.ts`). A domain covers
exactly one cell, and `sites_domain_uq` enforces that a domain appears once.

**Both new sites break that model, in opposite directions.**

- `borenhealth.com` has **no locality at all**. Peptides and peptide vendors
  are not geographic. `locality_id NOT NULL` rejects the row.
- `hotelhottubs.com` has **hundreds of localities and one domain**. Expressing
  it as cells needs ~300 `sites` rows carrying the same domain, which
  `sites_domain_uq` rejects, and which would be wrong anyway — it is one site.

The instinct is to read this as "add a non-local niche type". That is the wrong
read, and the reason is the second thing this plan turns on:

> **In local mode, geography is a parameter of the request. In affiliate mode,
> geography is a string inside the keyword — and the two are not the same
> geography.**
>
> The local pipeline buys `plumber` at `location_code = 1023191` (Kenosha) and
> deliberately keeps the city *out* of the query string
> (`service-intent-keywords.ts:5-8`). The searcher and the service are in the
> same place, so one code serves both roles.
>
> `hotelhottubs.com` breaks that identity. **The city in
> `hotels with hot tubs in room las vegas` is the destination, not the
> searcher.** Somebody in London planning a Vegas trip is the customer. The
> destination is a *token in the string*; the audience is **somewhere else**.
> (How far else is §0.2 — the answer there is "the rest of the country".)

### 0.1 The invariant: a destination is never a request parameter

This is the rule the whole affiliate path hangs on, and it is one line away
from being violated by accident, because `research_geos` rows carry a
`dataforseo_location_code` and it is sitting right there next to the name.

> **For `geoMode: in_keyword`, the entity's location code is enumeration and
> display only. It must never be passed to a volume call or a SERP call.**

Violating it fails in two directions at once, and neither raises an error:

- **Volume becomes the wrong population.** Buying
  `hotels with hot tubs in room las vegas` at Las Vegas's location code measures
  people *in* Las Vegas — residents, who are the one group not booking a Vegas
  hotel. It is a systematic undercount of exactly the audience the site
  monetises, and it returns a plausible small number rather than an error.
- **The SERP becomes a different page.** A query bought from inside Las Vegas is
  localised — Google injects hotel and map modules it does not serve a London
  searcher. `scoreDifficulty` then reads a page we are not competing on.

**And the fallback makes it silent.** `fetchDfsKeywordVolumes` retries with US
2840 when a location code is rejected and still returns
`source: 'dataforseo_google_ads'` (`keyword-volume.ts:258-296`). The truth is
recorded in `volumeGeoTarget` and nowhere else. A caller that passes a bad
destination code gets US national data labelled as a success.

So the model needs **three** settings, not one, and they are independent:

| Setting | Question it answers | `hotelhottubs` |
|---|---|---|
| `geoMode` | Where does geography appear? | `in_keyword` |
| `audienceScope` | **Whose demand are we measuring?** | `country:US` |
| `serpLocationCode` | Where do we stand to look at the SERP? | one fixed code, `2840` |

`audienceScope` is the axis this plan was missing, and it is what makes the
grammar cover directories generally rather than covering two sites. A
wedding-venue directory is `in_keyword` + `country:US` (people fly domestically
to weddings). A peptide vendor directory is `none` + `country:US` (shipping and
regulation are national). A SaaS-alternatives directory is `none` +
`worldwide`. **Same three knobs, no new code.**

### 0.2 Both sites ship at `country:US` — decided, with the reason

The first draft of this plan proposed `worldwide` for `hotelhottubs`, on the
correct observation that a traveller can be anywhere. **That observation is
right and the conclusion was wrong**, for three reasons that only appear once
you ask what the number is *for*:

| | `worldwide` | **`country:US`** |
|---|---|---|
| Volume for a US destination | Slightly higher | Nearly all of it — Vegas is ~15% international, Gatlinburg ~0% |
| **CPC / competition index** | Blended across ad markets with unrelated economics — **not usable in §4.1** | A real number the value model can multiply |
| **`monthly_searches` seasonality** | Blends hemispheres | The actual curve for a US destination |
| Code required | `WORLDWIDE` sentinel, fallback guard, new label | **None. `2840` is the default today** |

**The value model is what settles it.** §4.1 ranks on volume × CPC-informed
commercial signal × seasonality. Two of those three are meaningless at
worldwide scope. Choosing `worldwide` buys a slightly better numerator and
ruins two other terms.

**What this costs, stated so it is not forgotten.** International share varies
sharply by destination — Vegas, NYC, Miami and Orlando carry real overseas
demand; Gatlinburg, Branson and the Dells carry none. US-only therefore
**under-ranks international destinations relative to domestic ones**, as a
consistent bias rather than noise. §5 arm G measures the size of it for $0.

**What would flip this back:** the site covering non-US destinations. A US
audience for `bali villas with private hot tub` is a real but partial slice, and
at that point `worldwide` is correct and the sentinel gets built. The axis stays
in the model precisely so that is a config change.

**None of this relaxes §0.1.** The invariant is about the *destination's* code,
not the country's. `2840` was always compliant; Las Vegas never was.

That difference cascades through the entire funnel, and it cascades in
our favour:

**Above the city level, keywords have real, free, complete volume.** The whole
population-derived demand model (`demand.ts`,
`monthlySearches = population/1000 × demandPerCapitaPer1k`) exists only because
*"there is no city-level keyword database to buy"* (`endpoints.ts:79-87`,
TRAP 3). At national or worldwide scope that constraint disappears — Google Ads
returns true volume for every one of those 1,500 strings, for **$0**, through
`keyword-volume-cache.ts`, which is already built and already batches per
location.

**And US national is already the default path**, so per §0.2 both sites reach
free volume with no provider change at all. `DFS_VOLUME_LOCATION_US = 2840` is
already defined (`keyword-volume.ts:23`), and `2840` is the United States in
Google Ads' geo-target constants too — **one number serves both providers.**

Worldwide remains available and unbuilt. `keyword-volume.ts:11`, verbatim:

> "Docs: `location_code` optional; omit → worldwide. **We always pass a code.**"

There is no way to *not* pass one — `locationCode: null` falls through to
`DFS_VOLUME_LOCATION_US` at `keyword-volume.ts:183`. That is deferred, not
needed, and §0.2 states the condition that would call for it.

**So the funnel inverts.** In local mode you must buy a SERP to learn anything,
and volume is modelled afterwards. In affiliate mode you can size and rank the
entire keyword space for **zero dollars**, and only buy SERPs for the survivors.
The expensive stage moves from first to last.

**And one hazard, stated up front because it is the repo's own first rule
turned sideways.** The README rule is *never let an unmeasured signal read as a
good one*. The mirror hazard here is **never let a local-only model read as a
verdict on a non-local keyword** — and three of them will do exactly that,
silently, on the first run. They are §1.1.

---

## 1. What already exists (do not rebuild any of this)

Most of this plan is wiring, not construction. The catalog, the queue, the
budget ledger, the SERP layout extractor and the difficulty model are all built
and all mostly geography-agnostic already.

| Piece | Where | State for this use case |
|---|---|---|
| Keyword catalog (`keyword_norm` unique, `seed_key`, `variant`) | `research_keywords`, `schema.ts:1552` | **Reusable as-is.** Already the right shape for a generated grid |
| Geo catalog with resolved DFS codes | `research_geos`, `schema.ts:1592` | **Reusable as the locality entity set** for `hotelhottubs` |
| Free volume, batched per location | `keyword-volume-cache.ts:291` `ensureKeywordVolumes` | **Reusable, and it is the whole first stage.** 30-day TTL, misses not cached. ⚠️ **Cannot express worldwide today** — §3.3 |
| Google Ads keyword ideas (free) | `providers/google-ads/keyword-ideas.ts` | Reusable. `generateKeywordIdeas`, pageSize 100 |
| Run/job queue, `FOR UPDATE SKIP LOCKED` | `discovery_runs` / `discovery_jobs`, `run-discovery.ts` | Reusable. Nothing in it is local-specific |
| Budget reservation before purchase + ledger | `discovery-budget.ts`, `budget.ts` | Reusable, and mandatory — see `plan-step0-experiment.md` §1.5 |
| Queued SERP at $0.0006 vs live $0.0020 | `serp-queued.ts`, `useQueuedSerp` flag | Reusable, and the right default here |
| SERP layout extraction (~60 metrics) | `serp-layout.ts` → `discovery_serp_metrics` | **Mostly reusable.** Ads, AI Overview, PAA, related searches, top organic domains all transfer |
| Difficulty model | `scoring/difficulty.ts` `scoreDifficulty` | **Partly reusable** — see §4.2 |
| DataForSEO client: 3-gate validation, rate-limit retry, account-issue abort | `providers/dataforseo/client.ts` | Reusable for the new Labs endpoints unchanged |
| Ranked-keyword *count* for a domain | `quality-gates.ts:60` `fetchRankedKeywordCount` | **The endpoint we need, called with `limit: 1`** — see §3.2 |
| Semrush CSV → positions for an owned site | `core/serp/keywords.ts`, `serp_keywords.semrush_position` | Manual import. §3.1/§3.2 replace it |
| **Site model that admits a non-cell property** | — | **Missing — §2** |
| **"All keywords we rank for"** | — | **Missing — §3.1, §3.2** |
| **Competitor keyword gap** | — | **Missing — §3.4** |

### 1.1 Three models that will return confident wrong answers on day one

Each of these is correct for local services and is *load-bearing* there. None
is guarded against being handed a non-local keyword, and each fails silently
rather than loudly.

**a. The EMD local-pack blocker will veto every affiliate keyword.**
`scoring/emd.ts:94-105`:

```ts
if (!input.hasLocalPack && !d.hasLocalBusinessTop10)
  // → "Google does not treat this as a local query here … a guaranteed wasted build."
```

`hotels with hot tubs in room chicago` has no local pack, by design. Every
keyword on both sites returns this blocker, and it reads as a hard negative
verdict rather than "not applicable". **Fix: EMD and acquired-domain assessment
are local-only and must be gated off by site kind, returning `NOT_APPLICABLE`,
not `BLOCKED`.** A blocked verdict and an inapplicable model are different
facts and must not share a cell.

**b. `demand.ts` will model demand that we can measure for free.**
Population × per-capita rate is a *substitute* for an unpurchasable number. At
national scope the real number is free. **Fix: `volumeSource` already exists on
`discovery_serp_metrics` — affiliate rows must never carry the modelled source,
and the screen must refuse to run if it would.**

**c. `platforms.ts` knows only home-services directories.** `PLATFORM_DOMAINS`
is Yelp/Angi/HomeAdvisor/Thumbtack/Houzz/Porch. On a hot-tub-hotel SERP the
slot holders are `booking.com`, `expedia`, `tripadvisor`, `hotels.com`; on a
peptide SERP they are `reddit`, `examine.com`, `peptidesciences`, and vendor
sites. `slotDefence` will classify all of them as beatable independent sites.
That is the single most optimistic possible error, on the component with the
heaviest weight. **Fix: platform sets become per-space, not global.**

**And a fourth, in the portfolio UI rather than the model.** `MarketRow` carries
`calls30d`, `leads30d`, `closeRate`, `realisedMonthlyMicros`. An affiliate site
takes no calls. Those cells must render **`—`, never `0`** — this is the
README's rule verbatim, and a `0` here reads as "this site is failing" when the
truth is "this site is not measured that way".

---

## 2. The model — entity × pattern, and local services is the degenerate case

### 2.1 The grammar

Three nouns. Nothing else.

| Noun | What it is | Example |
|---|---|---|
| **Entity** | One member of a named set | `chicago-il`, `bpc-157`, `peptide-sciences` |
| **Dimension** | A named set of entities, bound to a slot | `locality`, `product`, `vendor` |
| **Pattern** | A template string with slots | `hotels with hot tubs in room {locality}` |

A site's **keyword space** is a list of patterns plus the dimensions they bind,
expanded as a cartesian product and normalised through the existing
`keyword_norm`.

Three independent settings carry the §0 distinction. They are what the grammar
generalises over, and none of them is the monetisation model — a site can be
affiliate and `location_code`, or lead-gen and `in_keyword`, without new code.

```
geoMode           'in_keyword'      geography is a token in the string
                  'location_code'   geography is a request parameter
                  'none'            no geography

audienceScope     'worldwide'       omit location on the volume call
                  'country:US'      2840, or any single country code
                  'per_locality'    one volume call per locality (local mode)

serpLocationCode  a single fixed code, held constant across the whole space
```

**`serpLocationCode` is separate because there is no such thing as a worldwide
SERP.** Volume can be scope-free; a SERP is always fetched from somewhere. For
`geoMode: in_keyword` that somewhere must be **one code for the entire grid** —
if Las Vegas keywords are measured from Las Vegas and Aspen keywords from
Aspen, the difficulty numbers are not comparable to each other and the ranking
across the grid is meaningless. Fix it, record it on every row, and never
derive it from the entity.

**The invariant of §0.1 is enforceable as a pure function**, which is how this
repo prevents this class of error:

```ts
// Refuses to hand a request a location code it must not have.
requestLocationFor(space, entity)
  // geoMode 'in_keyword'    → space.serpLocationCode      (entity ignored)
  // geoMode 'none'          → space.serpLocationCode
  // geoMode 'location_code' → entity.dataforseoLocationCode
```

The entity's code is never reachable in the first two branches. Test it with
Las Vegas by name, so a future edit fails against the case that motivated it —
the same convention as `acquisition-value.test.ts`.

### 2.2 The three sites in that grammar

This is the generality test. If local services cannot be written in this
grammar, the grammar is a special case wearing a general name.

```
kenosha-wi × plumber            (local services, today)
  kind          local_lead_gen
  geoMode       location_code        ← geo IS a request parameter
  audienceScope per_locality         ← modelled; no city volume to buy
  dimensions    —                    ← the niche IS the entity
  patterns      "{niche.keywordNoun}"
                "{niche.keywordNoun} near me"
                "emergency {niche.keywordNoun}"
                "best {niche.keywordNoun}"
  space         ~6 keywords × N localities, one SERP purchase per pair

hotelhottubs.com
  kind          affiliate
  geoMode       in_keyword           ← destination is a TOKEN
  audienceScope country:US           ← §0.2; NOT the destination's code
  serpLoc       2840, fixed for the whole grid
  dimensions    locality ← research_geos (~300 rows, codes NEVER sent)
  patterns      "hotels with hot tubs in room {locality}"
                "{locality} hotels with jacuzzi in room"
                "{locality} jacuzzi suites"
                "romantic hotels with hot tub {locality}"
                "hot tub suites {locality}"
  space         ~1,500 keywords, one US-national volume pass, $0

borenhealth.com
  kind          affiliate
  geoMode       none
  audienceScope country:US           ← shipping and regulation are national
  serpLoc       2840
  dimensions    product ← peptides   (~120 entities, operator-supplied)
                vendor  ← vendors    (~40 entities, operator-supplied)
  patterns      "{product}"                  "{product} review"
                "{product} dosage"           "{product} side effects"
                "{product} before and after" "where to buy {product}"
                "{vendor} review"            "is {vendor} legit"
                "{vendor} reviews reddit"    "{vendor} coupon code"
                "{product} vs {product:2}"   ← pairwise, opt-in, capped
  space         ~880 keywords + whatever the capped pairwise arm adds
```

**Both sites land on `country:US` (§0.2), and they get there for different
reasons** — `hotelhottubs` because its destinations are domestic-traveller
markets and its CPC/seasonality terms need a single ad market, `borenhealth`
because shipping and regulation are national. **Same value, different
justification, and the justification is what changes when a third site
arrives.** So the field stays explicit with **no default** — an unset scope is a
refusal to run, not a silent 2840. Two sites agreeing is not evidence that
agreement is automatic.

### 2.2.1 The generality test

The grammar is only worth the name if directories we have not thought about
land in it without new concepts. Written out, with the setting that does the
work in bold:

| Directory | `geoMode` | `audienceScope` | Dimensions | Shows |
|---|---|---|---|---|
| Hotel amenity (`hotelhottubs`) | **`in_keyword`** | `country:US` | locality | Destination ≠ audience, same country |
| Vendor reviews (`borenhealth`) | `none` | `country:US` | product, brand | Two dimensions, one space |
| Local services *(today)* | **`location_code`** | `per_locality` | — | The existing product, unchanged |
| Wedding / event venues | `in_keyword` | `country:US` | locality, venue type | Destination *and* a bounded audience |
| SaaS alternatives | `none` | **`worldwide`** | brand | One dimension, pure brand |
| "Best X for Y" comparison | `none` | `worldwide` | product, use case | Two non-entity dimensions |
| International destinations | `in_keyword` | **`worldwide`** | locality | The §0.2 flip, as a config change |
| Things to do, seasonal | `in_keyword` | `country:US` | locality, **season** | A dimension that is not a place or a thing |

The last row is the one that proves the point: `season` is a plain entity set of
twelve rows with no geography and no product. **The grammar does not know what
an entity means**, which is why it extends without edits. Everything specific to
a vertical lives in `research_entities.attributes` and in the pattern strings —
both data, neither code.

**The pairwise slot is the one dangerous construct.** `{vendor} vs {vendor:2}`
over 40 vendors is 1,560 keywords from one line; over 120 products it is
14,280. Volume is free so the *cost* is fine, but the row count is not.
**Require it to be opt-in per pattern, cap it explicitly, and log what was
dropped** — a silently truncated product reads as "that is the whole space".

**Entities carry aliases.** `bpc-157` must match `BPC 157`, `BPC157`,
`bpc-157 peptide`. Without aliases the ranked-keyword joins in §3.1/§3.2 will
under-report what we already rank for, and under-reporting reads as an
opportunity. `aliases text[]` on the entity, matched with the boundary-safe
token rules from `plan-step0-experiment.md` §1.2 — **never bare substring**;
`wi` matching every `wiki*` domain already cost this project one wrong probe.

### 2.3 Schema

Two new tables. Entities are data and must be queryable and joinable; patterns
are configuration and are small, so they live as `jsonb` on the site — the same
split the repo already uses for `hours` and `serviceAreaZips`.

```sql
-- Named sets. 'locality' is a reserved kind that reads research_geos
-- instead of this table, so the geo corpus is never duplicated.
research_entity_sets
  id, slug UNIQUE, kind, label, notes, created_at
    -- kind: 'product' | 'brand' | 'venue_type' | 'topic' | ...

research_entities
  id, set_id FK → research_entity_sets ON DELETE CASCADE,
  slug, label, aliases text[] NOT NULL DEFAULT '{}',
  attributes jsonb,          -- per-kind extras (price band, category, ...)
  active boolean NOT NULL DEFAULT true,
  UNIQUE (set_id, slug)
```

`attributes` is where the affiliate economics live per entity — a $600 peptide
and a $40 one are not worth the same click, and §4.1 needs somewhere to put
that without a column per vertical.

**The pattern config**, `sites.keyword_space jsonb`:

```jsonc
{
  "geoMode": "in_keyword",
  "audienceScope": "country:US",  // required; no default — see §0.2, §2.2
  "serpLocationCode": 2840,       // one code for the whole grid — see §2.1
  "dimensions": { "locality": { "source": "research_geos", "filter": { "minRank": 300 } } },
  "patterns": [
    { "template": "hotels with hot tubs in room {locality}", "label": "in-room" },
    { "template": "{locality} jacuzzi suites",               "label": "suites" }
  ],
  "volumeFloor": 50               // interpreted against audienceScope, not absolutely
}
```

**`volumeFloor` is scope-relative and must be stored with its scope.** 50/mo
US-national and 50/mo in Kenosha are not the same fact. A floor compared across
two spaces with different scopes is a category error, and the number that
survives it looks perfectly reasonable.

Expansion writes into `research_keywords` unchanged — `keyword_norm` already
dedupes, `seed_key` becomes the pattern label, and `variant` stays free for the
existing `primary`/`near_me` vocabulary. **No new keyword table.**

### 2.4 What changes on `sites`

Small, but every one of these is load-bearing and each has a caller to fix.

| Change | Why | Callers to fix |
|---|---|---|
| `kind` column, `'local_lead_gen' \| 'affiliate'`, default `'local_lead_gen'` | The gate for §1.1 a/b/c | scoring entry points, portfolio render |
| `locality_id`, `niche_id` → **nullable** | `borenhealth` has neither | `listMarkets` joins → `LEFT JOIN`; `CellDetail` |
| `sites_active_cell_uq` → scoped to `kind = 'local_lead_gen'` | Two affiliate sites both `(NULL, NULL)` must not collide | `db-extras.ts` (already the home for partial indexes) |
| `keyword_space jsonb` nullable | §2.3 | new |
| Routing | `/portfolio/[localitySlug]/[nicheSlug]` cannot address a site with no cell | `cellPathForSite` (`sites.ts:713`) returns `/portfolio/site/[id]` when `kind != 'local_lead_gen'` |

`sites_domain_uq` stays. One domain, one site — that is now true rather than
accidentally true.

### 2.5 Why not a second table

`spend_ledger`, `serp_keywords`, `serp_targets`, `serp_checks` and the whole
budget path all FK to `sites.id`. A parallel `properties` table forks every one
of them, and forks the ledger — which this repo has already learned not to do
(`discovery_run_id` is `ON DELETE SET NULL` because *"a ledger must not
forget"*, after a cascade reset $51 of lifetime spend to $2.72 in the books).
**Relaxing `sites` is five columns and four callers. Forking it is a second
product.**

---

## 3. Where keywords come from

Ordered by expected yield per dollar on credentials this project already holds,
with everything tagged **measured** / **list price** / **unproven**. Nothing
below has been measured yet — that is §5.

### 3.1 Google Search Console — free, complete, and the actual answer to the question asked

**This is the finding that should change how the request is scoped.** The ask
was "run keyword research for all keywords we rank for". For a domain we own,
the honest source for that is not a keyword vendor — it is Search Console, and
it is strictly better on every axis that matters:

| | Search Console | Labs `ranked_keywords` (§3.2) |
|---|---|---|
| Coverage | **Every query that produced an impression** | Vendor's crawled index, sampled |
| Position | **Actual average position, our traffic** | Modelled from a SERP snapshot |
| Impressions / clicks / CTR | **Yes** | No — volume is a national estimate |
| Cost | **$0** | Per request, unproven — §3.2 |
| Works on competitors | **No** | **Yes — this is its only advantage** |

The two are complements with a clean split: **GSC is truth about us; Labs is
the only thing that sees them.**

**Build cost is low because the OAuth shape already exists.** Google Ads already
runs on `GOOGLE_ADS_CLIENT_ID` / `_CLIENT_SECRET` / `_REFRESH_TOKEN` with a
refresh flow in `keyword-ideas.ts:64-81`. Search Console is the same Google
OAuth dance against `searchanalytics.query`, a different scope and one new
provider module. Rows land in `serp_keywords` for the site — which **retires the
manual Semrush CSV import** (`importKeywordCsv`) rather than adding a lane
beside it.

**The one thing GSC cannot do** is show a keyword we have never had a single
impression for. That is precisely the "find new keywords" half, and it is why
§3.3 and §3.4 exist.

**Blocker to confirm before this is scheduled:** do we have verified GSC
property access for both domains? If not, this drops behind §3.2.

### 3.2 DataForSEO Labs `ranked_keywords` — the paid approximation, and the only thing that sees competitors

Already reachable. Already called. Called wrong for this purpose:

```ts
// quality-gates.ts:60-72 — an expired-domain quality gate, not a keyword pull
const body = await client.post(RANKED_KEYWORDS_ENDPOINT, [
  { target, location_code: locationCode, language_code: 'en', limit: 1 },
])
return { count: body?.[0]?.total_count ?? 0, costMicros: PRICE.labsRankedKeywords }
```

It reads `total_count` and throws the rows away. Raising `limit` and keeping
them yields, per keyword: position, search volume, CPC, competition, the ranking
URL, and the SERP features present. That is a keyword-research dataset, and the
client work is nearly nil.

> **⚠️ The price constant is unproven at scale, and it is the one number that
> can make this expensive.** `PRICE.labsRankedKeywords = 12_000n` ($0.012) is
> modelled as **flat per request** and has only ever been exercised at
> `limit: 1`. DataForSEO Labs endpoints are commonly priced **per request plus
> per returned row** — the same shape as `backlinksBulkRequest` + `…BulkRow`,
> which this repo already models correctly at `24_000n + 36n/row`. A 5,000-row
> pull against a flat assumption would ledger $0.012 and spend considerably
> more. **Measure by balance delta at `limit` 1 / 100 / 1,000 before any wide
> run** — arm A of §5.

Two more things to fix while in there:

- **The path is a bare literal in `quality-gates.ts`, not in the endpoint
  registry.** TRAP 2 (a wrong path returns `"Invalid Path."` inside HTTP 200)
  is exactly what a registry prevents. Every Labs endpoint this plan adds goes
  into `endpoints.ts`.
- `location_code` defaults to `2840` there. Correct for both new sites; state
  it rather than inherit it.

### 3.3 The entity × pattern grid, priced by free volume — **$0, and it is the first stage**

The mechanical half of "find new keywords", and per §0 it costs nothing:

1. Expand the space (§2.1). ~1,500 for `hotelhottubs`, ~880 for `borenhealth`.
2. `ensureKeywordVolumes` at the space's `audienceScope` — **free**, batched,
   cached 30 days, already built.
3. Drop everything under `volumeFloor`. Keep the drops with their measured zero
   — a keyword measured at 0 and a keyword never measured are different rows and
   the second must never be shown as the first.
4. Only survivors are eligible for a SERP purchase, all at `serpLocationCode`.

**Step 2 needs no provider change at all**, which is most of what §0.2 bought.
`country:US` is `2840`, already the default in `fetchDfsKeywordVolumes` and
already a valid Google Ads geo-target constant. The free volume stage works
today.

**Two guards are still required, and they are about correctness, not reach:**

- **`requestLocationFor` must be the only source of the code** (§2.1). The point
  is not that 2840 is hard to pass — it is that `research_geos.dataforseoLocationCode`
  is in scope at the call site and passing it compiles.
- **A non-`serpLocationCode` value on an `in_keyword` space must throw, not fall
  back.** `fetchDfsKeywordVolumes:258-296` currently rescues a bad city code by
  retrying at US and still reporting `source: 'dataforseo_google_ads'`. At
  `country:US` that path never fires — `tryCodes` is `[2840]` alone — so it is
  harmless *today* and would silently absorb the §0.1 bug the moment someone
  introduced it. **Fail loudly at the boundary instead of relying on a
  coincidence.**

**One label to get right:** `language: 'languageConstants/1000'` is hardcoded to
English (`keyword-ideas.ts:131`). At `country:US` that is very nearly the whole
market, but it is still a scope, not a total. Store `us/en` rather than `US`.

**Deferred with worldwide (§0.2):** the `WORLDWIDE` sentinel, the
`volumeGeoLabel` case, and the open question of whether Google Ads accepts an
empty `geoTargetConstants` array — noting for whoever builds it that
`fetchKeywordIdeas` *never throws*, it returns `source: 'skipped'`, so a
rejected worldwide request would degrade to zero ideas with only a console
line.

**Seasonality arrives free and matters more here than it ever did locally.**
`monthly_searches` is already returned and already mapped (`mapMonthly`,
`keyword-volume.ts:84`) and is stored on `research_keywords.monthlySeries`. A
plumber's demand is roughly flat; `aspen hot tub suites` and `las vegas hot tub
suites` peak six months apart. For a travel directory that series is a
first-class ranking term — it decides *when* a page must exist, not just
whether — and like `hasAiOverview` it is sitting in the schema unused.

**The metric that decides whether the grid is a good generator** is the same one
the local pipeline already reports for its own templates: what share of
generated strings have measurable volume. That pipeline measured **79% for
`primary` and 31% for `geo_explicit`** — and drew the right conclusion:

> "115 of 256 SERPs bought for queries with no measured demand, and the template
> could not have known, because it never asked." — `opportunity-screen.ts:383`

Here the asking is free and happens *before* the buying. **A grid arm that
returns 30% is still fine**, because the 70% cost nothing. That is the whole
advantage of `geoMode: in_keyword`.

**Seed the patterns from what already ranks, not from imagination.** §3.1/§3.2
return the strings that work today; the operator's first pattern list should be
induced from them. `plan-step0-experiment.md` §1.1 is the precedent — a
hand-written list of "business websites" turned out to be fifteen adtech
domains.

### 3.4 Competitor keyword gap — unproven, and it may fail for `hotelhottubs` specifically

The classic move: `/dataforseo_labs/google/competitors_domain/live` to find who
overlaps, then `/dataforseo_labs/google/domain_intersection/live` for what they
rank for and we do not.

**The hypothesis I expect to fail, written down before the probe so it cannot be
argued after:** `hotelhottubs.com`'s organic competitors are `booking.com`,
`expedia.com`, `tripadvisor.com` and `hotels.com`. A gap list against those is
a list of keywords we cannot rank for, dressed as opportunity — the affiliate
equivalent of the `kohler.com` false candidate. The signal is only useful
against **peers of our size**, so the arm needs a size filter (rank / referring
domains / traffic band) before the intersection, not after.

`borenhealth.com` is the opposite case and the more promising one: peptide
review sites are small, numerous, and rank on the same long tail. **If the
competitor arm passes anywhere it will pass there**, and per §5 the rule is
per-arm and per-site, not overall.

**Cost: list price, unverified.** Both endpoints are Labs and inherit the §3.2
per-row uncertainty.

### 3.5 Labs keyword ideas / related keywords — probably redundant, cheap to check

`/dataforseo_labs/google/keyword_ideas`, `…/related_keywords`,
`…/keyword_suggestions` are the `phrase_related` / `phrase_fullsearch`
equivalents. Google Ads `generateKeywordIdeas` already does this for **free**
and is already wired.

**One probe, one metric: overlap.** Run both on the same 20 seeds and report
what the paid one adds that the free one missed. The repo has done exactly this
comparison before — `probe-volume-source-compare.mts`, Google Ads vs DataForSEO
for the same volumes. **Do not build this arm unless the overlap probe shows a
real delta.**

### 3.6 SERP-derived expansion — free, and it accumulates by itself

`discovery_serp_metrics` already stores `relatedSearches` and
`hasPeopleAlsoAsk`, and `discovery_jobs.raw_items` retains the **complete page-1
payload** for every SERP ever bought — re-scored for free, never re-purchased
(`serp-winnability.ts:25-38`).

So every SERP bought in stage 4 of §3.3 donates related searches and PAA
questions back into the catalog for nothing. **Second-round expansion is free
by construction.** Worth stating because it changes the shape of the recurring
job: run 1 is a grid, run 2 onwards is a grid plus a harvest.

### 3.7 Autocomplete and marketplace search — unproven, listed and not scheduled

Google Autocomplete and (for `borenhealth`) marketplace/vendor on-site search
would enumerate long-tail product strings the grid cannot invent. Both are
scrapes with their own reliability and ToS questions.

**Listed for completeness. Do not build until §3.1–§3.4 are measured and
exhausted.**

---

## 4. Scoring: what an affiliate keyword is worth

### 4.1 Value, and the parts of it we are not allowed to model

The local model is `avgTicketMicros × leadCommissionRateBps` on the niche row —
lead value. The affiliate analogue is per-click:

```
valuePerClickMicros
  = orderValueMicros            ← operator input, per entity or per site
  × commissionRateBps           ← operator input
  × conversionRateBps           ← MEASURED from the affiliate network, or absent

opportunityValue = volume × ctrAtTargetPosition × valuePerClickMicros
```

**Two of those three inputs are operator-supplied facts, not model outputs, and
the screen must say so on the page** — the README's "say what is modelled" rule
is an on-screen banner, not a docstring. A hotel booking commission and a
peptide order commission are wildly different and neither is derivable from
anything this tool can buy.

**`conversionRateBps` is the one that must not be defaulted.** Until affiliate
network data is imported it is unmeasured, and per the first rule it must
propagate as unknown — the keyword sorts with unknowns, it does not get a
plausible-looking 2%. `orderValueMicros` belongs in `research_entities.attributes`
because it genuinely varies per peptide and per city.

`ctrAtTargetPosition` is a standard curve, and it is modelled — label it.

### 4.2 Difficulty: what transfers and what does not

`scoreDifficulty` has four components. Two transfer unchanged, two do not.

| Component | Transfers? | Why |
|---|---|---|
| `authorityWall` (CTR-weighted referring domains) | ✅ **Unchanged** | Domain authority is not a local concept. Runs on the same bulk backlinks call |
| `linkQuality` (dofollow ratio × spam inversion) | ✅ **Unchanged** | Same |
| `slotDefence` (what kind of result holds each slot) | ❌ **Needs a per-space platform set** | §1.1c. Booking/Expedia/Reddit/examine.com are invisible to `platforms.ts` and will score as beatable |
| `intentLock` (exact-match dedication) | ⚠️ **Reinterpret** | Exact-match here means a page dedicated to *this city's hot tub hotels* or *this peptide* — a URL/title match, not an EMD homepage. `exactMatchHomepagesTop5` is the wrong probe |

**The omit-and-renormalise discipline is what makes this safe to extend.** A
component we cannot compute for an affiliate SERP is omitted and the weights
renormalise; `weightCovered` already reports how much of the model actually ran.
The failure mode to avoid is zero-filling `slotDefence`, which
`difficulty.ts:60-65` already warns about in the local case:

> "rendering a missing measurement as 0 turns every unknown domain into a
> jackpot and every unscannable SERP into a recommendation."

**One genuinely new signal these SERPs need and local ones mostly do not:**
`hasAiOverview` is already extracted and stored, and on informational affiliate
queries — `{product} dosage`, `{product} side effects` — an AI Overview is a
direct click loss. It is sitting unused in `discovery_serp_metrics`. For
`borenhealth` it should be a first-class term, not a column.

### 4.3 Verdict vocabulary

The local verdicts (`verdictEmd`, `verdictAcquired`) answer "should I buy a
domain for this cell". That is not the question for a site we already own. The
affiliate question is **"should this be the next page we build, or the next page
we improve"**, so the split is by whether we already rank:

| Bucket | Rule | Action |
|---|---|---|
| **Improve** | We rank 4–20 (GSC/Labs) and volume clears the floor | Existing page, on-page + links. Cheapest wins |
| **Build** | No ranking URL, difficulty passes, value clears the floor | New page |
| **Defend** | We rank 1–3 and a competitor is closing | Monitor via `serp_checks` (already built) |
| **Ignore** | Below the volume floor, or difficulty above the band | Recorded with a reason, never silently dropped |
| **Unknown** | Volume or difficulty unmeasured | Sorts last. Never folded into Ignore |

`Unknown` as a distinct bucket is the same correction
`plan-step0-experiment.md` §1.3 made with `UNKNOWN_VALUE`, for the same reason.

---

## 5. Step 0 — the probe, with decision rules written before it runs

The grid arm is free and will be built regardless. **Everything paid is
unproven**, including the price of the endpoint at the centre of the request.
So this follows the `experiment-step0.mts` pattern exactly: hard budget cap in
code, every request ledgered with `note = experiment=affiliate-kw`, a disk
measurement cache so a wall-clock kill cannot burn the spend twice — the
mistake that cost arm D $0.6345 for nothing last time.

### The arms

| # | Arm | Endpoint / source | Cost | Question |
|---|---|---|---|---|
| **A** | Own rankings, paid | Labs `ranked_keywords`, `limit` 1 / 100 / 1000 | **Unproven — this is the measurement** | Does cost scale with rows? What does it return for our two domains? |
| **B** | Competitor discovery | Labs `competitors_domain` | List price | Are our competitors peers, or Booking.com? |
| **C** | Keyword gap | Labs `domain_intersection` vs top peers from B | List price | Net-new qualifying keywords per dollar |
| **D** | Entity × pattern grid | Expansion + Google Ads volume | **$0** | What share of generated strings have volume ≥ floor? |
| **E** | Paid vs free ideas | Labs `keyword_ideas` vs Google Ads, same 20 seeds | List price | What does the paid one add? |
| **F** | Own rankings, free | Search Console | **$0** | Coverage vs arm A on the same domain |
| **G** | **What the `country:US` choice costs** | Same 20 keywords at US 2840, worldwide, and the destination's own code | **$0** | Sizes both the §0.2 trade and the §0.1 error |

**Arm F is the control that prices every other arm.** If GSC returns
substantially everything arm A returns for our own domains, then arm A's only
justified use is competitors, and its budget shrinks accordingly. Run F first if
access exists.

**Arm G is free and should run first of all.** §0.2 chose `country:US` on an
argument, not a measurement, and §0.1 asserts an error whose size nobody has
seen. Twenty `hotelhottubs` keywords — deliberately spanning a high-international
destination (Las Vegas), a domestic-only one (Gatlinburg) and a mid case — run
three ways:

| Column | Answers |
|---|---|
| **US 2840** | The number we will actually ship |
| **Worldwide** | What §0.2 gave up — **and whether the gap varies by destination**, which is the only part that changes rankings |
| **Destination's own code** | **What §0.1 costs.** The number the tool would report if the invariant were violated |

Note it is no longer blocking: `country:US` works today, so nothing waits on
this. It runs first because it is free and because both of the numbers it
produces are load-bearing arguments currently held on reasoning alone.

**The worldwide column doubles as the sentinel probe.** If omitting
`location_code` returns figures identical to US, it did not work — and that is
worth knowing now, cheaply, rather than when a non-US destination site makes it
urgent.

**Publish the destination-city ratio wherever the invariant is documented.**
"We would have under-counted Las Vegas by N×" is an argument that survives a
refactor; "do not pass the code" is a preference that does not.

**Scope:** both live domains. `borenhealth` gets a 40-product × 20-vendor grid,
`hotelhottubs` gets the top 100 `research_geos` localities × 5 patterns. Enough
for a rate; nowhere near enough for a tight interval, which the rules account
for.

### Cost

| Item | Cost |
|---|---|
| Arm A — 6 calls across two domains × three limits | Unproven; **hard-capped at $1.00** |
| Arms B, C, E | ~$0.50 at list price, capped |
| Arms D, F, G | **$0** |
| **Total** | **hard cap $2.00, enforced in code** |

If arm A turns out to be per-row, the cap stops the run rather than discovering
it on the invoice. **That is the entire reason for the cap and it is the most
likely thing to fire.**

### Decision rules, written before the run

The comparable metric across paid arms is **net-new qualifying keywords per
dollar**, where *qualifying* = volume ≥ floor **and** no existing top-10 ranking
**and** passes a hand relevance check on a 20-row sample.

| Outcome | Rule | Decision |
|---|---|---|
| **Paid discovery earns its place** | ≥ 200 qualifying keywords/$ on any paid arm | Build that arm into the run |
| **Free-only** | Paid arms < 200/$, and arm D yields ≥ 300 qualifying keywords per site | Ship the grid + GSC. Skip the paid arms entirely |
| **Neither** | Both fail | Stop. The space is too small for a tool — say so |

**Per-arm and per-site, not overall.** The pre-registered expectation is that
arm C passes for `borenhealth` and fails for `hotelhottubs` (§3.4). If that
happens, the gap feature ships gated by site, and the reason is recorded.

**Arm G re-opens a settled decision rather than gating a build**, and its rule
is written now so §0.2 cannot be defended after the fact:

> **If the worldwide/US ratio varies by more than 2× between the highest and
> lowest destination in the sample, `country:US` is systematically reordering
> the grid and §0.2 must be revisited.** A uniform gap of any size is fine — it
> divides out of the ranking. A *varying* gap does not.

That is the honest form of the trade. §0.2 argues the ranking is preserved
because most destinations are domestic; arm G is what makes that a measurement
instead of a plausible sentence.

**Arm A has a separate, non-negotiable rule.** If measured cost is per-row, the
`PRICE.labsRankedKeywords` constant is **wrong today** and must be corrected
before anything ships, because `quality-gates.ts` is currently under-ledgering
every expired-domain run that touches it. That is a bug found by this probe
regardless of what the probe decides.

**Honest statistics.** These are two sites, not a sample of sites. Every rate
here describes `hotelhottubs` and `borenhealth` specifically and generalises to
a third affiliate site only as a guess. Say that in the results section rather
than letting a number imply otherwise.

---

## 6. Order of work

| # | Item | Cost | Why here |
|---|---|---|---|
| **0a** | **Run §5 arm G** — US vs worldwide vs destination-city, 20 keywords | **$0** | Free. Tests §0.2's ranking claim and sizes the §0.1 error. Nothing waits on it |
| **0b** | **Confirm GSC access on both domains** | $0 | Re-prices arms A/F and half of §3. One login |
| **1** | `sites.kind` + nullable cell FKs + partial-index rescope + routing (§2.4) | $0 | Nothing else can be created until a non-cell site is representable |
| **2** | **Gate §1.1 a/b/c on `kind`** — EMD/acquired → `NOT_APPLICABLE`, modelled demand refused, per-space platform sets | $0 | **Before any run, not after.** These fail silently and optimistically |
| **3** | **`requestLocationFor` + fail-loud on a stray code** (§0.1, §3.3). Las Vegas test. **No provider change — `2840` already works** | $0 | The invariant. Every number below is wrong if this is wrong |
| **4** | `research_entity_sets` / `research_entities` + expansion into `research_keywords` (§2.3) | $0 | Arm D needs it; it is also the deliverable |
| **5** | Free volume pass + `Improve/Build/Defend/Ignore/Unknown` buckets (§3.3, §4.3) | **$0** | The complete free product. Ships without a single purchase |
| **6** | **Run the paid §5 arms (A–E)** | ≤ $2.00 capped | Decides items 8–9 |
| **7** | Search Console provider → `serp_keywords`; retire the CSV import (§3.1) | $0 | Free, complete, and it is the literal ask |
| **8** | Labs endpoints into `endpoints.ts` + `ranked_keywords` full pull; **fix the price constant** | per arm A | The competitor-visible half. Registry first — TRAP 2 |
| **9** | Competitor gap (§3.4), **gated by site if arm C splits as predicted** | per arm C | Only if it passes |
| **10** | Affiliate value model + on-screen "what is modelled" banner (§4.1) | $0 | Ranking is wrong without it, but the buckets are useful before it |
| **11** | Portfolio row renders `—` not `0` for call/lead columns (§1.1d) | $0 | Small, and it is the README's first rule |
| **12** | Seasonality (`monthlySeries`) + AI Overview as first-class terms (§3.3, §4.2) | $0 | Both already stored and unused. Seasonality is load-bearing for travel |
| **13** | Related-search / PAA harvest into the catalog (§3.6) | $0 | Free second-round expansion once SERPs exist |
| **—** | Labs keyword ideas (§3.5) | — | **Only if arm E shows a delta over free** |
| **—** | Autocomplete / marketplace scrape (§3.7) | — | **Not scheduled** |

**Items 0a–5 are free and are most of the value.** A site that can exist, an
invariant that cannot be violated, a keyword space that expands, real measured
volume on every string, and a bucketed list of what to build next — with zero
spend and zero paid endpoints. Item 6 decides whether anything paid is worth
adding at all.

**Item 3 must not slip past item 5**, and §0.2 makes it *more* important rather
than less. Choosing `country:US` means the correct code and the dangerous code
are both plain integers sitting in the same row of `research_geos`, and the
existing US fallback would absorb the mistake without reporting it. One pure
function and one thrown error is the difference between measuring travellers
and measuring Las Vegas residents.

**Item 2 must not slip past item 5 either.** The first affiliate run with the
local models ungated produces a screen full of confident, wrong, *optimistic*
verdicts — every keyword EMD-blocked, every competitor scored as beatable. This
repo has already spent four rounds of hand spot-checking on 27 wrong
`PARKED_DEAD` rows found by an operator and none by a test. Do not repeat it in
a new vertical.

---

## 7. What this cannot do

- **It cannot tell you what an affiliate click is worth.** Order value,
  commission rate and conversion are operator inputs or network imports. Every
  ranking derived from them inherits their accuracy, and an unmeasured
  conversion rate must stay unmeasured rather than become 2%.
- **Labs `ranked_keywords` is a vendor index, not our traffic.** Where GSC and
  Labs disagree about our own domain, GSC is right. Do not average them.
- **Competitor gap against giants is a list of things we cannot rank for.**
  §3.4 expects this for `hotelhottubs`; a size filter reduces it and does not
  remove it.
- **A grid cannot invent the keyword nobody templated.** The space is exactly as
  good as the entity list and the pattern list. §3.1/§3.2 induce patterns from
  what already ranks precisely because hand-written lists have been wrong here
  before.
- **`country:US` cannot see the overseas traveller, and that is a choice, not an
  oversight.** §0.2 traded international demand for usable CPC and seasonality.
  Vegas, NYC, Miami and Orlando are undercounted; Gatlinburg and the Dells are
  not. Arm G measures whether that reorders anything. **Until it has run, the
  claim that it does not is reasoning, not evidence.**
- **US-in-English, not US.** `language: languageConstants/1000` is hardcoded
  (`keyword-ideas.ts:131`), so Spanish-language US demand for the same
  destination is invisible. The label reads `us/en` for that reason.
- **Volume scope and SERP scope are different facts and only one of them is a
  choice.** There is no worldwide SERP, so difficulty is always measured from a
  single `serpLocationCode`. Even if worldwide volume were adopted later, the
  competition half stays national. **Global demand can be bought; global
  competition cannot be measured.**
- **One number per keyword, no origin breakdown.** Fine for ranking — a London
  booking and a Denver booking pay the same commission — and useless for
  anything that needs the searcher's market (currency, language, paid
  amplification).
- **And volume alone never proves a query is enterable.** One free number says
  nothing about whether the page is a hotel-booking carousel. Only the SERP
  answers that, which is why survivors still get bought.
- **~300 near-identical city pages is a thin-content and doorway-page pattern.**
  This tool ranks the opportunity; it does not judge whether the page deserves
  to exist. That constraint is real for `hotelhottubs` and belongs on the screen
  as a caution, not buried here.
- **`borenhealth` is YMYL.** Peptide dosage and side-effect queries sit in the
  category Google evaluates most harshly. Keyword difficulty as modelled here
  does not capture that, and a low-difficulty score on
  `{product} side effects` is not the invitation it looks like.
- **Two sites are not a sample.** Every rate §5 produces describes these two
  domains. The third affiliate site gets its own probe, or an explicit
  admission that its numbers were assumed.

---

## 8. Results — 2026-08-13

Built and run end to end. **$0.1764 of live spend.**

| Probe | Script | Verdict |
|---|---|---|
| Arm G — the §0.1 invariant | `probe-audience-scope.mts` | ✅ **Confirmed — 11.6× median undercount** |
| Arm G — the §0.2 trade | same | ⚠️ **Did not run.** The arm measured US twice |
| Arm A — Labs per-row billing | `probe-labs-pricing.mts` | ❌ **The flat price was wrong.** Per-row confirmed |

### 8.1 §0.1 is worth more than it claimed

Twenty `hotelhottubs` keywords, three ways, on free Google Ads volume:

| Keyword | US 2840 | at the destination's own code |
|---|---:|---:|
| `hotels with hot tubs in room las vegas` | **1,900** | 10 |
| `las vegas hotels with jacuzzi in room` | **1,900** | 10 |
| `las vegas jacuzzi suites` | 720 | 10 |
| `hotels with hot tubs in room miami` | 590 | 50 |

**Median 8.6% of the US figure — an 11.6× undercount, and 173× on the worst
row.** Buying `las vegas hotels with jacuzzi in room` at the Las Vegas location
code reports 10 searches a month for a keyword with 1,900, because it measures
Las Vegas *residents*. The invariant was written from an argument; it is now
measured, and it is larger than the argument assumed.

### 8.2 The §0.2 arm measured US twice, and the identity check caught it

The first run reported `worldwide/us = 1.00x` on every destination and concluded
"the gap is near-uniform, §0.2 stands". **That conclusion came from comparing a
column to itself.**

`normalizeGeoIds` (`google-ads/keyword-volume.ts:142-152`) converts an empty geo
list to `[2840]` *before the request is built*. Passing `[]` never reached Google
with no geo target. It is a silent coercion in our own code — the same class of
bug §0.1 exists to prevent, one layer down.

> **§0.2's ranking claim is still an argument, not a measurement**, and it cannot
> be tested without the provider change §0.2 deferred. The probe now detects
> byte-identical columns and says so instead of reporting a false 1.00×.

**This is also why `worldwide` throws rather than downgrading.** `runVolumePass`
refuses an unimplemented scope outright; the failure it is guarding against is
exactly the one that already happened here.

### 8.3 Arm A — the price constant was wrong, and by 51×

`PRICE.labsRankedKeywords = 12_000n` was measured at `limit: 1` and modelled as
flat. Balance delta against `booking.com`, three points:

| limit | rows | Δ balance |
|---:|---:|---:|
| 1 | 1 | $0.012120 |
| 10 | 10 | $0.013200 |
| 100 | 100 | $0.024000 |

**A perfect linear fit: $0.012 per request + $0.00012 per row.** So a 5,000-row
keyword pull costs **$0.612, not $0.012.** Independently confirmed on the first
real feature call — 50 keywords for `borenhealth.com` billed $0.0180, exactly
`0.012 + 50 × 0.00012`.

The same shape as `backlinksBulkRequest` + `backlinksBulkRow`, which this repo
already models correctly two constants away. `PRICE.labsRankedKeywordsRow` is
now `120n`, `costMicros('labsRankedKeywords', rows)` applies both terms, and
`quality-gates.ts` no longer under-ledgers. **This bug existed independently of
this feature** — it was found because the plan pre-registered the question.

### 8.4 What running it changed in the design

Three things only showed up against real data.

**Silence is the measurement, and it is not GSC-specific.** Stamping
`position_measured_at` only on rows a source RETURNED left all 350 generated
keywords UNKNOWN after a clean pull — a screen of em dashes that reads as a
broken feature. A source that returned its *complete* set has told us about every
keyword it omitted. Generalised to any untruncated result, with `position_source`
recording which source concluded it, because Search Console silence and an
exhausted vendor index are not equally strong evidence.

**`NULLS LAST` had to be explicit.** Postgres defaults `DESC` to `NULLS FIRST`,
which floated every unmeasured row above every measured one.

**A diagnostic read stale state.** The "waiting on the same signal" note tallied
`verdict_missing` from rows selected *before* the pass wrote — so it advised
re-running the command that had just succeeded.

### 8.5 Measured on the real sites

| | `hotelhottubs.com` | `borenhealth.com` |
|---|---:|---:|
| Keywords generated | **975** (195 markets × 5 patterns) | **350** (20 products, 10 vendors, 11 patterns) |
| Volume measured, free | 0 — **Google Ads daily quota exhausted** | 83 |
| Keywords we rank for | not pulled | **50** (Labs; GSC unconfigured) |
| SERPs bought | 0 | 5 |
| Spend | **$0** | $0.1271 |

`borenhealth.com` ranks for **50 keywords in total** — and the grid's
highest-demand targets are not among them. The five keywords that reached a
verdict:

| Verdict | Volume | KD | Keyword |
|---|---:|---:|---|
| **BUILD** | 1,000,000 | 55 | `tirzepatide` |
| **BUILD** | 368,000 | 48 | `semaglutide` |
| **BUILD** | 165,000 | **39** | `nad+` |
| **BUILD** | 165,000 | 44 | `sermorelin` |
| **BUILD** | 110,000 | 44 | `tirzepatide side effects` |

**`nad+` at 165,000/mo and difficulty 39 is the shape this feature exists to
find**, and it arrived through the full chain: generated from a pattern,
measured free, confirmed absent from a complete rankings pull, then scored on
one $0.002 SERP with the `health_supplement` platform overlay applied.

**The quota exhaustion on `hotelhottubs` is reported as 975 UNMEASURED, never as
zero demand.** That is the repo's first rule doing its job on the first real run.

### 8.7 The order is the economics

The 975-keyword `hotelhottubs` grid would cost **$1.95** to measure difficulty on
directly. Free volume filtering is what makes that unnecessary, and the
difficulty pass refuses to run on a keyword whose volume is unmeasured — not
because it is expensive, but because buying a SERP for an unknown-demand keyword
answers the second question before the first.

| Stage | Cost | On what |
|---|---|---|
| Expand | $0 | Everything |
| Volume | **$0** | Everything |
| Rankings | $0 with GSC · $0.012 + $0.00012/row via Labs | Everything |
| **Difficulty** | **$0.002/keyword + one bulk backlinks pass** | **Volume survivors only** |

### 8.6 Still blocked

| Blocker | Effect | Fix |
|---|---|---|
| **No Search Console access** | The free, complete, better rankings source is unreachable. Labs is a paid approximation standing in for it | Plan item 0b: `GSC_REFRESH_TOKEN`, scope `webmasters.readonly` |
| **Google Ads daily quota** | `hotelhottubs` has 975 keywords and 0 measurements | Re-run `volume --live`; it is free and cached 30 days |
| **Affiliate economics unset** | No keyword carries a value estimate; the board ranks on demand and difficulty only | Operator inputs + an affiliate-network import for conversion |
| **Only 5 SERPs bought** | 20 more `borenhealth` keywords qualify and are unscored; `hotelhottubs` has none until its volume lands | `difficulty --live --max=N`, capped and priced each run |
| **Portfolio UI untouched** | Item 11 (call/lead columns rendering `—` not `0` for affiliate rows) is not built — the board is CLI-only | `apps/web` work, not started |

**None of these is a silent failure.** Each one names itself on the screen with
the command that fixes it, which was the point of §1.1.
