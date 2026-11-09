# Plan: SERP coverage — visualising which surfaces we hold, and which we don't

| Field | Value |
|---|---|
| **Date** | 2026-08-17 |
| **Status** | 📋 **Draft for review.** Nothing built |
| **Goal** | See every keyword and cluster we target, and for each one which SERP surfaces we occupy — organic, the Discussions and Forums pack, video, images, Maps, AI Overview — as a list *and* as something you can read at a glance |
| **Depends on** | [`plan-clusters.md`](./plan-clusters.md) (the unit of work), [`plan-supply.md`](./plan-supply.md) (the gate), [`plan-distribution.md`](./plan-distribution.md) (the asset ledger this measures the *result* of) |

---

## 0. The reframing this plan turns on

The request sounds like a progress bar: *how far along are we on each keyword?*
Progress implies a finish line, and the first job of this plan is to say what the
finish line actually is — because the obvious answer is wrong in a way that would
quietly bend every decision downstream.

> **A SERP is not a ranking. It is a board with a dozen surfaces, and we either
> hold a slot on each or we don't.**

`hotels with jacuzzi in room chicago` does not return ten blue links. It returns
an AI Overview, a Maps pack, a Discussions and Forums pack full of Reddit
threads, an images strip, a video carousel, People Also Ask, and *then* organic
results. "Are we ranking?" collapses all of that into one number about one
surface. The honest question is **which of these surfaces do we appear on**, and
that question has a natural visual form — a grid — which is also why this is
answerable as a picture rather than a table of positions.

### 0.1 We already buy this data and throw it away

`runDifficultyPass` calls `extractSerpLayoutMetrics(f.raw)` on every SERP it
purchases — a function that already returns the discussions pack, the maps block,
paid and LSA counts, related searches, AI Overview, People Also Ask, and
`itemTypes`, the raw list of every block Google returned.

Then it stores this:

```ts
const layout = extractSerpLayoutMetrics(f.raw)
await db.update(siteKeywordTargets).set({
  difficulty: difficulty.difficulty,
  difficultyMeasuredAt: now,
  hasAiOverview: layout.hasAiOverview,   // ← one boolean, of about twenty fields
  updatedAt: now,
})
```

**The SERP is already paid for and the surfaces are already extracted.** The
visualisation everybody wants is mostly a matter of keeping what we currently
discard. `discovery_serp_metrics` proves the shape works — it persists
`itemTypes`, `discussionsPackPresent`, `redditHitCount`, `bestRedditRankAbsolute`
and `topOrganicDomains` — it just does it for the local pipeline, not for
directory keywords.

That makes items 1–2 of this plan close to free, and it is the reason to do this
before anything more elaborate.

### 0.2 Every cell has FOUR states, and three of them look like "no"

This is the design decision the whole visualisation rests on. For one keyword ×
one surface:

| State | Meaning | Reads as |
|---|---|---|
| **HELD** | The surface exists and we occupy a slot | ● |
| **THEIRS** | The surface exists, someone else holds it | ○ |
| **ABSENT** | Google does not return this surface for this query | · |
| **UNMEASURED** | We have never bought a SERP for this keyword | �many |

A heatmap that paints "not held" as one empty cell merges the last three, and
they are completely different instructions: THEIRS is *go compete*, ABSENT is
*there is nothing to win here*, UNMEASURED is *go spend $0.003 and find out*.

This is the repo's founding rule — never let an unmeasured signal read as a
measured one — applied to a grid. It also has teeth here that it does not have in
a table, because a grid **invites** the eye to read empty as bad, and at 2,363
keywords the overwhelming majority of cells are UNMEASURED today.

The dataviz guidance points the same way: four states is a **status** encoding,
not a sequential one, and status colours "ship with an icon + label, never colour
alone." So cells carry a glyph, and colour is the secondary channel.

### 0.3 The danger in making it a game

The request for a game-like view is a good instinct — a grid of held/not-held is
genuinely more legible than a list of ranks — and it carries one specific risk
worth naming before any pixels exist:

> **Occupancy is a proxy. Making it a score invites optimising the proxy.**

Owning five surfaces on a keyword with 20 searches a month is worth less than one
organic slot on a keyword with 1,900. A completion percentage sorted descending
would put the first above the second, permanently, and it would feel like
progress.

So: **there is no single "coverage score" anywhere in this design.** Completion is
always shown *beside* demand, never multiplied into one number, and the default
sort is `volume_max` — the same lower bound the cluster board already sorts on for
the same reason. The game framing is allowed to make the board readable; it is not
allowed to become the objective function.

---

## 1. What already exists

| Piece | Where | State |
|---|---|---|
| Full SERP layout extraction | `@rnr/core extractSerpLayoutMetrics` | **Built.** ~20 fields, one persisted for directories |
| Surface persistence, for the local pipeline | `discovery_serp_metrics` | **Built.** The shape to copy |
| Reddit thread + our-comment tracking, with decay | `serp_targets` / `serp_checks` | **Built.** `serpSourceKind`, `serpPackPosition`, three-state `commentPresent` |
| Our own organic position | `site_keyword_targets.position` (GSC) | Built, blocked on `GSC_REFRESH_TOKEN` |
| Clusters as the unit of work | `keyword_clusters` | **Built.** 228 clusters |
| A CSS vocabulary for SERP surfaces | `.serp-type-organic/-discussions/-maps/-ads/-perspectives` | **Built** |
| **Per-surface OWNERSHIP** | — | **Missing — §3** |
| **Any of the visualisations** | — | **Missing — §4-5** |

