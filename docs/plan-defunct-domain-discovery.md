# Plan: expired-domain search from the Research page

| Field | Value |
|---|---|
| **Date** | 2026-08-13 |
| **Status** | ⛔ **Step 0 run 2026-08-13 — BUY rate 0.5% at n=385. Do not build the buy list.** See [`plan-step0-experiment.md`](./plan-step0-experiment.md) §6. Probe detail in §1.5 below. |
| **Goal** | A second thing the Research page can buy: for the selected niches × markets, find domains of businesses that **died or were acquired** and are obtainable now |
| **Depends on** | `plan-domain-search-coverage.md` (Phase 1 is now built), `domain-search-backlog.md` |

---

## 0. The reframing this plan turns on

The domain search enumerates businesses from **Google Maps** and from **SERPs
the sweep already bought**. Both are *present-tense* sources: they list what is
visible right now. It then asks each domain "are you dead?"

The target population is **businesses that are no longer visible**. A plumber
who closed in 2019 is not in the map pack, does not rank, and appears in no
SERP we will ever buy. The current discovery method is structurally biased
against exactly the population this feature is for.

> **Everything the pipeline finds today is a business that is dying, not one
> that is dead.** `EXPIRING_SOON` and `PARKED_DEAD` are live-listing domains
> caught mid-decay. That is a real and useful output — it is just not the
> question the operator asked.

Finding the dead requires sources that **outlive the business**: archives, link
graphs, registries, and the drop pipeline. Sections 3–8 are those sources,
ranked. Section 2 is the UI that launches them.

One consequence to state up front, because it reorders the whole priority list:

**Acquired ≠ available.** A business absorbed by a roll-up keeps its domain
registered, 301'd to the acquirer. It is never purchasable at a registrar, and
it is often the *best* asset in the market — real age, real links, real
rankings, owned by someone who does not want it. The output for that population
is an **outreach list**, not a buy list. The pipeline already collects the field
that detects it (`redirected_to`) and does nothing with it — see §3.1.

---

## 1. What already exists (do not rebuild any of this)

A complete triage pipeline is built and working. The gap is discovery and
entry point, not classification.

| Piece | Where | State |
|---|---|---|
| Run + candidate tables | `domain_enrich_runs`, `domain_candidates` | Built |
| Stage 1a live map pack | `collect-businesses.ts` | Built, `depth: 200` |
| Stage 1b stored SERP harvest | `collect-from-serps.ts` | Built (coverage plan Phase 1) |
| Stages 2–5 triage | `enrich-pipeline.ts` | Built, cost-ordered |
| 9-status classifier | `core/domains/classify.ts` | Built, incl. `ACQUIRED_301` |
| Paid gates (spam, rankings, authority, JS render) | `quality-gates.ts`, `authority-links.ts`, `js-render.ts` | Built, opt-in |
| Long-running executor | `trigger/domain-enrich.ts` | Built, `maxDuration` 60 min |
| Entry points | `/scout/domains`, `/portfolio/[locality]/[niche]` | Built |
| **Entry point on `/scout` (Research)** | — | **Missing — this plan** |

Two things the coverage plan called for are still open and are cheap:

- **`depth: 700` on the map pack.** DataForSEO bills per *request*, not per
  result. The form sends 200. Raising it to 700 costs the same $0.002.
- **Spam is a column, not a gate.** `runQualityGates` fetches `spamScore` and
  stores it; nothing filters or sorts on it. The coverage plan measured 6 of
  the top 10 candidates at spam 37–49.

---

## 1.5 What the probes measured *(2026-08-13, $1.29 of live spend)*

Four probes were run before any of this was built. **Two hypotheses in the
first draft of this plan were wrong**, and the ranking below is the corrected
one. Scripts are committed so the numbers can be reproduced, not just trusted.

