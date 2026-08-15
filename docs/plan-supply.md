# Plan: supply — connecting a directory site's inventory to the keyword engine

| Field | Value |
|---|---|
| **Date** | 2026-08-14 |
| **Status** | ✅ **Built end to end** 2026-08-14 — 946 tests passing, migration 0026 applied, $0 spent. See §9. |
| **Goal** | `hotelhottubs.com` publishes its room listings over an API; this system pulls them, joins them to the keyword grid, and exposes them to agents — on the site and in Claude on your machine |
| **Depends on** | [`plan-affiliate-directory-sites.md`](./plan-affiliate-directory-sites.md) (the keyword grid and entity model this joins to), [`plan-paid-search.md`](./plan-paid-search.md) §2 (the BUY gate this becomes an input to) |
| **Deliverables** | A publishable package for your site (§3), and the consumer + agent surfaces here (§4, §5) |

---

## 0. The reframing this plan turns on

The obvious framing is "sync the listings so we can show them". That is a data
pipeline, and it is the smaller half of what this is for.

> **Supply is what decides whether a keyword is worth anything, and the keyword
> engine currently has no idea it exists.**

`expandSiteSpace` generated **975 keywords** for `hotelhottubs.com` — 195
localities × 5 patterns. It generated `hotels with hot tubs in room boise` with
exactly as much confidence as `…las vegas`, because nothing in this system knows
whether the site has **one** listing in Boise or **none**.

That gap has already been paid for downstream. `assessKeyword` can return
`BUILD` for a locality with no inventory. `assessPaidKeyword` can return `BUY`
and put real money behind a click that lands on an empty result set. Neither
model is wrong — they were never given the input.

**So supply is not a display feature. It is a gate**, and it belongs upstream of
both.

### 0.1 The 2×2 that falls out of it

Once supply and keywords are joined, every locality lands in one of four states,
and the two off-diagonal cells are where the value is:

| | **Keyword demand** | **No demand** |
|---|---|---|
| **Have supply** | ✅ **BUILD FIRST** — demand exists and we can fulfil it | 🔍 **Keyword gap** — inventory nobody can find. Cheapest page in the portfolio |
| **No supply** | ⛔ **Supply gap** — do not build, do not bid. Fix supply or drop it | ignore |

**The bottom-left cell is the one that costs money today.** It is where a
`BUILD` verdict sends someone to write a page about hotels we cannot book, and
where a `BUY` verdict spends CPC on a query we cannot convert.

**The top-right is the one nobody looks for.** Forty properties in a city with
no page is a keyword the grid never generated or a page never written —
demand-side work with the supply risk already removed.

### 0.2 Pull, never push. The site owns supply.

This system must never be able to write a listing. Not "should not" — must not.

`sites.status` versus `shortlist_items.state` is the precedent this repo already
paid for: *"Two state machines that both claim to describe the same asset
diverge silently."* Supply has the same shape and worse consequences — a
listing that exists here and not on the site is a page that 404s, and a price
that is authoritative in two places is a price that is wrong in one.

So the contract is one-directional and read-only:

```
   your hotel site  ──(HTTPS, cursor-paginated, read-only)──►  this system
        OWNS IT                                                  READ MODEL
```

Everything downstream — coverage, gating, agents — reads a cache and says when
that cache was last refreshed. Nothing writes back.

---

## 1. What already exists (do not rebuild any of this)

| Piece | Where | State |
|---|---|---|
| Keyword grid with per-row entity bindings | `site_keyword_targets.entities` | **Built.** `{ locality: 'las-vegas-nv' }` is the join key |
| Locality corpus with FIPS, population, provider codes | `localities`, `research_geos` | **Built.** What supply resolves against |
| Entity sets for non-geographic dimensions | `research_entities` | Built — `borenhealth` products/vendors |
| Verdicts that supply must gate | `assessKeyword`, `assessPaidKeyword` | Built, and currently **supply-blind** |
| Per-keyword economics | `resolveKeywordEconomics` | Built. Order value could come from real listings instead of a site average |
| Geo ingest that fails loudly below a coverage bar | `ingest-geo.ts` | **Built, and the precedent for §4.1** |
| **A supply feed on the site** | — | **Missing — §3** |
| **Ingest, coverage join, gating** | — | **Missing — §4** |
| **Agent surfaces** | — | **Missing — §5** |

---

## 2. The contract

### 2.1 Three endpoints, and only three

