"""Extract public listing evidence from immutable fetch.mjs response caches."""

import json
import re
from collections import defaultdict
from html.parser import HTMLParser
from urllib.parse import urljoin, urlparse, quote

from study import ROOT, TASKS, write_csv

RULES = {
    "kw_volume": r"search.volume|keyword.volume",
    "kw_ideas": r"keyword.research|keyword.ideas|keyword.suggestions|related.keywords",
    "kw_difficulty": r"keyword.difficulty",
    "serp_results": r"\bserp\b|search.engine.results|google.search.results",
    "rank_position": r"rank.track|keyword.rank|rank.monitor|search.rankings",
    "serp_aio": r"ai.overview",
    "gsc_drop": r"search.console|\bgsc\b",
    "gsc_top": r"search.console|\bgsc\b",
    "gsc_opportunity": r"search.console|\bgsc\b",
    "index_status": r"url.inspection|index.status|indexing.for.your.site",
    "index_submit": r"indexnow|indexing.api|submit.url|submit.*index",
    "index_diagnose": r"url.inspection|indexing.diagnos",
    "audit_site": r"seo.audit|site.audit|technical.*audit",
    "audit_speed": r"core.web.vitals|lighthouse|page.speed|pagespeed",
    "audit_links": r"broken.link",
    "audit_schema": r"structured.data|schema.markup|rich.result",
    "links_profile": r"backlink|referring.domain",
    "links_gap": r"backlink.gap|link.intersect",
    "links_lost": r"lost.backlink|backlink.*monitor",
    "comp_keywords": r"competitor.*keyword|organic.keyword|organic.*ranking",
    "comp_traffic": r"traffic.estimat|organic.traffic|competitor.*traffic",
    "comp_gap": r"keyword.gap|content.gap",
    "ai_mentions": r"ai.visibility|brand.mention|llm.mention|answer.engine|generative.engine",
    "ai_citations": r"ai.overview.*citat|ai.search.*citat",
    "local_rank": r"local.rank|geo.grid|maps.rank|local.seo",
    "local_reviews": r"google.*review|business.profile.*review",
    "local_audit": r"business.profile|\bgbp\b|google.my.business",
    "content_brief": r"content.brief",
    "content_onpage": r"on.page|content.optimi",
    "content_cannibal": r"cannibali",
}


class PageParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.links = []
        self.current = None
        self.skip = 0
        self.text = []
        self.scripts = []
        self.script = None

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag in ("script", "style"):
            self.skip += 1
        if tag == "script":
            self.script = {"attrs": attrs, "text": ""}
        if tag == "a":
            self.current = {"href": attrs.get("href", ""), "text": []}

    def handle_endtag(self, tag):
        if tag == "a" and self.current:
            self.current["text"] = " ".join(self.current["text"])
            self.links.append(self.current)
            self.current = None
        if tag in ("script", "style"):
            self.skip = max(0, self.skip - 1)
        if tag == "script" and self.script:
            self.scripts.append(self.script)
            self.script = None

    def handle_data(self, data):
        if self.script is not None:
            self.script["text"] += data
        if not self.skip:
            self.text.append(data)
            if self.current is not None:
                self.current["text"].append(data.strip())


def records():
    for path in sorted((ROOT / "cache").glob("*.json")):
        record = json.loads(path.read_text())
        record["cache_file"] = str(path.relative_to(ROOT))
        yield record


def map_tasks(text):
    text = text.replace("_", " ").replace("-", " ")
    return [task_id for task_id, pattern in RULES.items() if re.search(pattern, text, re.I)]


