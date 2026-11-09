# Plan: clusters — the unit of work is a page, not a keyword

| Field | Value |
|---|---|
| **Date** | 2026-08-17 |
| **Status** | 📋 Draft, implementing alongside |
| **Goal** | Import the Semrush keyword and cluster research for `hotelhottubs.com`, and change the system's unit of decision from one keyword to one cluster — because a cluster is one page |
| **Source** | `HOTTUBHOTELS/seo/clusters/` — 16 files: 6 Keyword Magic exports (3,090 rows), a hand-clustered standouts file, a cluster→URL architecture file, and five aggregate rollups |
| **Depends on** | [`plan-affiliate-directory-sites.md`](./plan-affiliate-directory-sites.md) (the grid and entity model), [`plan-supply.md`](./plan-supply.md) (the supply join clusters inherit) |

---

## 0. The reframing this plan turns on

The obvious framing is "import the keywords, add a `cluster` column". That is an
afternoon and it would leave the system making the same mistake it makes now.

> **The system decides one keyword at a time. Nothing it decides about is one
> keyword.**

`hotels with jacuzzi in room houston`, `houston hotels with hot tub in room`, and
`in room jacuzzi suites in houston tx` are not three decisions. They are one
page. Today the grid produces three independent `BUILD` verdicts, three
independent value estimates, and no notion of which of the three the title should
target. The work queue overstates the work, the prize overstates the prize, and
the operator has to do the grouping in their head — which is exactly what the
CSVs in `seo/clusters/` are: that grouping, done by hand, in a spreadsheet.

**So a cluster is not "similar keywords". A cluster is one page**, and it becomes
the unit the verdict, the value and the queue are all computed at.

### 0.1 The measurement that decides how a cluster aggregates

The moment clusters exist, something must answer "how much demand is this
cluster worth". The obvious answer — sum the members — is wrong, and this export
says so out loud.

Across the 3,090 rows: **2,359 distinct keywords**, and **109 of them report the
same volume as a longer or shorter variant of themselves.** Four separate rows,
all 590:

```
hot tub hotel rooms          hot tub hotel rooms near me
hotels near me with hot tubs hotels near me with hot tubs in room
```

That is one pool of demand reported four times, because Google groups
near-identical queries and Semrush exports each surface form. Summed, that
cluster claims 2,360 searches for roughly 590 of real demand.

Measured per city against the seed exports:

| City | Keywords | SUM | MAX | Inflation |
|---|---|---|---|---|
| Chicago | 92 | 14,560 | 1,300 | **11.2×** |
| Houston | 34 | 13,780 | 1,900 | **7.3×** |
| Las Vegas | 33 | 5,900 | 1,300 | **4.5×** |

**The inflation is not constant, so it does not cancel out — it REORDERS.**
`city-keyword-opportunity.csv` ranks Chicago above Las Vegas on summed volume.
By max they are identical at 1,300, and the entire gap is how many phrasings
happened to be in the export. A city with a verbose long tail outranks a city
with genuinely more demand, and nothing on the sheet reveals it.

So:

- **`volume_max` is the ranking number.** It is a genuine lower bound: real
  demand is at least the biggest single query in the cluster.
- **`volume_sum` is stored and labelled an upper bound.** Never used to sort,
  never shown without the max beside it.
- The truth is a range, and the system shows the range rather than picking a
  point estimate it cannot defend. Same discipline as break-even being computed
  at both ends of a bid range and only the pessimistic end qualifying a keyword.

### 0.2 A cluster's kind decides what page it becomes

The hand-built `cluster` column is free text with an implicit type prefix, and
the types are doing real work:

| Prefix | Example | Becomes |
|---|---|---|
| `city_` / `state_` / `region_` | `city_houston` | A locality page. Joins to supply |
| `chain_` | `chain_hilton` | A brand filter page. No supply join |
| `head` / `head_near_me` | `head` | The home page or a national hub |
| modifier | `romantic`, `two_person`, `balcony` | A filter or collection page |
| property type | `suites`, `motel`, `resort`, `bnb` | A collection page |
| `vocab_` | `vocab_bath` | Not a page — a phrasing variant of another cluster |
| `data_anomaly` | — | **Not a cluster at all.** A flag on bad data |

`data_anomaly` appearing as a cluster value is the one that would quietly corrupt
things: imported naively it becomes a content cluster with a verdict and a place
in the queue. It is a quarantine label and the importer treats it as one.

Only `city_`/`state_`/`region_` clusters bind to an entity, and therefore only
those inherit the supply gate. A `chain_hilton` cluster has no locality, so
asking whether we have supply for it is a category error — the same one
[`plan-distribution.md`](./plan-distribution.md) §0.3 makes about reels and
keywords.

### 0.3 What the CSVs already got right, and should not be thrown away

`city-demand-vs-inventory-2026-08-05.csv` is a hand-built version of the supply
gate this system now computes automatically — and it carries one idea the system
does **not** have:

```
city,              volume, keywords, verified_stays, status,   stays_needed, unlock_priority
Las Vegas,          5330,  16,       7,              thin,     1,            high — big demand, a few stays short
New York City,      4940,  14,       5,              thin,     3,            high — big demand, a few stays short
New Jersey/North NJ, 6740, 13,       11,             credible, 0,            ACT NOW — indexable today
```

**`stays_needed`** turns "supply gap" from a verdict into an instruction. The
supply model today says *have / none / unknown*; this says *one more listing and
this city unlocks*. That is strictly more actionable and it is cheap to compute
now that supply coverage is live — it is a threshold, not new data.

