# Hotel Backlink Scout

Hotel Backlink Scout is the inventory-first backlink prospecting workspace at
`/hotel-backlink-scout`. It is adjacent to the existing `/hht-bl` competitor
research pipeline and does not replace it.

- `/hht-bl` asks which backlink mechanisms work for successful travel sites.
- `/hotel-backlink-scout` asks which hotel, locality, manager, owner, or PR site is likely
  to link to HotelHotTubs and which HHT treatment gives it a credible reason.

The opportunity key is `hotel × domain × relationship type`. Hotels, domains,
relationships, crawl evidence, contacts, scores, content clusters, jobs, manual
overrides, and outcomes are normalized into separate `hotel_bl_*` tables by
`packages/data/drizzle/0030_hotel_backlink_scout.sql` and the URL-validation
extension in `0031_hotel_bl_url_validation.sql`.

## Architecture

- Next.js 15 App Router server components render list and detail views.
- Validated server actions handle imports, statuses, and manual overrides.
- Drizzle/Postgres is both durable storage and the resumable job queue.
- Trigger.dev runs crawls in production. Without `TRIGGER_SECRET_KEY`, the web
  action points operators to the CLI instead of running a cohort inside a
  browser request.
- `tldts` resolves registrable domains; `cheerio` performs deterministic page,
  link, date, contact, and relationship extraction.
- Semrush remains an explicit MCP/CLI checkpoint. Application code never holds
  or spends Semrush credentials.

There is no standalone crawler service and no automated outreach.

## Setup and inventory import

Apply the targeted migration:

```bash
pnpm hotel:bl migrate
```

Use the Overview upload form, or the CLI:

```bash
pnpm hotel:bl import \
  --file=hotel-direct-links-2026-08-21.csv \
  --name="August 2026 inventory"
```

The production CSV was not present in the repository when this feature was
implemented. The importer accepts common aliases instead of depending on one
exact header set.

| Model field | Accepted examples |
| --- | --- |
| Hotel name | `hotel_name`, `hotel`, `property_name`, `name` |
| Geography | `city`, `state`, `state_code`, `province`, `country` |
| Existing HHT URL | `existing_hht_url`, `hht_url`, `hotelhottubs_url`, `listing_url` |
| Hotel website | `source_url`, `direct_link`, `external_url`, `hotel_website`, `website`, `url` |
| Link type | `source_link_type`, `link_type`, `classification`, `type` |
| Brand | `brand_name`, `brand`, `chain` |

Every original column remains in `hotel_bl_hotels.raw_source`. Hotels are
deduplicated by normalized name and geography (URL is only a fallback when
geography is missing). Hosts and root domains are normalized separately, so
thousands of property URLs on a centralized brand host produce one domain and
one crawl job.

## Run and resume analysis

From Runs choose **Start analysis run**, or use:

```bash
pnpm hotel:bl run --run-id=1 --concurrency=5
pnpm hotel:bl status --run-id=1
```

The first stage validates every imported candidate URL against the current
HotelHotTubs/TubStays listing identity. Legacy per-hotel listing paths are
resolved to their current city/state pages. Candidate title/headings, lodging
JSON-LD, location, redirects, HTTP status, and organization signals determine:

- entity scope: `hotel`, `locality`, `other`, or `unknown`;
- detailed entity type such as hotel property/brand, tourism board, locality
  guide, booking directory, or travel media;
- URL result: confirmed, corrected redirect, locality, non-hotel, mismatch,
  unreachable, missing, or ambiguous.

CSV link labels are hints, not proof. Tourism boards remain valid locality
backlink prospects but never populate `canonical_property_domain`. Explicit
hotel/location conflicts and blocked pages remain reviewable. Run or resume the
validation stage directly with:

```bash
pnpm hotel:bl validate-urls --run-id=1 --concurrency=8
pnpm hotel:bl validation-report --run-id=1 --status=locality
pnpm hotel:bl reclassify-urls --run-id=1
```

`reclassify-urls` replays deterministic rules over stored HTTP evidence without
issuing network requests.

Default crawl limits are stored in the run configuration:

- 5 concurrent domains (hard limit 10)
- 15-second timeout and 3 attempts with exponential backoff
- 250 ms between requests on one domain
- 10 pages per domain, depth 1
- 1 MB stored HTML cap per page

