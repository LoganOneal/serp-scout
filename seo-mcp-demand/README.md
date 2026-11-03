# SEO MCP Demand Study

Status: complete for the US market. Semrush data was collected through the Cursor Semrush MCP login (`scripts/semrush.mts collect --stage=keywords|serps|pages`). See REPORT.md for the ranking and seo-mcp-demand.xlsx for every table.

## Rebuild From Cache

Run from the repository root:

```sh
python3 -m venv seo-mcp-demand/.venv
seo-mcp-demand/.venv/bin/pip install -r seo-mcp-demand/scripts/requirements.txt
seo-mcp-demand/.venv/bin/python -m unittest discover -s seo-mcp-demand/scripts -p 'test_*.py' -v
seo-mcp-demand/.venv/bin/python seo-mcp-demand/scripts/build.py
```

The build never makes network requests. It regenerates every CSV, REPORT.md, and one workbook tab per data CSV. Workbook cells are checked against the CSVs before success. Cache files and imports are ignored by git and remain local. Preserve the cache with the study when handing it off; without it, fetched observations cannot be regenerated. Configurable weights and request limits live in scripts/config.json. Suggested listings and fit judgments are analyst input in code, not fetched metrics.

## Public Sources

```sh
node seo-mcp-demand/scripts/fetch.mjs public
python3 seo-mcp-demand/scripts/public.py
node seo-mcp-demand/scripts/fetch.mjs enrich
seo-mcp-demand/.venv/bin/python seo-mcp-demand/scripts/build.py
```

Each response, including HTTP failures, is cached by request identity before parsing. Existing cache entries are never refetched. Sources are official APIs, public listing pages and vendor documentation. There is no search-engine HTML scraping or access-control bypass. Requests are sequential; 429 stops collection. Public API pagination is followed with a 15-page safety cap; any remaining cursor is recorded as incomplete coverage. GitHub enrichment stops on a 403. Re-running enrich uses cache; changed evidence-derived plans can add new requests.

## Semrush Access and Request Estimate

Kai authorized existing Semrush credits, $0 new paid API cash spend, US plus global and no optional first-party datasets. The environment API key failed with ERROR 122; the shared OAuth session was expired and its approved refresh failed. No alternative paid API was called.

The generated plan has 240 US seed lookups, 240 related-term reports (up to 10 expansions each), and 90 SERP reports. Up to 150 URL traffic reports follow review of the discovered free-tool pages. Thus the current base upper bound is **720 report requests**, excluding unconfirmed global, difficulty and historical enrichment. Cache hits, empty reports and shared URLs reduce new calls. Semrush units are per report/line, not simply per HTTP call; these counts are not a dollar quote. There is no automatic top-up, purchase or paid fallback.

The generic standard-API collector needs a valid SEMRUSH_API_KEY configured locally, never pasted into chat. It does not obtain a new API key from the expired OAuth session. The OAuth canary is separate and uses the existing repo client. Do not retry its refresh unless the shared session has been reconnected and approval is still applicable.

```sh
# Offline request planning, no network:
python3 seo-mcp-demand/scripts/prepare.py

# Only after a valid standard API key is configured and catalog/fields checked:
node seo-mcp-demand/scripts/fetch.mjs collect --stage=keywords --credits-approved
node seo-mcp-demand/scripts/fetch.mjs collect --stage=serps --credits-approved
python3 seo-mcp-demand/scripts/prepare.py

# Review actual SERP candidates, place decisions in imports/toolpage_reviews.csv,
# and regenerate the deduped page-metrics plan before executing it:
python3 seo-mcp-demand/scripts/prepare.py
node seo-mcp-demand/scripts/fetch.mjs collect --stage=pages --credits-approved
seo-mcp-demand/.venv/bin/python seo-mcp-demand/scripts/build.py

# Fail closed on any missing cache, with no network:
node seo-mcp-demand/scripts/fetch.mjs public --offline
```

