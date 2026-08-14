# Plan: Step 0 — does defunct-business discovery produce anything worth buying?

| Field | Value |
|---|---|
| **Date** | 2026-08-13 |
| **Status** | **RUN 2026-08-13. Result: do not build the buy list — §6** |
| **Parent** | [`plan-defunct-domain-discovery.md`](./plan-defunct-domain-discovery.md) §5 step 0 |
| **Question** | At what rate does each discovery angle produce a domain worth acquiring? |
| **Budget** | ~$1.00 live spend, hard-capped in code |
| **Output** | A decision: build a **buy list**, an **outreach list**, or neither |

---

## 0. Why this is an experiment, not a feature

The probes proved discovery works and then undercut the reason for it: of ten
domains recovered from a 2013 archive, **five were not live, four were
available, and exactly one had surviving link equity — carrying spam 46**.

n = 10, one market, two hand-picked snapshots. That is enough to justify a
measurement and nowhere near enough to justify a UI.

**So this run is designed to produce a decision, and the decision rules are
written down before it runs** (§4). Otherwise a 6% hit rate gets argued into
"promising" after the fact, which is how the `PARKED_DEAD` false positives
survived four rounds of spot-checking.

---

## 1. What must be fixed before the run

Five things in the current harness would corrupt the numbers. Each one already
produced a wrong answer during the probes.

### 1.1 Link extraction is hand-rolled and demonstrably wrong

`probe-wayback-directory` reported **15 "business websites"** on a BBB page.
All fifteen were adtech and BBB affiliates — `doubleclick`, `demdex`,
`newrelic`, `bbbpromos.org`. A hand-written regex was doing work the real
normaliser should do.

**Fix:** one extraction path, built on `registrableDomain` +
`NON_ACQUIRABLE_HOSTS`, plus a new `INFRASTRUCTURE_HOSTS` set for trackers,
CDNs and tag managers. These are semantically different from
`NON_ACQUIRABLE_HOSTS` — that set means "the business rents a page here";
this one means "not a business at all" — so it is a separate export, not an
append.

**Seed it from what the probes actually caught**, not from imagination:

```
YP chrome/partners: ypcdn.com, anywho.com, ingenio.com, keen.com, taleo.net,
                    truste.com, att.com, justanswer.com, dexknows.com,
                    superpages.com, yellowbook.com
Adtech/analytics:   doubleclick, demdex, omtrdc, newrelic, nr-data, mouseflow,
                    google-analytics, googletagmanager, googleadservices,
                    scorecardresearch, quantserve, criteo, hotjar, optimizely
Infra/CDN:          akamai, cloudfront, cloudflare, jquery, bootstrapcdn,
                    fontawesome, gstatic, googleapis, azurewebsites.net,
                    pages.dev, mozilla.org
Manufacturer refs:  carrier.com, kohler.com, trane.com, lennox.com, rheem.com
```

That last group matters: a plumber's site links to Kohler, and Kohler is not an
acquisition target. `kohler.com` has already cost this project one false
top-ranked candidate.

### 1.2 Token matching has no word boundaries

The citation-hub probe counted locality token `wi` as a match for every
`wiki*` domain, inflating the locality share with a wiki-spam network.

**Fix:** match on token boundaries within the domain label
(`kenosha`, `-wi-`, `wi.` as a suffix), never bare substring. Applies to the
WHOIS arm too, where `%wi%` would be catastrophic.

### 1.3 "Worth buying" is ad-hoc

The verdict logic lives inline in one probe. It needs to be one pure, tested
function, because every number this experiment reports is derived from it.

**New:** `packages/core/src/domains/acquisition-value.ts`

```
BUY      status is obtainable (AVAILABLE / PENDING_DELETE / REDEMPTION)
         AND yearsOfContent >= 3          (a real business existed)
         AND referringDomains >= 5        (some equity survived)
         AND spamScore < 30               (not a liability)

OUTREACH status is owned-but-idle (PARKED_DEAD / BROKEN / EXPIRING_SOON /
         ACQUIRED_301 / UNKNOWN)
         AND referringDomains >= 20
         AND spamScore < 30

NEITHER  everything else, with the specific reason recorded
```

Thresholds come from measured evidence, not taste: **spam < 30** because the
coverage plan measured 37–49 on candidates it called liabilities; **refdom ≥ 5**
because three of four available domains had 0–2; **3 years** because a 1-year
archive is a parked page, not a business.

**Nulls are not zeros.** An unmeasured spam score must not pass the `< 30` test.
Missing inputs yield `UNKNOWN_VALUE`, counted separately, never folded into
`NEITHER` — the whole point of the repo's first rule.

