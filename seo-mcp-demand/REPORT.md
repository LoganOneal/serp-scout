# CrakSEO MCP Demand Research

Data: Semrush US database via the Cursor Semrush MCP login (692 reports, 79,270 API units, fetched 2026-10-29). MCP directory data from the official MCP Registry, Smithery and Glama. Market: US. No new paid spend.

## Top 5

| Rank | Task | Score | Demand | Fit | Free-tool page traffic / mo | Recent keyword volume / mo | Smithery signal |
|---:|---|---:|---:|---:|---:|---:|---:|
| 1 | Find the technical SEO problems on my site. | 0.624 | 0.851 | 0.73 | 315,961 | 12,846 | 13.6 |
| 2 | Which keywords should I target for this topic? | 0.605 | 0.864 | 0.70 | 394,423 | 12,235 | 7.8 |
| 3 | What ranks for this keyword right now? | 0.534 | 0.616 | 0.87 | 40,390 | 16,277 | 0.4 |
| 4 | Who links to this website? | 0.532 | 0.799 | 0.67 | 180,116 | 61,393 | 1.8 |
| 5 | Why is this page slow or failing Core Web Vitals? | 0.507 | 0.801 | 0.63 | 264,646 | 21,840 | 4.5 |

**Sensitivity:** in 12 scenarios that move 0.1 weight between any two demand terms, a different set of five tasks made the top five in 11 (reordering not counted). Times in the top five: audit_site 12/12, kw_ideas 12/12, links_profile 10/12, serp_results 8/12, gsc_drop 4/12, ai_mentions 4/12, audit_speed 4/12, index_status 3/12.

## Before / After (Revision 2)

Revision 2: recent 3-month keyword volume, spike-then-collapse and navigational keywords excluded, vendor-branded volume at 0.5x, problem-phrased diagnostic seeds added, Search Console product page removed from free-tool pages, Smithery signal log-scaled with a 50% per-server cap, and Claude-directory gap set to 5 for the seven tasks Kai checked manually.

| Before | After | Change | Task ID | Why (moves of 3+ places) |
|---:|---:|---:|---|---|
| 2 | 1 | +1 | audit_site |  |
| 1 | 2 | -1 | kw_ideas |  |
| 11 | 3 | +8 | serp_results | keyword volume 39,000 -> 16,277 (score contribution +0.045); fit 0.77 -> 0.87 (Claude directory gap set to 5) |
| 5 | 4 | +1 | links_profile |  |
| 9 | 5 | +4 | audit_speed | keyword volume 63,000 -> 21,840 (score contribution +0.043); Smithery signal (now log-scaled, capped) 78.7 -> 4.5 (score contribution +0.033) |
| 22 | 6 | +16 | gsc_drop | keyword volume 30.0 -> 3,800 (score contribution +0.153); Smithery signal (now log-scaled, capped) 54.2 -> 1.2 (score contribution -0.027); fit 0.83 -> 0.93 (Claude directory gap set to 5) |
| 12 | 7 | +5 | ai_mentions | keyword volume 47,820 -> 15,894 (score contribution +0.040); Smithery signal (now log-scaled, capped) 34.3 -> 3.3 (score contribution +0.033) |
| 6 | 8 | -2 | rank_position |  |
| 7 | 9 | -2 | index_status |  |
| 8 | 10 | -2 | kw_volume |  |
| 16 | 11 | +5 | serp_aio | keyword volume 49,540 -> 29,370 (score contribution +0.056) |
| 15 | 12 | +3 | comp_keywords | own score changed little; other tasks moved past it |
| 14 | 13 | +1 | local_rank |  |
| 17 | 14 | +3 | comp_traffic | keyword volume 30,350 -> 8,797 (score contribution +0.033) |
| 13 | 15 | -2 | content_onpage |  |
| 23 | 16 | +7 | audit_schema | keyword volume 36,600 -> 15,997 (score contribution +0.046); Smithery signal (now log-scaled, capped) 70.2 -> 3.7 (score contribution +0.025) |
| 20 | 17 | +3 | content_cannibal | own score changed little; other tasks moved past it |
| 21 | 18 | +3 | local_reviews | keyword volume 5,420 -> 2,811 (score contribution +0.038) |
| 19 | 19 | +0 | comp_gap |  |
| 25 | 20 | +5 | audit_links | keyword volume 41,200 -> 25,628 (score contribution +0.056) |
| 24 | 21 | +3 | kw_difficulty | own score changed little; other tasks moved past it |
| 26 | 22 | +4 | local_audit | own score changed little; other tasks moved past it |
| 28 | 23 | +5 | content_brief | keyword volume 4,280 -> 1,557 (score contribution +0.027) |
| 18 | 24 | -6 | index_diagnose | free-tool page traffic 117,519 -> 0.0 (score contribution -0.362); keyword volume 20.0 -> 11,266 (score contribution +0.191); keyword trend 0.0 -> 0.9 (score contribution +0.027); fit 0.87 -> 0.97 (Claude directory gap set to 5) |
| 29 | 25 | +4 | links_gap | own score changed little; other tasks moved past it |
| 27 | 26 | +1 | ai_citations |  |
| 10 | 27 | -17 | index_submit | free-tool page traffic 117,519 -> 0.0 (score contribution -0.362); keyword volume 1,795 -> 1,304 (score contribution +0.040); fit 0.80 -> 0.90 (Claude directory gap set to 5) |
| 4 | 28 | -24 | gsc_opportunity | free-tool page traffic 117,519 -> 0.0 (score contribution -0.362); Smithery signal (now log-scaled, capped) 54.2 -> 1.2 (score contribution -0.027); fit 0.87 -> 0.97 (Claude directory gap set to 5) |
| 30 | 29 | +1 | links_lost |  |
| 3 | 30 | -27 | gsc_top | free-tool page traffic 117,519 -> 0.0 (score contribution -0.362); keyword volume 368,140 -> 0.0 (score contribution -0.266); Smithery signal (now log-scaled, capped) 54.2 -> 1.2 (score contribution -0.027); fit 0.77 -> 0.87 (Claude directory gap set to 5) |

