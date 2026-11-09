# Plan: distribution — what we published, where, and what it actually did

| Field | Value |
|---|---|
| **Date** | 2026-08-17 |
| **Status** | 📋 **Draft for review.** Nothing built |
| **Goal** | One ledger of every asset we publish — pages, Reddit comments, reels, LinkedIn posts — bound to the entities and keywords it targets, measured by Search Console and GA4 where measurement exists, and joined to supply so we stop producing content for markets we cannot fulfil |
| **Depends on** | [`plan-supply.md`](./plan-supply.md) (the supply read model this queries), [`plan-affiliate-directory-sites.md`](./plan-affiliate-directory-sites.md) (the keyword grid and entity model) |
| **Answers** | "Is the directory system already in the tool?" — **yes, and more of this than you'd expect.** See §1 |

---

## 0. The reframing this plan turns on

The system now knows two of the three things it needs. It knows **what to want** — the
keyword grid, with demand measured. It knows **what it can fulfil** — supply coverage,
as of last week. It has no idea **what we already did about any of it.**

> **Every surface in this request is the same object: an asset we published,
> pointed at something, hoping to move a ranking.** A city page, a Reddit
> comment, a reel, a LinkedIn post. The differences that feel large — which
> platform, which format — are mostly cosmetic. The difference that is *not*
> cosmetic is whether anything can measure the result.

So the shape is one ledger, not five integrations. But the ledger has a failure mode
that has to be designed against from the first table, because it is the whole reason
this feature can go wrong:

### 0.1 An effort ledger is not an attribution model

The tempting screen shows *"6 assets targeting `hot tub suites scottsdale`"* beside
*"rank 14 → 4"*. Nobody writes the word "caused" and everybody reads it.

This repo has already bought that lesson at full price. `plan-paid-search.md` §0 exists
because predicting paid-search profit from observational data reliably produces
optimistic, wrong answers; `assessPaidKeyword` refuses to claim it knows a conversion
rate; `DEFAULT_BUY_MARGIN` is 2× *specifically* because Lewis & Rao measured median ROI
confidence intervals over 100 percentage points wide. The same statistics apply here and
are worse, because organic rank moves on a competitor's schedule, not ours.

**So the ledger records effort and measures outcome, and never joins them into a causal
claim.** Concretely, three rules that the schema enforces rather than the UI:

- No `impact` column. No "assets → rank delta" chart. Rank history and asset history are
  two series on one timeline, adjacent and unmultiplied.
- Where a causal question genuinely matters, the answer is a **holdout**, not a
  correlation — and `assignClusters` / `assessFeasibility` in `ads/experiment.ts` already
  do exactly that for paid. The honest organic version is: publish to 30 of 60 comparable
  markets, hold 30 back, compare. That is a real experiment and it is the only thing here
  that would support the word "caused".
- The one number that *is* causal and cheap: **referral sessions and conversions** from
  GA4, by source. A Reddit comment that sent 40 sessions sent 40 sessions. That is
  measured, not inferred.

### 0.2 Only two of these surfaces measure the outcome we care about

| Surface | What it measures | Is that our outcome? |
|---|---|---|
| **Search Console** | query → **page** → position, clicks, impressions | ✅ Yes. This is the outcome |
| **GA4** | landing page sessions, referral source, conversions | ✅ Yes. This is the money |
| **DataForSEO SERP check** | does our Reddit thread rank, and where | ✅ Yes — already built, see §1 |
| LinkedIn impressions | LinkedIn's engagement | ❌ No |
| Reel views | Instagram's engagement | ❌ No |
| Upvotes | Reddit's engagement | ❌ No |

The bottom three are not worthless — they are just not what this system optimises, and
putting them in the same column as clicks makes them look like they are. They are stored
as `platform_metrics` jsonb, displayed in their own section, and **excluded from every
ranking, sort and verdict**. Same discipline as `serp_keywords` being explicitly labelled
an import-time snapshot rather than a measurement.

