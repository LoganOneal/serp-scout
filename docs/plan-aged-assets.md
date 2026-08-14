# Plan: acquire an aged ranking asset — domain or Google Business Profile

| Field | Value |
|---|---|
| **Date** | 2026-08-13 |
| **Status** | **Tests 1–3 run 2026-08-13 — results in §5. Part A registrar route is dead; Part B has a real population.** |
| **Goal** | Either (**A**) an aged high-authority domain that ranks fast, or (**B**) a Google Business Profile taken over from a defunct or acquired company |
| **Supersedes framing of** | [`plan-defunct-domain-discovery.md`](./plan-defunct-domain-discovery.md), [`plan-step0-experiment.md`](./plan-step0-experiment.md) |

---

## 0. What step 0 actually proved — and why it points somewhere else

Step 0 measured 385 domains and found a 0.5% buy rate. **That was the wrong
population, and the result is evidence for a different route rather than against
the goal.**

The BUY rule required `AVAILABLE`. High-authority aged domains **never reach
`AVAILABLE`** — drop-catchers take anything with metrics within seconds of the
drop. So the experiment gated on precisely the domains that had already been
rejected by a market of professional buyers.

**The evidence is inside our own results.** Sorted by referring domains, the
assets in that run were:

| Domain | Refdom | Status |
|---|---:|---|
| `benjaminsupply.com` | 480 | UNKNOWN — **owned** |
| `customsolarandleisure.com` | 419 | UNKNOWN — **owned** |
| `plumbingdrainservices.com` | 238 | UNKNOWN — **owned** |
| `reddiservices.com` | 232 | UNKNOWN — **owned** |
| `homeplumbingexperts.com` | **33** | AVAILABLE ← best available domain found |

**Every domain with real authority was still registered.** The two the
experiment called BUY have 33 and 9 referring domains — neither is a high-DA
domain by any definition, so the archive route did not merely underperform on
goal A, it produced **zero** qualifying assets.

Three corrections follow, and they define this plan:

1. **Aged authority is bought from owners or at auction, not at a registrar.**
   Neither route has been tested.
2. **The name-token constraint was wrong.** Arm D filtered the WHOIS database to
   domains containing a city or niche string. An aged brandable is perfectly
   usable for rank-and-rent; that filter discarded most of the candidate space.
3. **Goal B has never been touched at all** — and the data needed for it is
   already being purchased and thrown away (§2.1).

---

## PART A — an aged, high-authority domain

### A0. Measure authority as authority

`scoreDomain` and the step-0 rule both used **referring domains** as the proxy
for DA. DataForSEO returns an actual **domain rank (0–1000)** in the same bulk
response, and the WHOIS database exposes it as a filterable field. It was
fetched and never used as a gate.

**Do first, costs nothing:** define the bar in rank terms
(`domain_rank >= 150` as a starting line, calibrated against the ~10 real local
operators measured so far — `daveburns.com` 243, `southportheating.com` 237,
`masterserviceslg.com` 194) and re-assess the cached step-0 measurements
against it. That is a pure re-run of `--reassess` with a different predicate.

### A1. Auction and marketplace inventory — *the untested mainstream route*

This is where domains with metrics actually go, and nothing here has touched it.

| Source | Access | Notes |
|---|---|---|
| **GoDaddy Auctions** | API | Expiring/expired inventory with traffic + appraisal. **A GoDaddy connector exists in this workspace but is unauthorised** — authorise it before building anything custom |
| **DropCatch / NameJet / SnapNames** | Daily lists, free to read | Pre-filtered to domains with metrics; backorder model |
| **Sedo / Afternic / Atom** | API / listings | Aftermarket, owner-priced. Our triage already detects these as `PARKED_DEAD` "listed for sale via…" |
| **ExpiredDomains.net** | Free tier | Aggregates the above with DA/backlink columns. Check ToS before automating |

**Test A1:** pull one day of GoDaddy Auctions inventory, filter to
`domain_rank >= 150` **and** any local-service relevance, and price the top 20.
The question is not "do aged domains exist" — it is **what they cost**, which
nothing in this project has ever established.

**Success criterion, pre-registered:** ≥ 10 domains per week at rank ≥ 150 for
**under $500**. Below that price the economics of rank-and-rent work; above it,
a fresh EMD plus time is cheaper.

### A2. Invert the WHOIS query — metrics first, name second