| Probe | Script | Verdict |
|---|---|---|
| P0 roll-up clustering | `probe-rollups.mts` | ⚠️ **Thin** — real but tiny |
| P1 WHOIS database | `probe-whois-db.mts` | ✅ **Confirmed** — best source found |
| P2 citation hubs | `probe-citation-hub.mts` | ❌ **Falsified** — wrong link direction |
| P3 Wayback directories | `probe-wayback-yp.mts`, `probe-wayback-triage.mts` | ✅ **Confirmed** — 50% non-live |
| P4 Are they worth buying? | `probe-recovered-value.mts` | ❌ **Mostly no** — 1 of 4 had equity, spam 46 |

### The number that justifies the whole feature

Ten domains recovered from **2011–2013 YellowPages archives**, run through the
existing free triage:

| | Archive-recovered | Present-tense pipeline |
|---|---|---|
| Sample | 10 | 1,371 |
| `LIVE` | 4 (40%) | 1,157 (**84%**) |
| **Not a live business** | **5 (50%)** | 214 (16%) |
| Outright `AVAILABLE` | **4** | 34 (2.5%) |

`citysewercleanersservices.com`, `buildingwatersplumbers.com`,
`mohrhusen.com` and `villageplumber.biz` came back **AVAILABLE** — registerable
today, and unreachable by any present-tense source. `superplumberusa.com` is
`EXPIRING_SOON` (71 days).

**This is the §0 thesis, measured.** A decade-old directory snapshot has a
~3× better hit rate than everything the pipeline does today.

### P4 — but almost none of them are worth buying

**Discovery ≠ value, and this is the measurement that nearly kills the buy-list
framing.** Archive depth (free) and surviving link profile ($0.0731, one bulk
request) for the same ten domains:

| Domain | Status | Archive | Refdom | Spam | Verdict |
|---|---|---:|---:|---:|---|
| `mohrhusen.com` | AVAILABLE | **14y** | **34** | **46** | Equity — and a spam liability |
| `citysewercleanersservices.com` | AVAILABLE | 4y | **0** | — | Links did not survive |
| `villageplumber.biz` | AVAILABLE | 4y | **0** | — | Links did not survive |
| `buildingwatersplumbers.com` | AVAILABLE | 1y | 2 | 10 | Effectively a fresh registration |
| `drainsruswi.com` | UNKNOWN | 8y | **78** | **15** | **Best asset in the set — not available** |
| `superplumberusa.com` | EXPIRING_SOON | 1y | 51 | 43 | Expiring, spammy |
| `daveburns.com` | LIVE | 10y | 295 | 9 | Live business |
| `southportheating.com` | LIVE | 20y | 221 | 7 | Live business |
| `masterserviceslg.com` | LIVE | 16y | 150 | 13 | Live business |
| `billingsleyeng.com` | LIVE | 8y | 39 | 46 | Live business |

**One of four AVAILABLE domains had surviving equity, and it carries spam 46 —
inside the 37–49 band the coverage plan already called liabilities. Zero of ten
are a clean buy.**

This is the coverage plan's §6 prediction, confirmed rather than refuted:

> "Valuable drops never reach retail… If a domain reached `AVAILABLE`, that is
> evidence against its value, not for it." · "Google resets dropped domains."

**The finding that reorders the output.** The best asset recovered is
`drainsruswi.com` — 8 years of content, 78 referring domains, **spam 15**, and
it is `UNKNOWN`, not available. The same pattern holds across the set: link
equity lives with domains that are *still owned*. The archive route's real
product is an **outreach list**, and the buy list is a thin by-product.

**Implication for §4:** the three-list split is not a presentation nicety, it is
the difference between a useful feature and one that recommends spam-46
registrations. Build it before, not after, any wide run.

### P1 — the WHOIS database is real, and it is a database

`/domain_analytics/whois/overview/live`, on credentials already configured:

- **251,821,316 domains** indexed.
- `domain like '%plumb%'` → **202,912**. `'%kenosha%'` → **2,445**. Accepted.
- `expiration_datetime <` → accepted. **3,304,331** already past expiry.
- `epp_status_codes has 'redemption_period'` → **188,983** domains in the drop
  window right now. `pending_delete` appears too.
- **Compound `and` filters + `order_by` accepted.** `%plumb%` + expiring +
  `referring_domains > 5` → **30,830** rows.
- Every row carries `backlinks_info` (referring domains, subnets, dofollow) and
  `metrics.organic` (full rank distribution + ETV).