The standard collector uses the documented phrase_this, phrase_related, phrase_organic and url_rank reports. Its live successful path remains unverified because authentication is blocked. It stops on the first API error. ERROR 50 no-data reports remain cached; a later controlled resume can process those as empty evidence. Never clear cached observations just to make a run look successful. Credential changes do not authorize silently re-fetching existing cached failures; explicitly choose a new research snapshot after reconnecting if needed.

The OAuth catalog canary can be run with `node --import tsx --conditions=react-server seo-mcp-demand/scripts/semrush.mts probe`. It does not refresh unless `--refresh-approved` is explicitly supplied. Refresh writes use the repo's normal credential store, with Kai's prior approval; tokens are never printed or written to research outputs. This canary checks the repo's existing domain_overview tool, not a fictional list_reports tool. OAuth report collection would require inspecting the authenticated report catalog and using that interface; do not assume the standard API key and OAuth session are interchangeable.

## Import Contracts

Create the ignored imports directory locally and use these CSV headers. Import files are hashed into cache before transformation. Metrics must come from fetched data or real exports, never hand-entered guesses. Every observed row requires source and fetched_at. Source URLs can be public URLs or relative cached-evidence paths. Task IDs come from data/taxonomy.csv.

### keywords.csv

```csv
keyword,task_ids,seed_keyword,volume_us,volume_global,traffic_potential,cpc,keyword_difficulty,clicks_per_search,trend_24m,parent_topic,source,source_url,fetched_at
```

One row per normalized keyword, with US/global fields merged. Use `|` between task IDs. Task IDs can be inferred from an exact seed_keyword. Expansions must preserve their seed or provide valid task IDs. Parent topic must be an actual provider/export topic, not a fabricated stem. trend_24m is a CSV-quoted JSON list of exactly 24 monthly volumes in chronological order; use blank when unavailable, not a 12-month trend repeated twice. Global must be a true provider global estimate, not the sum of overlapping regional databases. Standard Semrush cached reports automatically populate supported US fields; explicit imported rows override those same keywords to add unsupported fields.

### toolpage_reviews.csv

```csv
task_id,url,verified_free_tool,review_note
```

Choose 3-5 actual free interactive tools per task from data/serp_candidates.csv, excluding guides, listicles, unrelated tools and paid-only product pages. Set verified_free_tool to 1 only after reviewing the page. These are qualitative decisions, not manual metrics. The collector rejects review URLs absent from cached SERPs. Shared URLs are fetched once and traffic is allocated across tasks.

### toolpages.csv

For externally exported SERP-discovered tool pages and URL traffic:

```csv
task_id,url,serp_query,serp_position,verified_free_tool,organic_traffic_us,source,source_url,fetched_at
```

Set verified_free_tool to 1 after review. A recorded query and positive organic position are mandatory. Do not substitute sitewide domain traffic for exact URL traffic. This import can supply genuine page data when the local provider is unavailable.

### first_party.csv (Optional)

```csv
task_id,calls
```

Provide an already aggregated, privacy-safe call distribution for the same observation period, covering all task IDs, including genuine observed zeros. Do not include tokens, queries, customer identifiers or raw account data. Its presence enables the configured first-party weight of at least 0.3. Prompt-volume data is not enabled because no dataset was provided.

## Missing-Data and Scoring Rules

The final score remains blank unless all weighted demand components exist. Partial observed subtotals are exposed only for auditing and must not be used as final ranks. Parent-topic volume uses maximum volume once per topic and equal allocation across tasks. US and global are not added. A task needs at least three reviewed pages with measured URL traffic to get the page-traffic component. Positive 24-month trend growth is log-normalized; signed decline is retained separately. Sensitivity transfers 0.1 between weight pairs without changing their sum.

Public server metadata is not tool-call telemetry. Only the single configured Smithery useCount metric contributes to mcp_usage_signal; npm downloads and GitHub stars are separate contextual columns. Tool-to-task regex mapping and any real parent-topic/trend grouping need review before a decision-ready live run. Directory-gap scores are conservative while Claude-specific coverage is unresolved.

Ahrefs parent-topic, traffic-potential and global/history exports would materially improve fidelity over the presently documented Semrush standard reports. Ask Kai before any new paid source is used.