Discovery checks the property/homepage seed, `sitemap.xml`, internal relevant
links, and only then seven conventional paths. It honors wildcard robots
`Disallow` rules and ignores non-text/binary responses. Centralized brand
domains are sampled from at most three property paths and do not receive the
conventional-path expansion.

Each domain job is claimed with `FOR UPDATE SKIP LOCKED`. One domain failure is
recorded without failing the cohort. Claims stale for 30 minutes are re-driven.
Retry failures without recreating successful evidence:

```bash
pnpm hotel:bl retry --run-id=1
pnpm hotel:bl run --run-id=1
```

Page/domain writes use natural keys and conflict updates. Manual overrides are
separate fields and are never overwritten by recrawls.

`hotel_bl_outcomes.feature_snapshot` is reserved for the site-control, press,
contact, SEO, relationship, geography, and treatment values present when
future outreach is recorded. This preserves the inputs needed for later
independent-vs-brand conversion analysis without adding ML or outreach to v0.

## Evidence extraction

The crawler stores:

- press/media/news/awards/blog/about/contact pages;
- status, title, raw HTML, content hash, and crawl timestamp;
- external editorial destination, anchor, `rel`, `nofollow`, `sponsored`,
  `ugc`, and followed status;
- public business emails/phones and PR/media/marketing context;
- explicit metadata, JSON-LD, or `<time datetime>` dates only;
- sitemap/HTTP last-modified as lower-confidence fallback evidence;
- owner, manager, or PR relationships only when an external link appears beside
  explicit ownership, management, or agency language.

Social, maps, booking platforms, and booking/navigation anchors do not count as
editorial press links. A normal link without a blocking rel is followed.

## Scoring

All deterministic components are stored:

- Feasibility: editorial behavior 30, autonomy 25, editorial surface 20,
  contactability 15, freshness 10.
- Link value: Authority Score 35, log-normalized traffic 25, topical relevance
  15, expected placement 15, new referring domain 10.
- Content fit compares all seven supported treatments.
- Effort is 1–100, where higher means more work.
- Priority is the geometric mean of feasibility, link value, and content fit,
  followed by the effort multiplier `1 - effort / 200`.

Explanations use stored facts only. A ranking/award recommendation explicitly
requires transparent, verifiable editorial criteria.

## Semrush enrichment

Only domains with feasibility at least 50 receive provider jobs. Missing/stale
data (30-day freshness) queues:

- `domain_rank` for organic traffic;
- `backlinks_overview` for Authority Score and referring domains.

Inspect an exact request:

```bash
pnpm hotel:bl semrush-request --job-id=123
```

Codex executes that request through the authenticated Semrush MCP. Preserve
responses in a batch file:

```json
[
  {
    "jobId": 123,
    "envelope": {
      "report": "domain_rank",
      "params": {},
      "body": "exact Semrush response body",
      "estimatedUnitsConsumed": 10,
      "accountIdentifier": "optional"
    }
  }
]
```

Import immediately:

```bash
pnpm hotel:bl semrush-import \
  --run-id=1 \
  --file=exports/hotel-backlink-scout/semrush-batch.json
```

Exact body/params merge into `domains.semrush_raw`, job state is checkpointed,
estimated units accumulate on the run, and scores recalculate without crawling.
Provider calls are never made by tests, the web app, or the worker.

## UI, export, and tests

Views: Overview, Opportunities, Hotels, Domains, Content Opportunities, and
Runs. Hotel/domain detail views expose evidence and overrides. Opportunity
filters include entity scope, so hotels, localities, and other organizations can
be reviewed separately. The Hotels view exports the complete per-row URL audit;
opportunity filters are URL parameters, so reloads and exports use the same
filter function.

```bash
pnpm hotel:bl export \
  --file=exports/hotel-backlink-scout/opportunities.csv

pnpm vitest run \
  packages/core/src/hotel-backlink-scout.test.ts \
  packages/data/src/hotel-bl/crawl.test.ts \
  packages/data/src/hotel-bl/import.test.ts \
  packages/data/src/hotel-bl/validation.test.ts
```

The migration/import integration suite requires an explicitly disposable
Postgres target and never inherits the application's database URL:

```bash
HOTEL_BL_E2E_DATABASE_URL=postgres://... \
  pnpm e2e packages/data/src/hotel-bl/hotel-bl.e2e.test.ts
```

Before the full ~5,800-hotel run, import 5–10 representative rows: independent,
microsite, centralized brand, explicit management attribution, and dead URL.
Inspect stored links/contacts in domain detail before scaling.