- **Cost: $0.1269 per request**, balance delta over 6 requests. Flat — the
  filters are free.

**Two traps, both measured:**

1. **`expiration_datetime` is a stale snapshot, not a live fact.** The
   expired-before-today filter returned `freepik.com`, `ameblo.jp`,
   `corriere.it` and `thebump.com` — all obviously alive. **It is a discovery
   signal that still requires RDAP verification.** It does not replace triage.
2. **A wrong filter *value* returns zero rows with a 20000 success code.**
   `epp_status_codes has 'redemptionPeriod'` (RDAP camelCase) returned an empty
   set and a null `total_count`; the stored values are snake_case. An
   unrecognised value is not an error here — it reads exactly like "no such
   domains exist", which is this repo's core failure mode. The probe now flags
   that shape explicitly.

**`metrics.organic` is the same signal the rankings gate buys at $0.012/domain
from Labs `ranked_keywords`** — included free in a request that already costs
$0.127. On a 15-domain gate that is $0.18 replaced by $0.

### P2 — falsified, and the reason is instructive

`/backlinks/referring_domains/live` on two hubs:

| Hub | Referring domains | Acquirable | Locality-token | Local *businesses* |
|---|---|---|---|---|
| `kenoshanews.com` | 6,825 | 935 | 48 (5.1%) | **0** |
| `kenoshaareachamber.com` | 490 | 428 | 49 (11.4%) | **0** |

Neither returned a single local service business. The yield was SEO spam
(`seo-anomaly-top-34.xyz`, `kilo-wiki.win`, `m98ufa.com`), platform hosts
(`pages.dev`, `azurewebsites.net`) and unrelated national sites.

**The hypothesis confused two link directions.** §3.2 wanted pages that link
**out to** local businesses; `referring_domains` returns domains linking **in
to** the hub. Local businesses rarely link to a newspaper — the newspaper links
to them. Getting outbound links needs the hub's HTML, which means the task-based
On-Page flow, not this endpoint.

**Also corrected: the price is not flat.** The backlog records $0.025/target for
this endpoint; measured here it scales with rows — **$0.0416 for 490 rows,
~$0.08 for 1,000**.

**And a bug in the probe's own method:** the locality token `wi` matched every
`wiki*` domain, inflating the "locality" count with a wiki-spam network. Token
matching needs word boundaries. The percentages above are therefore
*over*-stated, which makes the falsification stronger, not weaker.

### P0 — roll-ups are real but not yet worth a feature

Across 1,371 candidates: only **44 carry a redirect**, 31 distinct targets, and
after excluding marketplaces just **2 clusters, both of size 2**.

- `technicalaffiliate.com` ← `allelectricandairconditioning.com`, `mytxhvac.com`
  — a genuine roll-up, exactly the predicted shape.
- `usmapinformation.com` ← `usmapid.org`, `usmapol.org` — thin sites, not local.

The mechanism works; the population is too small to build a tab for. **Revisit
once more markets are triaged.** The first run of this probe also reported
`hugedomains.com` as a 2-member "roll-up" — `classify.ts` already treats
marketplace redirects as *for sale*, and grouping by target re-introduced the
same error one level up. The probe now excludes `DOMAIN_MARKETPLACES`.

**Incidental finding:** `aaatotal.com` appears twice in `domain_candidates`
with different `age_years` — the same domain triaged in two runs. Direct
evidence for the `domain_triage_cache` in §2.4.

---

## 2. Part A — the second option on the Research page

### 2.1 Why it belongs here

`OpportunityFunnel` already holds exactly the two inputs a domain run needs:
`nicheIds` (match-set keywords) and `geoIds` (markets carrying
`dataforseoLocationCode`). The operator has already made the selection. Today
the only thing they can do with it is buy SERPs; to run a domain search on the
same markets they must leave, go to `/scout/domains`, and re-pick one market at
a time.

### 2.2 Shape: one selection, two things to buy

Keep the `1 · Select` → `2 · Runs` flow. Add a **run-type choice** in the
composer, so the selection is made once and the run type is chosen at the
moment of purchase.