Arm D asked "which domains contain `kenosha`". The right question is **"which
high-rank domains are in the drop window"**, with relevance applied afterwards.

The endpoint is proven and costs **$0.1269 flat** per request:

```jsonc
{
  "limit": 1000,
  "filters": [
    ["backlinks_info.referring_domains", ">", 100],
    "and", ["epp_status_codes", "has", "redemption_period"]
  ],
  "order_by": ["backlinks_info.referring_domains,desc"]
}
```

188,983 domains sit in `redemption_period` globally. **One request** returns the
1,000 best of them. Relevance filtering is then free and local.

**Test A2:** three queries (`redemption_period`, `pending_delete`, and
expiring-soon), ~$0.38 total. Count how many carry rank ≥ 150 **and** plausible
local-service relevance.

### A3. Buy from the owner — the only route where equity demonstrably lives

Step 0 produced **42 outreach candidates**, and they are the highest-authority
domains in the entire dataset. This route has never been tried, and it is the
one the data actually supports.

**Test A3:** contact the top 15 by rank. Measure reply rate, willingness to
sell, and asking price. This costs an afternoon and no API spend, and it is the
single highest-information test in this document — it prices the asset class.

Buying from an owner also **preserves history that a drop destroys**, which is
the difference between an aged domain and an aged domain that still ranks.

### A4. Then test the premise itself

Nothing here has established that **an aged domain ranks faster than a fresh
one**. That is the assumption the whole strategy rests on and it is unmeasured.

The repo already has the instrument: `outcomes.position` with a non-null
`checked_at`, plus the EMD verdict bands. **Test A4:** acquire one aged domain
and one fresh EMD in comparable markets, build equivalent sites, and record
time-to-rank in `outcomes`. Until this runs, "aged ranks faster" is a prior.

---

## PART B — take over a Google Business Profile

**This is probably the stronger play, and it is completely unexplored.**

For local lead generation the map pack — not the organic result — is where the
volume is. An aged GBP with 40 reviews and years of history **ranks in the map
pack immediately**, needs no domain authority, no backlinks and no content
runway. It is closer to revenue than any domain in Part A.

### B0. We are already buying the data and deleting it

Measured today:

| Field | Where | State |
|---|---|---|
| `is_claimed` | `collect-businesses.ts:131` | **Read from every listing, never persisted** |
| `rating`, `reviewCount` | same | **Read, never persisted** |
| `place_id`, `cid` | same | **Read, never persisted** (100% coverage) |
| `gbp_leaders` | `discovery_serp_metrics` | Non-null in **5,109 rows, empty array in every one** |
| `maps_domains` | same | Populated in 438 rows |

`run-enrich.ts` persists `businesses` as `{name, website}` and discards the
rest. **An unclaimed profile with 40 reviews is a takeover candidate, and the
field identifying one has been fetched and thrown away on every run this project
has ever done.**

**Test B0 — free, and do it first:** persist those fields, then query the
existing corpus for unclaimed listings with meaningful review counts. This is a
schema change plus a mapping fix. **Zero API cost, and it may answer the whole
question from data already paid for.**

### B1. What makes a profile takeable

Ranked by how strongly each signals an abandoned asset:

| Signal | Meaning | Source |
|---|---|---|
| `is_claimed = false` | **Nobody is managing it.** The cleanest claim path | Maps listing — already fetched |
| `business_status = CLOSED_PERMANENTLY` | Business is gone; profile persists with reviews | Places Details / business listings |
| Live GBP + **dead website** | Orphaned profile — the business stopped paying for hosting | **Computable now** from `maps_domains` × `domain_candidates.status` |
| High reviews, none recent | Was real, now unattended | Reviews endpoint |
| No photos/posts in years | Unmanaged | Business data |

**The third row is free and available today.** We hold 438 rows of
`maps_domains` and 1,371 triaged domains. A profile whose domain triaged
`PARKED_DEAD`, `AVAILABLE` or `EXPIRING_SOON` while still appearing in a map
pack is an orphaned GBP, and that join is a query.

### B2. Probe the business-listings database

`/business_data/business_listings/search/live` is the GBP analogue of the WHOIS
database that worked so well in Part A — a filterable index rather than a
per-place lookup.

**Test B2 (one request, ~$0.02):** does it accept filters on `is_claimed`,
`business_status`, `rating`, `total_photos`, category and location? If it does,
"every unclaimed plumber profile in Tucson with 20+ reviews" is **one request**,
and Part B is essentially solved — the same shape of win as the WHOIS probe.