### 0.3 "A reel targeting a keyword" is a category error — bind to entities instead

An Instagram reel does not rank for `hotels with hot tubs in room las vegas`. It cannot;
Google does not index it into that SERP. A Reddit thread genuinely does — that is the
entire premise of the existing discovery pipeline, and `serp_checks.serp_pack_position`
tracks its place in the Discussions and Forums pack. A LinkedIn post occasionally does.
A page on our own site does, by construction.

So the binding is:

```
   every asset  ──targets──►  ENTITY   (las-vegas-nv, bpc-157, a specific property)
   indexable assets only ──►  KEYWORD  (and only then does rank mean anything)
```

This is not pedantry, it is what makes the reel row *useful*. Bound to a keyword, a reel
is a row that can never have a position and will read as a permanent failure. Bound to
`las-vegas-nv`, it sits beside the city page, the three Reddit comments and the supply
count for that market — which is the actual unit of work — and its honest measurement is
referral sessions, not rank.

The entity vocabulary already exists and is already shared by both other models:
`site_keyword_targets.entities` and `supply_coverage.entity_slug`. Reusing it is what
makes §5 a three-way join instead of a new join.

---

## 1. What already exists — and it is more than you'd think

**Yes, the directory system is implemented.** `SiteKind: 'affiliate'`, keyword spaces
with geo/entity dimensions, `upsertAffiliateSite`, and both sites are live in the
database with `hotelhottubs.com` running a 5-pattern × 195-locality grid.

The more useful surprise is the second row:

| Piece | Where | State |
|---|---|---|
| Directory sites, keyword grid, entity dimensions | `sites.kind='affiliate'`, `site_keyword_targets` | **Built.** hotelhottubs + borenhealth live |
| **Reddit asset tracking, with decay detection** | `serp_targets` + `serp_checks` | **Built — see below.** This is 80% of the "what Reddit posts have we commented on" ask |
| Supply coverage per entity | `supply_coverage` | **Built and pulling from production** |
| Search Console client | `providers/google/search-console.ts` | **Built, but `dimensions: ['query']` only** — §3 |
| Per-keyword verdicts, economics, supply gate | `assessKeyword`, `resolveKeywordEconomics` | Built |
| Holdout machinery for real causal claims | `ads/experiment.ts` | Built for paid; reusable for §0.1 |
| **Our own pages as first-class rows** | — | **Missing — §4** |
| **GA4** | — | **Missing — §6** |
| **LinkedIn / reels / non-indexable assets** | — | **Missing — §7** |

### 1.1 `serp_targets` is already the asset ledger, for one platform

Read the table comment: *"A URL watched for a keyword — in practice a Reddit thread you
commented on."* It carries `platform` (defaulting to `'reddit'`, so the generalisation
was anticipated), `comment_permalink`, `comment_id`, a `next_check_at` queue claimed with
`FOR UPDATE SKIP LOCKED`, and `serp_checks` records per check:

- `serp_position`, `serp_pack_position`, `serp_source_kind` — where the thread ranks,
  organic vs Discussions and Forums, kept apart
- `our_domain_position` — our own site's rank for the same query, free from the same call
- `comment_rank` / `comment_total` — our comment's ordinal *and its denominator*
- `comment_present` — **three-state**, with an explicit rule that a block page or a fetch
  failure must produce `null`, never `false`, because *"telling someone their comment was
  removed when Reddit merely blocked us is the worst thing this feature can do"*

That last one is the decay problem already solved. Every other platform in this plan
needs the same treatment and should copy it rather than reinvent it.

**What it cannot do:** it hangs off `serp_keywords` — the import-time Semrush snapshot —
not off `site_keyword_targets`, the directory grid. So today the grid cannot see a single
one of these assets. That gap is §2.

---

## 2. The one hard structural decision: two keyword tables

