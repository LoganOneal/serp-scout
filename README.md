# Rank & Rent — locality opportunity research

An operator names one place — "Kenosha, Wisconsin" — and this answers two
questions: **which local service niche can I win here**, and **can an exact-match
`.com` rank inside a month?**

**Locality-first.** Every keyword tool answers the inverse question (niche-first,
sweeping thousands of cities for one niche) and so cannot answer the question an
operator actually has. Retrofitting locality-first onto a niche-first schema is a
migration, so it is built this way from the start.

## Four independent numbers, never blended

| Output | Meaning |
|---|---|
| **SERP Difficulty** 0–100 | Competition only. Higher = harder. The primary sort. |
| **EMD verdict** | `likely_30d` / `likely_90d` / `likely_6m` / `not_winnable` / `unknown` |
| **Demand** | Monthly searches — **modelled from population** |
| **Modelled rent** | $/month the site could rent for |

A brutal SERP worth $2,400/mo and an empty one worth nothing are different
facts. One combined "opportunity score" destroys the ability to filter for
either.

---

## The one rule this codebase is organised around

> **Never let an unmeasured signal read as a good one.**

Null is not zero. Silence is not availability. An unchecked domain is not a free
one. A rate-limited registry is not a yes. Every place that rule is broken, the
failure is **silent** and points toward spending money.

Concretely:

- **Unmeasured scoring components are omitted and the weights renormalise** —
  never defaulted to 0. Zero referring domains is the strongest "beatable" signal
  there is, so a missing measurement rendered as `0` turns every unknown domain
  into a jackpot. `weightCovered` is surfaced next to every difficulty score.
- **`difficulty` is nullable** and sorts LAST in an easiest-first table. A 0 would
  sort first and read as the best opportunity in the locality.
- **`outcomes.position` is nullable, `checked_at` is not.** The row existing is
  the measurement; a null position means *checked and nowhere*. Treating it as
  missing data drops every failed build from the denominator.
- **One deliberate inconsistency:** the `likely_30d` band, alone, treats missing
  evidence as a **failure**. Everywhere else leniency is right; here it is not,
  because this is the only output that says "go buy this domain".

## And: say what is modelled

Volume is estimated. Rent is modelled. The 30-day verdict is a prior until
outcome data says otherwise. That is on screen in a permanent banner, not in a
docstring — this is a tool people buy domains from.

---

## Setup

```bash
pnpm install
cp .env.example .env          # then fill in DATABASE_URL
pnpm db:push                  # create the schema
pnpm seed:niches              # 41 local service niches
pnpm ingest:geo               # Census corpus + provider location resolution
```

Two processes:

```bash
pnpm dev       # Next.js
pnpm worker    # the ONLY consumer of the scan_runs queue
```

A queued scan only starts when the worker is running. There is no Redis: the
`scan_runs` table **is** the queue, so there is no second system to forget to
poll — which is what made the previous build's "Start scan" button silently do
nothing forever.

### Everything runs for $0 by default

`LIVE_CALLS_ENABLED` must be the **exact string** `true` to spend money. Anything
else — unset, empty, `TRUE`, `1`, a typo — routes every provider call to the
deterministic fixture implementations. The polarity is deliberate: a
misconfigured env var should fail toward $0, not toward live spend.

```bash
pnpm test      # unit + contract, no network, no database
pnpm e2e       # full pipeline on fixtures; ASSERTS spend === 0
pnpm scan kenosha-wi --cap-cents 25   # one locality, explicit cap, full log
```

---

## Costs

| Endpoint | Cost |
|---|---|
| `/serp/google/organic/live/advanced` | $0.002 |
| `/serp/google/maps/live/advanced` | $0.002 |
| `/backlinks/bulk_*/live` (×3) | $0.024/req + $0.000036/row |
| `/serp/google/locations` · `/appendix/user_data` | free |
| US Census bulk files · RDAP | free |

**~$0.24 per cold locality** (41 niches × [SERP + map pack] + one batched link
lookup). Budget is integer **micros** in a `bigint`, checked **before** each
purchase, and every purchase writes a `spend_ledger` row so the total is
reconcilable rather than merely tracked.