Also worth one probe each: `/business_data/google/my_business_info/live` for
per-profile detail, and Places Details for `business_status` (measured 0/100 on
the Maps endpoint, and every row already stores a `place_id` for exactly this).

### B3. The mechanics, and the risk that decides the design

Google provides a documented path: **unclaimed** listings can be claimed and
verified; **claimed** listings can be ownership-requested, which emails the
current owner and, absent a response within a short window, can transfer access.
For a genuinely defunct business this is the process working as intended —
Google wants accurate listings.

**The operational risk is suspension, and it is what makes or breaks the asset.**
Google's guidelines require a listing to represent a real business operating at
that address. Running lead-gen under a dead company's name and address is
exactly the misrepresentation those guidelines target, and a suspended profile
is worth nothing — you lose the reviews and the ranking history you acquired it
for. Verification postcards go to the listed address, which is a hard constraint
on any profile whose address you do not control.

**This shapes the plan rather than merely cautioning about it:**

- Prefer profiles you can operate honestly — claim, then **update name, category
  and address** to the entity actually taking the calls. Google supports
  businesses that change name or ownership.
- **Test durability before scaling.** Take over one profile and hold it for 90
  days. If it survives, the asset class is real; if it is suspended, everything
  built on it was worthless. This is Test B3 and it gates any investment in B.
- Address control is the binding constraint. Budget for it.

---

## Priority — do B before A

| # | Test | Cost | Why |
|---|---|---|---|
| **1** | **B0** — stop discarding `is_claimed` / reviews / `place_id`; query the corpus | **$0** | Data is already bought. May answer B outright |
| **2** | **B2** — probe business-listings filters | ~$0.02 | Could collapse B the way the WHOIS probe collapsed A's collection stage |
| **3** | **A0** — re-assess cached step-0 data on `domain_rank`, not refdom | **$0** | Pure re-run; fixes a wrong metric |
| **4** | **A3** — outreach to the 42 known candidates | $0 + time | Prices the asset class; highest information per dollar |
| **5** | **A2** — WHOIS by metrics, not name | ~$0.38 | Proven endpoint, corrected query |
| **6** | **A1** — GoDaddy Auctions inventory | auth first | The mainstream route, never tried |
| **7** | **B3** — hold one profile 90 days | 1 profile | Gates all further investment in B |
| **8** | **A4** — aged vs fresh, time-to-rank | 2 sites | Tests the premise everything rests on |

**Tests 1–4 cost essentially nothing** and between them cover both goals. Nothing
in Part A should be bought until A0 and A3 have run, because A0 fixes the metric
and A3 prices the market.

---

## 5. Results — 2026-08-13

Tests B0(a), B0(c) and A0 are done. **$0.1356 of new spend**, ledgered.

### A0 — the registrar route for aged authority is dead, conclusively

Re-assessed all 385 cached step-0 domains on **domain rank (0–1000)** instead of
referring domains, with the bar at **rank ≥ 150** (calibrated against real local
operators measured here: `daveburns.com` 243, `southportheating.com` 237,
`masterserviceslg.com` 194).

| | Count |
|---|---:|
| Domains at rank ≥ 150 | **105** |
| Of those, **obtainable at a registrar** | **0** |
| Of those, still owned | **105** |

**Not one.** The population contains plenty of authority —
`simonelectric.com` 417, `jsplumbing.net` 316, `tazplumbing.com` 308,
`heatmasters.com` 296 — and every single one is held by its owner.

This closes the question the last three planning documents kept circling.
**Aged authority is never available at a registrar.** Part A now depends
entirely on A1 (auction) and A3 (owner outreach); nothing else in Part A is
worth building until one of those returns a price.

### B0(a) — orphaned profiles exist, and coverage is the ceiling

Joining `maps_domains` × `domain_candidates.status` — both already purchased,
never put together:

- **24 orphaned GBP candidates**: in a map pack, website not a live business.
- **264 of 2,671** distinct map-pack domains have ever been triaged.

So the 24 come from **10% of the available corpus**. Triaging the remaining
2,407 is free and would be expected to produce roughly ten times as many.

### B0(c) — the disqualifying risk was false

The plan named the case that would end Part B: *`is_claimed` may be
near-universally true in competitive local niches.* Measured on **979 Houston
listings** across AC repair, roofing and plumbing, for **$0.0220**:

| | Count | Rate |
|---|---:|---:|
| Listings | 979 | |
| **Unclaimed** | **121** | **12.4%** |
| Unclaimed **with ≥ 10 reviews** | **41** | **4.2%** |
| Listings with no website at all | 207 | 21.1% |

**4.2% against the domain buy list's 0.5% — an eight-fold better qualifying
rate, at $0.002 per market-niche instead of hours of archive crawling.**

The strongest shape is an unclaimed profile with reviews and **no website**:
the profile is the entire asset and there is no site to diligence.
`Josiah & Sons Plumbers` (116 reviews, 4.7), `Emergency Local Plumbing` (100,
4.8) and `Hayden & Sons Plumbers` (90, 4.8) all match.

**One confirmed cross-hit between the two free datasets:**
`Thomas Family Roofing` — 50 reviews, 4.9, unclaimed — whose website
`thomasfamilyroofing.online` triaged **AVAILABLE** in B0(a). Dead domain, live
unclaimed profile with review history. That intersection is the exact target
shape and it was found for $0.

### Three caveats that must gate any action on B

1. **Unclaimed ≠ defunct ≠ takeable.** `M&M Roofing, Siding & Windows` tops the
   list at **1,381 reviews** and is plainly an active business with an unclaimed
   location profile. Claiming it would be taking over a live competitor's
   listing — the misrepresentation case, and the one that gets profiles
   suspended. **The list needs a defunct filter before it is an action list.**
2. **Some candidates are already someone else's lead-gen.** `FREE AC CHECK`,
   `Emergency Local Plumbing`, `24 HR Emergency Plumber Houston Local Pros` —
   generic keyword-stuffed names with no website are the signature of an
   existing rank-and-rent operation, not a defunct local business.
3. **Single market.** All of this is Houston. Nothing here says the 12.4%
   unclaimed rate generalises.

### Test 1 result — map-pack triage backfill (2026-08-13)

Triaged **2,298** previously unchecked map-pack domains. **$0.00** — no provider
calls. 54 minutes, 0 failures.

| | Before | After |
|---|---:|---:|
| Map-pack domains triaged | 264 | **2,596** of 2,671 |
| **Orphaned GBP candidates** | 24 | **237** |
| With 3+ years of archived content | — | **40** |
| Also obtainable at a registrar | — | 4 |

The 10× held. A mid-run reading of 4.3% at n=300 suggested otherwise and was
recorded as a correction; the full sweep landed at **9.4%**, so the early sample
was simply unrepresentative.

**Archive depth is what separates the two populations.** Of 237 candidates, ~200
are churn domains — zero archived content, novelty TLDs (`.online`, `.pro`),
spun up for a lead-gen play and abandoned. The 40 with real trading history are
the shortlist:

```
statetostatemove.com              13.2y age  14y archived  108 snaps  local movers
powerwashinghouston.com           17.2y      14y            75        pressure washing
mp2energy.com                     16.8y      13y            95        commercial electrician
greenbeelawn.com                  15.0y      12y            84        lawn aeration
spehouston.com                    17.3y      12y            37        commercial electrician
colonialfencing.com               15.3y       9y            56        fence company
sandersandsonsappliancerepair.com 20.5y       5y            64        appliance repair
solargrids.com                    24.9y       5y            56        solar
```

**Two operational findings:**

- **Recent `last_content_snapshot_at` on a `PARKED_DEAD` row is ambiguous** — a
  parking page can register as "content". The unambiguous shape is deep archive
  history *plus* an old last-content date: `sandersandsonsappliancerepair.com`
  last served real content in **2019-02** after 20 years, which is as clean a
  "this business is gone" signal as this system produces.
- **`20solarenergy.com` and `one4solar.com` appear twice** — the same domain
  triaged under two run ids with slightly different `age_years`. Third
  independent sighting of the cross-run duplication that the
  `domain_triage_cache` in `plan-defunct-domain-discovery.md` §2.4 exists to fix.

### Test 2 result — is the profile claimed? ⛔ THE FILTER FAILS

Re-pulled the map pack for each of the shortlist's 24 canonical niches (5,637
listings) and read `is_claimed` for all 38 leads.

| Outcome | n | % |
|---|---:|---:|
| **Claimed** — actively managed | **24** | **63%** |
| Gone from the pack entirely | 10 | 26% |
| **Unclaimed** | 4 | 11% |
| Unclaimed **with real review history** | **1** | **2.6%** |