### 1.4 There is no collector, only two hardcoded URLs

**New:** `packages/data/src/domains/archive-directory.ts`

- locality + niche → YellowPages slug (`kenosha-wi/plumbers`)
- CDX with the two gotchas already burned in: **no `encodeURIComponent` on the
  `url` param**, and **no `filter=`/`collapse=`** — both return an empty body
  rather than an error, and both produced false "nothing is archived" readings.
- snapshot selection: oldest + one mid-decade, since 2025 pages are
  client-rendered and carry no business links
- extraction via §1.1

### 1.5 Everything spends off the books

The probes moved $1.34 without a `spend_ledger` line, because they construct the
DataForSEO client directly and never pass `onSpend`. That is precisely the
failure that caused the discovery overspend this repo documents.

**Fix:** the harness ledgers every request, tagged `experiment=step0`, and
enforces a **hard budget cap in code** — it stops rather than overspends.

---

## 2. The arms

"All angles", each measured on the same markets and niches so the rates are
comparable.

| # | Arm | Source | Cost | Tests |
|---|---|---|---|---|
| **A** | Control | Existing pipeline (stored SERP + map pack) | $0 (already bought) | The 84%-LIVE baseline |
| **B** | YP archive, one hop | Wayback CDX → YP category pages | **$0** | The confirmed source |
| **C** | YP archive, two hop | + `/mip/` profile pages | $0, ~300 fetches/page | Where the yield was hiding |
| **D** | WHOIS name-token | `whois/overview/live`, niche + locality tokens | $0.127/query | The domains B cannot see |
| **E** | Other archived directories | superpages, merchantcircle, citysearch, manta | $0 | Whether YP is special or the method is general |

Arm C is capped hard — 300 fetches per page across many pages is the one thing
here that can run for hours. **Cap at 60 profiles per snapshot** and record what
was dropped, so the coverage claim stays honest.

**Arm E matters more than it looks.** If only YellowPages works, this is a
YellowPages integration with a single point of failure. If four directories
work, it is a method.

### Scope

- **Markets:** 5, drawn from `research_geos` with a `dataforseo_location_code`,
  spanning sizes (one large metro, three mid, one small like Kenosha) — archive
  coverage is known to vary with market size.
- **Niches:** 3 high-ticket local services (plumber, HVAC, electrician).
- **Target:** ≥ 300 unique domains harvested across arms B–E.

At ~6–17 domains per snapshot one-hop, 5 markets × 3 niches × 2 snapshots is
roughly 180–500 for arm B alone. Enough for a rate; not enough for a tight
confidence interval, which §4 accounts for.

---

## 3. Cost and time

| Item | Cost |
|---|---|
| Arms B, C, E — Wayback | **$0** |
| Arm D — WHOIS, 5 markets × 3 niches, batched to 5 queries | ~$0.64 |
| Bulk backlinks + spam on ~300 domains, one request | ~$0.06 |
| Triage (DNS/HTTP/RDAP/Wayback) at any volume | **$0** |
| **Total** | **~$0.70**, hard cap $1.00 |

**Wall clock is the real constraint.** ~300 domains × ~15s ÷ 10 concurrent
≈ 8 minutes for triage, plus archive fetches. Arm C uncapped would be hours,
which is why it is capped.

**In-memory dedupe across arms**, keyed by domain, with the source recorded —
so a domain found by both B and D is triaged once and attributed to both. The
persistent `domain_triage_cache` stays a build item; the experiment does not
need it.

---

## 4. Decision rules, written before the run

Rates are over **unique domains harvested per arm**.

| Outcome | Rule | Decision |
|---|---|---|
| **Buy list viable** | BUY ≥ 5% | Build the buy list. Ship §2's entry point |
| **Outreach only** | BUY < 5% **and** OUTREACH ≥ 15% | Ship as an outreach list. Buy list becomes a labelled sub-tab |
| **Not worth building** | BUY < 5% **and** OUTREACH < 15% | Stop. Record the negative result and keep the present-tense pipeline |

**Per-arm, not just overall.** If B fails and D passes, build D.

**Honest statistics.** With n ≈ 300 a 5% rate has roughly a ±2.5pp 95% interval,
so a result between **2.5% and 7.5% is not a decision** — it is a request for a
bigger sample. That band is stated now so a 6% cannot be read as a pass later.

**A negative result is a real result.** If everything fails, that is worth more
than the $0.70 it cost: it closes a direction this project has been circling
across three planning documents, and it is recorded rather than quietly
abandoned.

---

## 5. Build order

