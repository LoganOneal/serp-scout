"""Render REPORT.md from generated tables. Recommendation copy is analyst input; all numbers come from data/."""

import csv
from collections import Counter

from public import PageParser, map_tasks, records
from study import ROOT, write_csv

# Analyst copy per task; the report uses whichever five tasks rank highest.
PLAYBOOK = {
    "kw_ideas": {"product": "Keyword Research; SEO MCP bundle", "listing_name": "Keyword Research and Ideas", "description": "Find keyword ideas for any topic with search volume, keyword difficulty and CPC from live keyword data.", "keywords": "keyword research, keyword research tool, free keyword research tool, keyword ideas, keyword generator", "tools": "suggest_keywords|get_keyword_volume|get_keyword_difficulty|get_related_keywords", "skills": "research-keywords-for-topic|plan-content-cluster"},
    "audit_site": {"product": "SEO Site Audit", "listing_name": "SEO Site Audit", "description": "Audit any website for technical SEO issues: crawlability, indexability, broken links, meta tags, speed and structured data, with prioritized fixes.", "keywords": "seo audit, website audit, free seo audit tool, seo checker, site audit", "tools": "run_site_audit|get_audit_issues|check_page_seo|recheck_after_fix", "skills": "audit-site-before-launch|fix-technical-seo-issues"},
    "gsc_top": {"product": "Search Console MCP (free)", "listing_name": "Google Search Console", "description": "Query your Google Search Console data: top queries and pages, clicks, impressions, CTR and position, plus URL inspection.", "keywords": "google search console, search console, gsc, search console api", "tools": "get_search_performance|get_top_queries|get_top_pages|inspect_url", "skills": "weekly-search-report|find-pages-losing-clicks"},
    "gsc_opportunity": {"product": "Search Console MCP (free) plus paid plugin workflow", "listing_name": "Search Console Opportunities", "description": "Find striking-distance keywords (positions 8-20) in your Search Console data and turn them into a prioritized page-update list.", "keywords": "striking distance keywords, search console keyword opportunities, quick win keywords", "tools": "find_striking_distance_keywords|get_page_queries|suggest_page_updates", "skills": "weekly-search-opportunities|refresh-underperforming-page"},
    "links_profile": {"product": "Backlink Checker", "listing_name": "Backlink Checker", "description": "Check backlinks and referring domains for any website, compare against competitors and find link opportunities.", "keywords": "backlink checker, free backlink checker, backlinks, check backlinks", "tools": "get_backlinks|get_referring_domains|get_backlink_summary|compare_backlink_gap", "skills": "audit-backlink-profile|find-competitor-link-opportunities"},
    "rank_position": {"product": "Rank Tracker", "listing_name": "Keyword Rank Checker", "description": "Check where your site ranks on Google for any keyword, by location and device, and track position changes over time.", "keywords": "keyword rank checker, rank tracker, google rank checker, serp position checker", "tools": "check_keyword_position|track_keywords|get_rank_history", "skills": "track-rankings-after-deploy|report-rank-changes"},
    "index_status": {"product": "Search Console MCP; planned indexing listing", "listing_name": "Google Index Checker", "description": "Check whether pages are indexed in Google, see why they are not, and submit sitemaps or eligible URLs.", "keywords": "google index checker, check if page is indexed, google indexing", "tools": "inspect_url_indexing|diagnose_indexing_blockers|submit_sitemap", "skills": "post-deploy-index-check|fix-indexing-blockers"},
    "kw_volume": {"product": "Keyword Research", "listing_name": "Keyword Search Volume", "description": "Check monthly search volume, CPC and difficulty for any keyword.", "keywords": "keyword search volume, search volume checker, keyword volume", "tools": "get_keyword_volume|get_keyword_difficulty", "skills": "validate-keyword-demand"},
    "audit_speed": {"product": "SEO Site Audit", "listing_name": "Page Speed and Core Web Vitals", "description": "Check page speed and Core Web Vitals from real-user field data and lab tests, with prioritized fixes.", "keywords": "pagespeed insights, website speed test, core web vitals", "tools": "get_core_web_vitals|run_lighthouse|compare_page_speed", "skills": "check-performance-before-deploy"},
    "serp_results": {"product": "Google SERP API", "listing_name": "Google SERP Checker", "description": "Get live Google search results for any keyword by location and device, including AI Overviews and SERP features.", "keywords": "serp checker, google serp, serp api", "tools": "get_google_serp|get_ai_overview|get_serp_features", "skills": "research-live-serp|build-serp-backed-brief"},
    "ai_mentions": {"product": "AI Visibility", "listing_name": "AI Visibility Checker", "description": "Check whether ChatGPT, Perplexity and Google AI Overviews mention your brand for the prompts that matter, and track it over time.", "keywords": "ai visibility, ai visibility checker, ai search visibility, chatgpt brand mentions", "tools": "check_ai_visibility|track_prompts|get_ai_citations", "skills": "audit-ai-visibility|improve-ai-citations"},
    "gsc_drop": {"product": "Search Console MCP (free) plus paid plugin workflow", "listing_name": "Traffic Drop Diagnosis", "description": "Find out why your Google traffic dropped: compare Search Console periods, match the drop to Google core updates, and list the pages and queries that lost clicks.", "keywords": "website traffic dropped, organic traffic drop, google core update, google algorithm update", "tools": "diagnose_traffic_drop|compare_search_periods|get_google_updates", "skills": "investigate-traffic-drop|recover-lost-rankings"},
}


