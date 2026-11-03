"""Prepare documented Semrush report requests and transform cached report CSVs."""

import csv
import io
import json
import re
from collections import defaultdict
from urllib.parse import urlparse

from public import records
from study import ROOT, generate, write_csv

# A related keyword counts for a task only if it matches that task's terms.
TASK_TERMS = {
    "kw_volume": r"volume|how many searches|search count|keyword planner",
    "kw_ideas": r"keyword (research|ideas?|generator|finder|tool|suggest\w*|planner|explorer)|ubersuggest",
    "kw_difficulty": r"difficult|\bkd\b|keyword competition",
    "serp_results": r"\bserps?\b|search results|google results",
    "rank_position": r"\brank|position",
    "serp_aio": r"ai overview|\bsge\b|ai mode",
    "gsc_drop": r"traffic (drop|loss|decline|down)|lost traffic|algorithm update|traffic dropped|drop in traffic|core update",
    "gsc_top": r"search console|webmaster tools?|\bgsc\b",
    "gsc_opportunity": r"striking distance|low hanging|quick wins?|keyword opportunit",
    "index_status": r"index|not on google|not showing (up )?on google",
    "index_submit": r"index|submit",
    "index_diagnose": r"index|crawled|discovered|canonical|soft 404|noindex|not on google|without content",
    "audit_site": r"audit|analy[sz]er|seo check|site check|website check|seo test|seo score|grader",
    "audit_speed": r"(website|site|page|web ?page|wordpress|shopify|mobile site|seo) ?speed|pagespeed|core web vitals|lighthouse|load time|gtmetrix|pingdom|webpagetest|\bcwv\b",
    "audit_links": r"broken (link|url|page|backlink)s?|dead link|(?<!back)link check|\b404\b",
    "audit_schema": r"schema (markup|validator|checker|generator|test|org)|schema\.org|structured data|rich (result|snippet)|json.?ld|microdata",
    "links_profile": r"backlink|inbound link|link explorer|referring domain",
    "links_gap": r"(back)?link gap|link intersect|backlink.*(compar|competitor)",
    "links_lost": r"lost|reclaim",
    "comp_keywords": r"competitor|spyfu|rival",
    "comp_traffic": r"traffic",
    "comp_gap": r"gap",
    "ai_mentions": r"\bai (visibility|search|seo|mention|brand|rank)|chatgpt|perplexity|\bllms?\b|gemini|claude|\bgeo\b|generative engine|answer engine|brand mention",
    "ai_citations": r"citation|ai overview|cited",
    "local_rank": r"(map|maps|local|gmb|gbp|business profile) ?(rank|ranking)|rank.*(map|local)|geo ?grid|local falcon",
    "local_reviews": r"review (management|response|monitor|tracker|generator|link|widget|api)|(respond|reply|manage|get more|monitor|track)\w* .*reviews?|business reviews?|reviews? (checker|tool|software)",
    "local_audit": r"business profile|\bgmb\b|\bgbp\b|google my business|audit",
    "content_brief": r"brief|outline",
    "content_onpage": r"on.?page|content optimi|page seo|seo checker|seo analy",
    "content_cannibal": r"cannibal",
}

# Extra SERP queries for tasks whose seed SERPs came back empty.
EXTRA_SERP_QUERIES = {
    "ai_citations": ["ai overview checker", "ai citation checker"],
    "gsc_drop": ["traffic drop checker", "google algorithm update checker"],
    "index_diagnose": ["page not indexed checker", "why is my page not indexed"],
}

TOPIC_STOPWORDS = {"free", "online", "tool", "tools", "checker", "check", "best", "top", "the", "a", "an", "for", "of", "to", "how", "my", "your", "website", "site", "google", "seo", "app", "software", "and", "in", "on", "is", "2024", "2025", "2026"}

# People going to a product they already use, not looking for a way to do the task.
NAVIGATIONAL = r"^(google )?(search console|webmaster tools?|gsc|google console|console search)( (login|log ?in|sign ?in|home|app|account|analytics|tools?|google|search))?$|^search webmaster tools?$|\b(log ?in|sign ?in)\b|\w\.\s?(com|net|org|io|co|ai)\b"