**A dead website does not mean a dead business.** That is the finding, and it
invalidates the whole dead-domain→profile filter. A local service business runs
on Google Maps and a phone; the website is optional infrastructure that lapses
first while the profile stays actively managed:

```
airbornelocksmiths.com   PARKED_DEAD → Airborne Locksmith        678 reviews, CLAIMED
houstonkeylocksmith.com  BROKEN      → Houston Key Locksmith     445 reviews, CLAIMED
truorganicrestoration.com BROKEN     → TruOrganic Restoration    274 reviews, CLAIMED
imyourplumber.net        PARKED_DEAD → I Am Your Plumber         230 reviews, CLAIMED
```

The one unclaimed lead with reviews is `txbunkhouse` (52) — a **motel**, not a
service business, surfaced by the "bed bugs" keyword.

### The direct filter finds more, but most of it is not takeable

Across the same 5,637 listings: **143 unclaimed with 10+ reviews (2.5%)**, 86 of
them with no website at all. But the list does not survive inspection:

- **National chains**: `Lowe's Home Improvement` (2,259), `Two Men and a Truck`
  (284) — unclaimed *location* profiles of live national businesses.
- **Category mismatch is severe**: "bed bugs" returns motels
  (`Garden Inn`, `Sahara Motel`, `Relax Inn`); "maids" returns
  `Southern Maid Donuts`; "power washer" returns car washes; "dryer repair"
  returns a laundromat; "electrician" returns the IBEW union hall and a
  `houstontx.gov` facility.
- Roughly **12–15 of 143** are plausibly real local operators.

**And unclaimed still does not mean defunct.** `Derek & Sons Plumbing` with 125
reviews at 4.9 and no website is almost certainly a *working* business that
never bothered to claim its listing. Taking that over is the misrepresentation
case from §B3 — the one that gets profiles suspended, and the one that is simply
wrong.

**Verdict: the takeable population — defunct AND unclaimed AND carrying review
equity — is rare enough that neither filter tested produces a usable list.**
Part B does not survive contact with data, on the same pattern as Part A.

### Measured correction: the Maps endpoint is not $0.002 flat

`collect-businesses.ts` states the endpoint "charges per request… so asking for
200 in one call costs the same $0.002 as asking for 100", and records
`PRICE.serpMapsLive` regardless of depth.

**Measured by balance delta: 24 requests at depth 700 cost $0.138 — ~$0.0058
each**, roughly 2.9× the recorded figure, and it scales with results returned
(~$0.002 per 100). Consequences:

1. **`spend_ledger` under-records map-pack spend by ~3×** on deep requests,
   because the constant is written instead of the real cost.
2. **`plan-domain-search-coverage.md` §2 recommends raising depth 200→700 as
   free.** It is not free; it roughly triples the per-call price.

### What to do next, revised

| # | Test | Cost | Why |
|---|---|---|---|
| **1** | Triage the 2,407 untriaged map-pack domains | **$0** | Ten-fold more orphan candidates from data already bought |
| **2** | B2 — probe `business_listings/search` filters | ~$0.02 | If it filters `is_claimed` + `business_status`, the defunct filter is one request |
| **3** | Repeat B0(c) in 3 more markets | ~$0.02 | Does 12.4% generalise beyond Houston? |
| **4** | A3 — outreach to the 105 rank-≥150 owners | $0 + time | The only remaining Part A route with evidence behind it |
| **5** | B3 — hold one profile 90 days | 1 profile | Still gates everything in Part B |

**Test 1 is free and is the single best next move.** The orphan count is
currently limited by triage coverage, not by the phenomenon.

---

## What would make this fail

Stated up front, in the style the other plans in this repo use.

- **Aged authority may simply be expensive.** If A1 and A3 return $2,000+ asks,
  rank-and-rent economics do not support it and the answer is fresh EMDs plus
  patience. That is a real outcome, not a failure of the search.
- **GBP suspension risk may be disqualifying.** If B3's profile is suspended,
  the asset class is not durable regardless of how cheaply it can be found.
- **`is_claimed` may be near-universally true** in competitive local niches.
  B0 answers this for free, which is why it is first.
- **Aged domains may not rank faster.** Untested (A4). Google resets dropped
  domains, so a dropped aged domain may behave like a fresh one — in which case
  only owner-purchase (A3) preserves what we are paying for.
