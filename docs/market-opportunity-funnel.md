# Design: Market Opportunity Funnel (Screen → Deep Dive → Target)

| Field | Value |
|---|---|
| **Title** | Two-stage market opportunity: volume screen → Reddit/SERP deep dive → target |
| **Date** | 2026-08-05 |
| **Status** | Draft for implementation |
| **Primary question** | If we leave a lead-gen phone number on a Reddit thread that ranks in local SERPs, will it be seen, and how often / how hard is that opportunity? |
| **Related** | `docs/bulk-market-research-import.md`, Research wizard, catalog import, discovery queue |

---

## 1. Problem

Operators already import:

- **Hundreds of keywords** (Google Ads saved stats — national volume)
- **Hundreds of localities** (home-service geos with DataForSEO codes)

Today the app is strong at **deep research on one market** (buy-intent cluster × devices) but weak at **efficiently finding which markets deserve depth**.

Users need:

1. **Screen** the corpus by demand (volume × geo priority) without buying thousands of SERPs.
2. **Select** top opportunities (default Top 50 keywords × Top 50 geos).
3. **Deep-dive** those cells with SERP metrics that answer the Reddit lead-gen question.
4. A **clear UI path**: import → rank → pick → deep research → target.

---

## 2. Product principle

**Do not buy a SERP to learn volume.** Volume is already on the keyword import (and optionally Google Ads API). SERPs answer **visibility and competitability**, not demand.

| Stage | Question | Data source | Spend |
|---|---|---|---|
| **0. Import** | What keywords & places exist? | CSV/TSV | **$0** |
| **1. Screen** | Where is demand high? | Catalog volume + geo rank/pop | **$0** |
| **2. Deep dive** | Can Reddit comments convert? Who owns the SERP? | DataForSEO organic (+ optional maps/backlinks) | **$** |
| **3. Target** | Operate this cell | Pipeline / Markets / promote | optional |

---

## 3. Simplified UI flow (single mental model)

### Nav (keep simple)

```
Research     ← one page, funnel steps
Pipeline     ← saved opportunities
Markets      ← operating cells
Tracking
Settings
```

### Research page = 3-step funnel (not 5 tool pages)

```
┌─────────────────────────────────────────────────────────────────┐
│ Research                                                         │
│ [1 Import] ──► [2 Screen & select] ──► [3 Deep dive]            │
└─────────────────────────────────────────────────────────────────┘
```

#### Step 1 — Import (free)

- Two dropzones: **Keywords** (Google Ads TSV) · **Markets** (geo CSV)
- Summary chips: `N keywords · M primaries · G purchasable geos · last import date`
- No spend language; CTA: **Continue to Screen**

#### Step 2 — Screen & select (free)

**Demand board** (sortable table / dual lists):

| Keywords (left) | Markets (right) |
|---|---|
| Sort by **national volume** desc | Sort by **selected_rank** / population |
| Filter: primary only, min volume | Filter: purchasable code only, tier |
| Checkboxes or “Top N” presets | Checkboxes or “Top N” presets |

**Selection summary bar (sticky):**

```
Keywords: 50 of 1,273  ·  Markets: 50 of 200
Screen estimate (no SERP): $0
Deep-dive estimate: 50×50×1 device = 2,500 SERPs ≈ $5.00
                    50×50×2 devices = 5,000 SERPs ≈ $10.00
[ Preview deep dive ]  [ Start deep dive ]
```

**Default preset:** Top 50 keywords by `avg_monthly_searches` × Top 50 geos by `selected_rank` (matches existing bulk design).

**Important honesty copy:**

> National keyword volume is **not** city volume. Stage 1 ranks *relative demand proxies*. Stage 2 measures *local SERP reality*.

Optional Stage 1b (later): Google Ads geo-targeted volume for selected cells only — still not a full SERP.

#### Step 3 — Deep dive (paid)

- Dry-run modal: job count, devices, hard cap, budget, “worker/cron will take ~N minutes”
- Progress: run status (pending/running/done/failed), jobs done/total, cost so far
- Results: **Opportunity grid** (see §5)

#### After deep dive → Target