There is deliberately **no two-stage cheap/expensive funnel**. At $0.24 for full
fidelity, a funnel spent real complexity plus a score gate that silently dropped
most rows in order to save about twenty cents, and made the output worse.

---

## Traps, all verified live

Each of these is guarded by a test, and each one failed **silently** in the
previous build.

### 1. `bulk_ranks` returns only `{target, rank}`

It does **not** return `referring_domains`, despite the name and every instinct.
Reading them off it yields `null` for every domain forever — the 0.40-weight
`authorityWall` component vanishes from every score, the model renormalises
around the hole exactly as designed, and the only symptom is a coverage
percentage nobody reads. This survived for months.

All **three** backlinks endpoints are required, fanned out in parallel and merged
on `target`. Guarded by a **negative** contract test asserting the field is
absent — a test written against our own beliefs would agree with whatever we
already believe, which is how the bug survived.

### 2. Wrong endpoint paths return `"Invalid Path."` inside HTTP 200

It is `/serp/google/locations`, not `/serp/google/organic/locations`. Guessing
produces "zero locations exist" rather than an error.

### 3. There is no city-level search volume to buy

`/dataforseo_labs/locations_and_languages` returns 94 rows and stops at
**Country** — it enumerates keyword *databases*, not queryable places. Volume is
modelled from population and flagged `estimated: true` as a **literal type**, so
it cannot be constructed unflagged.

### 4. Account problems arrive as HTTP 200 — caught live during this build

A real capture, in `__contracts__/error_ip_not_whitelisted.json`:

```
HTTP 200 · status_code: 20000 · status_message: "Ok." · tasks_error: 1
  tasks[0].status_code: 40207
  tasks[0].status_message: "Access denied. Your IP is not whitelisted."
  tasks[0].result: null
```

The outer envelope claims success **twice**. Only `tasks[0].status_code` says
otherwise. Read as "no results", this scores every SERP in the corpus as a
wide-open jackpot — and the credentials were perfectly valid, so nothing else
looked wrong. Every response passes three gates: HTTP status → body *shape* →
`tasks[0].status_code === 20000`. An account issue throws and **aborts the run**;
it is never catchable into an empty result set.

### 5. The Census API now requires a key on every request

`api.census.gov` returns an 8,529-byte HTML **"Missing Key"** page under HTTP 200
— at national, state, and single-place scope alike. Verified 2026-08-02.

The whole geography corpus therefore comes from **keyless** `www2.census.gov`
bulk files, and median household income (API-only) was **cut from the rent
model** rather than made a prerequisite for ingest. The general rule it produced:
the fetch layer asserts response *shape*, never just status.

Two of the briefed paths were also wrong:
- sub-county population is at `.../cities/**totals**/sub-est2024.csv`
- `.../metro/totals/cbsa-est2024-alldata.csv` gives **real CBSA population**,
  which retires the metro-undercount problem at source rather than tuning
  around it (Milwaukee: 1.57M actual vs ~700k from summing places)

### 6. Location codes have TWO sources, and only one may be spent against

`/serp/google/locations` is free but sits behind the account's **IP whitelist** —
and this machine's egress IP rotates within a NAT pool, so a single-address
whitelist works intermittently (one ingest got all 267,107 rows; the next got
40207). Without a location index, *every* locality fails to resolve and the tool
has nothing to scan. That is what "Tucson, AZ has no provider location code"
looks like from a perfectly healthy ingest.

So there is a fallback: **Google Ads geo target constants** — free, keyless,
16,407 active US cities plus 3,098 counties. DataForSEO documents its
`location_code` as the Google Ads criterion ID, and the canonical-name forms
match exactly, including both odd ones:

```
Orange,Orange,California,United States                  <- county, no word "County"
Brentwood,Contra Costa County,California,United States  <- county with the word
McKinney,Texas,United States                            <- no county at all
```

But that equivalence is **unverified**, so `localities.location_source` records
which source produced each code, and **`runScan` refuses to spend money on
anything but `'dataforseo'`**:

```
Tucson, AZ has location code 1013509 from "google_geotargets", not from
DataForSEO. Refusing to spend money on an unverified code -- it could return a
well-formed SERP for the wrong city.
```

Fixture scans work fine on either source. Verification is free, so the fix is to
re-run `ingest:geo` with a reachable API, not to trust the fallback.