---

## 2. The surfaces worth tracking

Taken from what DataForSEO actually returns in `itemTypes`, filtered to what we
can plausibly occupy:

| Surface | Can we hold it? | How |
|---|---|---|
| **Organic** | Yes | A page on our domain |
| **Discussions & Forums** | Yes | A Reddit thread we posted or commented in |
| **Images** | Yes | Pinterest pins, our own image results |
| **Video** | Yes | YouTube, Reels indexed into the carousel |
| **Maps / Local pack** | No, for a directory | We are not a local business. Tracked as ABSENT-by-design |
| **AI Overview** | Cited, not held | Track *citation*, which is a different and weaker claim |
| **People Also Ask** | Yes | A page answering the question |
| **Top stories** | Rarely | Track presence only |
| **Paid** | Yes | The ads plan already models this |

**Ownership is decided by domain match**, which is the one genuinely new
measurement: `topOrganicDomains` already tells us who holds organic; the same
logic per surface tells us who holds the rest. For Reddit, ownership is
*our comment in that thread*, which `serp_checks` already answers with its
three-state `commentPresent`.

---

## 3. Schema

```sql
serp_surface_observations(
  site_id, keyword_norm, cluster_id,
  measured_at, location_code, device,
  surface,                      -- organic | discussions | images | video | paa | ai_overview | maps | paid
  present boolean,              -- did Google return this surface at all?
  our_rank int,                 -- NULL + present = surface exists, we are absent
  our_url text,
  holder_domains jsonb,         -- who does hold it
  block_rank_absolute int,      -- where the surface sits on the page
  source                        -- which purchased SERP this came from
)
```

One row per (keyword, surface, measurement) rather than a wide table with twenty
columns: surfaces come and go as Google changes, and a row-per-surface absorbs a
new one without a migration. It is also what makes "when did we lose the
discussions pack" answerable, which a wide current-state table cannot do.

`present` and `our_rank` together encode the four states of §0.2 without a
nullable enum: `present=false` → ABSENT; `present=true, our_rank=null` → THEIRS;
`our_rank` set → HELD; **no row at all** → UNMEASURED.

---

## 4. The visualisation options — all of them, and what each is good for

The request asked for options, so here is the full field, including the ones I
would not build.

### 4.1 Coverage matrix (keyword × surface heatmap) — **recommended, primary**

Rows are clusters or keywords, columns are the ~8 surfaces, cells are the four
states.

**Why it wins:** the data's job is *identity of state across two dimensions*, and
a grid is the only form that shows every keyword and every surface at once
without aggregation. It is also the form the whole industry converged on —
Semrush Position Tracking's *SERP Features* report, Advanced Web Ranking's
feature tracking, and Ahrefs' SERP overview are all this grid, because it is the
one layout that answers "where am I missing" in a single glance.

**Cost:** rows are limited by screen height; past ~50 rows it needs virtual
scrolling or grouping by cluster.

### 4.2 Completion meter per cluster — **recommended, secondary**

A small track showing *held / available* — where **available excludes ABSENT
surfaces**, so a keyword with no video carousel is not penalised for not being in
one. The dataviz guidance is explicit that a single ratio against a limit is a
**meter**, not a pie or a one-bar chart.

Shown next to `vol (max)`, never multiplied by it (§0.3).

### 4.3 Share-of-voice / pixel share — **strong, later**

Nozzle and Authoritas pioneered measuring the **pixel area** of the SERP you
occupy rather than your rank, on the argument that position 1 below an AI
Overview, a Maps pack and a video carousel is not position 1 in any meaningful
sense. It is the most intellectually honest metric in this space.

**Why later:** it needs the pixel geometry of each block, which DataForSEO gives
only partially (`rank_absolute` ordering, not heights). A credible version needs
rendered screenshots or a height model per block type, and a *guessed* height
model would produce a confident number nobody can check — worse than not having it.

### 4.4 Bump chart / rank movement over time — **recommended, once history exists**

Lines of rank over time across keywords. The right form for *trend*, and it is
the only view that answers "is what we did working". Requires several
measurements per keyword; useless on day one, valuable in month three.

Cap at ~8 series and use emphasis (one highlighted, rest gray) rather than eight
categorical hues.

### 4.5 Small multiples of the SERP itself — **recommended, on the drill-down**

A miniature of the actual SERP layout for one keyword: stacked blocks in page
order, ours highlighted. This is the view that makes "we are #1 organic but
organic starts at 1,400px" obvious without any pixel-share arithmetic. One per
keyword, on demand.

### 4.6 Treemap / marimekko of demand × coverage — **rejected**

