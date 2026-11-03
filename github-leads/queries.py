"""Code and repository search catalog.

Add a SearchQuery here when a harvest report shows a new endpoint host or
path. Code search tokenizes on punctuation, so keep endpoint strings quoted.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class SearchQuery:
    q: str
    tool: str  # adspower | dolphin | antidetect


CODE_QUERIES: list[SearchQuery] = [
    SearchQuery('"local.adspower.net"', "adspower"),
    SearchQuery('"local.adspower.com"', "adspower"),
    SearchQuery('"adspower" "50325"', "adspower"),
    SearchQuery('"api/v1/browser/start" "user_id"', "adspower"),
    SearchQuery('"api/v1/user/create" adspower', "adspower"),
    SearchQuery('"api/v2/browser-profile" adspower', "adspower"),
    SearchQuery('"dolphin-anty-api.com"', "dolphin"),
    SearchQuery('"anty-api.com"', "dolphin"),
    SearchQuery('"browser_profiles" "automation=1"', "dolphin"),
    SearchQuery('"localhost:3001/v1.0/browser_profiles"', "dolphin"),
    SearchQuery('"v1.0/browser_profiles"', "dolphin"),
]

# Removed from the catalog. Hits already stored from these queries are kept
# only when the file still matches an AdsPower or Dolphin Anty API marker.
BROAD_QUERIES = frozenset(
    {
        "adspower selenium",
        "adspower playwright",
        "adspower puppeteer",
        "dolphin anty selenium",
        "dolphin anty playwright",
        "dolphin anty puppeteer",
    }
)

REPO_QUERIES: list[SearchQuery] = [
    SearchQuery("adspower in:name,description,readme", "adspower"),
    SearchQuery('"dolphin anty" in:name,description,readme', "dolphin"),
    SearchQuery("dolphin-anty", "dolphin"),
    SearchQuery("topic:adspower", "adspower"),
    SearchQuery("topic:dolphin-anty", "dolphin"),
    SearchQuery("topic:antidetect", "antidetect"),
]

TOOL_BY_QUERY = {item.q: item.tool for item in [*CODE_QUERIES, *REPO_QUERIES]}


def tool_for_query(query: str) -> str | None:
    return TOOL_BY_QUERY.get(query.strip())