### 7. RDAP: three states, not two

`404` = available · `200` = registered · **anything else = `null`**. A 429 is not
a yes. DNS fallback is asymmetric: nameservers *present* proves registered;
their *absence* proves nothing.

---

## Geography quirks

Each silently loses real cities.

- **Never widen.** "Kenosha, Wisconsin" happily matches the Wisconsin *Region*
  row, returning a well-formed statewide SERP that is completely wrong. Explicit
  `acceptTypes` per kind; unmatched beats substituted.
- **Case-SENSITIVE suffix stripping.** `Richmond city` → `Richmond`, but
  `Kansas City` stays `Kansas City`. Blind stripping sends Kansas City to the
  *state* of Kansas.
- **State-scoped consolidation aliases.** `Boise City|ID` → Boise. Keyed on name
  *and state* because there is also a Boise City in **Oklahoma** (pop. ~1,100),
  and a name-only table sends it to Idaho.
- **Three county-qualification forms**, because the provider is inconsistent:
  `Kenosha,Wisconsin,US` · `McKinney,Collin County,Texas,US` ·
  `Orange,Orange,California,US`. McKinney is 227,000 people and was missing
  entirely until form 2.
- **The 95% rule.** Skip a county rollup when one member place is ≥95% of its
  population. Catches all 23 VA/MD/MO/DC independent cities generically — they
  are simultaneously places and county-equivalents, and their county rows can
  never resolve because the provider types them as `City`.
- **Slug is the only natural key.** `(kind, state, name)` is not unique — two
  Wilmingtons in Illinois, three Oakwoods in Ohio. FIPS disambiguation is applied
  to *every* member of a collision, so slugs don't depend on row order.

`pnpm ingest:geo` **fails loudly** below 100% coverage of cities >250k and 99% of
the 25k–250k band, and prints a sample of unmatched localities with reasons. An
unresolved locality is silently excluded from scanning, so a bad rule must
surface as a failed ingest rather than as "no data for half the country".

---

## The scoring model

CTR-weighted, never `1/position`:
`[0.276, 0.151, 0.100, 0.070, 0.052, 0.040, 0.031, 0.025, 0.021, 0.018]`

| Component | Weight |
|---|---|
| `authorityWall` — CTR-weighted defender link strength | 0.40 |
| `slotDefence` — what *kind* of result holds each slot | 0.30 |
| `intentLock` — is there a city+niche-dedicated asset, and how high? | 0.15 |
| `linkQuality` — dofollow ratio + spam, **scaled by link mass** | 0.15 |

### The platform authority discount

Platform domains (Yelp, Angi, Facebook, BBB, Thumbtack, …) contribute a **fixed
0.12**, *not* their real link profile. Yelp has ~4M referring domains; through
the same curve as a local plumber it scores ~1.0 and walls off the page. But a
Yelp "Best Plumbers in Kenosha" page at #2 ranks on generic domain power applied
to a template — nobody there is defending that query, and for a local operator
it is the *easiest* slot to take.

Without this discount, every directory-stuffed SERP — which is to say every
genuinely winnable market, which is to say the entire reason this tool exists —
scores as unwinnable. It looks like a bug and it is the most important constant
in the model.

### Acceptance: the three archetypes

| SERP | This model | Brief's estimate |
|---|---|---|
| 8 directory slots + 2 thin locals | **16** → `likely_30d` | ~10 |
| 2 committed operators + directories | **32** → `likely_6m` | ~33 |
| 5 exact-match operators, 150–420 refdomains | **81** → `not_winnable` | ~72 |

Ordering and all three bands match exactly. The two magnitude gaps are left in
place rather than tuned away: reaching ~72 on the brutal page needs an authority
saturation ceiling around 23,000 referring domains — a *national*-scale ceiling,
and a local-scale one is precisely why this reads local SERPs better than Ahrefs
KD does. Both differences are conservative (harder, not easier), so they cost
missed opportunities rather than wasted purchases. See
`packages/core/src/scoring/__fixtures__/archetypes.ts`.

### A bug the tests found

