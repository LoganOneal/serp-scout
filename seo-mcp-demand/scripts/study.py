"""Reproducible SEO MCP demand study. No network requests in the default command."""

import argparse
import csv
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TASKS = [
    ("Keyword research", "kw_volume", "What is the search volume for this keyword?", "keyword search volume", "US and global demand"),
    ("Keyword research", "kw_ideas", "Which keywords should I target for this topic?", "keyword research", "Related and matching terms"),
    ("Keyword research", "kw_difficulty", "How hard is it to rank for this keyword?", "keyword difficulty", "Provider-specific difficulty"),
    ("SERP / rank", "serp_results", "What ranks for this keyword right now?", "google serp", "Location and device matter"),
    ("SERP / rank", "rank_position", "Where does my site rank for this keyword?", "keyword rank", "Exact positions and historical tracking"),
    ("SERP / rank", "serp_aio", "What does the AI Overview say for this keyword?", "google ai overview", "Overview content, not brand citation share"),
    ("GSC performance", "gsc_drop", "Why did my organic traffic drop?", "organic traffic drop", "Private Search Console diagnostics"),
    ("GSC performance", "gsc_top", "Which queries and pages bring me search traffic?", "google search console analytics", "Private query and page performance"),
    ("GSC performance", "gsc_opportunity", "Which keywords in positions 8 to 20 can I improve?", "striking distance keywords", "Private performance joined to page content"),
    ("Indexing", "index_status", "Is this page indexed by Google?", "google index", "Exact owned-URL inspection versus public inference"),
    ("Indexing", "index_submit", "Submit these URLs for indexing.", "google indexing", "Google Indexing API restricted to eligible content; no guarantee"),
    ("Indexing", "index_diagnose", "Why is this page not indexed?", "page not indexed", "URL inspection and crawl diagnostics"),
    ("Technical audit", "audit_site", "Find the technical SEO problems on my site.", "seo audit", "Crawl-based site audit"),
    ("Technical audit", "audit_speed", "Why is this page slow or failing Core Web Vitals?", "website speed", "Field data distinct from local Lighthouse"),
    ("Technical audit", "audit_links", "Find broken links on my site.", "broken link", "Local crawling is a strong substitute"),
    ("Technical audit", "audit_schema", "Is my structured data valid for rich results?", "schema markup", "Validation distinct from generating JSON-LD"),
    ("Backlinks", "links_profile", "Who links to this website?", "backlink", "Proprietary external link index"),
    ("Backlinks", "links_gap", "Who links to my competitors but not me?", "backlink gap", "Compare referring domains"),
    ("Backlinks", "links_lost", "Which backlinks did my site lose?", "lost backlinks", "Historical link index"),
    ("Competitor", "comp_keywords", "Which keywords send traffic to my competitor?", "competitor keywords", "Public estimated ranking dataset"),
    ("Competitor", "comp_traffic", "How much search traffic does my competitor get?", "website traffic", "Organic estimates, not measured analytics"),
    ("Competitor", "comp_gap", "Which keywords do competitors rank for that I miss?", "keyword gap", "Cross-domain ranking comparison"),
    ("AI visibility", "ai_mentions", "Is my brand mentioned in ChatGPT and Perplexity?", "ai visibility", "Prompt sampling and reproducibility limits"),
    ("AI visibility", "ai_citations", "Which sites are cited in AI Overviews for my topic?", "ai overview citations", "Citation extraction distinct from overview content"),
    ("Local", "local_rank", "Where does my business rank on Google Maps?", "google maps rank", "Geo-grid rather than one organic position"),
    ("Local", "local_reviews", "What are customers saying in my Google Business Profile reviews?", "google business reviews", "Owned account versus public review discovery"),
    ("Local", "local_audit", "What should I fix in my Google Business Profile?", "google business profile audit", "Owned profile diagnostics and updates"),
    ("Content", "content_brief", "Create a search-informed content brief for this keyword.", "seo content brief", "SERP evidence versus generic text generation"),
    ("Content", "content_onpage", "How can I optimize this page for its target keyword?", "on page seo", "Remote evidence must beat reading local HTML"),
    ("Content", "content_cannibal", "Are my pages competing for the same keyword?", "keyword cannibalization", "Combine query/page history and site content"),
]

# Problem-phrased seeds: what people type when something is already wrong.
PROBLEM_SEEDS = [
    ("crawled currently not indexed", ("index_diagnose", "index_status")),
    ("discovered currently not indexed", ("index_diagnose", "index_status")),
    ("page indexed without content", ("index_diagnose",)),
    ("duplicate without user-selected canonical", ("index_diagnose",)),
    ("excluded by noindex tag", ("index_diagnose",)),
    ("soft 404", ("index_diagnose",)),
    ("why is my page not on google", ("index_diagnose", "index_status")),
    ("website traffic dropped", ("gsc_drop",)),
    ("organic traffic drop", ("gsc_drop",)),
    ("google core update", ("gsc_drop",)),
]


def write_csv(name, fields, rows):
    path = ROOT / "data" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)


def generate():
    write_csv("taxonomy.csv", ["cluster", "task_id", "task", "notes"], [
        dict(zip(["cluster", "task_id", "task", "notes"], [cluster, task_id, task, notes]))
        for cluster, task_id, task, subject, notes in TASKS
    ])
    patterns = [
        ("free_checker", "free {subject} checker"),
        ("free_tool", "free {subject} tool"),
        ("check", "check {subject}"),
        ("checker", "{subject} checker"),
        ("how_to", "how to check {subject}"),
        ("api", "{subject} api"),
        ("mcp", "{subject} mcp"),
        ("core", "{subject}"),
    ]
    seed_rows = [
        {"task_id": task_id, "seed_keyword": template.format(subject=subject), "pattern": pattern}
        for cluster, task_id, task, subject, notes in TASKS
        for pattern, template in patterns
    ]
    existing = {(row["task_id"], row["seed_keyword"]) for row in seed_rows}
    seed_rows += [
        {"task_id": task_id, "seed_keyword": keyword, "pattern": "problem"}
        for keyword, task_ids in PROBLEM_SEEDS for task_id in task_ids
        if (task_id, keyword) not in existing
    ]
    write_csv("seeds.csv", ["task_id", "seed_keyword", "pattern"], seed_rows)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["generate"])
    args = parser.parse_args()
    generate()