That threshold is a POLICY, not a measurement, and belongs beside
`DEFAULT_BUILD_DIFFICULTY_CEILING` where it can be argued with.

---

## 1. Schema

```sql
keyword_clusters(
  id, site_id,
  slug,                       -- city_houston, head_near_me
  kind,                       -- locality | brand | head | modifier | property_type | vocab | quarantine
  label,
  primary_keyword_norm,       -- the head term. What the title targets
  entity_kind, entity_slug,   -- locality clusters only. NULL = unresolved, never "none"
  primary_url, supporting_urls jsonb,

  member_count,
  volume_max,                 -- THE ranking number. A lower bound
  volume_sum,                 -- upper bound. Never sorted on
  kd_min, kd_median,
  best_position,

  verdict, verdict_reason, verdict_missing jsonb,
  source, notes,
  created_at, updated_at
)

site_keyword_targets.cluster_id   -- nullable FK. NULL = not yet clustered
keyword_import_runs(...)          -- file, rows, deduped, unresolved, skipped
```

`cluster_id` is nullable and that is load-bearing: an unclustered keyword is
UNKNOWN-clustered, not "its own cluster of one". Auto-promoting singletons would
manufacture 1,000 clusters of one keyword and bury the 40 that matter.

---

## 2. Import

Four shapes, one importer, each recorded with its provenance:

| File(s) | Shape | Handling |
|---|---|---|
| `magic-*.PARTIAL.csv` × 6 | `keyword,intent,relevance,volume,kd_percent,cpc_usd` | **Dedupe across files** — 3,090 rows → 2,359 keywords, 524 appear in more than one seed. Keep max volume, record every seed |
| `keyword-standouts` | adds `cluster`, `why_it_matters`, `source_seed` | Authoritative cluster assignment |
| `near-me-jacuzzi-architecture` | `cluster,primary_keyword,volume,primary_url,supporting_urls` | Authoritative cluster → page mapping |
| the five rollups | city/state aggregates | **Imported as provenance, not as truth.** Recomputed from members |

The rollups are deliberately not trusted: their volume column is the summed one,
which §0.1 shows is inflated 4.5–11.2× and unevenly. Keeping them as a record of
what was believed on 2026-08-05 is useful; treating them as input would import
the bug.

**`city_path` (`/texas/houston`) resolves to the grid's slug (`houston-tx`)** with
the same loud-failure rule as supply ingest: unresolved is counted and reported,
never guessed, never zero.

---

## 3. Cluster verdicts

A cluster's verdict is not a vote of its members' verdicts — it is computed from
the aggregate, because the members are one page:

- **volume** — `volume_max`, per §0.1
- **difficulty** — `kd_min` is the way in (the easiest member is the entry
  point), `kd_median` is the honest picture. Both stored, both shown
- **position** — the BEST member position. If any member ranks, the page ranks
- **supply** — for `locality` clusters only, from `supply_coverage`, with
  `stays_needed` when short

The existing `assessKeyword` and the supply gate are reused verbatim on those
aggregates rather than reimplemented, so a cluster and a keyword cannot drift
into disagreeing about what BUILD means.

---

## 4. UI

`/directories/[domain]` gains **Clusters** as the primary view; the keyword board
becomes the drill-down.

The cluster row shows what a page-level decision needs:

```
verdict   cluster          kind      vol(max)  ⌄sum    kd min/med  supply        keywords
BUILD     city_houston     locality     1,900  13,780      13/20   12 stays          34
IGNORE    city_las_vegas   locality     1,300   5,900       9/23   7 · need 1         33
—         chain_hilton     brand          590   1,200      31/44   n/a                 4
```

Three deliberate choices:

- **`vol(max)` is the column; `sum` is secondary and marked.** Sorting is always
  on max. A screen that sorts on sum reproduces the 11× reordering in §0.1.
- **`supply` shows `stays_needed` when short**, so the row says what would change
  the verdict rather than only what it is.
- **Kind is visible**, because `n/a` supply on a `brand` cluster is correct and
  must not read as a gap.

---

## 5. Order of work

| # | Item | Cost |
|---|---|---|
| 1 | Migration 0027: `keyword_clusters`, `cluster_id`, import runs | $0 |
| 2 | `@rnr/core` cluster aggregation — the max/sum bound, kd min/median | $0 |
| 3 | Importer for the four shapes, with dedupe and loud entity resolution | $0 |
| 4 | Cluster verdicts reusing `assessKeyword` + the supply gate | $0 |
| 5 | Clusters view on the directory page | $0 |
| 6 | `stays_needed` in the supply model | $0 |
| — | Auto-clustering unimported keywords by similarity | Later. The 975 grid rows can be clustered by entity+pattern deterministically, which needs no model |

All free — this is a CSV import and a model change, no vendor calls.

---

## 6. What this cannot do

- **It cannot recover the true demand of a cluster.** Max is a lower bound and
  sum an upper one; the real number is between them and no source available here
  narrows it. The system shows the range instead of inventing a point.
- **It cannot cluster the 975 generated grid keywords by meaning.** They can be
  grouped deterministically by entity and pattern, which is most of the value;
  genuine semantic clustering of the long tail is a separate problem.
- **The imported KD is Semrush's**, on Semrush's scale, and is not the repo's own
  `scoreDifficulty`. Stored in its own column and never silently mixed with it.
- **The rollups are a snapshot of 2026-08-05.** They are kept as provenance and
  will not be refreshed; the live numbers come from members.