```
Sweep 10 niches across 20 markets
200 SERPs · about $0.40

  [ Review keywords → ]   [ Find expired domains → ]
```

Both land on `2 · Runs` as a priced draft. The domain draft shows domain
counts and stage costs instead of a keyword list.

### 2.3 Two sub-modes, and the free one is the default

`executeEnrichRun` currently always calls `collectBusinesses` (a live Maps
request). For a 10 × 20 selection that is 200 requests — $0.40 before triage.
But Stage 1b already harvests every domain the sweep stored for a market, for
nothing.

| Mode | Stage 1a (Maps) | Cost | Requires |
|---|---|---|---|
| **Harvest** *(default)* | skipped | **$0.00** | a prior sweep in those markets |
| **Enumerate** | live, `depth: 700` | $0.002 × niches × markets | — |

This needs a `skipLiveMaps` flag on `domain_enrich_runs` and a branch in
`executeEnrichRun`. It is the single highest-value change in Part A: it makes
the feature free by default, which is what lets an operator run it across
twenty markets without thinking about it.

**When Harvest returns nothing**, say why — "no sweep has run in these markets,
so there is no stored SERP data to harvest" — and offer Enumerate. An empty
result that reads as "no dead domains here" is the failure mode this repo's
first rule exists to prevent.

### 2.4 Fan-out, dedupe and wall clock

A 10 × 20 selection is 200 (niche, market) pairs. Three constraints:

- **One run per market, not per pair.** `collectFromStoredSerps` is scoped by
  `locationCode` with `nicheId` optional; passing `null` harvests the whole
  market. So Harvest mode is **M runs, not N×M** — 20, not 200. Enumerate mode
  genuinely needs N×M Maps calls, so cap it and price it loudly.
- **Triage dominates wall clock.** ~15s per domain, concurrency 10, 500+
  domains per wide market — the coverage plan measured ~16 min for 500. Twenty
  markets serially will exceed the 60-minute `maxDuration`. Dispatch **one
  Trigger task per market** so they run in parallel and each stays well inside
  its budget.
- **The same domain will appear in many runs.** `domain_candidates` is unique
  on `(run_id, domain)`, so a domain in five markets is triaged five times.
  DNS/HTTP/RDAP/Wayback answers are stable for days. **Add a
  `domain_triage_cache` keyed by domain with a `checked_at` TTL** (7 days is
  defensible) and read through it. On a multi-market run this is most of the
  wall clock, and it costs nothing but a table.

### 2.5 Cap and confirm

Reuse the sweep's existing guard shape: an estimate in the composer, and an
acknowledgement checkbox above a threshold. Enumerate mode over 50 pairs
should require the same explicit ack the sweep requires over 50 jobs.

---

## 3. Part B — every way to find these domains

Ordered by **expected yield per unit of work on credentials this project
already holds**. Each entry states what is measured, what is a list price, and
what is unproven.

> **This ordering was written before the probes and is left in place with
> verdicts attached, so the two hypotheses that failed stay visible.** The
> corrected build order is §5. Short version: **§3.4 and §3.3 are the feature**;
> §3.2 is dead as designed; §3.1 is real but too thin to build yet.

### 3.1 Redirect-target clustering — *free, uses data already collected* ⚠️ THIN

**The acquisition detector, and it is already sitting in the database.**

`domain_candidates.redirected_to` is populated by `httpTriage` on every run.
`ACQUIRED_301` is assigned per-domain. Nothing ever **groups by the target**.

If six local plumbers in one metro all 301 to `apexservicepartners.com`, that
is a private-equity roll-up, and each of those six domains is an acquirable
asset with real history held by **one seller who does not want them**. Roll-ups
in HVAC, plumbing, electrical and pest control are the dominant M&A pattern in
these niches right now, which makes this a large population, not an edge case.

**Do:** a `GROUP BY redirected_to HAVING count(*) > 1` view across all runs,
surfaced as a "Roll-ups" tab. Sort by member count × mean age.

**Cost:** zero. It is a query against rows that already exist.

**Output class:** outreach list. Say so on the screen — none of these is
buyable at a registrar, and a UI that mixes them with `AVAILABLE` rows will get
someone to try.