# Vendor names; branded volume counts at BRAND_WEIGHT.
BRANDS = ["ahrefs", "semrush", "ubersuggest", "spyfu", "google keyword planner", "keyword planner", "moz", "similarweb", "se ranking", "seranking", "mangools", "kwfinder", "majestic", "screaming frog", "gtmetrix", "pingdom", "pagespeed insights", "neil patel", "neilpatel", "wordstream", "keywordtool", "keywords everywhere", "seobility", "seoptimer", "sitechecker", "brandrank", "local falcon", "yoast", "rank math", "surfer", "clearscope", "frase", "conductor", "brightlocal", "whitespark", "serpstat", "seoquake", "wordtracker", "webpagetest", "smallseotools", "small seo tools", "sistrix", "accuranker", "serpapi", "dataforseo"]
BRAND_WEIGHT = 0.5
SPIKE_RATIO = 5


def brand_of(keyword):
    return next((brand for brand in BRANDS if re.search(r"\b" + re.escape(brand) + r"\b", keyword, re.I)), "")


def trend_values(series):
    return [float(value) for value in series.split(",") if value.strip()] if series else []


def recent_volume(volume, series):
    """Headline volume x mean of the last 3 monthly trend values (Semrush trends are oldest-first)."""
    values = trend_values(series)
    if volume in (None, "") or len(values) != 12:
        return volume, False
    return round(float(volume) * sum(values[-3:]) / 3), True


def spike_collapse(series):
    values = trend_values(series)
    if len(values) != 12 or max(values) == 0:
        return False
    peak = max(values)
    recent = sum(values[-3:]) / 3
    median = sorted(values)[6]
    return peak > SPIKE_RATIO * recent and peak > SPIKE_RATIO * median


def topic_key(keyword):
    words = [word[:-1] if len(word) > 3 and word.endswith("s") and not word.endswith("ss") else word for word in re.findall(r"[a-z0-9]+", keyword.lower())]
    core = sorted({word for word in words if word not in TOPIC_STOPWORDS})
    return " ".join(core) or keyword.lower()


def relevant_tasks(keyword, task_ids):
    return {task_id for task_id in task_ids if re.search(TASK_TERMS[task_id], keyword, re.I)}


def trend_growth_12m(series):
    values = [float(value) for value in series.split(",") if value.strip()] if series else []
    if len(values) != 12 or sum(values[:3]) == 0:
        return ""
    return round(sum(values[-3:]) / sum(values[:3]) - 1, 4)


def read_optional(name):
    path = ROOT / "imports" / name
    if not path.exists():
        return []
    with path.open(newline="", encoding="utf-8-sig") as handle:
        return list(csv.DictReader(handle))


ALIASES = {
    "keyword": ("keyword", "ph"),
    "volume": ("search volume", "search_volume", "volume", "nq"),
    "cpc": ("cpc", "cp"),
    "difficulty": ("keyword difficulty", "keyword difficulty index", "keyword_difficulty", "kd"),
    "url": ("url", "ur"),
    "position": ("position", "po"),
    "traffic": ("organic traffic", "organic_traffic", "ot"),
    "trend": ("trends", "trend", "td"),
    "date": ("date", "dt"),
}


def report_rows(payload):
    if isinstance(payload, str) and payload.strip():
        first = payload.strip().splitlines()[0]
        delimiter = ";" if ";" in first else "\t" if "\t" in first else ","
        payload = list(csv.DictReader(io.StringIO(payload.strip()), delimiter=delimiter))
    if not isinstance(payload, list):
        return []
    return [{str(key).strip().lower(): value for key, value in row.items()} for row in payload if isinstance(row, dict)]


def pick(row, field):
    return next((str(row[name]).strip() for name in ALIASES[field] if row.get(name) not in (None, "")), "")