```
GET  /api/supply/manifest        counts, schema version, last-modified
GET  /api/supply/items?cursor=&limit=     cursor-paginated items
GET  /api/supply/health          liveness + auth check, no data
```

`items` is **cursor-based, not offset-based**. Offsets shift under a catalogue
that is being edited while we page through it — rows get skipped or duplicated
and nothing announces it. A cursor over `(updated_at, id)` is stable under
concurrent writes.

Incremental by default: `?since=<iso>` returns only what changed. A 5,000-room
catalogue re-pulled hourly is 40k wasted requests a month otherwise.

**Webhooks, if you want them, carry no data** — only "something changed, come
and look". A webhook that carries the listing is a listing that silently
vanishes when a delivery fails, and §10.8 of the outreach plan is a reminder of
how quiet that failure is.

### 2.2 The item shape

One shape covers both sites, because supply is always *supplier → item →
attributes → a link that earns*:

```ts
interface SupplyItem {
  id: string                 // stable and yours. We never mint one.
  supplierId: string         // the hotel property / the peptide vendor
  supplierName: string
  title: string              // "King Suite with In-Room Jacuzzi"
  url: string                // canonical page on your site
  affiliateUrl?: string      // the monetising link, when it differs
  location?: {               // omitted entirely for borenhealth
    city: string
    region?: string          // "NV"
    country: string          // ISO-3166 alpha-2
    lat?: number
    lon?: number
  }
  attributes: Record<string, string | number | boolean>
  priceMicros?: number       // integer micros. Never a float — see money.ts
  currency?: string
  available?: boolean
  images?: string[]
  updatedAt: string          // ISO 8601. Drives the cursor.
}
```

**`attributes` is where the thing that makes it findable lives** —
`{ in_room_hot_tub: true, occupancy: 2 }`. It is deliberately free-form: the
attribute that matters for `hotelhottubs` is a hot tub, and for `borenhealth` it
is a peptide's form and size, and a fixed column set would be wrong for both
within a month.

**`id` is yours and we never mint one.** A synthesised key means a re-crawl
creates duplicates the moment your ordering changes.

### 2.3 The manifest is what makes a partial sync detectable

```jsonc
{
  "schemaVersion": 1,
  "totalItems": 5231,
  "totalSuppliers": 418,
  "lastModified": "2026-08-14T09:12:00Z",
  "invalidItems": 3,          // failed validation, NOT served
  "invalidSamples": [ { "id": "rm_991", "problem": "missing url" } ]
}
```

**This is the most important endpoint of the three.** Without a total, a sync
that pulls 4,000 of 5,231 items is indistinguishable from a catalogue that
shrank — and the ingest would happily mark 1,231 listings as gone, dropping
their localities out of coverage and turning `BUILD` rows into `supply gap` rows
overnight.

`invalidItems` is served rather than hidden for the same reason: three listings
that fail validation are three pages we will silently never rank, and the count
belongs where somebody sees it.

### 2.4 Auth, failing closed

A bearer token in `Authorization`, set on both sides.

The package **refuses to serve when no token is configured** rather than serving
openly — the same direction the repo already chose with `LIVE_CALLS_ENABLED`
requiring the exact string `'true'`: *"A misconfigured env var should fail
toward $0, not toward live spend."* Here it fails toward *no data leaving your
site*, not toward an open catalogue endpoint.

Requests are also rate-limited and the token is compared with a
timing-safe equality check, because a naive `===` on a secret is a
side-channel and it costs one function call to avoid.

---

## 3. The package you install (`@rnr/supply-feed`)

### 3.1 What you write

One function. Everything else is the package's problem.