`authorityWall` initially reported itself *measured* whenever any result was
evaluable — but platforms always are, since they use a constant. On a page where
five exact-match operators hold 1–5 and five directories hold 6–10, losing the
operators' link data still left the directories, and the component happily
reported `0.12`: a page walled by five committed operators with hundreds of
referring domains, scored as having almost nothing defending it. Fixed with
`AUTHORITY_WALL_MIN_CTR_COVERAGE` — the evaluated results must account for ≥50%
of the page's click weight, or the component is not a weak reading of the
defenders, it is **no** reading of them.

### Calibration

Every threshold in `priors.ts` is annotated `PRIOR — awaiting calibration` with
its source (Ahrefs' 2M-page study: 1.74% of new pages reach the top 10 within a
year; ~40.8% of those that do arrive within a month). Emitting "72% chance" from
that would be invention dressed as measurement, so the model emits **bands with
named blockers**.

- Hit rate per band is reported **with n always visible** — "100%" off 3 builds
  is not the same claim as off 300.
- `isOrderingSound()` checks `30d ≥ 90d ≥ 6m`. Answerable at far smaller n than
  any absolute rate, and it fails for a *different* reason: a violation means the
  model is **misreading SERPs**, not that a constant needs nudging.
- Rank re-checks at day 7/14/30/60/90 are **not cache-first**. The cached
  snapshot predates the site by definition, so serving it would record every
  build as never having ranked.
- `difficulty_at_save` / `verdict_at_save` are **frozen** on the shortlist item.
  Joining to a live score would let today's thresholds judge yesterday's build,
  and every band would validate itself.

---

## Markets — one locality + niche, one page

```
scan_runs -> scan_targets -> shortlist_items -> sites -> calls -> leads -> lead_outcomes
                                                 \-> serp_keywords -> serp_targets -> serp_checks
```

A locality+niche pair is one **market**, addressed by `/markets/{locality}/{niche}` rather
than by a site id -- research exists before a site does, so an id-keyed URL could never show a
cell you had merely scanned. One market has one website: `sites_active_cell_uq` is a partial
unique index on `(locality_id, niche_id) WHERE status <> 'dropped'`, so a cell can be
re-targeted after being dropped without losing its history. `sites.domain` is **nullable** --
you start watching keywords before you register a domain, and a placeholder domain would be
worse than none because the column is unique.

`/sites`, `/sites/:id` and `/shortlist` permanently redirect here. Keeping them apart is what
put the frozen prediction on one page and the realised result on another, so the one comparison
this system exists to make was never on screen together.

### SERP monitoring

You post comments on Reddit threads that rank for a market's keywords. Two things are watched:
whether the thread still ranks, and whether your comment held its place.

- Keywords arrive as a **Semrush CSV** -- UI headers (`Keyword`, `Search Volume`) and API codes
  (`Ph`, `Nq`) both, any column order, `,`/`;`/tab, BOM tolerated. Only a keyword column is
  required and **every skipped row is reported with its line number**.
- The thread's rank comes from one live SERP ($0.002), which also yields **your own domain's
  position for free** from the same response.
- The comment ordinal is read from `old.reddit.com` markup fetched through DataForSEO.
  **Reddit answers 403 to server IPs** -- verified against `www`, `old` and `api`, all three
  returning a "blocked / bot / network security" page -- and self-service OAuth registration
  closed in 2026, so there is no token to go get. DataForSEO crawls for a living, and it is
  already the vendor whose credentials and spend ledger this repo understands.
- `serp_targets.next_check_at` **is** the queue, claimed with `FOR UPDATE SKIP LOCKED` like
  `scan_runs`. Daily, capped by `SERP_MONITOR_DAILY_CAP_CENTS` before each purchase.

#### The three states, never collapsed into two

`serp_checks.comment_present` is the column this feature can get dangerously wrong:

| Value | Meaning | Alerts? |
|---|---|---|
| `true` | found, with an ordinal | no |
| `false` | a **complete** thread was loaded and the comment is not in it | **yes** |
| `NULL` | could not measure -- blocked, or the tree was truncated | **never** |

Telling you your comment was deleted because Reddit rate-limited a crawler is the worst thing
this feature could do, so a 403, a layout change, or a "load more comments" node all write
NULL. `serp_position` is the opposite: there NULL *is* the measurement -- we ran the search and
the thread was not in the top 100, which is the "post is not showing up" signal itself.

---

