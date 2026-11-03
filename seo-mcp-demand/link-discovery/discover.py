"""Link Network / parasite SEO keyword discovery. `plan` writes the next request plan; `build` writes outputs.

Collection runs through ../scripts/semrush.mts collect --plan=link-discovery/plan.json --stage=<stage>.
"""

import csv
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path
from urllib.parse import urlsplit

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "scripts"))

from prepare import BRAND_WEIGHT, BRANDS, NAVIGATIONAL, pick, recent_volume, report_rows, spike_collapse, topic_key, trend_values  # noqa: E402
from public import records  # noqa: E402

SEEDS = ["backlinks", "link building", "buy backlinks", "guest post", "link exchange", "pbn", "parasite seo", "site reputation abuse", "reddit seo", "sponsored post"]
SERP_QUERIES = ["buy backlinks", "link building service", "backlink exchange", "pbn links", "parasite seo", "parasite seo tool"]
KEYWORD_REPORTS = {"phrase_fullsearch": 250, "phrase_related": 100, "phrase_questions": 100}
MAX_TARGETS = 15
TARGET_ROWS = 300
CLUSTER_SERPS = 400
SHARED_URLS = 3
COLUMNS = ["keyword", "volume", "cpc", "keyword_difficulty", "trend"]

# Link-selling vendors and marketplaces, on top of the SEO-tool brands from revision 2.
LINK_BRANDS = ["fiverr", "upwork", "legiit", "loganix", "authority builders", "rhino rank", "the hoth", "outreach monks", "fatjoe", "adsy", "collaborator", "getfluence", "prposting", "vefogix", "linkody", "editorial link", "linkbuilder", "blackhatworld", "bhw", "searchcombat", "pbn hq", "serpzilla", "rankster", "icopify", "whitepress", "linksme", "linkhouse", "accessily", "linkdoctor", "authority hacker"]
ALL_BRANDS = BRANDS + LINK_BRANDS
# Generic platforms: pull ranked keywords for the ranking URL, not the whole domain.
PLATFORMS = {"reddit.com", "quora.com", "fiverr.com", "upwork.com", "blackhatworld.com", "medium.com", "linkedin.com", "facebook.com", "x.com", "twitter.com", "github.com", "legiit.com"}
NON_COMMERCIAL = {"wikipedia.org", "youtube.com", "google.com", "developers.google.com", "support.google.com", "searchengineland.com", "searchenginejournal.com", "moz.com", "backlinko.com"}
TOPIC = (
    r"backlink|link ?build|links? (exchange|insertion|swap|farm|scheme|wheel|pyramid|juice|seller|placement|for seo|network)"
    r"|(buy|paid|seo|dofollow|nofollow|guest|niche|contextual|editorial|quality|high (da|dr|authority)|edu|gov|pbn|tier ?[123]|web ?2\.0|forum|profile|press release|cheap|permanent) links?"
    r"|guest ?post|guest blog|\bpbns?\b|private blog network|parasite|reputation abuse"
    r"|reddit (seo|marketing|rank|thread|post|traffic|google|search)|(seo|google|rank\w*) .{0,20}reddit"
    r"|quora (seo|marketing|traffic|backlink)|medium (seo|articles?)|linkedin (seo|articles?)|forum (seo|posting)"
    r"|sponsored (posts?|content|articles?|links?|guest)|press release (seo|distribution|sites)|niche edits?|link outreach|blogger outreach"
    r"|domain (authority|rating)|high (da|dr|authority) (sites?|domains?|websites?)|barnacle seo|weak serps?|link indexer|index backlinks"
)
# "pbn" is also Providence Business News, performance-based navigation, etc.
PBN_SEO = r"pbn.*(seo|link|backlink|blog|network|hosting|buy|domain|expired|sites?)|(seo|link|backlink|blog|buy|what is a?) ?.{0,15}pbn"
SITE_NAMES = r"uploadarticle|crecso|\bbuilding ?link\b(?! ?build)"