```ts
import { createSupplyFeed } from '@rnr/supply-feed'

export const feed = createSupplyFeed({
  token: process.env.SUPPLY_FEED_TOKEN,

  async fetchPage({ cursor, limit, since }) {
    const rows = await db.room.findMany({
      where: since ? { updatedAt: { gt: new Date(since) } } : {},
      cursor: cursor ? { id: cursor } : undefined,
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      take: limit,
      include: { property: true },
    })

    return {
      items: rows.map((r) => ({
        id: r.id,
        supplierId: r.property.id,
        supplierName: r.property.name,
        title: r.name,
        url: `https://hotelhottubs.com/hotels/${r.property.slug}#${r.id}`,
        affiliateUrl: r.bookingUrl,
        location: {
          city: r.property.city,
          region: r.property.state,
          country: 'US',
        },
        attributes: {
          in_room_hot_tub: r.hasInRoomHotTub,
          occupancy: r.maxOccupancy,
        },
        priceMicros: r.nightlyRateCents * 10_000,
        currency: 'USD',
        available: r.active,
        updatedAt: r.updatedAt.toISOString(),
      })),
      nextCursor: rows.at(-1)?.id ?? null,
    }
  },

  async counts() {
    return { totalItems: await db.room.count(), totalSuppliers: await db.property.count() }
  },
})
```

### 3.2 What it does for you

- **Validates every item** against the schema. Invalid ones are **excluded from
  the response and counted in the manifest** — never served half-formed, never
  silently dropped.
- **Auth**, timing-safe, failing closed.
- **Cursor plumbing**, `since` filtering, `limit` clamping (default 200, max
  1,000 — a caller asking for 50,000 gets 1,000 and a header saying so).
- **ETag + `Cache-Control`**, so an unchanged page costs you a 304.
- **Rate limiting**, per token.
- **A structured error shape** rather than an HTML error page, because an HTML
  500 parsed as JSON is a confusing failure two systems away.

### 3.3 It cannot follow this repo's package conventions

`@rnr/core` and `@rnr/data` are `private: true` and export **raw TypeScript** —
no build step, consumed only under `tsx --conditions=react-server`.

**Your hotel site cannot consume that.** So this package is the exception and
needs to be a real published artifact:

| Concern | Choice |
|---|---|
| Build | `tsup` → ESM + CJS + `.d.ts` |
| Runtime deps | **Zero.** It must not fight your site's dependency tree |
| Node | ≥ 18 (native `fetch`, `crypto.timingSafeEqual`) |
| Distribution | npm private package, or a git dependency if you'd rather not publish |
| Adapters | `createSupplyFeed(...).handler` is a plain `(Request) => Response`; thin wrappers for Next.js route handlers and Express |

Framework adapters are thin on purpose — the core is a Web-standard
`Request → Response` function, so a Next.js App Router route is three lines and
nothing about the package assumes your framework.

---

## 4. The consumer here

### 4.1 Ingest, and the resolution that has to fail loudly

A scheduled pull (Trigger.dev task, same as `discovery-drain`) walks the cursor
and upserts into `supply_items`.

**Then the part that actually matters: resolving `location` to our slug.** Your
site says `{ city: "Las Vegas", region: "NV" }`. The keyword grid says
`las-vegas-nv`. The join only exists if those meet.

Resolution happens **here, not on your side** — your codebase should not have to
know our slug vocabulary, and a slug we changed would silently break your feed.

`ingest-geo.ts` is the precedent and the standard to match: it *"fails loudly
below coverage bars"* rather than quietly ingesting a partial corpus. Same rule
here — an ingest that resolves 60% of localities reports **40% unresolved with
examples**, and unresolved supply is `UNKNOWN` coverage, never zero coverage.

That distinction is the whole feature in miniature: **"we have no listings in
Boise" and "we could not work out where these listings are" must never render
the same**, because the first is a reason not to build a page and the second is
a reason to fix an importer.

### 4.2 The coverage join

```sql
supply_coverage(site_id, entity_kind, entity_slug) →
  supplier_count, item_count, available_item_count,
  min_price_micros, median_price_micros, last_seen_at