`serp_keywords` and `site_keyword_targets` both mean "a keyword for a site", and the
schema comment is explicit that this was deliberate: the first is *"an IMPORT-TIME
SNAPSHOT — Semrush's numbers at import time, never refreshed"*, the second *"is the
opposite: it is refreshed, it is the measurement, and it carries a verdict."*

That distinction is still right. But assets currently attach only to the snapshot, so the
directory grid — the thing with verdicts, entities, economics and supply — is blind to
every Reddit comment we have ever posted.

Three options, and the third is the one to take:

| Option | Verdict |
|---|---|
| Merge the tables | ❌ Destroys a distinction the repo made on purpose and would rewrite the local lead-gen pipeline for a directory feature |
| Duplicate assets into a second table | ❌ Two ledgers of the same asset diverge silently. This is precisely the `sites.status` vs `shortlist_items.state` failure, and `plan-supply.md` §0.2 refused it once already |
| **Attach assets to the ENTITY, and resolve keywords through it** | ✅ |

Assets bind to `(site_id, entity_kind, entity_slug)` — the vocabulary both grid and supply
already share — plus an **optional** `keyword_norm` for indexable assets. A keyword row and
an asset row then meet through the entity, no foreign key between the two keyword tables
is needed, and `serp_targets` keeps working untouched for local lead-gen.

Migration for the existing Reddit rows is a backfill, not a rewrite: parse each
`serp_keywords.keyword` for entity tokens with `matchEntities` (boundary-safe, already
built), and record `entity_slug = null` where it does not resolve — **unresolved, never
guessed**, exactly as supply ingest does.

---

## 3. Search Console: add the `page` dimension (the highest-value change in this plan)

`fetchSearchConsoleQueries` requests `dimensions: ['query']`. Adding `'page'` costs
nothing — same free API, same quota — and it is what answers the question as asked.

It also produces three findings the system cannot currently see at all:

1. **Which page ranks for which query.** The literal ask.
2. **Cannibalisation.** Two of our pages appearing for one query, splitting authority.
   This is common on a 195-locality grid built from 5 near-identical patterns, and it is
   invisible without the page dimension.
3. **Intent drift.** A page built for `hot tub suites scottsdale` that actually earns its
   clicks on `scottsdale hotels with private pools`. That is a keyword we did not know we
   had, and a page whose title is now wrong.

Worth knowing before building: the 16-month window (no history before you start
collecting — **so start collecting now, even before the rest of this is built**), 25k rows
per request, and Google's privacy filtering silently omits low-volume queries. That last
one matters: an absent query is `UNKNOWN`, not zero impressions, and the same
`stampMeasuredAbsence` discipline used for ranked keywords applies.

---

## 4. Pages as first-class rows

```sql
site_pages(site_id, url, path, title, entity_kind, entity_slug,
           first_seen_at, last_crawled_at, status, canonical_url, noindex)
site_page_queries(page_id, keyword_norm, clicks, impressions, position,
                  measured_at, source)   -- from GSC, per date range
```

Populated from three sources, and which one found a page is recorded:

- **GSC** — pages that earn impressions. Authoritative for "does this rank".
- **Sitemap / crawl** — pages that exist. The difference between this set and the GSC set
  is *pages we published that earn nothing*, which is a report nobody can run today.
- **The supply feed** — every `SupplyItem.url` is a page on the directory. §5.

`entity_slug` on a page is what lets a city page, its Reddit comments, its reels and its
supply count appear as one row.

---

## 5. The three-way join, and the cell that is costing money

`plan-supply.md` §0.1 crossed demand against supply. Adding effort makes it a cube, and
the interesting cells are the ones where effort is misplaced:

| Demand | Supply | Effort | Verdict |
|---|---|---|---|
| ✅ | ✅ | ❌ | **BUILD NOW** — the work queue, ordered by demand × supply depth |
| ✅ | ✅ | ✅ but no rank | **DIAGNOSE** — we tried and it did not work. The only cell where more content is probably the wrong answer |
| ✅ | ❌ | ✅ | ⛔ **WASTED WORK** — content produced for markets we cannot fulfil |
| ✅ | ✅ | ✅ + ranks | **DEFEND** |
| ❌ | ✅ | — | Keyword gap (already reported by `supply board`) |

**The wasted-work cell is the one to build first**, because it is the only one that is
retrospective — it counts effort *already spent*, in hours and posts, on markets with no
inventory. Everything else in this plan tells you what to do next; that cell tells you
what to stop.

It also has a live example waiting: today **4,424 of 5,828 suppliers are unresolved**, so
most of the portfolio's actual inventory is `UNKNOWN` supply. Until the geo corpus is
expanded (200 markets vs 2,301 cities of real inventory), this cell must read `UNKNOWN`
rather than `WASTED` — an unresolved market is not a market with no hotels, and firing a
"stop working on this" verdict off an importer gap would be the most expensive possible
version of this feature's core mistake.

### 5.1 Querying supply through the API we just built

Coverage is already local (`supply_coverage`, refreshed by `supply pull`), so the join is
a local read — not an HTTP call per row. What the feed adds here is **per-item** data the
coverage roll-up does not carry: a page for a specific property, the affiliate URL that
page should link to, the price range a reel should quote.

`searchSupplyItems` already serves exactly that and is already exposed to agents through
the MCP server, so the drafting path in §8 gets it for free.

---

## 6. GA4 — where off-site effort becomes money

The Data API is free, and gives two things nothing else here can:

- **Landing-page sessions and conversions.** Joins to `site_pages.path`, turning "this
  page ranks #4" into "this page earns".
- **Referral source and medium.** The only honest measurement of a Reddit comment, a
  LinkedIn post or a link in a reel bio — *did anyone actually come through it*.

**Tag every off-site link with a UTM at publish time**, and the ledger's `published_url`
carries the tag it was published with. Retrofitting attribution to an untagged link is
impossible, which makes this the one part of the plan with a deadline: links published
untagged this month can never be measured.

Conversions require the affiliate side to report back, which
`plan-affiliate-economics.md` §8.8 already names as an open gap. Until then GA4 measures
sessions, and sessions are labelled as sessions.

---

## 7. The asset ledger

```sql
content_assets(
  site_id, kind, platform, title, url, published_at, author,
  entity_kind, entity_slug,          -- always. The join key
  keyword_norm,                       -- ONLY for indexable assets. NULL for reels
  utm_campaign, target_page_id,       -- what it points at
  platform_metrics jsonb,             -- views, upvotes. Never sorted on
  status, last_verified_at, gone_at,  -- decay. Three-state, per §1.1
  notes
)
content_asset_checks(asset_id, checked_at, present, position, measured_via, cost_micros, error)
```

`kind`: `page | reddit_comment | reddit_post | reel | linkedin_post | youtube | guest_post`.
Free text with a documented vocabulary, the same choice `research_entity_sets.kind` made.

**Note `guest_post`** — the link outreach feature already produces exactly this asset and
currently loses track of it after the placement lands. That is a free win.

### 7.1 How each platform actually gets in — and the honest constraints

| Platform | Ingest | Reality |
|---|---|---|
| Our pages | Automatic (GSC + sitemap) | Free |
| Reddit | **Already built** — `serp_targets`. Extend, don't rebuild | Self-service OAuth **closed in 2026** and JSON 403s server IPs; checks go through DataForSEO's page API and **cost money per check** |
| LinkedIn | Manual / CSV | API is partner-gated. A plan promising auto-sync here would be wrong |
| Reels (IG/TikTok) | Manual / CSV | Graph API needs a Business account and app review |
| Guest posts | Automatic from `outreach_messages` | Free |