Area-encoded volume, shaded by coverage. Looks impressive; area is
famously hard to compare, and the volume numbers here are already a range
(max vs sum) rather than a point, so encoding them as area asserts a precision we
do not have.

### 4.7 Skill tree / tech tree — **rejected**

The game metaphor the request most evokes. It implies **dependency** — unlock A to
reach B — and keywords do not have that structure. A tree would be a decorative
lie about causality, and this repo's §0 in the distribution plan already refuses
to imply causation it cannot support.

### 4.8 GitHub-style contribution heatmap — **rejected for the main view**

Density over time is the wrong axis. Our question is coverage across *surfaces*,
not activity across *days*. Would be reasonable much later for publishing cadence.

### 4.9 Radar / spider chart per keyword — **rejected**

Eight surfaces around a circle. Radar charts make area meaningless (it depends on
axis order), and comparing two keywords means overlaying two blobs. A row in the
matrix does the same job and can be scanned a hundred at a time.

### 4.10 Single "coverage score" leaderboard — **rejected, deliberately**

The most game-like option and the one §0.3 exists to refuse. It would rank a
20-search keyword with five surfaces above a 1,900-search keyword with one.

---

## 5. The screen

`/directories/[domain]` gains a **Coverage** view beside Clusters and Keywords.

```
                      org   disc   img   vid   paa   ai   │ held  vol(max)  supply
city_chicago           ○     ●      ·     ○     ○     ◐   │ 1/5     1,300   4 · need 1
city_houston           ○     ○      ○     ·     ●     ·   │ 1/4     1,900      22 ok
head                   ○     ●      ○     ○     ●     ◐   │ 2/5    18,100        n/a
city_gatlinburg        ▪     ▪      ▪     ▪     ▪     ▪   │  —        590     unknown

●  we hold it     ○  someone else holds it     ·  surface not on this SERP
◐  cited, not held (AI Overview)      ▪  never measured — no SERP bought
```

Four deliberate choices:

- **Glyph first, colour second.** Status encoding, per the dataviz rules; also
  survives colourblindness, print and a screenshot pasted into Slack.
- **`held` is n/m, never a percentage**, and m excludes ABSENT surfaces. A
  denominator is what makes a count interpretable — the same reason
  `comment_total` sits beside `comment_rank`.
- **A fully unmeasured row shows `—` for held**, not `0/6`. Zero-of-six is a
  claim; we have not made a measurement.
- **Sorted on `vol (max)`.** Never on coverage (§0.3).

Row grouping follows clusters, because a cluster is one page and therefore one
thing that either holds a slot or does not.

---

## 6. Cost, and the thing that constrains the whole design

Every cell in this matrix comes from a purchased SERP. That is the binding
constraint and it should shape expectations before anyone falls in love with a
picture:

- 2,363 keywords is **~2,363 SERP purchases** for one full sweep.
- Surfaces move. A monthly re-sweep multiplies that by twelve a year.
- Clusters make this tractable: **228 clusters, measured at their primary keyword,
  is a ~90% reduction** and is the right default — the cluster is the page, so the
  page's SERP is the one that matters.

So the plan measures **clusters, not keywords**, by default; keyword-level
coverage is a drill-down you request for a cluster you are actually working on.
The matrix will be mostly `▪` for a long time, and that is honest rather than a
defect — it is what makes the "go spend $0.003 and find out" cell actionable.

---

## 7. Order of work

| # | Item | Cost |
|---|---|---|
| **1** | **Stop discarding the layout** — persist all of `extractSerpLayoutMetrics`, not just `hasAiOverview` | $0 — the SERP is already bought |
| **2** | `serp_surface_observations` + ownership by domain match | $0 |
| 3 | Coverage matrix on the directory page (§5) | $0 |
| 4 | Completion meter per cluster, beside demand | $0 |
| 5 | Cluster-level sweep command, priced and capped | $ per SERP |
| 6 | Reddit ownership from the existing `serp_checks` three-state | $0 |
| 7 | SERP small-multiple on the cluster drill-down (§4.5) | $0 |
| 8 | Bump chart, once two sweeps exist | $0 |
| — | Pixel share (§4.3) | Later — needs a height model nobody can check yet |
| — | Any single coverage score | **Never.** §0.3 |

**Items 1–4 are free and use SERPs already purchased.** Item 1 alone turns every
past difficulty pass into coverage data retroactively, for nothing.

---

## 8. What this cannot do

- **It cannot tell you a surface is winnable.** Holding organic and not video may
  mean the video carousel is all major brands. The matrix shows the gap; it does
  not price it.
- **A SERP is a snapshot from one location on one device.** Surfaces differ by
  both. Every observation carries `location_code` and `device` and must not be
  compared across them.
- **AI Overview citation is not occupancy**, and is tracked as its own state for
  that reason. Being cited in a box that answers the query may still cost the click.
- **Nothing here measures traffic.** Occupancy is upstream of clicks, and Search
  Console is the only thing that closes that loop.
- **The matrix will be mostly unmeasured**, indefinitely, unless SERPs are bought
  deliberately. That is a budget decision the picture makes visible rather than one
  it solves.