def enrich_listings(listings):
    plan = {}
    tool_rows = []
    snapshots = {record["label"]: record for record in records()}
    for row in listings.values():
        if not row["task_ids"]:
            continue
        repository = row["github_url"]
        if repository.startswith("https://github.com/"):
            parts = urlparse(repository).path.strip("/").split("/")
            if len(parts) >= 2:
                slug = "/".join(parts[:2]).removesuffix(".git")
                label = "github:" + slug
                if label in snapshots and snapshots[label]["status"] == 200:
                    row["github_stars"] = json.loads(snapshots[label]["body"]).get("stargazers_count", "")
                    row["evidence"] += "|" + snapshots[label]["cache_file"]
                plan[label] = {"name": label, "url": "https://api.github.com/repos/" + slug}
        for package in filter(None, row["npm_packages"].split("|")):
            label = "npm:" + package
            if label in snapshots and snapshots[label]["status"] == 200:
                row["npm_weekly_downloads"] = json.loads(snapshots[label]["body"]).get("downloads", "")
                row["evidence"] += "|" + snapshots[label]["cache_file"]
            plan[label] = {"name": label, "url": "https://api.npmjs.org/downloads/point/last-week/" + quote(package, safe="@/")}
        if row["source"] == "smithery":
            label = "smithery-detail:" + row["name"]
            if label in snapshots and snapshots[label]["status"] == 200:
                payload = json.loads(snapshots[label]["body"])
                tools = payload.get("tools", payload.get("server", {}).get("tools", []))
                if isinstance(tools, list) and tools:
                    names = [tool.get("name", "") for tool in tools if isinstance(tool, dict)]
                    row["tool_names"] = "|".join(filter(None, names))
                    row["tool_names_status"] = "observed_public_manifest"
                    row["evidence"] += "|" + snapshots[label]["cache_file"]
                    mapped = set(row["task_ids"].split("|"))
                    for tool in tools:
                        if not isinstance(tool, dict) or not tool.get("name"):
                            continue
                        task_ids = map_tasks(tool["name"] + " " + tool.get("description", ""))
                        mapped.update(task_ids)
                        tool_rows.append({"source": "smithery", "server": row["name"], "tool_name": tool["name"], "description": tool.get("description", ""), "task_ids": "|".join(task_ids), "mapping_basis": "manifest_regex_requires_review", "evidence": snapshots[label]["cache_file"]})
                    row["task_ids"] = "|".join(sorted(filter(None, mapped)))
            plan[label] = {"name": label, "url": "https://registry.smithery.ai/servers/" + row["name"]}
    github = [item for name, item in sorted(plan.items()) if name.startswith("github:")][:25]
    npm = [item for name, item in sorted(plan.items()) if name.startswith("npm:")][:20]
    smithery = sorted([row for row in listings.values() if row["source"] == "smithery" and row["task_ids"]], key=lambda row: -int(row["usage_count"] or 0))[:15]
    details = [plan["smithery-detail:" + row["name"]] for row in smithery]
    return github + npm + details, tool_rows