## Sites & CRM — what happened after you bought the domain

The research half answers *which domain*. This half answers *what it produced*.

```
scan_runs → scan_targets → shortlist_items → sites → calls → leads
        (research)          (the decision)   (the asset and its revenue)
```

**Ranking was never the outcome. Calls are.** `shortlist_items` already freezes
what the model predicted at decision time, and the only outcome data was
`outcomes.position` — did it rank. A site at position 3 producing two calls a
month falsifies the modelled rent just as loudly as one that never ranked, and
nothing could see that. `sites` carries `locality_id`, `niche_id` and an optional
`shortlist_item_id`, so real call volume finally tests `priors.ts`.

A Twilio number rings, a Retell agent answers, triages for genuine emergencies,
qualifies the caller, and the lead lands in Postgres before they hang up.

### One agent, many sites

Retell's **inbound call webhook** fires before the call connects. We resolve the
dialled number to a site and return its name, hours, service area and fee as
dynamic variables, plus `metadata.site_id`. One prompt, one agent, every site
correct — adding a site is an INSERT plus a number.

`metadata.site_id` is then the **only** way a call learns its site. Resolving by
`to_number` at report time would silently reattribute every historical call the
moment a number moved between sites — the same discipline as `difficulty_at_save`.

### The founding bug, in a new costume

> A number whose webhook URL was never configured produces real calls, sends
> nothing, and renders as `0 calls`.

Zero calls and never-connected are the same pixels, and the second one means
customers are ringing through and vanishing. That is the Start-scan button that
silently did nothing, again. So `sites.first_webhook_at` is nullable and drives a
permanent banner, and **every count on an unconnected site renders as an em dash
rather than a zero**. Provisioning also sets the webhook URL in the same API call
that imports the number, so the banner is a backstop rather than the only defence.

### Nullable, for the usual reason

- **`leads.is_emergency` is nullable, not `false`.** Never asked ≠ caller said no.
  A `false` here is how a no-heat call at 11pm in January gets queued for Tuesday.
  The tool parser coerces `"unknown"`/`"maybe"`/absent to null, and deterministic
  triage over the transcript can only ever **promote** to true — a keyword scan
  finding no hazard is absence of evidence, not evidence of absence.
- **`in_service_area` is nullable.** An unvalidated zip is not an in-area zip.
- **`qualified` is nullable and sorts LAST**, exactly like `difficulty`.
- **`calls` rows are created on `call_started`.** A caller who hangs up at four
  seconds is a *measurement* — abandon rate is how you learn the greeting is too
  slow or too obviously synthetic. Create the row at end-of-call and every
  abandoned call vanishes and the funnel looks perfect.
- **`captured_fields` is stored separately from the values.** "Address is null" and
  "address was never asked" are different bugs.

### Two capture paths, one winner

The mid-call `save_lead` tool is **authoritative** — it is what makes a lead
survive a hang-up, and the caller who gives a name and "my furnace is dead" then
hangs up is still worth $50–200. Retell's post-call analysis only *fills nulls*;
where it disagrees the tool wins and the conflict is written to
`reconcile_conflict`, because a recurring conflict on one field is a prompt bug and
that is the only place it becomes visible.

### Recordings are re-hosted, deliberately

Retell's `recording_url` is an S3 link with no documented lifetime — and a hard
**ten minutes** when the PII opt-out is enabled. A queued job copies the bytes to
`RECORDINGS_DIR`; the UI reads `recording_path`, and a null renders the *reason* it
is missing rather than a play button that 404s.

### Commands

```bash
pnpm db:push && pnpm db:extras   # extras adds the partial indexes push cannot express
pnpm voice:agent-config          # the prompt + tool schema to paste into Retell
pnpm voice:simulate <domain>     # a full signed fake call, no phone needed
pnpm sites:provision <domain> --number +1XXXXXXXXXX [--confirm]
```

`voice:simulate` exists so the dashboard is built without phoning the number and
squinting at logs. It **signs** its payloads with `RETELL_API_KEY` rather than
bypassing verification — there is no `SKIP_SIGNATURE` flag, because that flag
eventually ships and turns the tool endpoint into an open write endpoint.