## Recommendations

### 1. Find the technical SEO problems on my site.

- **Why:** free-tool pages for this task get 315,961 US organic visits a month; recent task keyword volume is 12,846 US searches a month (branded at 0.5x) across 5 keyword groups; Smithery signal 13.6 (largest server: nexgendata-apify/seo-web-analysis-mcp-server (60% before cap)); 12-month keyword trend -38%; fit 0.73.
- **Top keywords:** website audit (7,018) | seo audit (6,068) | seo checker (5,723).
- **Top free-tool pages:** https://www.seoptimer.com/ | https://www.seobility.net/en/seocheck/ | https://seositecheckup.com/.
- **CrakSEO product:** SEO Site Audit.
- **Listing name:** SEO Site Audit.
- **Listing description:** Audit any website for technical SEO issues: crawlability, indexability, broken links, meta tags, speed and structured data, with prioritized fixes.
- **Keywords to target:** seo audit, website audit, free seo audit tool, seo checker, site audit.
- **Suggested tool names:** `run_site_audit`, `get_audit_issues`, `check_page_seo`, `recheck_after_fix`.
- **Suggested plugin skills:** `audit-site-before-launch`, `fix-technical-seo-issues`.

### 2. Which keywords should I target for this topic?

- **Why:** free-tool pages for this task get 394,423 US organic visits a month; recent task keyword volume is 12,235 US searches a month (branded at 0.5x) across 5 keyword groups; Smithery signal 7.8 (largest server: axel-belfort/keyword-research (37% before cap)); 12-month keyword trend +196%; fit 0.70.
- **Top keywords:** and keyword research (5,485) | keyword research and (5,485) | free keyword research tool (3,132).
- **Top free-tool pages:** https://business.google.com/us/ad-tools/keyword-planner/ | https://keywordtool.io/ | https://backlinko.com/tools/keyword.
- **CrakSEO product:** Keyword Research; SEO MCP bundle.
- **Listing name:** Keyword Research and Ideas.
- **Listing description:** Find keyword ideas for any topic with search volume, keyword difficulty and CPC from live keyword data.
- **Keywords to target:** keyword research, keyword research tool, free keyword research tool, keyword ideas, keyword generator.
- **Suggested tool names:** `suggest_keywords`, `get_keyword_volume`, `get_keyword_difficulty`, `get_related_keywords`.
- **Suggested plugin skills:** `research-keywords-for-topic`, `plan-content-cluster`.

### 3. What ranks for this keyword right now?

