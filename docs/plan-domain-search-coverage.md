# Plan: full-coverage domain search

| Field | Value |
|---|---|
| **Date** | 2026-08-07 |
| **Status** | Planned — nothing here is built |
| **Goal** | Find every expired/abandoned domain reachable from the SERPs, directories and GBP listings a market already produces |
| **Guiding constraint** | Widen coverage without widening spend, and never let a wider net lower the accuracy bar |

---

## 0. The finding that reorders everything

The sweep already buys an organic SERP — and often a map pack — for **every**
niche × market cell, and stores the domains it saw. The domain search ignores
all of it and re-enumerates from a fresh Maps call.

Measured on the current database:

| | Count |
|---|---|
| Distinct organic domains stored (`top_organic_domains`) | 163 |
| Distinct map-pack domains stored (`maps_domains`) | 388 |
| Union | 516 |
| Domains the domain search has actually triaged | 254 |
| **Stored domains never triaged** | **509** |

The overlap between the two populations is tiny. The sweep's SERP data and the
domain search's Maps call surface almost entirely **different** domains, and
**509 domains we have already paid for have never been checked**.

This is Phase 1, and it costs nothing.

**Why organic domains matter most.** A domain in `top_organic_domains` is
*ranking right now*. An expired or abandoned domain that still ranks is the
single most valuable thing this tool can find — it has demonstrated ranking
ability, which is the entire thesis. Map-pack domains are next: a GBP that
still appears with a dead website behind it is a live citation attached to a
dead asset.

---

## 1. Phase 1 — Harvest what we already own *(zero marginal cost)*

**Do:** add a Stage 1 source that reads `discovery_serp_metrics` for a
niche × market and returns every domain in `top_organic_domains` and
`maps_domains`, alongside the live Maps call. Dedupe through the existing
`dedupeDomains`, triage through the existing stages.

**Carry the provenance.** Each candidate should record where it was seen and
how well it was doing:

| Field | Why |
|---|---|
| `source` | `organic` \| `map_pack` \| `maps_live` \| `directory` |
| `serpRank` | Organic rank_absolute when it came from an organic SERP |
| `keyword`, `device` | Which query and device surfaced it |

`serpRank` becomes a first-class ranking input: an abandoned domain at organic
position 4 is worth more than an identical one nobody can find.

**Also fix `gbp_leaders` while here.** The column exists and read 0 in every
sampled row. Either it is not populating — in which case a whole GBP signal is
being silently discarded — or it is genuinely empty and should stop being
selected. It has never been investigated.

**Expected yield:** 509 domains, immediately, for $0.00.

---

## 2. Phase 2 — Widen the seed cheaply

Everything here reuses requests already being made, or costs the same as what
it replaces.

**Deeper map pack.** `collectBusinesses` requests `depth: 200`. DataForSEO
bills per *request*, not per result, and accepts up to 700 — so depth 700 costs
the **same $0.002** and returns up to 3.5× the businesses. There is no reason
not to.

**Every keyword variation, not just the niche term.** The sweep already buys a
SERP per variation (8 per niche on current runs). Each variation returns a
different result set, so harvesting all of them multiplies organic coverage at
no extra cost. Today only the niche-level Maps call is used.

**Store more organic results.** `top_organic_domains` is capped at the first
few positions. The full SERP was already purchased and parsed; storing
positions 1–20 rather than the top handful widens the pool for free. Requires a
look at what `normaliseOrganicResult` currently keeps.

---

## 3. Phase 3 — Directories that rank in the SERP

**The question this plan exists to answer:** businesses that no longer appear
in Maps — closed, rebranded, absorbed — are invisible to every source above,
and they are the best targets because the business is definitively gone.

**What is already known, so nobody re-derives it:**

- **BBB cannot be crawled.** `bbb.org` category pages return **403 even through
  DataForSEO**. Not a rate limit, not a user-agent problem. Do not retry this.
- **`dallaschamber.org` returns 200 with no usable markup.**
- **`on_page/instant_pages` returns no `raw_html` at all**, `store_raw_html`
  notwithstanding — verified against `example.com`. Fetching any page's markup
  through DataForSEO needs the task-based On-Page flow
  (`task_post` → `/on_page/raw_html`), which nothing here has used yet.

**Two routes worth testing, in order of expected yield:**

1. **Directory pages that already rank.** Every sweep SERP contains directory
   results (Yelp, YellowPages, Angi, Houzz category pages) for the exact
   niche + city. Those pages list operators, including ones Maps has dropped.
   Yelp and YellowPages are worth a fetchability probe — BBB's 403 does not
   imply theirs. **Unproven:** whether their category pages expose business
   *websites* or only internal profile links. Check before building.

2. **Wayback snapshots of directory pages.** `web.archive.org` does not block.
   Archived Yelp/YP/BBB/chamber category pages from 2014–2019 list businesses
   that no longer exist anywhere else. This is the only known route to
   genuinely defunct operators. **Unproven:** whether archived pages carry
   outbound website links; if they only carry profile links it is a two-hop
   crawl and the yield may not justify it.

Probe both before writing a collector. One `instant_pages` call each is
$0.00015 and answers the question.

---

## 4. Phase 4 — Stop widening, start filtering

A wider net is worthless if the shortlist stays unreliable. Four gates, in
order of how much damage their absence does.

**Spam score — already fetched, never read.** The bulk backlinks call returns
it and the code discards it. Measured on the top 10 candidates: **6 had spam
scores of 37–49**, which makes them liabilities rather than assets. Gate the
shortlist on this before adding a single new source.

```
macfelderplumbing.com   spam 43      matthewjplumb.com   spam 49
plumber-ny.com          spam 44      caracozzaplumbing   spam 46
```