### 3.2 Local citation hubs, reversed — ❌ FALSIFIED AS DESIGNED

> **Measured 2026-08-13 on two hubs: zero local businesses returned.** The
> section below is kept because its *premise* survives — local pages do outlive
> the businesses they link to — but the endpoint it proposed answers the
> opposite question. See §1.5 (P2) for the numbers and the corrected reading.
>
> **What would actually test the premise:** the hub's own **outbound** links,
> which requires the task-based On-Page flow (`task_post` → `/on_page/raw_html`),
> not `referring_domains`. That is the same flow §3.3 needs, so it is worth
> building once and pointing at both.

**The insight:** a local business is linked from local things — the chamber of
commerce, the local paper, the city's licensed-contractor page, a little league
sponsor page. Those pages **outlive the business**. The link stays after the
company dies.

So: take one local hub domain, ask the backlinks index **who links to it**, and
you get a list heavily weighted to local businesses — including dead ones, which
no present-tense source can reach.

**Endpoint:** `/backlinks/referring_domains/live`, **measured at $0.025 per
target** (this repo's own balance-delta measurement, recorded in
`domain-search-backlog.md` §3).

**The economics are the point:** the cost is *per hub*, not per domain found.
Five hubs per market is **$0.125** and could return hundreds of local domains.
Compare $0.002 for a map pack that returns only the living.

**Hub selection, in priority order:**

| Hub | Why | How to find it |
|---|---|---|
| Chamber of commerce | Member directories link out to every member, and never prune | `{city} chamber of commerce` |
| Local newspaper | Business section, obituaries of businesses, sponsor pages | Known per metro |
| City / county `.gov` | Licensed contractor lists, permit records | `{city}.gov`, `{county}.gov` |
| Local sponsor pages | Youth sports, charity donor walls — pure local, never pruned | Requires discovery |
| Sub-metro directory | Neighbourhood association sites | Requires discovery |

**Hub discovery can be free:** the sweep already stores `top_organic_domains`
per market. A hub is a domain that appears across *many different niches* in
one market and nowhere in other markets. That is a query, not a purchase.

**Unproven — probe first:** whether `referring_domains` for a chamber domain
skews local enough to be worth $0.025, or is swamped by national link spam.
**One call on one chamber answers it.** Do this before building anything.

### 3.3 Wayback-archived directory pages — ✅ CONFIRMED, *free, and the best hit rate measured*

> **Measured 2026-08-13.** YellowPages category pages are **one hop** — the
> archived page carries business websites directly. BBB is **two hops** in both
> 2019 and 2025: its category pages link only to `bbb.org` profiles, its own
> affiliates and adtech. Of ten domains recovered from 2011–2013 YP snapshots,
> **five were not live businesses and four were outright `AVAILABLE`**.
>
> | Directory | Archived? | Shape | Use it? |
> |---|---|---|---|
> | **YellowPages** | 2011–2024, 20+ snapshots for Kenosha alone | **one hop** | **Yes — start here** |
> | BBB | 2019+, big metros only | two hops | Later; profile crawl needed |
> | Yelp | search URLs archive poorly | untested | Low priority |
>
> **Two CDX gotchas, both of which produced a false "nothing is archived":**
> `filter=statuscode:200&collapse=timestamp:6` returns an empty body rather than
> an error, and `encodeURIComponent` on the `url` param breaks it. Filter status
> codes in code, and pass the URL raw.
>
> **Coverage is market-size dependent.** BBB has no archived category page for
> Kenosha but does for Chicago; YellowPages covers Kenosha back to 2013. Check
> per market rather than assuming.
>
> **The one-hop route captures a minority of the page.** The Kenosha 2013
> snapshot carried **307 `/mip/` profile links but only ~6 usable business
> domains** — most listings had no outbound website. The two-hop crawl is where
> the rest of the yield is, at ~300 fetches per page.

Established in `domain-search-backlog.md` §4 and restated here because the
critical implication was never drawn:

- **BBB returns 403 even through DataForSEO.** Do not retry it.
- **`web.archive.org` does not block.**