- **Why:** free-tool pages for this task get 40,390 US organic visits a month; recent task keyword volume is 16,277 US searches a month (branded at 0.5x) across 8 keyword groups; Smithery signal 0.4 (largest server: ahrefs (61% before cap)); 12-month keyword trend -26%; fit 0.87.
- **Top keywords:** serp (9,774) | serp api (3,564) | serp checker (2,565).
- **Top free-tool pages:** https://whatsmyserp.com/serp-check | https://ahrefs.com/serp-checker | https://serpwatch.io/serp-checker/.
- **CrakSEO product:** Google SERP API.
- **Listing name:** Google SERP Checker.
- **Listing description:** Get live Google search results for any keyword by location and device, including AI Overviews and SERP features.
- **Keywords to target:** serp checker, google serp, serp api.
- **Suggested tool names:** `get_google_serp`, `get_ai_overview`, `get_serp_features`.
- **Suggested plugin skills:** `research-live-serp`, `build-serp-backed-brief`.

### 4. Who links to this website?

- **Why:** free-tool pages for this task get 180,116 US organic visits a month; recent task keyword volume is 61,393 US searches a month (branded at 0.5x) across 8 keyword groups; Smithery signal 1.8 (largest server: hithereiamaliff/mcp-keywords-everywhere (86% before cap)); 12-month keyword trend +194%; fit 0.67.
- **Top keywords:** backlink checker (44,568) | verified backlinks (8,268) | backlinks checker (6,878).
- **Top free-tool pages:** https://ahrefs.com/backlink-checker | https://www.seoreviewtools.com/valuable-backlinks-checker/ | https://www.seobility.net/en/backlinkchecker/.
- **CrakSEO product:** Backlink Checker.
- **Listing name:** Backlink Checker.
- **Listing description:** Check backlinks and referring domains for any website, compare against competitors and find link opportunities.
- **Keywords to target:** backlink checker, free backlink checker, backlinks, check backlinks.
- **Suggested tool names:** `get_backlinks`, `get_referring_domains`, `get_backlink_summary`, `compare_backlink_gap`.
- **Suggested plugin skills:** `audit-backlink-profile`, `find-competitor-link-opportunities`.

### 5. Why is this page slow or failing Core Web Vitals?

- **Why:** free-tool pages for this task get 264,646 US organic visits a month; recent task keyword volume is 21,840 US searches a month (branded at 0.5x) across 8 keyword groups; Smithery signal 4.5 (largest server: speedvault/speedvault (66% before cap)); 12-month keyword trend +40%; fit 0.63.
- **Top keywords:** page speed (7,074) | google pagespeed insights (5,667) | website speed test (4,356).
- **Top free-tool pages:** https://pagespeed.web.dev/ | https://gtmetrix.com/ | https://tools.pingdom.com/.
- **CrakSEO product:** SEO Site Audit.
- **Listing name:** Page Speed and Core Web Vitals.
- **Listing description:** Check page speed and Core Web Vitals from real-user field data and lab tests, with prioritized fixes.
- **Keywords to target:** pagespeed insights, website speed test, core web vitals.
- **Suggested tool names:** `get_core_web_vitals`, `run_lighthouse`, `compare_page_speed`.
- **Suggested plugin skills:** `check-performance-before-deploy`.

## All Tasks