**A simulated call never texts anyone.** `calls.simulated` is set at ingest from the
call-id prefix (`sim_`, `test_`, `e2e_` — Retell's own ids are `call_…`, so there is
no overlap), and with live providers the delivery job records `suppressed` instead of
sending. Found the hard way: the first simulated call after `LIVE_CALLS_ENABLED=true`
queued a real SMS to a real phone about a caller who did not exist. Suppression is
gated on the provider being live, so the fixture path still tests delivery end to end.

Relatedly, **both vitest configs force `LIVE_CALLS_ENABLED=false`**. They load the
real `.env`, so flipping that flag silently turned `pnpm e2e` into a suite that buys
SERP data and sends texts — and `expect(spend).toBe(0)` fires *after* the requests, so
it reports the loss rather than preventing it.

`sites:provision` is a **dry run without `--confirm`**: attaching a number to the
trunk silently removes it from Programmable Voice, and these are working business
lines. It also refuses outright when the trunk has no Disaster Recovery URL —
without one, a Retell outage is a dead phone line. Full runbook in
[`docs/telephony.md`](docs/telephony.md); architecture in
[`docs/crm-plan.md`](docs/crm-plan.md) and
[`docs/voice-agent-plan.md`](docs/voice-agent-plan.md).

---

## Layout

```
packages/core     pure: scoring, EMD, calibration, geography, money,
                  and the voice agent's prompt/triage/lead parsing.
                  ZERO dependencies. Safe to import from a client component.
packages/data     providers + Drizzle schema + pipeline + voice ingest. Imports
                  'server-only', so a client component reaching in fails AT BUILD TIME.
apps/web          Next.js App Router, incl. the Retell/Twilio webhook routes.
```

The package boundary is load-bearing, not decorative: `core` cannot see DB or
network types, so "scoring is pure" is enforced by the compiler rather than by
discipline.

### Pipeline: one pass per locality, three phases

1. SERP + map pack per niche, cache-first, `p-limit(6)`
2. **BARRIER** — collect every unique domain across *all* niches, buy link data
   in **one batched call set**. The single most cost-sensitive line in the
   codebase: the bulk endpoints charge per *request* plus per row, so 41
   per-niche lookups pay the request fee 41 times for identical rows (~10×).
3. Score → assess EMD → check availability → persist

Caches: SERP 45d · link profiles 90d · availability 7d · **negative cache for
unresolved domains 14d** — small local sites with no measurable link profile are
the *common* case, and without it they are re-requested and re-paid for forever.

---

## Status

Verified end to end against Supabase (ca-central-1, Postgres 17.6):

| | |
|---|---|
| `pnpm typecheck` | clean across all three packages |
| `pnpm test` | **147 passing, 1 failing by design** (see below) |
| `pnpm e2e` | **13/13**, including `SPENDS NOTHING` |
| `pnpm ingest:geo` | 19,479 cities · 3,074 counties · 921 metros = **23,471 localities** |
| `pnpm build` | all 5 routes compile; the server-only boundary holds |
| Kenosha fixture scan | 41/41 niches, $0.0000, difficulty 14–75, stdev 17.4, 24 distinct values |

Coverage, both assertion bars cleared:

```
kind/band            resolved / total
city/250k+              93 / 93     100.0%   <- assertion: 100%
city/25k-250k         1505 / 1513    99.5%   <- assertion: >= 99%
city/under 25k        9890 / 17873   55.3%   (below the viable band)
county/25k-250k       1297 / 1302    99.6%
metro/25k-250k         656 / 665     98.6%
```

The 19,479 incorporated places matches the briefed ~19,475. The remaining
mid-band misses are places newer than the free geo-target vintage — South Fulton
GA (2017), Jurupa Valley CA (2011), Stonecrest GA (2017), Peachtree Corners GA
(2012) — not rule failures.

### Six bugs found by running it

**Zero metros.** The CBSA gazetteer puts the code in `GEOID`, not `CBSA`.
Looking for `CBSA` gave index `-1` and therefore zero rows — with no error,
because an empty result from a file that downloaded fine looks exactly like
"there are no metros". Now 935 CBSAs → 921 metros, and the parser throws if the
column is missing rather than returning an empty list.