**Therefore: BBB is reachable through Wayback even though it is closed to us
live.** BBB category pages are the best directory of local operators in
existence, and archived 2014–2019 copies list businesses that no longer exist
anywhere. The same applies to archived Yelp, YellowPages and chamber category
pages.

**Route:**

1. CDX query for archived category URLs — e.g.
   `web.archive.org/cdx/search/cdx?url=bbb.org/us/tx/dallas/category/plumber*`
2. Fetch the best snapshot per year, 2014–2020.
3. Extract outbound business website links.
4. Feed into the existing triage unchanged.

`wayback.ts` already speaks CDX, so the client work is small.

**Unproven, and it decides whether this is cheap or expensive:** whether
archived BBB/Yelp category pages carry business **website** links or only
internal profile links. If profiles only, it is a two-hop crawl at ~10× the
requests. **Check one archived page by hand before writing a collector.**

**Note on fetching:** `on_page/instant_pages` returns **no `raw_html`**
(verified against `example.com`). Wayback snapshots can be fetched directly
over plain HTTP — no DataForSEO involved, no cost — which sidesteps that
entirely.

### 3.4 DataForSEO WHOIS database — ✅ CONFIRMED, *and it does collapse the collection stage*

`/domain_analytics/whois/overview/live` is a **queryable WHOIS database with
filters**, not a per-domain lookup. It runs on credentials this project already
holds.

If it supports what the docs describe, a single request could return:

> every domain containing `plumb` **or** `dallas`, expiring in the next 90 days,
> with a non-zero backlink profile

That is the entire feature in one call, and it inverts the architecture — from
"enumerate businesses, then check domains" to "query domains directly".

**All four questions are now answered — see §1.5 (P1).** Every filter works,
compound `and` + `order_by` works, and it costs **$0.1269 per request** flat.

**The query to build the feature on** — locality or niche token, in the drop
window, with a real profile:

```jsonc
{
  "limit": 100,
  "filters": [
    ["domain", "like", "%kenosha%"],
    "and", ["epp_status_codes", "has", "redemption_period"],
    "and", ["backlinks_info.referring_domains", ">", 5]
  ],
  "order_by": ["backlinks_info.referring_domains,desc"]
}
```

**Two constraints that shape the design:**

- **It discovers; it does not verify.** `expiration_datetime` is a stale
  snapshot — the filter returns live majors like `freepik.com`. Everything it
  finds still goes through the existing free RDAP/DNS/HTTP triage. This replaces
  the *collection* stage, not the pipeline.
- **It only finds domains whose NAME carries the token.** A Kenosha plumber
  trading as `acmeservices.com` is invisible to it. That gap is exactly what
  §3.3 covers, which is why the two are complements rather than alternatives.

### 3.5 Google Places Details — *the documented gap, now worth closing*

Measured on a live 100-business Maps result: `business_status` present **0/100**.
`place_id` present **100/100** — retained on every row for exactly this purpose.

Places Details supplies `business_status: CLOSED_PERMANENTLY`, which the
original spec calls the highest-value rows. Google keeps closed listings in the
index for years, **with the old website field intact**.

**Cost:** field-masked Details calls (Basic tier: `business_status`, `website`)
are ~$0.017 each at list price — **not measured here, and no Places key is
configured**. Gate it: only call for listings that already look weak (no
rating, no reviews, unclaimed), not the whole map pack.

**Blocker:** no Google Places API key. Flagged in the backlog as
credential-blocked; unchanged.

### 3.6 Local public records — *free, locality-scoped by construction, name-only*

The only sources here that are **authoritative about death** rather than
inferring it from silence.

| Source | Gives | Format |
|---|---|---|
| City/county **business licence** registries | Name, address, licence status, expiry | Open-data portals (Socrata/CKAN), often a real API |
| Secretary of State **dissolutions** | Name, status `dissolved`/`forfeited`, date | Per-state, quality varies wildly |

**The catch:** these give **business names, not domains.** They need a
name→domain step (§3.8). A dissolved "Joe's Plumbing LLC" in Kenosha plus a
registered `joesplumbing.com` with 12 years of archive history is as strong a
signal as this system can produce.