def semrush_rows():
    with (ROOT / "data/seeds.csv").open() as handle:
        seeds = list(csv.DictReader(handle))
    mappings = defaultdict(set)
    for seed in seeds:
        mappings[seed["seed_keyword"]].add(seed["task_id"])
    for task_id, queries in EXTRA_SERP_QUERIES.items():
        for query in queries:
            mappings[query].add(task_id)
    keywords = {}
    excluded = []
    empty_seeds = {}
    candidates = []
    traffic = {}
    for record in records():
        payload = record.get("body", record.get("data"))
        if not record["label"].startswith("semrush:") or record["status"] != 200 or (isinstance(payload, str) and payload.strip().startswith("ERROR")):
            continue
        parts = record["label"].split(":", 2)
        if len(parts) != 3 or parts[1] not in ("phrase_this", "phrase_related", "phrase_organic", "resource_rank_history"):
            continue
        _, report, params_text = parts
        params = json.loads(params_text)
        rows = report_rows(payload)
        if report == "phrase_this" and not rows:
            empty_seeds[params["phrase"]] = record
        if report in ("phrase_this", "phrase_related"):
            seed = params["phrase"]
            for row in rows:
                keyword = pick(row, "keyword").lower()
                if not keyword:
                    continue
                matched = relevant_tasks(keyword, mappings[seed])
                if not matched:
                    excluded.append({"keyword": keyword, "seed_keyword": seed, "seed_task_ids": "|".join(sorted(mappings[seed])), "volume_us": pick(row, "volume"), "trend_12m": pick(row, "trend"), "reason": "no task term match"})
                    continue
                if re.search(NAVIGATIONAL, keyword, re.I):
                    excluded.append({"keyword": keyword, "seed_keyword": seed, "seed_task_ids": "|".join(sorted(matched)), "volume_us": pick(row, "volume"), "trend_12m": pick(row, "trend"), "reason": "navigational / product login"})
                    continue
                if spike_collapse(pick(row, "trend")):
                    excluded.append({"keyword": keyword, "seed_keyword": seed, "seed_task_ids": "|".join(sorted(matched)), "volume_us": pick(row, "volume"), "trend_12m": pick(row, "trend"), "reason": f"spike then collapse (peak > {SPIKE_RATIO}x last-3-month avg and median)"})
                    continue
                recent, has_trend = recent_volume(pick(row, "volume"), pick(row, "trend"))
                brand = brand_of(keyword)
                existing = keywords.get(keyword, {})
                task_ids = set(filter(None, existing.get("task_ids", "").split("|"))) | matched
                keywords[keyword] = {
                    "keyword": keyword, "task_ids": "|".join(sorted(task_ids)), "seed_keyword": existing.get("seed_keyword", seed),
                    "volume_us": pick(row, "volume"), "volume_recent_3m": recent,
                    "brand_vendor": brand,
                    "volume_scored": round(float(recent) * (BRAND_WEIGHT if brand else 1), 1) if recent not in (None, "") else "",
                    "volume_basis": "last 3 months" if has_trend else "headline (no trend data)",
                    "cpc": pick(row, "cpc"),
                    "keyword_difficulty": pick(row, "difficulty"),
                    "trend_12m": pick(row, "trend"), "trend_growth_12m": trend_growth_12m(pick(row, "trend")),
                    "parent_topic": topic_key(keyword),
                    "source": "Semrush US keyword report via MCP; parent_topic = core-word grouping (Semrush has no parent topic)",
                    "source_url": record["cache_file"], "fetched_at": record["fetched_at"],
                }
        elif report == "phrase_organic":
            for index, row in enumerate(rows, 1):
                url = pick(row, "url")
                position = int(float(pick(row, "position") or index))
                if not url:
                    continue
                for task_id in mappings[params["phrase"]]:
                    candidates.append({"task_id": task_id, "url": url, "serp_query": params["phrase"], "serp_position": position, "verified_free_tool": "", "source": "Semrush US organic report via MCP", "source_url": record["cache_file"], "fetched_at": record["fetched_at"]})
        elif report == "resource_rank_history":
            months = sorted(((pick(row, "date"), float(pick(row, "traffic") or 0)) for row in rows if pick(row, "date")), reverse=True)
            traffic[params["target"]] = {
                "organic_traffic_us": months[0][1] if months else 0,
                "traffic_24m": json.dumps([value for _, value in reversed(months[:24])]),
                "traffic_months": len(months),
                "source": "Semrush resource_rank_history US via MCP (latest month)",
                "source_url": record["cache_file"], "fetched_at": record["fetched_at"],
            }
    excluded_names = {row["keyword"] for row in excluded if row["reason"] != "no task term match"}
    for seed, record in empty_seeds.items():
        if seed in keywords or seed in excluded_names:
            continue
        matched = relevant_tasks(seed, mappings[seed]) or mappings[seed]
        keywords[seed] = {
            "keyword": seed, "task_ids": "|".join(sorted(matched)), "seed_keyword": seed, "volume_us": "0",
            "volume_recent_3m": 0, "brand_vendor": brand_of(seed), "volume_scored": 0, "volume_basis": "no Semrush data",
            "cpc": "", "keyword_difficulty": "", "trend_12m": "", "trend_growth_12m": "", "parent_topic": topic_key(seed),
            "source": "Semrush returned no data (volume below Semrush's reporting threshold)",
            "source_url": record["cache_file"], "fetched_at": record["fetched_at"],
        }
    write_csv("keywords_excluded.csv", ["keyword", "seed_keyword", "seed_task_ids", "volume_us", "trend_12m", "reason"], excluded)
    reviews = read_optional("toolpage_reviews.csv")
    first_seen = {}
    for row in candidates:
        first_seen.setdefault(row["url"], row)
    pages = []
    for review in reviews:
        if review.get("verified_free_tool") != "1" or review["url"] not in first_seen:
            continue
        found = next((row for row in candidates if row["url"] == review["url"] and row["task_id"] == review["task_id"]), first_seen[review["url"]])
        pages.append({**found, "task_id": review["task_id"], **traffic.get(review["url"], {}), "verified_free_tool": "1"})
    return list(keywords.values()), candidates, pages