1. `INFRASTRUCTURE_HOSTS` + boundary-safe token matching (§1.1, §1.2) — pure, tested
2. `acquisition-value.ts` (§1.3) — pure, tested, null-safe
3. `archive-directory.ts` (§1.4) — the collector
4. `experiment-step0.mts` — arms, ledger, budget cap, report
5. Run it
6. Write results into the parent plan and act on §4

Steps 1–2 are pure functions with tests, because every number the run reports
is computed by them. Step 3 is the only new I/O.

---

## 6. Results — 2026-08-13

**n = 385 unique domains** across 5 markets × 3 niches. Ledgered spend
**$0.8653** (`note = experiment=step0`).

| Arm | n | BUY | OUTREACH | NEITHER | UNKNOWN_VALUE | **BUY %** | **OUTREACH %** |
|---|---:|---:|---:|---:|---:|---:|---:|
| B — YP archive, one hop | 212 | 2 | 20 | 135 | 55 | **0.9%** | 9.4% |
| C — YP archive, two hop | 16 | 0 | 2 | 9 | 5 | **0.0%** | 12.5% |
| E — superpages + others | 190 | 0 | 25 | 155 | 10 | **0.0%** | 13.2% |
| **Overall** | **385** | **2** | **42** | — | — | **0.5%** | **10.9%** |

### The decision the pre-registered rule produces

> **NOT WORTH BUILDING.** BUY 0.5% against a 5% bar; OUTREACH 10.9% against 15%.

0.5% is not near the confidence band — it is an order of magnitude below the
line. Two domains out of 385:

```
homeplumbingexperts.com   AVAILABLE  13y  refdom 33  spam 10
plumberintucson.net       AVAILABLE   5y  refdom  9  spam 20
```

### Discovery worked. The domains are just worthless.

This is the important distinction, and it holds up:

| | Archive route | Present-tense pipeline |
|---|---:|---:|
| `LIVE` | **54.0%** | 84% |
| `AVAILABLE` | **18.7%** | 2.5% |
| Not a live business | **46%** | 16% |

The archive route finds dead businesses at roughly **3× the rate**, exactly as
designed. **72 domains came back AVAILABLE and 2 were worth buying.** The
bottleneck was never discovery — it is that an expired local-service domain has
no surviving equity. `plan-domain-search-coverage.md` §6 predicted this from
first principles; it is now measured at n=385 rather than n=10.

### What the arms say about each other

- **Superpages works** (arm E, 190 domains), so the method is not a YellowPages
  quirk. Its snapshots are 2021–2025 rather than 2011–2013, which is likely why
  it produced zero BUY: recent snapshots list businesses that are still alive.
  **`merchantcircle` had no snapshots for any market** and should be dropped.
- **The two-hop crawl is not worth its cost.** 16 domains for 40 profile fetches
  per snapshot. It did surface `drainsruswi.com` and `leeplumbing.com`, both
  outreach rows — so it finds *different* domains, just very few per unit work.

### Three caveats that limit how far this generalises

1. **Arm D (WHOIS) was never assessed.** It harvested 492 domains across 5
   markets for **$0.6345**, and the run was killed by a wall-clock limit during
   triage before the value pass. That spend bought nothing. Completing it costs
   ~$0.05 in bulk backlinks against the cached harvest — **the harvest cache
   added afterwards exists precisely so this cannot happen again.**
2. **The harvest is not deterministic.** Arm B returned 419 domains on one run
   and 212 on the next with identical parameters — `fetchSnapshot` returns null
   on a Wayback timeout and the loss is silent. The BUY rate was 0.2% and 0.9%
   respectively, so the conclusion is stable, but any *count* from this harness
   is a floor rather than a measurement.
3. **`UNKNOWN` dominates the OUTREACH bucket** (most rows, and their archive
   depth reads `—`). `UNKNOWN` means triage never concluded, not that the domain
   is idle — so 10.9% is an upper bound. Resolving it needs the JS-render pass
   (`renderUnknown`), which is built and was not enabled here.

### Recommendation

**Do not build the buy list.** Do not build the research-page entry point *for
the purpose of finding purchasable expired domains* — the population is 0.5%.

The **outreach** angle is the only one still standing, and it is not yet proven
either: 10.9% is below the bar and inflated by `UNKNOWN`. Before spending
anything more on it, re-run arm D's cached harvest (~$0.05) and enable
`renderUnknown` so the outreach rate is measured rather than assumed.

**The negative result is the deliverable.** Three planning documents in this
repo circled defunct-business discovery as the obvious next source. It has now
been measured end to end for **$2.20 total**, and the answer is that the domains
it finds are not worth buying.