Row actions:

- **Save to Pipeline**
- **Open market** / Start targeting
- **Promote Reddit** (existing promote path)
- **Deepen further** (full buy-intent cluster on one cell — existing market discovery expand)

---

## 4. Stage 1 math (no SERP spend)

### Inputs

- `research_keywords`: `avg_monthly_searches`, `variant=primary` preferred for seed heads  
- `research_geos`: `selected_rank`, `population_2025`, `dataforseo_location_code`

### Demand score (recommended default)

Per **keyword**:

```
kw_score = avg_monthly_searches   // NULLS LAST when sorting
```

Per **geo**:

```
geo_score = -selected_rank        // lower rank = higher priority
// fallback: population_2025 when rank null
```

**Cell proxy demand** (for ranking/sorting selected pairs without a SERP):

```
cell_proxy = kw_score × geo_weight
geo_weight = 1 / max(selected_rank, 1)   // or log1p(population)
```

Stage 1 does **not** materialize full N×M rows in DB if N×M is huge — only **selected** keywords and geos, and optionally a virtual preview of top cells.

### Full cross-product volume “analysis”

Operators sometimes say “all niches × localities traffic.” Interpret carefully:

| Interpretation | How | Cost |
|---|---|---|
| **A. Rank seeds by national volume; rank geos by tier** | Sort catalog only | **$0** |
| **B. Estimate cell demand** as volume × geo weight | Pure math on imports | **$0** |
| **C. True local search volume per city** | Google Ads Keyword Planner geo metrics (if available for that geo) | Ads API quota / low $ |
| **D. SERP for every keyword × every geo** | DataForSEO organic | **Very expensive** (see §6) |

**Recommendation:** Stage 1 = **A + B**. Never default to D for the full corpus.

---

## 5. Stage 2 deep-dive metrics (optimized for Reddit lead-gen)

### North-star question

> Will a comment with our tracking number on a ranking Reddit thread be **seen** and **drive calls**, and how **reachable** is that SERP?

### Metric pack (per keyword × locality × device)

#### A. Reddit opportunity (primary)

| Metric | Definition | Why it matters |
|---|---|---|
| **Reddit on page 1?** | Any reddit.com hit in organic or discussions pack | Entry condition |
| **Reddit absolute rank** | Absolute position including non-organic above | “How high is the thread?” |
| **Reddit organic position** | Position among organics only | Classic SEO rank |
| **Source** | `organic` vs `discussions_and_forums` | Pack vs blue-link visibility |
| **Subreddit** | r/… | Brand safety / fit |
| **Commentable** | open / closed / unknown | Can we post the phone number? |
| **Reddit hit count** | Distinct threads on page 1 | Breadth of surfaces |
| **Best Reddit absolute rank** | Min absolute across hits | Primary sort key for lead-gen |

**Lead-gen visibility score (composite, transparent formula):**

```
reddit_visibility =
  0 if no reddit or not commentable
  else w1 * rank_score(absolute_rank)
     + w2 * (1 if discussions_pack else 0.7 if organic)
     + w3 * commentable_bonus
```

Show components; never hide as a black box.

#### B. SERP clutter / attention competition

| Metric | Definition | Why |
|---|---|---|
| **Ads above organic** | Paid units above first organic | Less organic attention |
| **Local profiles above organic** | Map/local pack count above first organic | Business list absorbs clicks |
| **First organic absolute rank** | Where blue links start | How far down is organic/Reddit |
| **Paid count / organic count** | Layout density | Busy SERP |
| **Discussions pack present** | boolean | Forum-style module exists |

#### C. Competitiveness (can we also rank a site later?)

| Metric | Source | Why |
|---|---|---|
| **Difficulty 0–100** | Existing scorer on organic results (+ backlinks batch) | How hard to rank a site |
| **Median ref domains** (non-platform) | Backlinks bulk | Authority of organic peers |
| **Platform-held slots** | Classify Yelp/Angi/etc. | Soft SERP vs real local cos |
| **Slots open** | Existing component | Room for a new site |

**KD of the query:** we do **not** buy Semrush KD by default. Options:

1. **Proxy KD** = our difficulty score from live SERP (preferred, measured)  
2. Optional import of Semrush KD on keyword CSV (catalog field already can hold competition from Ads)

#### D. Demand (from Stage 1, denormalized onto cell)

| Metric | Source |
|---|---|
| **National volume** | research_keywords.avg_monthly_searches |
| **Geo rank / pop** | research_geos |
| **Proxy demand** | volume × geo_weight |

#### E. Opportunity composite (for sorting the grid)

```
opportunity =
  demand_norm * reddit_visibility * commentable * (1 - ads_local_clutter_norm)
  / max(difficulty_norm, ε)
```

Sortable columns; operator can sort by pure Reddit rank, pure volume, or composite.

### Recommended default view: Opportunity grid

One row = **keyword × locality** (device toggle: Desktop | Mobile | Best of both).

Columns (MVP):

1. Keyword  
2. Market  
3. Volume (nat.)  
4. Reddit? / best abs rank  
5. Commentable  
6. Ads↑ / Local↑  
7. Difficulty  
8. Opportunity score  
9. Status (queued / done / failed)  
10. Actions  

Expand row → Reddit threads table + layout metrics + related searches.

### Deep-dive purchase matrix (default)

| Parameter | Default | Rationale |
|---|---|---|
| Keywords | Top 50 by volume (primary) | Demand |
| Geos | Top 50 by selected_rank | Market priority |
| Devices | **Desktop only** for screen-depth | Cost; mobile optional pass |
| Near-me | **Off** for bulk | Cost; on for single-cell deepen |
| Depth | 10 (page 1) | Reddit visibility is page-1 game |
| Backlinks | **Batch after SERP** for top organics only | DA/ref domains for difficulty |
| Maps live | **Optional** phase 2 | Local pack already partly in organic layout |

**Default bulk deep dive:**  
`50 × 50 × 1 device × 1 keyword form = 2,500 jobs ≈ $5.00`

Optional dual-device: `5,000 jobs ≈ $10.00` (existing hard cap).

---

## 6. Cost estimates (DataForSEO organic live = **$0.002**/job)

### Unit costs

| Item | Unit price |
|---|---|
| Organic live advanced | **$0.002** |
| Maps live | $0.002 |
| Backlinks bulk request | $0.024 + $0.000036/row |
| Instant page (commentability) | $0.00015 |

### Stage 1 — full catalog screen

| Action | Jobs | Cost |
|---|---|---|
| Import keywords + geos | 0 | **$0** |
| Sort Top 50×50 | 0 | **$0** |
| “All niches × all geos” volume proxy table | 0 | **$0** |

### Stage 2 — deep dive scenarios

Assume **one keyword string per cell** (seed head, not full HVAC cluster).

| Scenario | Formula | Jobs | Live cost |
|---|---|---|---|
| **Recommended: Top 50×50 desktop** | 50×50×1 | **2,500** | **$5.00** |
| Top 50×50 dual device | 50×50×2 | **5,000** | **$10.00** |
| Top 20×20 desktop | 20×20 | 400 | **$0.80** |
| Top 10×10 dual device | 10×10×2 | 200 | **$0.40** |
| Full 600 primaries × 200 geos desktop | 600×200 | **120,000** | **$240** |
| Full 1,200 KW × 200 geos desktop | 1,200×200 | **240,000** | **$480** |
| Full 1,200 × 200 × 2 devices | 480,000 | **$960** |
| Single market deep cluster (HVAC-style) | ~24 KW × 2 devices | ~48 | **~$0.10** |
| 50 markets × HVAC cluster desktop | 50×24 | 1,200 | **$2.40** |
| 50×50 cells then + cluster deepen on top 10 cells | 2,500 + 10×48 | 2,980 | **~$5.96** |

### Full corpus SERP (what not to do by default)

| | |
|---|---|
| 300 keywords × 200 geos × 1 device | 60,000 × $0.002 = **$120** |
| Same × 2 devices | **$240** |
| Plus maps on each | **+$120–240** |

**Hard product rule:** Keep `DEFAULT_MAX_JOBS = 5000` ($10) for bulk deep dive unless operator explicitly raises cap with dry-run confirmation.