**The other catch:** fifty states and thousands of municipalities, each with
its own format. This does not generalise — it is per-market integration work.
Build it for one metro, measure the yield, and only then decide whether it
scales.

### 3.7 The drop pipeline — *definitive on availability, weak on relevance*

The sources that answer "is it obtainable **right now**".

| Source | Cost | Notes |
|---|---|---|
| **ICANN CZDS zone files** | Free w/ approval | Daily `.com` zone; day-over-day diff = every domain that dropped. ~165M lines, GB-scale per day. Definitive and heavy. |
| **DropCatch / NameJet / SnapNames** daily drop lists | Free to read | Pre-filtered to domains with metrics. Filter by city/niche token. |
| **ExpiredDomains.net** | Free tier | Convenient, aggregates the above. Check ToS before automating. |
| **GoDaddy / Namecheap / Dynadot APIs** | Free tier | Availability + aftermarket price. `checkRegistrarAvailability` is **already an unwired hook** in `EnrichPipelineOptions` — wiring one is small. |

**Read the coverage plan's warning before investing here.** Two things cap the
value of this entire class:

- **Valuable drops never reach retail.** Drop-catchers take anything with real
  metrics within seconds. A domain reaching `AVAILABLE` is *evidence against*
  its value.
- **Google resets dropped domains.** History does not survive the drop. Buying
  from the owner preserves far more than catching a drop does.

**So the honest use of this class is verification, not discovery** — confirming
that a domain found by §3.1–3.6 is obtainable, and by what mechanism (registrar
vs backorder). Zone-file diffing is a large build for a population the strategy
says is weak; **do it last, if ever**.

### 3.8 Name-space generation — *free, unlimited, and a different product*

Two distinct uses:

**a. Name → domain resolution.** For business names from §3.6 with no known
website, generate candidates (`joesplumbing.com`, `joes-plumbing.com`,
`joesplumbingkenosha.com`) and check via RDAP. Free, and it is what makes the
public-records route usable at all.

**b. EMD permutation.** Generate `{niche}{city}.com`, `{city}{niche}.com`,
`best{niche}{city}.com` and check availability. Free and unbounded.

**Keep (b) clearly separate in the UI.** An available EMD has **no history, no
links, no rankings** — it is the opposite of an expired domain with equity.
This product already has an EMD verdict as a first-class output; feeding
brand-new registrations into a list labelled "expired domains" would conflate
two different purchases. Different tab, different label.

### 3.9 Content-index search — *unproven, probe if cheap*

`/content_analysis/search/live` searches an index of page content. A query for
`"Kenosha plumbing"` returns pages mentioning it — including citations of
businesses that no longer exist.

**Entirely unproven here:** index freshness, whether it retains pages for dead
sites, and cost by balance delta. Worth one probe **after** §3.4, and only if
that one disappoints.

### 3.10 Common Crawl — *free corpus, heavy engineering*

The URL index is queryable by host prefix; WAT/WET files carry extracted text
and outbound links. Locality-scoped queries mean processing segments, which is
a data-engineering project, not a feature.

**Listed for completeness. Do not build this** unless §§3.1–3.6 have all been
exhausted and measured.

---

## 4. Ranking and presentation

The existing `scoreDomain` ranks acquisition attractiveness. This feature adds
a dimension it does not model: **how the domain can be obtained.**

Split the results into three lists, because the operator's next action differs
completely between them:

| List | Statuses | Action |
|---|---|---|
| **Buy now** | `AVAILABLE` | Register at a registrar |
| **Backorder** | `PENDING_DELETE`, `REDEMPTION`, `EXPIRING_SOON` | Place a backorder — *not* a registrar purchase |
| **Approach the owner** | `PARKED_DEAD`, `ACQUIRED_301`, roll-up clusters | Outreach. Preserves history a drop destroys |

`domain-search-backlog.md` §2 already makes this correction and notes the UI
does not draw the distinction. This is the moment to fix it, because a
multi-market run produces far too many rows to sort by hand.