INTENT_RULES = [
    ("risk", r"penal|dead|\bsafe\b|risk|\bban|abuse|spam|illegal|policy|violat|manual action|still work|does .* work|\btoxic|disavow|legit|scam|against google"),
    ("buy", r"\bbuy|cheap|price|pricing|cost|\bservices?\b|package|for sale|\bhire|agency|compan|purchase|\border|marketplace|seller|vendor|affordable|\bpaid\b|\bsell"),
    ("tool", r"\btools?\b|software|checker|finder|generator|plugin|\bapp\b|extension|indexer|\bapi\b|platform|automat|\bai\b|\bfree\b|\bsites?\b|\blist\b"),
    ("learn", r"."),
]
FIT_RULES = [
    ("Parasite tool", r"parasite|reputation abuse|reddit|quora|\bmedium\b|linkedin|forum|barnacle|\bugc\b|weak serp|high (da|authority) sites?|web ?2\.0"),
    # Checking or monitoring links is the Backlink Checker product, not link acquisition.
    ("neither", r"checker|\bcheck\b|monitor|analy[sz]|audit|research tool|\bverif|what (are|is) (a )?backlinks?\b|backlink profile|search console"),
    ("Link Network", r"\bbuy|purchase|service|agenc|compan|package|exchange|swap|guest ?post|guest blog|niche edit|link insertion|\bpbns?\b|private blog|sponsored post|outreach|how (to|do i) (get|build|create|earn)|link ?building|backlink (building|generator|sources?)|free backlinks|director(y|ies) for backlinks|index(ing)? backlinks|backlinks? index|white label|quality backlinks|high (da|dr|authority) backlinks|dofollow"),
]


def cache_records():
    out = defaultdict(list)
    for record in records():
        if record.get("identity", {}).get("provider") != "semrush-oauth" or record["status"] != 200:
            continue
        out[record["identity"]["report"]].append(record)
    return out


def domain_of(url):
    host = urlsplit(url).netloc.lower()
    return host[4:] if host.startswith("www.") else host


def norm_url(url):
    parts = urlsplit(url)
    return (domain_of(url) + parts.path.rstrip("/")).lower()


def serp_urls(reports, phrase):
    for record in reports.get("phrase_organic", []):
        if record["identity"]["params"].get("phrase") == phrase:
            return [pick(row, "url") for row in report_rows(record["data"]) if pick(row, "url")][:10]
    return None


def keyword_params(report, phrase):
    return {"phrase": phrase, "database": "us", "display_limit": KEYWORD_REPORTS[report], "display_sort": "volume_desc", "export_columns": COLUMNS}


def serp_params(phrase):
    return {"phrase": phrase, "database": "us", "display_offset": 0, "display_limit": 10, "positions_type": "organic", "export_columns": ["position", "domain", "url"]}


def targets(reports):
    reviewed = HERE / "targets_reviewed.csv"
    if reviewed.exists():
        with reviewed.open(newline="", encoding="utf-8") as handle:
            return [{"target": row["target"], "kind": row["kind"]} for row in csv.DictReader(handle)][:MAX_TARGETS]
    seen = Counter()
    platform_urls = []
    for query in SERP_QUERIES:
        for url in serp_urls(reports, query) or []:
            domain = domain_of(url)
            if any(domain == bad or domain.endswith("." + bad) for bad in NON_COMMERCIAL):
                continue
            if any(domain == platform or domain.endswith("." + platform) for platform in PLATFORMS):
                platform_urls.append(url)
            else:
                seen[domain] += 1
    picked = [{"target": domain, "kind": "domain"} for domain, _ in seen.most_common()]
    picked += [{"target": url, "kind": "platform_url"} for url in dict.fromkeys(platform_urls)]
    return picked[:MAX_TARGETS]


def target_params(target):
    return {"target": target, "database": "us", "display_limit": TARGET_ROWS, "display_sort": "traffic_desc",
            "display_filter": [{"field": "position", "operation": "less_than", "sign": "+", "value": 21}],
            "export_columns": ["keyword", "position", "volume", "cpc", "keyword_difficulty", "trend", "url"]}


def collect_keywords(reports):
    """Every keyword row from seed reports and target ranked keywords, deduped, with revision-2 rules applied."""
    rows = {}
    excluded = []
    sources = defaultdict(set)
    for report in list(KEYWORD_REPORTS) + ["resource_organic"]:
        for record in reports.get(report, []):
            params = record["identity"]["params"]
            if report == "resource_organic":
                if params.get("display_limit") != TARGET_ROWS:
                    continue
                source = f"ranked:{params['target']}"
            else:
                if params.get("phrase") not in SEEDS or params.get("export_columns") != COLUMNS:
                    continue
                source = f"{report}:{params['phrase']}"
            for row in report_rows(record["data"]):
                keyword = pick(row, "keyword").lower().strip()
                if not keyword:
                    continue
                sources[keyword].add(source)
                if keyword in rows:
                    continue
                volume, trend = pick(row, "volume"), pick(row, "trend")
                if not re.search(TOPIC, keyword, re.I):
                    excluded.append({"keyword": keyword, "volume_us": volume, "source": source, "reason": "off-topic (not link building / parasite SEO)"})
                    continue
                if re.search(r"\bpbns?\b", keyword, re.I) and not re.search(PBN_SEO, keyword, re.I):
                    excluded.append({"keyword": keyword, "volume_us": volume, "source": source, "reason": "ambiguous PBN (not SEO)"})
                    continue
                if re.search(NAVIGATIONAL, keyword, re.I) or re.search(r"\w\s\.\s?(com|net|org|io|co|ai)\b", keyword, re.I) or re.search(SITE_NAMES, keyword, re.I):
                    excluded.append({"keyword": keyword, "volume_us": volume, "source": source, "reason": "navigational / product login"})
                    continue
                if spike_collapse(trend):
                    excluded.append({"keyword": keyword, "volume_us": volume, "source": source, "reason": "spike then collapse (peak > 5x last-3-month avg and median)"})
                    continue
                recent, has_trend = recent_volume(volume, trend)
                brand = next((name for name in ALL_BRANDS if re.search(r"\b" + re.escape(name) + r"\b", keyword, re.I)), "")
                rows[keyword] = {
                    "keyword": keyword, "volume_us": volume, "volume_recent_3m": recent, "brand_vendor": brand,
                    "volume_scored": round(float(recent or 0) * (BRAND_WEIGHT if brand else 1), 1),
                    "volume_basis": "last 3 months" if has_trend else "headline (no trend data)",
                    "cpc": pick(row, "cpc"), "keyword_difficulty": pick(row, "difficulty"), "trend_12m": trend,
                }
    excluded = list({item["keyword"]: item for item in excluded if item["keyword"] not in rows}.values())
    for keyword, row in rows.items():
        row["sources"] = "|".join(sorted(sources[keyword]))
    return rows, excluded