```

Materialised per ingest rather than computed per query — it is read by the
keyword board, the ads planner, and every agent call, and recomputing a
195-locality aggregate on each is waste.

`last_seen_at` earns its column: a locality whose supply has not been seen in 30
days is a locality where something upstream broke, and it should read as stale
rather than as absent.

### 4.3 Gating — where this changes existing behaviour

Three call sites, and each one keeps its current answer when supply is unknown:

| Model | Change | When supply is UNKNOWN |
|---|---|---|
| `assessKeyword` | `BUILD` requires ≥ 1 available item for the bound entity. Zero supply → `IGNORE`, reason `no supply` | Unchanged. Not a silent downgrade |
| `assessPaidKeyword` | Zero supply → `BLOCKED`, alongside the AI-Overview block | Unchanged — we do not block on an unmeasured signal |
| `buildAdsPlan` | Reports supply coverage per keyword in the plan notes | Reported as unknown |

> **Supply-blindness must not be replaced by supply-certainty.** A locality we
> failed to resolve is not a locality with no hotels, and gating on it would
> turn an importer bug into a decision to stop building pages.

**A fourth output, which is new rather than a gate:** the §0.1 top-right cell —
suppliers whose locality has supply and *no keyword row at all*. That is a list
of pages worth writing, and nothing in the system can currently produce it.

### 4.4 Order value, from real listings

`resolveKeywordEconomics` currently uses one site-wide order value, flagged
`INHERITED`, with the plan noting that *"order value varies more across
destinations than commission varies across vendors."*

Supply answers it directly: the **median `priceMicros` of available items in
that locality** is a measured average booking value, per destination. It
replaces an inherited guess with a number that came from your own inventory —
and where supply is thin, it stays inherited and stays flagged.

---

## 5. The agent surfaces

### 5.1 Claude on your machine — an MCP server

A local MCP server (`packages/mcp`, run over stdio) exposing this system's
read models. Registered once with `claude mcp add`, then available in Claude
Code and Claude Desktop.

Tools, all **read-only**:

| Tool | Answers |
|---|---|
| `supply_search` | "What in-room hot tub suites do we list in Aspen under $400?" |
| `supply_coverage` | "Which localities have supply and no page?" — the §0.1 2×2 |
| `keyword_board` | "What should I build next for hotelhottubs?" |
| `keyword_economics` | "Why does this keyword need a 12% conversion rate?" |
| `prospect_board` | "Which link prospects are worth approaching?" |
| `run_status` | "What did the last ingest do, and when?" |

**Read-only is the design, not a v1 limitation.** An MCP tool that could launch
an ads campaign or send outreach would put an uncapped spend behind a
conversational turn — and the ads launcher deliberately needs *four* independent
conditions before it can spend. Those gates exist precisely so that no single
surface can bypass them.

### 5.2 The outbound agent

Two places supply makes outbound concretely better, both by supplying **sourced
facts** rather than more prose:

- **Link outreach.** `draftCampaign` already refuses claims it cannot source —
  every fact must appear in `facts_used` with its origin. Supply adds real ones:
  *"we list 40 hot tub suites across 12 Aspen properties"* is checkable, and it
  is the kind of specific that distinguishes a pitch from a template.
- **The voice agent.** `SiteVoiceContext` is contractor-shaped today
  (`service_area`, `dispatch_fee`). A directory site's equivalent is inventory,
  and an agent that can say what is actually listed is answering rather than
  deflecting.

Both consume the same read model. Neither writes.

---

## 6. Schema

```sql
supply_sources        -- one per connected site: base URL, token ref, schema version,
                      -- last_pulled_at, last_manifest (counts we compare against)
supply_suppliers      -- site_id, external_id, name, resolved entity_slug, raw_location
supply_items          -- site_id, external_id UNIQUE per site, supplier_id, title, url,
                      -- affiliate_url, attributes jsonb, price_micros, currency,
                      -- available, updated_at (theirs), last_seen_at (ours)