| Rank | Task ID | Task | Score | Demand | Fit | Page traffic | Recent keyword volume | Smithery signal | 12-mo keyword trend | 24-mo page trend |
|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | audit_site | Find the technical SEO problems on my site. | 0.624 | 0.851 | 0.73 | 315,961 | 12,846 | 13.6 | -38% | +193% |
| 2 | kw_ideas | Which keywords should I target for this topic? | 0.605 | 0.864 | 0.70 | 394,423 | 12,235 | 7.8 | +196% | +819% |
| 3 | serp_results | What ranks for this keyword right now? | 0.534 | 0.616 | 0.87 | 40,390 | 16,277 | 0.4 | -26% | +267% |
| 4 | links_profile | Who links to this website? | 0.532 | 0.799 | 0.67 | 180,116 | 61,393 | 1.8 | +194% | +412% |
| 5 | audit_speed | Why is this page slow or failing Core Web Vitals? | 0.507 | 0.801 | 0.63 | 264,646 | 21,840 | 4.5 | +40% | +13% |
| 6 | gsc_drop | Why did my organic traffic drop? | 0.506 | 0.542 | 0.93 | 4,219 | 3,800 | 1.2 | -26% | +164% |
| 7 | ai_mentions | Is my brand mentioned in ChatGPT and Perplexity? | 0.496 | 0.676 | 0.73 | 4,701 | 15,894 | 3.3 | +168% | n/a |
| 8 | rank_position | Where does my site rank for this keyword? | 0.495 | 0.646 | 0.77 | 207,416 | 12,844 | 0.1 | -6% | +346% |
| 9 | index_status | Is this page indexed by Google? | 0.479 | 0.513 | 0.93 | 2,014 | 2,914 | 0.1 | +259% | +110% |
| 10 | kw_volume | What is the search volume for this keyword? | 0.468 | 0.610 | 0.77 | 48,818 | 2,383 | 1.3 | -22% | -14% |
| 11 | serp_aio | What does the AI Overview say for this keyword? | 0.452 | 0.646 | 0.70 | 1,132 | 29,370 | 3.3 | +148% | +8791% |
| 12 | comp_keywords | Which keywords send traffic to my competitor? | 0.428 | 0.584 | 0.73 | 50,823 | 3,848 | 0.4 | -22% | +145% |
| 13 | local_rank | Where does my business rank on Google Maps? | 0.428 | 0.584 | 0.73 | 19,001 | 1,711 | 1.6 | +8% | +509% |
| 14 | comp_traffic | How much search traffic does my competitor get? | 0.408 | 0.644 | 0.63 | 265,984 | 8,797 | 0.1 | -11% | +199% |
| 15 | content_onpage | How can I optimize this page for its target keyword? | 0.406 | 0.641 | 0.63 | 12,734 | 7,862 | 3.0 | -29% | +171% |
| 16 | audit_schema | Is my structured data valid for rich results? | 0.386 | 0.681 | 0.57 | 10,848 | 15,997 | 3.7 | +37% | +178% |
| 17 | content_cannibal | Are my pages competing for the same keyword? | 0.375 | 0.450 | 0.83 | 546 | 3,419 | 0.5 | -25% | +27% |
| 18 | local_reviews | What are customers saying in my Google Business Profile reviews? | 0.375 | 0.511 | 0.73 | 8,990 | 2,811 | 0.1 | +16% | n/a |
| 19 | comp_gap | Which keywords do competitors rank for that I miss? | 0.354 | 0.462 | 0.77 | 6,867 | 982 | 0.0 | -63% | +2921% |
| 20 | audit_links | Find broken links on my site. | 0.351 | 0.620 | 0.57 | 48,538 | 25,628 | 0.0 | +22% | +155% |
| 21 | kw_difficulty | How hard is it to rank for this keyword? | 0.347 | 0.520 | 0.67 | 24,405 | 1,591 | 0.1 | -42% | +452% |
| 22 | local_audit | What should I fix in my Google Business Profile? | 0.329 | 0.470 | 0.70 | 361 | 891 | 2.9 | -19% | +341% |
| 23 | content_brief | Create a search-informed content brief for this keyword. | 0.288 | 0.454 | 0.63 | 143 | 1,557 | 0.0 | +982% | +705% |
| 24 | index_diagnose | Why is this page not indexed? | 0.278 | 0.287 | 0.97 | 0 | 11,266 | 0.1 | +91% | n/a |
| 25 | links_gap | Who links to my competitors but not me? | 0.262 | 0.394 | 0.67 | 582 | 794 | 0.1 | +22% | +11357% |
| 26 | ai_citations | Which sites are cited in AI Overviews for my topic? | 0.260 | 0.371 | 0.70 | 1,488 | 7 | 2.2 | +0% | +9923% |
| 27 | index_submit | Submit these URLs for indexing. | 0.201 | 0.223 | 0.90 | 0 | 1,304 | 0.1 | +68% | n/a |
| 28 | gsc_opportunity | Which keywords in positions 8 to 20 can I improve? | 0.194 | 0.201 | 0.97 | 0 | 189 | 1.2 | -14% | n/a |
| 29 | links_lost | Which backlinks did my site lose? | 0.071 | 0.101 | 0.70 | 0 | 29 | 0.1 | -38% | n/a |
| 30 | gsc_top | Which queries and pages bring me search traffic? | 0.051 | 0.058 | 0.87 | 0 | 0 | 1.2 | n/a | n/a |

## How the Score Works

demand_index = 0.4 x page traffic + 0.3 x keyword volume + 0.2 x Smithery signal + 0.1 x keyword growth. Each term is log1p(x) / max log1p(x) across the 30 tasks. fit = mean of six 1-5 fit scores / 5 (rationales in fit_scores.csv). score = demand_index x fit. Weights live in scripts/config.json.