**185 counties silently deleted, most of them real.** Dothan city spans Dale,
Henry *and* Houston County, Alabama, and the place→county file gives no
population split. Attributing Dothan's full 71k to Dale County (pop 49k) read as
**143%** of the county and tripped the 95% independent-city rule. The rule was
right; its input was wrong. Now: an exact name test first (Census marks these
county-equivalents with a trailing lowercase `" city"`), and a share above 1.0 is
treated as proof of misattribution rather than evidence of an independent city.
150 skipped, 35 real counties recovered.

**Every accented place name was corrupted.** The gazetteer files are UTF-8 —
"Doña Ana County" is stored as `44 6F C3 B1 61` — and were being decoded as
Latin-1, producing "DoÃ±a Ana County". That does not surface as an encoding bug;
it surfaces as a county that will not resolve.

**Multi-word legal suffixes left debris.** The suffix list matched shortest-first,
so `"Juneau city and borough"` hit `" borough"` and became `"Juneau city and"`,
and Utah's `"Kearns metro township"` became `"Kearns metro"`. Longest form first.

**Eleven Massachusetts cities over 25k were unreachable.** Census writes
`"Weymouth Town city"`; stripping the lowercase `" city"` leaves `"Weymouth
Town"`, but the provider carries `"Weymouth"`. Now stripped — **New England
only**, because a blanket rule turns Boys Town, Nebraska into "Boys".

**St. Paul (307,465) was the only US city over 250k that failed.** Census writes
`"St. Paul city"`, the provider carries `"Saint Paul"`. Both spellings are now
generated, in both directions, plus Mount/Mt. and Fort/Ft. This alone took
cities-over-250k from 98.9% to 100%.

**Every metro failed (0 of 921).** The resolver was fed the full CBSA name
(`"Kenosha-Racine, WI"`) rather than an anchor. Fixed by trying progressively
shorter hyphen prefixes **longest first** — `"Winston-Salem"` before
`"Winston"`, since splitting on the hyphen and taking the first segment is the
obvious implementation and it breaks Winston-Salem.

**Upsert conflicted on the wrong key.** `slug` is *derived* from the name and
legitimately changes when a naming rule improves; `(kind, fips)` is the immutable
identity. Matching on slug meant an improved metro name inserted a second row and
then died on the `(kind, fips)` index.

### The one failing test

`contracts.test.ts › fixture provenance › CAPTURED FROM THE LIVE API`.

The failing test is `contracts.test.ts › fixture provenance › CAPTURED FROM THE
LIVE API`. The payloads in `__contracts__/` were transcribed from documentation,
so the tests asserting against them confirm what we already believe — and a wrong
belief about which fields an endpoint returns *is* Trap 1. A green suite there
would claim Trap 1 is guarded when it is not, so it fails until real payloads are
captured:

```bash
pnpm probe:dfs    # ~$0.08, gated on explicit confirmation
```

Three fixtures are already **verified**: the two error captures and the real
40207. If a field assertion breaks after the probe, **the mechanism worked** —
fix the adapter, not the fixture.

**Blocked on the IP whitelist.** The credentials are valid; this machine's IP
(`167.220.102.1`) is not whitelisted, which is what produced the captured 40207.
Add it at <https://app.dataforseo.com/api-access>, then:

```bash
pnpm probe:dfs      # captures real payloads
pnpm ingest:geo     # LIVE_CALLS_ENABLED=true for the real 267k location dump
```

### Running it

```bash
pnpm dev      # http://localhost:3000
pnpm worker   # in a second terminal
```

`pnpm worker` is now the only consumer of **two** queues: `scan_runs` and
`voice_jobs`. Voice drains first — a scan takes minutes and a lead alert is meant
to reach the contractor in seconds, so putting voice second would park an
emergency text behind a 40-niche SERP sweep. Recordings and lead texts only move
while it is running.

`DATABASE_SCHEMA=some_schema pnpm dev` runs the whole app against an isolated copy
of the schema, which is how the webhook routes get smoke-tested without a single
write landing in real data.

Note for monorepo readers: every Node entry point runs with
`--conditions=react-server`, and both vitest configs declare the same resolve
condition. `@rnr/data` imports `server-only`, whose default export **throws** by
design so a client component importing it fails loudly — but plain Node trips the
same guard, and that condition resolves the package to an empty module. The guard
still fires where it should: in a browser bundle.