So: **auto-ingest what has a free API, record the rest.** Recording is one CLI command or
one MCP tool call — `content log --site=… --kind=reel --entity=las-vegas-nv --url=…` —
and an agent can do it conversationally, which is the realistic path for a phone-published
reel.

Because Reddit checks cost money, they get the same treatment as every other priced call
in this repo: a per-run cap, `cost_micros` on every check row, and a re-check cadence that
backs off for assets that have been stable for months.

---

## 8. Agent surfaces

Read-only, added to the existing MCP server:

| Tool | Answers |
|---|---|
| `content_board` | "What should I publish next?" — the BUILD NOW cell, ranked |
| `content_for_entity` | "Everything we've done for Scottsdale, and what it earned" |
| `page_queries` | "What does this page actually rank for?" — including drift |
| `cannibalisation` | "Where are two of our pages competing?" |
| `wasted_effort` | "What have we published into markets we cannot fulfil?" |
| `content_log` | **The one write.** Record an asset we just published |

`content_log` is deliberately the only mutation in the MCP surface, and it is safe in the
way the blocked ones are not: it writes a row describing something that already happened
in the world. It cannot spend money, send anything, or change a decision. The read-only
rule in the MCP server exists because a chat surface must not authorise spend — recording
a fact about the past is a different act, and the distinction is worth stating in the tool
description so nobody later reads it as precedent for a `launch_campaign` tool.

---

## 9. Order of work

| # | Item | Cost | Why here |
|---|---|---|---|
| **1** | **GSC `page` dimension + start collecting** | $0 | The 16-month window means history starts the day this ships. Everything else can wait; this cannot |
| **2** | `site_pages` + `site_page_queries`, populated from GSC | $0 | Answers the literal question asked |
| **3** | Cannibalisation + intent-drift reports | $0 | Pure reads over #2. First real finding, no new integration |
| **4** | `content_assets` schema + `content log` CLI | $0 | The ledger. Manual entry works from day one |
| **5** | Backfill `serp_targets` → assets, resolve entities loudly | $0 | Existing Reddit work becomes visible to the grid |
| **6** | Three-way join: demand × supply × effort (§5) | $0 | **The wasted-work report.** Tells you what to stop |
| **7** | GA4 client + landing-page and referral join | $0 | Turns rank into money, and off-site links into sessions |
| **8** | UTM discipline on published links | $0 | Must start with #4 — untagged links are permanently unmeasurable |
| **9** | MCP tools (§8) | $0 | Conversational logging is what makes #4 actually get used |
| **10** | Reddit asset checks on the directory grid | $ per check | Reuses `serp_checks`; the only recurring cost in this plan |
| **—** | LinkedIn / IG auto-sync | — | Blocked on partner API access. Manual until that changes |
| **—** | Any "content impact" score | — | **Never.** §0.1 |

**Items 1–3 are free, need no new platform access, and answer the question you asked.**
Item 6 is where it starts preventing waste.

---

## 10. What this cannot do

- **It cannot tell you a post caused a ranking.** It can show both on one timeline. The
  only instrument here that supports a causal claim is a holdout, and `ads/experiment.ts`
  already knows how to build one.
- **It cannot measure LinkedIn or reels beyond what you type in.** Their APIs are gated.
  Referral sessions via GA4 are the one real number, and only for tagged links.
- **GSC has no history before you turn it on**, and silently omits low-volume queries. An
  absent query is unmeasured, not zero.
- **Reddit checks cost money and will break.** They depend on scraped `old.reddit.com`
  markup, as `serp/reddit.ts` says at length. Every failure must read as `null`.
- **It cannot see content we published and forgot to log.** A manual ledger is only as
  complete as the habit. The GSC and sitemap paths partly cover our own pages; nothing
  covers an untracked reel.
- **The wasted-work cell is only as good as supply resolution**, which is currently 24%.
  Expanding the geo corpus is a prerequisite for trusting it, not a follow-up.
- **It will not tell you what to write.** It ranks where the gap is; the asset is still
  yours to make.