def read_table(name):
    with (ROOT / "data" / name).open(newline="", encoding="utf-8") as handle:
        return list(csv.DictReader(handle))


def num(value, digits=0):
    if value in (None, ""):
        return "n/a"
    return f"{float(value):,.{digits}f}"


def pct(value):
    return f"{float(value) * 100:+.0f}%" if value not in (None, "") else "n/a"


def market_evidence():
    output = []
    for record in records():
        if record["label"] not in ("dataforseo:products", "serpapi:products", "serpapi:pricing") or record["status"] != 200:
            continue
        parser = PageParser()
        parser.feed(record["body"])
        for link in parser.links:
            if "api" in link["text"].lower() and link["text"].strip():
                output.append({"vendor": record["label"].split(":")[0], "product": link["text"].strip(), "url": link["href"], "task_ids": "|".join(map_tasks(link["text"])), "signal_type": "commercial_api_supply_not_usage", "evidence": record["cache_file"]})
    unique = {(row["vendor"], row["url"]): row for row in output}
    write_csv("api_market_signals.csv", ["vendor", "product", "url", "task_ids", "signal_type", "evidence"], unique.values())


def write_report(scores, scenarios, signals, config):
    market_evidence()
    rows = read_table("scores.csv")
    by_id = {row["task_id"]: row for row in rows}
    ranked = [row for row in rows if row["rank"]]
    top5 = [row["task_id"] for row in ranked[:5]]
    recommendations = [{"rank": by_id[task]["rank"], "task_id": task, **PLAYBOOK.get(task, {"product": "new build", "listing_name": by_id[task]["task"], "description": "", "keywords": "", "tools": "", "skills": ""})} for task in top5]
    write_csv("recommendations.csv", ["rank", "task_id", "product", "listing_name", "description", "keywords", "tools", "skills"], recommendations)
    keywords = read_table("keywords_raw.csv")
    excluded = read_table("keywords_excluded.csv")
    tools = read_table("mcp_tools.csv")
    counts = Counter(row["source"] for row in signals)
    gsc = [row for row in signals if row["source"] == "official_registry" and "gsc_top" in row["task_ids"].split("|")]
    indexnow = [row for row in signals if "indexnow" in (row["name"] + row["description"]).lower()]
    scenario_rows = [row for row in scenarios if row["scenario"] != "baseline"]
    appearances = Counter(task for row in scenario_rows for task in row["top_five"].split("|"))
    changed = sum(set(row["top_five"].split("|")) != set(top5) for row in scenario_rows)
    weights = config["weights"]
    semrush = [record for record in records() if record.get("identity", {}).get("provider") == "semrush-oauth"]
    units = sum(record.get("units") or 0 for record in semrush)
    fetched = sorted(record["fetched_at"][:10] for record in semrush)

    out = [
        "# CrakSEO MCP Demand Research",
        "",
        f"Data: Semrush US database via the Cursor Semrush MCP login ({len(semrush)} reports, {units:,} API units, fetched {fetched[0] if fetched else 'n/a'}). MCP directory data from the official MCP Registry, Smithery and Glama. Market: US. No new paid spend.",
        "",
        "## Top 5",
        "",
        "| Rank | Task | Score | Demand | Fit | Free-tool page traffic / mo | Recent keyword volume / mo | Smithery signal |",
        "|---:|---|---:|---:|---:|---:|---:|---:|",
    ]
    for task in top5:
        row = by_id[task]
        out.append(f"| {row['rank']} | {row['task']} | {num(row['score'], 3)} | {num(row['demand_index'], 3)} | {num(row['fit'], 2)} | {num(row['tool_page_traffic'])} | {num(row['keyword_volume_rollup'])} | {num(row['mcp_usage_signal'], 1)} |")
    out += [
        "",
        f"**Sensitivity:** in {len(scenario_rows)} scenarios that move 0.1 weight between any two demand terms, a different set of five tasks made the top five in {changed} (reordering not counted). "
        + "Times in the top five: " + ", ".join(f"{by_id[task]['task_id']} {count}/{len(scenario_rows)}" for task, count in appearances.most_common(8)) + ".",
    ]
    changes = read_table("rank_changes.csv") if (ROOT / "data/rank_changes.csv").exists() else []
    if changes:
        out += [
            "",
            "## Before / After (Revision 2)",
            "",
            "Revision 2: recent 3-month keyword volume, spike-then-collapse and navigational keywords excluded, vendor-branded volume at 0.5x, problem-phrased diagnostic seeds added, Search Console product page removed from free-tool pages, Smithery signal log-scaled with a 50% per-server cap, and Claude-directory gap set to 5 for the seven tasks Kai checked manually.",
            "",
            "| Before | After | Change | Task ID | Why (moves of 3+ places) |",
            "|---:|---:|---:|---|---|",
        ]
        for change in changes:
            out.append(f"| {change['rank_before']} | {change['rank_after']} | {int(change['rank_change']):+d} | {change['task_id']} | {change['explanation']} |")
    out += [
        "",
        "## Recommendations",
    ]
    for rec in recommendations:
        row = by_id[rec["task_id"]]
        out += [
            "",
            f"### {rec['rank']}. {row['task']}",
            "",
            f"- **Why:** free-tool pages for this task get {num(row['tool_page_traffic'])} US organic visits a month; recent task keyword volume is {num(row['keyword_volume_rollup'])} US searches a month (branded at 0.5x) across {row['keyword_topics']} keyword groups; Smithery signal {num(row['mcp_usage_signal'], 1)} (largest server: {row['mcp_top_server'] or 'none'}); 12-month keyword trend {pct(row['trend_growth_signed'])}; fit {num(row['fit'], 2)}.",
            f"- **Top keywords:** {row['top_keywords']}.",
            f"- **Top free-tool pages:** {row['top_tool_pages'] or 'none found'}.",
            f"- **CrakSEO product:** {rec['product']}.",
            f"- **Listing name:** {rec['listing_name']}.",
            f"- **Listing description:** {rec['description']}",
            f"- **Keywords to target:** {rec['keywords']}.",
            f"- **Suggested tool names:** `{rec['tools'].replace('|', '`, `')}`.",
            f"- **Suggested plugin skills:** `{rec['skills'].replace('|', '`, `')}`.",
        ]
    if "gsc_top" in top5 and "gsc_opportunity" in top5:
        out += ["", "Search Console top queries and striking-distance keywords are the same product. Ship one free Search Console connector and make the opportunity workflow the paid plugin skill."]
    out += [
        "",
        "## All Tasks",
        "",
        "| Rank | Task ID | Task | Score | Demand | Fit | Page traffic | Recent keyword volume | Smithery signal | 12-mo keyword trend | 24-mo page trend |",
        "|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for row in ranked:
        out.append(f"| {row['rank']} | {row['task_id']} | {row['task']} | {num(row['score'], 3)} | {num(row['demand_index'], 3)} | {num(row['fit'], 2)} | {num(row['tool_page_traffic'])} | {num(row['keyword_volume_rollup'])} | {num(row['mcp_usage_signal'], 1)} | {pct(row['trend_growth_signed'])} | {pct(row['tool_page_trend_24m'])} |")
    out += [
        "",
        "## How the Score Works",
        "",
        f"demand_index = {weights['tool_page_traffic']} x page traffic + {weights['keyword_volume_rollup']} x keyword volume + {weights['mcp_usage_signal']} x Smithery signal + {weights['trend_growth']} x keyword growth. Each term is log1p(x) / max log1p(x) across the 30 tasks. fit = mean of six 1-5 fit scores / 5 (rationales in fit_scores.csv). score = demand_index x fit. Weights live in scripts/config.json.",
        "",
        "- **Page traffic:** latest-month US organic traffic (Semrush resource_rank_history) for 3-5 free-tool pages per task, chosen from the task's actual US search results (imports/toolpage_reviews.csv). A page used by several tasks has its traffic split equally between them. Google's Search Console product page is excluded: its traffic is people opening a product they already use.",
        f"- **Keyword volume:** {sum(row['status'] == 'observed' for row in keywords)} US keywords from Semrush (seeds, problem-phrased diagnostic seeds, and top-10 related terms). Volume = Semrush headline volume x mean of the last 3 monthly trend values (Semrush trends run oldest to newest); keywords without a trend use headline volume. Vendor-branded keywords (ahrefs, semrush, ubersuggest, spyfu, keyword planner, moz, etc.) count at 0.5x. Close variants are grouped by their core words and counted once; Semrush has no parent-topic field, so this approximates it.",
        f"- **Excluded keywords ({len(excluded)}, in keywords_excluded.csv):** {sum(row['reason'] == 'no task term match' for row in excluded)} off-topic related terms; {sum(row['reason'].startswith('spike') for row in excluded)} spike-then-collapse terms (peak month more than 5x both the last-3-month average and the 12-month median); {sum(row['reason'].startswith('navigational') for row in excluded)} navigational terms (Search Console / webmaster tools product names, login terms, and keywords containing a domain name).",
        "- **Smithery signal:** per server, log1p(useCount) split equally across the tasks it maps to. No single server may contribute more than 50% of a task's uncapped signal (largest server shown in scores.csv as mcp_top_server). useCount's time window isn't published.",
        "- **Trend:** Semrush keyword reports give a 12-month relative trend, not 24 months of volumes. The score uses the volume-weighted change between the last 3 and first 3 months, floored at zero. The 24-month page-traffic trend is shown for reference only.",
        "- **Directory gap:** the score uses the Claude Connectors Directory gap. Kai checked it manually and found no dedicated connector for gsc_top, gsc_opportunity, gsc_drop, index_status, index_submit, index_diagnose or serp_results (set to 5). Other tasks use the open-registry score. The open-registry gap (official MCP Registry, Smithery, Glama) is kept separately as directory_gap_open_registry in fit_scores.csv.",
        "",
        "## Directory Findings",
        "",
        f"- Official MCP Registry: {counts['official_registry']} SEO-related listings across the searches run. Smithery: {counts['smithery']}. Glama: {counts['glama']} detail pages. {len(tools)} tool names observed.",
        f"- Open registries: {len(gsc)} official MCP Registry listings map to Search Console, including [CrakSEO's own](https://registry.modelcontextprotocol.io/?q=com.crakseo/search-console). Claude Connectors Directory (Kai's manual check): no dedicated Search Console, indexing or SERP API connector. The gap is in Claude's directory, not in the MCP ecosystem.",
        f"- Indexing: the Registry search for 'indexing' returned nothing, but {len(indexnow)} IndexNow listings exist.",
        "- Claude Connectors Directory: its public page ignored search queries, so the gap scores for the seven Search Console, indexing and SERP tasks rest on Kai's manual check. PulseMCP blocked requests (HTTP 403).",
        "",
        "## API Market Signal",
        "",
        "[DataForSEO](https://dataforseo.com/apis) leads with SERP, Keyword Data, Backlinks, On-Page and Labs APIs. [SerpAPI](https://serpapi.com/) leads with Google Search and also sells AI Overview, AI Mode, Maps and Reviews endpoints. Both line up with the top-ranked tasks here. Product links are in api_market_signals.csv.",
        "",
        "## Validation Plan for the Top 3",
        "",
        "For each, ship a landing page targeting the listed keywords plus a directory listing or a thin free version, and run for 2-3 weeks.",
        "",
        "| Task | Thin free version | Success event |",
        "|---|---|---|",
    ]
    for task in top5[:3]:
        rec = PLAYBOOK.get(task, {})
        first_tool = rec.get("tools", "").split("|")[0]
        out.append(f"| {by_id[task]['task']} | {rec.get('listing_name', '')} with a small free quota | first successful `{first_tool}` call |")
    out += [
        "",
        "Track installs, first successful tool call, install-to-first-call rate, week-2 repeat use and paid conversion per listing. Exclude internal testing and tag traffic by source (directory, plugin, landing page).",
        "",
        "## Caveats",
        "",
        "- US only. Global volume, traffic potential and clicks per search are not in the Semrush reports used.",
        "- Free-tool page choices and keyword relevance filters are judgment calls. Both are in editable files; rerun build.py after changing them.",
        "- Search Console tasks (top queries, striking-distance keywords, indexing) now get no free-tool page traffic, and almost no keyword volume once product-name searches are removed. Demand for analysing your own Search Console data barely shows up in search, because people do it inside Search Console. The search-based demand proxy undercounts these private-data tasks.",
        "- Lost backlinks had no free tool in its search results, so its page traffic is zero.",
        "- The 5x spike rule is strict; seeds right at the threshold (e.g. 'crawled currently not indexed', exactly 5.0x) are kept.",
        "- Smithery useCount has no published time window. Even after log scaling and the 50% cap, a handful of servers drive most of it (mcp_signals.csv).",
        "- Branded keywords count at 0.5x but still count; some top keywords remain vendor-specific.",
        "- No first-party CrakSEO call data or AI prompt-volume data was used.",
        "",
        "## Reproduce",
        "",
        "From the repo root, run `seo-mcp-demand/.venv/bin/python seo-mcp-demand/scripts/build.py`. It rebuilds every CSV, this report and the workbook from cache with no network calls. See README.md for collection commands.",
    ]
    (ROOT / "REPORT.md").write_text("\n".join(out) + "\n", encoding="utf-8")