def main():
    generate()
    config = json.loads((ROOT / "scripts/config.json").read_text())
    with (ROOT / "data/seeds.csv").open() as handle:
        seeds = list(csv.DictReader(handle))
    plan = []
    for seed in seeds:
        for report in ("phrase_this", "phrase_related"):
            params = {"phrase": seed["seed_keyword"], "database": "us", "export_columns": ["keyword", "volume", "cpc", "competitive_density", "results", "trend", "keyword_difficulty"]}
            if report == "phrase_related":
                params.update(display_limit=config["expansions_per_seed"], display_sort="volume_desc")
            plan.append({"stage": "keywords", "type": report, "params": params})
        if seed["pattern"] in ("core", "checker", "free_tool"):
            plan.append({"stage": "serps", "type": "phrase_organic", "params": {"phrase": seed["seed_keyword"], "database": "us", "display_offset": 0, "display_limit": config["serp_result_limit"], "positions_type": "organic", "export_columns": ["position", "domain", "url"]}})
    for queries in EXTRA_SERP_QUERIES.values():
        for query in queries:
            plan.append({"stage": "serps", "type": "phrase_organic", "params": {"phrase": query, "database": "us", "display_offset": 0, "display_limit": config["serp_result_limit"], "positions_type": "organic", "export_columns": ["position", "domain", "url"]}})
    keywords, candidates, pages = semrush_rows()
    write_csv("serp_candidates.csv", ["task_id", "url", "serp_query", "serp_position", "verified_free_tool", "source", "source_url", "fetched_at"], candidates)
    reviewed = read_optional("toolpage_reviews.csv")
    discovered = {row["url"] for row in candidates}
    counts = defaultdict(int)
    page_urls = set()
    for row in reviewed:
        if row.get("verified_free_tool") != "1":
            continue
        if row["url"] not in discovered:
            raise ValueError(f"Reviewed free tool was not found in any cached SERP: {row['url']}")
        if urlparse(row["url"]).scheme not in ("http", "https"):
            raise ValueError("Tool URLs must be HTTP(S)")
        counts[row["task_id"]] += 1
        if counts[row["task_id"]] > config["tool_pages_per_task"]:
            raise ValueError("Too many reviewed pages for one task; cap at the configured 3-5 tools")
        page_urls.add(row["url"])
    for url in sorted(page_urls):
        plan.append({"stage": "pages", "type": "resource_rank_history", "params": {"target": url, "database": "us", "display_limit": 25, "display_sort": "date_desc", "export_columns": ["date", "organic_traffic"]}})
    (ROOT / "data/semrush_fetch_plan.json").write_text(json.dumps(plan, indent=2) + "\n")
    counts = {stage: sum(item["stage"] == stage for item in plan) for stage in ("keywords", "serps", "pages")}
    print("Prepared report requests:", counts, "; only caches or an explicitly approved collector can execute them")


if __name__ == "__main__":
    main()