def classify(keyword, rules):
    return next(label for label, pattern in rules if re.search(pattern, keyword, re.I))


def classify_fit(keyword):
    return next((label for label, pattern in FIT_RULES if re.search(pattern, keyword, re.I)), "neither")


def plan():
    reports = cache_records()
    items = [{"stage": "ld_keywords", "type": report, "params": keyword_params(report, seed)} for seed in SEEDS for report in KEYWORD_REPORTS]
    items += [{"stage": "ld_serps", "type": "phrase_organic", "params": serp_params(query)} for query in SERP_QUERIES]
    chosen = targets(reports) if all(serp_urls(reports, query) is not None for query in SERP_QUERIES) else []
    items += [{"stage": "ld_targets", "type": "resource_organic", "params": target_params(item["target"])} for item in chosen]
    keywords, _ = collect_keywords(reports)
    top = sorted(keywords.values(), key=lambda row: -row["volume_scored"])[:CLUSTER_SERPS] if chosen else []
    items += [{"stage": "ld_cluster_serps", "type": "phrase_organic", "params": serp_params(row["keyword"])} for row in top]
    (HERE / "plan.json").write_text(json.dumps(items, indent=2) + "\n")
    (HERE / "targets.json").write_text(json.dumps(chosen, indent=2) + "\n")
    print({stage: sum(item["stage"] == stage for item in items) for stage in ("ld_keywords", "ld_serps", "ld_targets", "ld_cluster_serps")})


def write_csv(name, fields, rows):
    with (HERE / name).open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def existing_tasks():
    with (HERE / "existing_tasks.tsv").open(newline="", encoding="utf-8") as handle:
        return list(csv.DictReader(handle, delimiter="\t"))


MATCH_STOPWORDS = {"the", "a", "an", "for", "of", "to", "my", "your", "on", "in", "is", "and", "get", "me"}


def match_words(text):
    words = re.findall(r"[a-z0-9]+", text.lower())
    return {word[:-1] if len(word) > 3 and word.endswith("s") and not word.endswith("ss") else word for word in words} - MATCH_STOPWORDS


def match_task(keywords, tasks):
    """Existing task whose full seed phrases cover the most cluster volume; needs at least 20% of the cluster's volume."""
    total = sum(row["volume_scored"] or 0.1 for row in keywords)
    scores = Counter()
    for task in tasks:
        seeds = [match_words(seed) for seed in task["seed_keywords"].split(",") if seed.strip()]
        for row in keywords:
            words = match_words(row["keyword"])
            if any(seed and seed <= words for seed in seeds):
                scores[task["task_id"]] += row["volume_scored"] or 0.1
    if not scores:
        return "", 0
    task, value = scores.most_common(1)[0]
    return (task, value / total) if value / total >= 0.2 else ("", value / total)