### Add-ons

| Add-on | Approx. cost on 2,500-cell run |
|---|---|
| Commentability probe on each Reddit URL (instant pages) | ~1–3 pages/cell × 0.00015 → typically **&lt; $1** if only cells with Reddit |
| Backlinks bulk on top 10 organics × 2,500 cells | Batch carefully: prefer **one bulk per run** on unique domains, not per cell × domain; order **$1–20** depending on unique domain count |
| Maps live every cell | +**$5** at 2,500 cells |

### Google Ads

| | |
|---|---|
| Volume already in import | **$0** extra |
| Live Keyword Planner refresh | API free/quota; not DFS $ |

---

## 7. Backend design (reuse, don’t fork)

### Stage 1

- Existing: `research_keywords`, `research_geos`, import services  
- New: `listScreenCandidates(db, { topKeywords, topGeos, filters })`  
- New: `previewDeepDive(db, selection) → jobCount, cost, selectionNote`  
- Optional table later: `opportunity_selections` (saved Top-N presets)

### Stage 2

- Reuse **`enqueueCatalogBulkResearch`** / discovery_jobs with:
  - `source = 'catalog'` or new `source = 'opportunity_screen'`
  - selected keyword IDs + geo IDs
  - `includeNearMe: false`, devices default `['desktop']`
  - hard cap 5000  
- Extend metrics already in `discovery_serp_metrics` + `discovery_hits`  
- Add **opportunity rollup view** (query): one row per keyword×geo with best desktop metrics

### Stage 3

- Existing Pipeline shortlist + Markets targeting + promote Reddit  

### Worker

- Same cron drain; bulk 2,500 jobs ≈ **~40–90+ minutes** at 1 SERP/cron minute if only one job per drain — **must** raise drain throughput (multiple discovery jobs per cron invocation within 45s budget) before shipping bulk as UX-default.

**Implementation requirement:** drain **N discovery jobs per cron** until ~40s budget (e.g. 10–15 SERPs/min) so 2,500 jobs finish in ~3–4 hours max, not 40 hours.

---

## 8. Implementation PR plan

### PR A — UI funnel shell (no new spend)

- Research page steps: Import | Screen | Deep dive results  
- Collapse wizard “single cell” under **Deepen one market** advanced  
- Demand board: top keywords / top geos with Top-50 presets  
- Dry-run cost calculator (client math + server preview)

### PR B — Bulk deep dive wire-up

- Enable bulk enqueue from Screen selection (behind confirm)  
- `RESEARCH_BULK_ENABLED=true` after canary  
- Opportunity grid from discovery metrics + catalog volume join  
- Multi-job cron drain improvement  

### PR C — Reddit lead-gen score + promote UX

- Composite visibility score  
- Commentable batch (on_promote or sample)  
- Sort by “best Reddit comment opportunity”  

### PR D — Optional competitiveness enrich

- Backlinks batch for difficulty on deep-dive results  
- Optional maps live toggle  

---

## 9. Success criteria

| Criterion | Target |
|---|---|
| Time to select Top 50×50 after import | &lt; 2 minutes, $0 |
| Cost of default deep dive | **$5** desktop / **$10** dual-device max default |
| User understands Stage 1 ≠ local volume | Copy on Screen step |
| Primary sort answers Reddit lead-gen | Best Reddit abs rank + commentable first-class |
| No accidental full-grid $240 spend | Hard cap + dry-run |

---

## 10. Summary recommendation

1. **Stage 1 free:** sort imported keywords by volume, geos by rank → pick Top 50×50.  
2. **Stage 2 paid:** one geo-targeted SERP per cell (desktop default) → Reddit + ads/local clutter + difficulty.  
3. **Stage 3:** save/target/promote.  
4. **Single-cell HVAC cluster** remains the “go deep on one winner” tool (~$0.10).  
5. **Never** run full corpus × dual device as default (**$240–$960**).

**Default spend path:** $0 screen → **$5** deep dive (2,500 SERPs) → optional **~$1–3** deepen top cells with full intent clusters.