**Existing rankings — the one item in this plan that costs money.**
DataForSEO Labs `ranked_keywords` shows whether a domain still ranks for
anything. A dead domain that retains rankings is worth multiples of one that
does not, and it is the closest thing to a direct measure of the asset.

**Measured by balance delta: $0.012 per domain.** Every other gate in this
phase reuses data already bought. Gate it to the top ~15 by score rather than
running it on the whole shortlist: $0.18/market instead of $0.48.

Worth it on the evidence — `hays-nyc.com`, currently the #3 candidate at score
39.8, ranks for **zero** keywords.

**Anchor-text profile.** Pharma/casino/foreign-language anchors are
disqualifying regardless of age or link count.

**Dofollow vs nofollow.** BBB and YellowPages links are nofollow. The authority
audit currently counts them as citations, which overstates their value —
they are NAP/trust signals, not link equity. Splitting the two changes which
domains look good.

**What the archive years actually mean.** `yearsOfContinuousContent` counts
snapshots that returned HTTP 200 with an HTML mime type. Thirteen years of a
real plumber and thirteen years of a parked page score identically. Sampling
one archived snapshot per candidate and classifying it would separate them.

---

## 5. Phase 5 — Watch, because one probe is a snapshot

Nothing re-checks anything. Two consequences already visible in the data:

- 14 domains expire within 90 days and **13 are `LIVE`** — the watchlist shows
  them, nothing watches them. A business whose registration quietly lapses is
  the strongest signal this system can produce and it will be missed.
- Triage is noisy: `ramarplumbing.com` read `EXPIRING_SOON` on one pass and
  `LIVE` minutes later. `imhandymen.com` flipped too.

**Do:** a daily Trigger.dev scheduled task re-probing everything with
`days_to_expiry <= 90` plus anything whose expiry has passed. Free — DNS, HTTP,
RDAP only. **Require two consecutive agreeing probes before recording a state
change**, or the noise above will generate false lapse alerts.

Record transitions rather than overwriting, so "renewed" and "lapsed" are both
visible.

---

## 6. What "all possibilities" cannot include

Stated so the coverage claim stays honest:

- **A domain nobody links to and nothing ranks** is unreachable by any method
  here. Discovery is bounded by what SERPs, map packs and directories expose.
- **BBB is closed to us.** Its category pages are the single best directory of
  local operators and they return 403.
- **Google resets dropped domains.** A domain that goes through `pendingDelete`
  and is re-registered loses most of its history. Continuity of ownership —
  buying from the owner — preserves far more than catching a drop does. Wider
  discovery does not change this, and it caps what the whole strategy can
  return.
- **Valuable drops never reach retail.** Drop-catchers take anything with real
  metrics within seconds. If a domain reached `AVAILABLE`, that is evidence
  against its value, not for it.

**The implication worth acting on:** the highest-value output of a wider net may
be an **outreach list**, not a purchase list. `BROKEN` (someone stopped caring)
and `EXPIRING_SOON` (someone about to let go) are warmer leads than anything
winnable at auction, and buying from an owner preserves the history a drop
destroys.

---

## 7. Order of work

| Phase | API cost | Yield | Risk |
|---|---|---|---|
| 1 — harvest stored SERP/map domains | **$0.00** | 509 domains now | Wall-clock, see below |
| 4a — spam gate | **$0.00** (already fetched, unread) | Removes ~6/10 bad candidates | None |
| 2 — depth 700, all variations | **$0.00** (billed per request, not per result) | 2–3× seed | None |
| 5 — scheduled re-check | **$0.00** DataForSEO | Catches actual lapses | Trigger.dev compute; needs 2-probe confirmation |
| 4b — rankings gate | **$0.012/domain** → ~$0.18/market gated to top 15 | Separates real assets from dead weight | None |
| 3 — directory + Wayback | $0.00015/page to probe; collector unpriced | Defunct businesses | Unproven; probe first |

### What the whole thing costs per market

| | Cost |
|---|---|
| Today | $0.002 |
| After phases 1 + 2 + 4a (everything free) | **$0.002**, with 3–4× the domains and a spam gate |
| \+ rankings gate on the top 15 | ~$0.18 |
| \+ authority audit (built, unwired) | ~$0.53 |

**Triage itself is free at any volume** — DNS, HTTP, RDAP and Wayback cost
nothing, which is why widening the seed does not widen spend.

**The real constraint on Phase 1 is time, not money.** 509 domains at ~15s each
across 6 workers is ~21 minutes, against a 30-minute `maxDuration` on the
Trigger task. Raise concurrency or the duration before harvesting, or the first
wide run will time out mid-market.

Phases 1 and 4 together are the whole of the near-term value: a much larger
pool, filtered by a gate that already exists in data we pay for. Do them before
anything that adds a request.

---

## Appendix: the accuracy bar this has to clear

Four operator spot-checks found four classes of false positive. Each time the
probe was accurate and the label overreached.

| Reported | Actually | Cause |
|---|---|---|
| `kohler.com` PARKED_DEAD, #2 | Live manufacturer | 10s timeout read as `dead` |
| `borismechanical.com` PARKED_DEAD, #1 in two runs | Broken WordPress (500) | 5xx lumped with 404 |
| `247manhattanplumbingnyc.com` PARKED_DEAD | Broken WordPress (500) | Same |
| 30 rows PARKED_DEAD | Working JS-rendered businesses | 600-char text floor assumed server-rendered HTML; generic phrases ("under construction") matched real copy; bot user-agent got stripped pages |

**27 of 64 `PARKED_DEAD` rows were not dead**, and a later pass moved 30 more to
`LIVE`.

Any new source multiplies whatever error rate the classifier has. **Phase 4
before Phase 3.** And every new source should be spot-checked by hand on its
first run, because every one of these was found that way and none by a test.