def build():
    reports = cache_records()
    keywords, excluded = collect_keywords(reports)
    serps = {}
    for record in reports.get("phrase_organic", []):
        phrase = record["identity"]["params"].get("phrase")
        if phrase in keywords and record["identity"]["params"].get("display_limit") == 10:
            serps[phrase] = {norm_url(pick(row, "url")) for row in report_rows(record["data"]) if pick(row, "url")}
    # Each keyword joins the head (highest-volume keyword) it shares the most top-10 URLs with, if 3+; heads don't chain.
    heads = []
    head_of = {}
    for keyword in sorted(serps, key=lambda item: -keywords[item]["volume_scored"]):
        best = max(heads, key=lambda head: len(serps[head] & serps[keyword]), default=None)
        if best and len(serps[best] & serps[keyword]) >= SHARED_URLS:
            head_of[keyword] = best
        else:
            heads.append(keyword)
            head_of[keyword] = keyword

    def find(item):
        return head_of[item]

    members = defaultdict(list)
    for keyword in serps:
        members[find(keyword)].append(keyword)
    words = {root: Counter(word for keyword in group for word in topic_key(keyword).split()) for root, group in members.items()}
    for keyword, row in keywords.items():
        if keyword in serps:
            row["cluster_root"], row["cluster_method"] = find(keyword), "serp_overlap"
            continue
        own = set(topic_key(keyword).split())
        best = max(members, key=lambda root: (sum(words[root][word] for word in own) / max(1, len(members[root])), -len(root)), default=None)
        if best and own & set(words[best]):
            row["cluster_root"], row["cluster_method"] = best, "wording"
        else:
            row["cluster_root"], row["cluster_method"] = "", "unclustered"
    tasks = existing_tasks()
    task_names = {task["task_id"]: task["cluster"] for task in tasks}
    clusters = []
    for root, group in members.items():
        rows = [row for row in keywords.values() if row.get("cluster_root") == root]
        rows.sort(key=lambda row: -row["volume_scored"])
        intent = Counter()
        fit = Counter()
        for row in rows:
            row["intent"], row["fit"] = classify(row["keyword"], INTENT_RULES), classify_fit(row["keyword"])
            intent[row["intent"]] += row["volume_scored"] or 0.1
            fit[row["fit"]] += row["volume_scored"] or 0.1
        task, share = match_task(rows, tasks)
        clusters.append({
            "cluster_name": rows[0]["keyword"],
            "total_recent_volume": round(sum(row["volume_scored"] for row in rows)),
            "serp_grouped_volume": round(sum(row["volume_scored"] for row in rows if row["cluster_method"] == "serp_overlap")),
            "keywords": len(rows), "serp_grouped_keywords": len(group),
            "intent": intent.most_common(1)[0][0], "intent_mix": ", ".join(f"{label} {value / sum(intent.values()):.0%}" for label, value in intent.most_common()),
            "product_fit": fit.most_common(1)[0][0], "fit_mix": ", ".join(f"{label} {value / sum(fit.values()):.0%}" for label, value in fit.most_common()),
            "top_phrasings": " | ".join(f"{row['keyword']} ({int(row['volume_scored']):,})" for row in rows[:5]),
            "avg_cpc": round(sum(float(row["cpc"] or 0) * row["volume_scored"] for row in rows) / max(1, sum(row["volume_scored"] for row in rows)), 2),
            "existing_task": task, "existing_task_name": task_names.get(task, ""), "existing_task_volume_share": f"{share:.0%}",
            "in_existing_tab": "yes" if task else "no",
            "branded_share": f"{sum(row['volume_scored'] for row in rows if row['brand_vendor']) / max(1, sum(row['volume_scored'] for row in rows)):.0%}",
        })
        for row in rows:
            row["cluster"] = clusters[-1]["cluster_name"]
    clusters.sort(key=lambda row: -row["total_recent_volume"])
    for rank, cluster in enumerate(clusters, 1):
        cluster["rank"] = rank
    write_csv("clusters.csv", ["rank", "cluster_name", "total_recent_volume", "serp_grouped_volume", "keywords", "serp_grouped_keywords", "intent", "intent_mix", "product_fit", "fit_mix", "top_phrasings", "avg_cpc", "branded_share", "in_existing_tab", "existing_task", "existing_task_name", "existing_task_volume_share"], clusters)
    for row in keywords.values():
        row.setdefault("intent", classify(row["keyword"], INTENT_RULES))
        row.setdefault("fit", classify_fit(row["keyword"]))
        row.setdefault("cluster", "")
    write_csv("keywords.csv", ["keyword", "cluster", "cluster_method", "volume_us", "volume_recent_3m", "brand_vendor", "volume_scored", "volume_basis", "cpc", "keyword_difficulty", "trend_12m", "intent", "fit", "sources"], sorted(keywords.values(), key=lambda row: -row["volume_scored"]))
    write_csv("excluded.csv", ["keyword", "volume_us", "source", "reason"], excluded)
    unclustered = [row for row in keywords.values() if row["cluster_method"] == "unclustered"]
    print(f"{len(keywords)} keywords, {len(excluded)} excluded, {len(serps)} SERP-grouped, {len(clusters)} clusters, {len(unclustered)} unclustered ({round(sum(row['volume_scored'] for row in unclustered)):,} volume)")


if __name__ == "__main__":
    {"plan": plan, "build": build}[sys.argv[1]]()