**Carry provenance into the row.** With this many sources, "where did this come
from" becomes the first question about any surprising result. `sources` already
exists as a `jsonb` array; extend the vocabulary rather than the schema:
`organic`, `map_pack`, `maps_live`, `wayback_directory`, `citation_hub`,
`public_record`, `whois_db`, `drop_list`, `generated`.

---

## 5. Order of work

**The probes are done** (§1.5). This is the corrected order, and it differs from
the pre-probe draft: the two confirmed sources move to the front, the falsified
one is dropped, and roll-up clustering is deferred.

> **Do step 0 before committing to any of this.** P4 measured a 1-in-4 equity
> rate on a sample of ten, on the one source with the best hit rate. That is far
> too small to justify UI work, and the cheapest way to size it is to run the
> discovery headless across several markets and count. **If the equity rate
> holds at ~10%, the buy list is not a product and this should ship as an
> outreach list instead.**

| # | Item | Cost | Why here |
|---|---|---|---|
| **0** | **Headless YP-archive harvest across 5–10 markets, triage free, measure equity rate** | **$0** + ~$0.10 bulk | Decides whether steps 1–4 are worth building at all |
| **1** | Research-page entry point + **Harvest mode** (§2) | **$0** | The actual ask; free by default; nothing below is reachable without it |
| **2** | **Wayback → YellowPages collector** (§3.3) | **$0** | Best hit rate measured: 50% non-live vs 16%. One hop, confirmed |
| **3** | `domain_triage_cache` (§2.4) | $0 | Multi-market runs re-triage the same domains; already observed |
| **4** | **WHOIS-DB collector** (§3.4) | $0.127/market | One request replaces the collection stage; adds a population §3.3 misses |
| **5** | Three-list split by obtainability (§4) | $0 | A wide run is unreadable without it |
| **6** | Spam **gate**, `depth: 700` | $0 | Open items from the coverage plan |
| **7** | Drop `metrics.organic` into the score | **−$0.18/market** | Replaces the paid rankings gate with data step 4 already bought |
| **8** | Two-hop YP profile crawl (§3.3) | On-Page task flow | ~300 fetches/page; most of the archive yield is here |
| **9** | Public records, one metro (§3.6) | $0 | Measure yield before generalising |
| **10** | Registrar availability hook (§3.7) | $0 | Small; verifies obtainability |
| **—** | ~~Citation hubs (§3.2)~~ | — | **Falsified.** Only revisit via outbound links in step 8's flow |
| **—** | Roll-up clustering (§3.1) | $0 | **Deferred** — 2 clusters of 2. Re-run `probe-rollups` after more markets |
| **—** | Places Details (§3.5) | blocked | Needs a key |

**Steps 1–3 are free and are most of the value**: the entry point, the
highest-yielding source measured, and the cache that makes wide runs finish.

**Step 7 pays for step 4.** `metrics.organic` arrives inside the WHOIS response,
so the $0.012/domain Labs rankings gate — $0.18 per market at the current cap of
15 — can be dropped. That more than covers the $0.127 the WHOIS request costs.

---

## 6. What this cannot do

Stated so the coverage claim stays honest — extending §6 of the coverage plan.

- **A domain nobody ever linked to and nothing ever ranked is unreachable.**
  Every method here reads a record someone else kept. A business with no
  website, no citations and no archive coverage leaves no trace.
- **Google resets dropped domains.** This caps what the entire strategy can
  return and is why the outreach list outranks the buy list.
- **Valuable drops never reach retail.** `AVAILABLE` is weak evidence.
- **Public records give names, not domains.** The join is a heuristic and will
  produce false pairs. A generated domain that happens to be registered is
  *not* evidence it belonged to the dissolved business.
- **BBB stays 403 live.** Only the archive is open.
- **Wider discovery multiplies whatever error rate the classifier has.**

That last one is not a formality. **27 of 64 `PARKED_DEAD` rows were wrong**,
and a later pass moved 30 more to `LIVE`. Every one was found by an operator
spot-checking by hand; none by a test.

> **The coverage plan's rule stands: Phase 4 before Phase 3 — filter before you
> widen.** The spam gate and the three-list split (items 4 and 5) should land
> before any new source, and **every new source must be hand-checked on its
> first run.**