- **Page traffic:** latest-month US organic traffic (Semrush resource_rank_history) for 3-5 free-tool pages per task, chosen from the task's actual US search results (imports/toolpage_reviews.csv). A page used by several tasks has its traffic split equally between them. Google's Search Console product page is excluded: its traffic is people opening a product they already use.
- **Keyword volume:** 372 US keywords from Semrush (seeds, problem-phrased diagnostic seeds, and top-10 related terms). Volume = Semrush headline volume x mean of the last 3 monthly trend values (Semrush trends run oldest to newest); keywords without a trend use headline volume. Vendor-branded keywords (ahrefs, semrush, ubersuggest, spyfu, keyword planner, moz, etc.) count at 0.5x. Close variants are grouped by their core words and counted once; Semrush has no parent-topic field, so this approximates it.
- **Excluded keywords (749, in keywords_excluded.csv):** 677 off-topic related terms; 58 spike-then-collapse terms (peak month more than 5x both the last-3-month average and the 12-month median); 14 navigational terms (Search Console / webmaster tools product names, login terms, and keywords containing a domain name).
- **Smithery signal:** per server, log1p(useCount) split equally across the tasks it maps to. No single server may contribute more than 50% of a task's uncapped signal (largest server shown in scores.csv as mcp_top_server). useCount's time window isn't published.
- **Trend:** Semrush keyword reports give a 12-month relative trend, not 24 months of volumes. The score uses the volume-weighted change between the last 3 and first 3 months, floored at zero. The 24-month page-traffic trend is shown for reference only.
- **Directory gap:** the score uses the Claude Connectors Directory gap. Kai checked it manually and found no dedicated connector for gsc_top, gsc_opportunity, gsc_drop, index_status, index_submit, index_diagnose or serp_results (set to 5). Other tasks use the open-registry score. The open-registry gap (official MCP Registry, Smithery, Glama) is kept separately as directory_gap_open_registry in fit_scores.csv.

## Directory Findings

- Official MCP Registry: 294 SEO-related listings across the searches run. Smithery: 121. Glama: 24 detail pages. 638 tool names observed.
- Open registries: 51 official MCP Registry listings map to Search Console, including [CrakSEO's own](https://registry.modelcontextprotocol.io/?q=com.crakseo/search-console). Claude Connectors Directory (Kai's manual check): no dedicated Search Console, indexing or SERP API connector. The gap is in Claude's directory, not in the MCP ecosystem.
- Indexing: the Registry search for 'indexing' returned nothing, but 8 IndexNow listings exist.
- Claude Connectors Directory: its public page ignored search queries, so the gap scores for the seven Search Console, indexing and SERP tasks rest on Kai's manual check. PulseMCP blocked requests (HTTP 403).

## API Market Signal

[DataForSEO](https://dataforseo.com/apis) leads with SERP, Keyword Data, Backlinks, On-Page and Labs APIs. [SerpAPI](https://serpapi.com/) leads with Google Search and also sells AI Overview, AI Mode, Maps and Reviews endpoints. Both line up with the top-ranked tasks here. Product links are in api_market_signals.csv.

## Validation Plan for the Top 3

For each, ship a landing page targeting the listed keywords plus a directory listing or a thin free version, and run for 2-3 weeks.

| Task | Thin free version | Success event |
|---|---|---|
| Find the technical SEO problems on my site. | SEO Site Audit with a small free quota | first successful `run_site_audit` call |
| Which keywords should I target for this topic? | Keyword Research and Ideas with a small free quota | first successful `suggest_keywords` call |
| What ranks for this keyword right now? | Google SERP Checker with a small free quota | first successful `get_google_serp` call |

Track installs, first successful tool call, install-to-first-call rate, week-2 repeat use and paid conversion per listing. Exclude internal testing and tag traffic by source (directory, plugin, landing page).

## Caveats

- US only. Global volume, traffic potential and clicks per search are not in the Semrush reports used.
- Free-tool page choices and keyword relevance filters are judgment calls. Both are in editable files; rerun build.py after changing them.
- Search Console tasks (top queries, striking-distance keywords, indexing) now get no free-tool page traffic, and almost no keyword volume once product-name searches are removed. Demand for analysing your own Search Console data barely shows up in search, because people do it inside Search Console. The search-based demand proxy undercounts these private-data tasks.
- Lost backlinks had no free tool in its search results, so its page traffic is zero.
- The 5x spike rule is strict; seeds right at the threshold (e.g. 'crawled currently not indexed', exactly 5.0x) are kept.
- Smithery useCount has no published time window. Even after log scaling and the 50% cap, a handful of servers drive most of it (mcp_signals.csv).
- Branded keywords count at 0.5x but still count; some top keywords remain vendor-specific.
- No first-party CrakSEO call data or AI prompt-volume data was used.

## Reproduce

From the repo root, run `seo-mcp-demand/.venv/bin/python seo-mcp-demand/scripts/build.py`. It rebuilds every CSV, this report and the workbook from cache with no network calls. See README.md for collection commands.