supply_coverage       -- materialised: (site_id, entity_kind, entity_slug) → counts, prices
supply_ingest_runs    -- pulled, upserted, unresolved, invalid_from_manifest, cost, errors
```

`last_seen_at` is ours and `updated_at` is theirs, deliberately kept apart: the
first says when we last confirmed the row exists, the second says when they last
changed it. Collapsing them loses the ability to distinguish *stale* from
*unchanged*.

Deletion is **soft** — an item absent from a full sync is marked
`available: false` with `last_seen_at` untouched, never hard-deleted. A feed
outage that returned an empty page would otherwise erase the catalogue, and
`supply_coverage` would report a portfolio-wide supply gap that never existed.

---

## 7. Order of work

| # | Item | Cost | Why here |
|---|---|---|---|
| **1** | `@rnr/supply-feed` package: schema, validation, auth, cursor, manifest (§3) | $0 | The contract. Nothing else can start |
| **2** | Wire it into `hotelhottubs.com` with your adapter, verify `/manifest` | $0 | One function on your side |
| **3** | `supply_*` schema + ingest with **loud** entity resolution (§4.1) | $0 | The resolution report is the deliverable, not a side effect |
| **4** | `supply_coverage` materialisation + the §0.1 2×2 report | $0 | First real output. Answers "what should I build" |
| **5** | Gate `assessKeyword` and `assessPaidKeyword` on supply (§4.3) | $0 | Stops building and bidding on what we cannot fulfil |
| **6** | MCP server, read-only tools (§5.1) | $0 | Claude on your machine |
| **7** | Median listing price → `resolveKeywordEconomics` (§4.4) | $0 | Replaces an inherited site average with a measured one |
| **8** | Supply facts into outreach drafting (§5.2) | $0 | Sourced claims, same `facts_used` discipline |
| **9** | Scheduled incremental pull as a Trigger task | $0 | Manual pull is fine until this is proven |
| **—** | Webhook-triggered pull | — | Only if hourly is too slow. Carries no data either way |
| **—** | Write-back of any kind | — | **Never.** §0.2 |

**Items 1–4 are the whole reframing** and none of them costs anything: a feed, an
ingest that admits what it could not resolve, and the 2×2 that tells you which
pages to build. Item 5 is where it starts preventing spend.

---

## 8. What this cannot do

- **It cannot tell you a listing converts.** Supply presence is necessary, not
  sufficient — a locality with 40 properties and a bad affiliate link earns
  nothing, and this system cannot see the difference.
- **Coverage is only as fresh as the last pull.** `last_seen_at` is on every row
  and on every screen for that reason; a stale catalogue is a coverage claim
  about the past.
- **Entity resolution will not be 100%.** Ambiguous city names, international
  destinations, and localities outside `research_geos` will not resolve. They
  land as `UNKNOWN` and are counted, never assumed to be zero.
- **Median listing price is not average booking value.** People do not book the
  median room, and it ignores length of stay entirely. It is better than one
  site-wide number and it is still an estimate — labelled as one.
- **A supply gap is not always a reason to stop.** A locality with no listings
  might be worth *acquiring* supply for, and that decision is commercial, not
  something the model can make. The gate blocks the build; it does not tell you
  which way to fix it.
- **Nothing here validates that your affiliate links pay.** The link is carried
  through and never tested — that would need the affiliate network's own data,
  which is the gap `plan-affiliate-economics.md` §8.8 already names.

---

## 9. Results — implemented 2026-08-14

**Status: built end to end.** 946 tests passing (was 854), typecheck clean, one
migration applied. **$0 spent** — a supply feed costs no vendor money, only the
publisher's own database.

### 9.1 What shipped

| # | Item | Where |
|---|---|---|
| 1 | `@rnr/supply-feed` — the package for your site | `packages/supply-feed/` (+ `README.md`) |
| 2 | Supply model, the 2×2, the gates | `packages/core/src/supply/{coverage,gate}.ts` |
| 3 | Migration 0026 + five tables | `packages/data/drizzle/0026_supply.sql` |
| 4 | Feed client, loud resolution, ingest | `packages/data/src/supply/{client,resolve,ingest}.ts` |
| 5 | Coverage materialisation + the 2×2 report | `packages/data/src/supply/coverage.ts` |
| 6 | Gating in `runVerdictPass` and `buildAdsPlan` | `spaces/research.ts`, `ads/plan.ts` |
| 7 | Read-only MCP server, 7 tools | `packages/mcp/` |
| 8 | Supply facts in outreach drafting | `links/outreach.ts`, `supply/query.ts` |
| 9 | CLI | `scripts/supply.mts` (`pnpm supply`) |

### 9.2 The end-to-end probe

`probe-supply-e2e.mts` stands the real package up on a real socket and pulls it
with the real client — because the unit tests fake `fetch`, and the wire is the
only place the two packages meet. **27/27 checks pass**, including the three that
the whole feature rests on:

```
ok   have    → a locality with available inventory
ok   none    → a locality measured at zero available
ok   unknown → a locality never resolved