def generate_public():
    listings = {}
    checks = []
    candidates = []
    for record in records():
        label = record["label"]
        if not re.match(r"registry:|smithery:|glama:|pulsemcp:|claude:", label):
            continue
        base = record["identity"]["url"]
        checks.append({
            "source": label, "url": base, "http_status": record["status"],
            "fetched_at": record["fetched_at"], "cache_file": record["cache_file"],
            "coverage": "not_assessed" if record["status"] == 200 else "blocked_or_unavailable",
            "next_cursor": "", "records": "",
        })
        if record["status"] != 200:
            continue
        if label.startswith(("registry:", "smithery:")):
            data = json.loads(record["body"])
            checks[-1]["next_cursor"] = data.get("metadata", {}).get("nextCursor", "")
            checks[-1]["records"] = len(data.get("servers", []))
            checks[-1]["coverage"] = "response_page"
            for item in data.get("servers", []):
                server = item.get("server", item)
                official = item.get("_meta", {}).get("io.modelcontextprotocol.registry/official", {})
                if label.startswith("registry:") and not official.get("isLatest", True):
                    continue
                if official.get("status", "active") != "active" or server.get("inactive"):
                    continue
                source = "official_registry" if label.startswith("registry:") else "smithery"
                name = server.get("name", server.get("qualifiedName", ""))
                description = server.get("description", "")
                task_ids = map_tasks(name + " " + description)
                if not task_ids and not re.search(r"\bseo\b|search.console|indexnow", name + " " + description, re.I):
                    continue
                packages = server.get("packages", [])
                repository = server.get("repository", {}).get("url", "")
                homepage = server.get("homepage", server.get("websiteUrl", ""))
                if not repository and "github.com/" in homepage:
                    repository = homepage
                npm_names = [package["identifier"] for package in packages if package.get("registryType") == "npm"]
                listings[(source, name)] = {
                    "source": source, "name": name, "description": description,
                    "listing_url": ("https://registry.modelcontextprotocol.io/?q=" + name) if source == "official_registry" else "https://smithery.ai/server/" + name,
                    "tool_names": "", "tool_names_status": "not_published_in_search_response",
                    "task_ids": "|".join(task_ids), "mapping_basis": "description_regex_requires_review",
                    "usage_count": server.get("useCount", ""), "usage_metric": "smithery_useCount_unspecified_window" if "useCount" in server else "",
                    "npm_packages": "|".join(npm_names), "npm_weekly_downloads": "",
                    "github_url": repository, "github_stars": "", "fetched_at": record["fetched_at"],
                    "evidence": record["cache_file"],
                }
        else:
            parser = PageParser()
            parser.feed(record["body"])
            checks[-1]["coverage"] = "public_page_not_exhaustive"
            for link in parser.links:
                href = urljoin(base, link["href"])
                marker = "/marketplace/connectors/" if label.startswith("claude:") else "/mcp/servers/" if label.startswith("glama:") else "/servers/"
                if marker in href and link["text"].strip():
                    candidates.append({"source": label, "url": href, "text": link["text"], "task_ids": "|".join(map_tasks(link["text"])), "evidence": record["cache_file"]})
    fetch_plan, tool_rows = enrich_listings(listings)
    for record in records():
        if record["label"].startswith("glama-detail:") and record["status"] == 200:
            parser = PageParser()
            parser.feed(record["body"])
            url = record["identity"]["url"]
            base_url = re.sub(r"/tools/.*$", "", url)
            names = sorted({link["href"].split("/tools/")[-1].strip("/") for link in parser.links if "/tools/" in link["href"] and base_url.removeprefix("https://glama.ai") in link["href"]})
            description = ""
            for script in parser.scripts:
                if script["attrs"].get("type") == "application/ld+json":
                    payload = json.loads(script["text"])
                    nodes = payload.get("@graph", [payload])
                    description = next((node.get("description", "") for node in nodes if node.get("@type") == "SoftwareApplication"), description)
            text = description + " " + " ".join(names)
            listings[("glama", base_url)] = {
                "source": "glama", "name": base_url.split("/mcp/servers/")[-1],
                "description": description, "listing_url": base_url,
                "tool_names": "|".join(names), "tool_names_status": "observed_public_tool_links" if names else "unavailable",
                "task_ids": "|".join(map_tasks(text)), "mapping_basis": "public_page_regex_requires_review",
                "usage_count": "", "usage_metric": "", "npm_packages": "", "npm_weekly_downloads": "",
                "github_url": "", "github_stars": "", "fetched_at": record["fetched_at"], "evidence": record["cache_file"],
            }
            for name in names:
                tool_rows.append({"source": "glama", "server": base_url.split("/mcp/servers/")[-1], "tool_name": name, "description": "", "task_ids": "|".join(map_tasks(name)), "mapping_basis": "tool_name_regex_requires_review", "evidence": record["cache_file"]})
    fields = ["source", "name", "description", "listing_url", "tool_names", "tool_names_status", "task_ids", "mapping_basis", "usage_count", "usage_metric", "npm_packages", "npm_weekly_downloads", "github_url", "github_stars", "fetched_at", "evidence"]
    write_csv("mcp_signals.csv", fields, sorted(listings.values(), key=lambda row: (row["source"], row["name"])))
    write_csv("mcp_tools.csv", ["source", "server", "tool_name", "description", "task_ids", "mapping_basis", "evidence"], tool_rows)
    write_csv("directory_checks.csv", ["source", "url", "http_status", "fetched_at", "cache_file", "coverage", "next_cursor", "records"], checks)
    unique = {(row["source"].split(":")[0], row["url"]): row for row in candidates}
    write_csv("listing_candidates.csv", ["source", "url", "text", "task_ids", "evidence"], unique.values())
    glama_urls = sorted({re.sub(r"/tools/.*$", "", row["url"]) for row in unique.values() if row["source"].startswith("glama:")})
    fetch_plan += [{"name": "glama-detail:" + url.split("/mcp/servers/")[-1], "url": url} for url in glama_urls[:24]]
    (ROOT / "data/fetch_plan.json").write_text(json.dumps(fetch_plan, indent=2) + "\n")
    print(f"Extracted {len(listings)} active/latest API listings, {len(unique)} public listing links; description mappings need review")


if __name__ == "__main__":
    generate_public()