ok   BUILD survives where supply exists
ok   BUILD is blocked where supply is measured zero
ok   BUILD is UNTOUCHED where supply is unknown        ← §4.3
```

### 9.3 Four bugs the build found

**1. `invalidItems` was always zero, and it broke reconciliation.** The manifest
was read *before* the walk — but the feed can only count rows its validation
refused once something has asked for them. So every catalogue with a single
broken row reported a permanent PARTIAL SYNC, and because a failed reconciliation
disables the soft-delete sweep, **the catalogue would have silently stopped
pruning forever.** The manifest is now read twice; the second read is what
reconciliation uses.

**2. Reconciliation asserted an equality it had no right to.** It required
`totalItems === pulled + invalid`. But `totalItems` comes from the publisher's
own `db.room.count()`, and whether that pre-filters rows their mapper would choke
on is *their* decision. Now a range — `pulled ≤ total ≤ pulled + invalid` — which
accepts both conventions and still catches a real gap.

**3. A literal NUL byte in `coverage.ts`.** The composite-key separator was
written as a raw byte rather than an escape, which made the file
`Binary file matches` to git, grep and every editor — and cost a debugging round
where the tooling could not show me the line. NUL is still the right separator
(it is the one character that can appear in neither an entity slug nor an entity
kind, where `:` and `-` both can); it is now `COVERAGE_KEY_SEP = '\u0000'`.

**4. The MCP server dropped in-flight responses.** `stdin.on('end')` called
`process.exit` while tool calls were still awaiting the database — three requests
in, two responses out, and the missing one indistinguishable from a tool that
returned nothing. A long-lived client never closes stdin so it would not have
surfaced in normal use; it surfaced the moment the server was driven from a file,
which is also how anyone would script it.

*And one wrong assumption in the probe itself*, worth recording because it wasted
the first run: it hardcoded Las Vegas and Aspen. Aspen is not in this corpus, so
it landed unresolved and six downstream assertions failed for a reason that had
nothing to do with the code under test. The probe now reads two real markets out
of `research_geos`.

### 9.4 Two decisions that departed from the plan

**The package is the only non-private one here, and it needs a real build.**
`@rnr/core` and `@rnr/data` are `private: true` and export raw TypeScript,
consumed only under `tsx --conditions=react-server`. Your hotel site has no such
loader. So `@rnr/supply-feed` builds to `dist/{esm,cjs,types}` — via **tsc, not
tsup**, because a bundler would be a build dependency in a repo whose two library
packages have one runtime dependency between them. `dist/` is gitignored, so a
`prepare` script builds it on install, which is why TypeScript is a
**dev**Dependency of that package — dev dependencies are not installed
transitively, so nothing lands in your site's runtime tree.

**The gate is a wrapper, not a parameter.** `assessKeyword` and
`assessPaidKeyword` are untouched; `gateKeywordVerdict` and `gatePaidVerdict`
compose over them. Threading supply *into* those functions would have been tidier
to call and much worse to audit — the supply decision would interleave with the
demand decision inside two already-long branch chains, and the one question an
operator asks about a downgraded keyword ("did supply do this, or did the
arithmetic?") would need a reading of the whole function. As a wrapper, `gated`
is a boolean on the result and both verdicts stay visible.

### 9.5 What it does when there is no feed

Nothing, loudly. Every keyword resolves to `unknown` supply, every verdict is
returned byte-for-byte, and both `runVerdictPass` and `buildAdsPlan` say so:

> *No supply coverage for this site, so no keyword is gated on it. That is the
> safe state, not a clean bill of health — this plan cannot tell whether it is
> bidding into empty inventory.*

### 9.6 What you need to do

1. **Install the package on `hotelhottubs.com`** and write the one `fetchPage`
   function — see `packages/supply-feed/README.md`. Set `SUPPLY_FEED_TOKEN` to a
   long random string on both sides.
2. ```sh
   pnpm supply connect --site=hotelhottubs.com --url=https://hotelhottubs.com/api/supply
   pnpm supply check <sourceId>          # reaches the feed, writes nothing
   pnpm supply pull  <sourceId> --dry-run
   pnpm supply pull  <sourceId>
   pnpm supply board --site=hotelhottubs.com    # the 2×2
   ```
3. **Read `supply unresolved <sourceId>` first.** The resolution report is the
   deliverable, not a side effect — everything it could not place looks exactly
   like a locality with no supply, and only you can tell which markets are
   missing from the corpus versus named differently.
4. **Register the MCP server** for Claude on your machine:
   ```sh
   claude mcp add rank-and-rent -- pnpm --dir "C:/Users/logan/money_sites/rank-and-rent-semrush" mcp
   ```
5. Nothing is committed. Migration 0026 **has** been applied to the database.

### 9.7 Still open, and named rather than quietly skipped

- **The scheduled pull (item 9) is not wired to Trigger.dev.** `pnpm supply pull`
  is manual, which is the right place to stop until one real catalogue has been
  pulled and its resolution report read by a human.
- **The `entity_set:` resolver is untested against real data.** It is built and
  unit-tested, and `borenhealth.com` has no feed to point it at yet.
- The blockers from earlier features are unchanged: `GSC_REFRESH_TOKEN`, real
  `economics observe` numbers, Google Ads quota, `ANTHROPIC_API_KEY`, lemlist auth.
