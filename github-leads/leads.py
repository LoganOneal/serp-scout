#!/usr/bin/env python3
"""Find public GitHub accounts whose code calls the AdsPower or Dolphin Anty APIs.

Usage (from this directory):

    python leads.py harvest
    python leads.py repos
    python leads.py enrich
    python leads.py score
    python leads.py export
    python leads.py all

Every step commits to leads.db as it goes. Re-running a finished step makes
no GitHub requests. Set GITHUB_TOKEN in .env. One token; do not rotate it to
dodge rate limits. Profile emails and commit author emails are never stored.
"""

from __future__ import annotations

import calendar
import csv
import json
import math
import os
import re
import sqlite3
import sys
import time
from collections import Counter
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from urllib.parse import quote, urlparse

import httpx
import typer
from dotenv import load_dotenv

from queries import BROAD_QUERIES, CODE_QUERIES, REPO_QUERIES, tool_for_query

APP_DIR = Path(__file__).resolve().parent
DB_PATH = APP_DIR / "leads.db"
LEADS_CSV = APP_DIR / "leads.csv"
REPOS_CSV = APP_DIR / "repos.csv"

SEARCH_CAP = 1000
PER_PAGE = 100
INDEXED_MAX_BYTES = 384_000
CODE_SEARCH_INTERVAL = 6.5
REPO_SEARCH_INTERVAL = 2.2
CORE_INTERVAL = 0.8
INITIAL_BACKOFF = 60.0
INCOMPLETE_RETRY_SECONDS = 10.0
README_LIMIT = 30_000
README_SCORE_MIN = 4
WRAPPER_LIMIT = 50
RECENT_DAYS = 365
THROWAWAY_DAYS = 30
FOLLOWER_MIN = 20
START_YEAR = 2008

# Case-insensitive substrings. Review the printed matches once before outreach.
VENDOR_LOGIN_SUBSTRINGS = ("adspower", "dolphin")

WEIGHT_ORG = 3
WEIGHT_CONTACT = 2
WEIGHT_RECENT = 2
WEIGHT_EXTRA = 1
EXTRA_REPO_CAP = 3
WEIGHT_TWITTER = 1
WEIGHT_FOLLOWERS = 1
WEIGHT_THROWAWAY = -2

LANGUAGES = ["Python", "JavaScript", "TypeScript", "Go", "C#", "Java", "PHP", "Other"]
NAMED_LANGUAGES = [lang for lang in LANGUAGES if lang != "Other"]

TUTORIAL_RE = re.compile(r"awesome|tutorial|example|demo|docs", re.I)
# Bare "dolphin" is the emulator, not Dolphin Anty.
WRAPPER_REPO_RE = re.compile(r"adspower|dolphin\W*anty", re.I)
KEEP_HIT_RE = re.compile(r"adspower|dolphin\W*anty|anty-api|browser_profiles|50325|:3001/v1\.0", re.I)
ADSPOWER_RE = re.compile(r"adspower", re.I)
DOLPHIN_RE = re.compile(r"dolphin[-\s_]?anty|anty-api\.com|browser_profiles", re.I)
URL_RE = re.compile(r"https?://[^\s\"'<>]+", re.I)
HOST_RE = re.compile(r"\b(?:localhost|(?:[a-z0-9-]+\.)+[a-z]{2,})(?::\d{2,5})?\b", re.I)
SIZE_KEY_RE = re.compile(r"size:(\d+)\.\.(\d+)(?: lang:(.+))?$")
CREATED_RE = re.compile(r"created:(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$")
CYRILLIC_RE = re.compile(r"[\u0400-\u04FF]")
CJK_RE = re.compile(r"[\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]")
VIETNAMESE_RE = re.compile(
    r"[ăâđêôơưáàảãạấầẩẫậắằẳẵặéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]",
    re.I,
)
CODE_EXTENSIONS = {
    "py", "js", "ts", "tsx", "jsx", "go", "php", "java", "rb", "cs", "json",
    "yml", "yaml", "md", "txt", "xml", "html", "css", "sh", "toml", "lock",
    "svg", "png", "jpg", "jpeg", "gif", "webp", "vue", "rs",
}
TRAILING_PUNCT = ".,);:'\">]}"

SEGMENT_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("facebook_ads", re.compile(r"facebook\s*ads|fb\s*ads|meta\s*ads|\bfacebook\b", re.I)),
    ("tiktok", re.compile(r"\btiktok\b|tik\s*tok", re.I)),
    ("google_ads", re.compile(r"google\s*ads|\badwords\b", re.I)),
    ("amazon", re.compile(r"\bamazon\b", re.I)),
    ("etsy", re.compile(r"\betsy\b", re.I)),
    ("ebay", re.compile(r"\bebay\b", re.I)),
    ("shopify", re.compile(r"\bshopify\b", re.I)),
    ("crypto_airdrop", re.compile(r"airdrop|galxe|zealy|metamask|\bwallet\b|sybil", re.I)),
    ("social_warmup", re.compile(r"\bwarm(?:up|ing)?\b|\bfarm(?:ing)?\b|autopost|\binstagram\b|\btwitter\b", re.I)),
    ("scraping", re.compile(r"scrap(?:e|ing|er)", re.I)),
    ("affiliate", re.compile(r"affiliate", re.I)),
    ("arbitrage", re.compile(r"arbitrage", re.I)),
]

LOCATION_REGIONS: list[tuple[str, re.Pattern[str]]] = [
    ("cis", re.compile(r"\b(russia|ukraine|belarus|kazakhstan|uzbekistan|moscow|kyiv|kiev|minsk|almaty)\b", re.I)),
    ("vietnam", re.compile(r"\b(vietnam|viet nam|hanoi|ha noi|ho chi minh|saigon)\b", re.I)),
    ("china", re.compile(r"\b(china|beijing|shanghai|shenzhen|guangzhou|hangzhou)\b", re.I)),
    ("japan", re.compile(r"\b(japan|tokyo|osaka)\b", re.I)),
    ("korea", re.compile(r"\b(korea|seoul)\b", re.I)),
    ("sea", re.compile(r"\b(thailand|indonesia|philippines|malaysia|singapore|bangkok|jakarta|manila)\b", re.I)),
    ("latam", re.compile(r"\b(brazil|brasil|mexico|argentina|colombia|chile)\b", re.I)),
    ("india", re.compile(r"\b(india|bangalore|bengaluru|delhi|mumbai)\b", re.I)),
]

LEAD_COLUMNS = [
    "login",
    "type",
    "name",
    "company",
    "blog",
    "twitter",
    "location",
    "score",
    "segments",
    "matched_repo_count",
    "top_repos",
    "last_push",
    "tool",
    "related_accounts",
    "excluded",
    "exclude_reason",
]

REPO_COLUMNS = [
    "full_name",
    "url",
    "owner_login",
    "owner_type",
    "source",
    "is_fork",
    "forked_from",
    "stars",
    "language",
    "pushed_at",
    "created_at",
    "description",
    "homepage",
    "tool",
    "matched_files",
    "matched_urls",
]

app = typer.Typer(add_completion=False, help="Find GitHub accounts that call the AdsPower or Dolphin Anty APIs.")


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


# ---------------------------------------------------------------------------
# Slice planning (pure)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SizeSlice:
    low: int | None = None
    high: int | None = None
    language: str | None = None

    def key(self) -> str:
        if self.low is None or self.high is None:
            return ""
        base = f"size:{self.low}..{self.high}"
        if self.language:
            return f"{base} lang:{self.language}"
        return base


def bisect_size(low: int, high: int) -> tuple[tuple[int, int], tuple[int, int]] | None:
    """Split an inclusive byte range in half.

    size:0..384000 becomes size:0..192000 and size:192001..384000.
    A single-byte range cannot be split.
    """
    if low >= high:
        return None
    mid = (low + high) // 2
    return (low, mid), (mid + 1, high)


def language_qualifier(language: str) -> str:
    if language == "Other":
        return " ".join(f"-language:{_quote_language(name)}" for name in NAMED_LANGUAGES)
    return f"language:{_quote_language(language)}"


def _quote_language(language: str) -> str:
    if language == "C#":
        return '"C#"'
    return language


def github_size_qualifier(sl: SizeSlice) -> str:
    parts: list[str] = []
    if sl.low is not None and sl.high is not None:
        parts.append(f"size:{sl.low}..{sl.high}")
    if sl.language:
        parts.append(language_qualifier(sl.language))
    return " ".join(parts)


def parse_size_slice(key: str) -> SizeSlice:
    if not key:
        return SizeSlice()
    match = SIZE_KEY_RE.fullmatch(key)
    if not match:
        raise ValueError(f"bad size slice: {key}")
    return SizeSlice(int(match.group(1)), int(match.group(2)), match.group(3))


def child_size_slices(current: SizeSlice, total_count: int) -> list[SizeSlice]:
    """Return the next code-search slices, or [] when this slice can be paged.

    Over the 1,000 cap, start at size:0..384000 and bisect. A range that is
    already one byte wide is split by language. A language slice that is still
    over the cap is returned as [] so the caller keeps the first 1,000.
    """
    if total_count <= SEARCH_CAP:
        return []
    if current.low is None or current.high is None:
        return [SizeSlice(0, INDEXED_MAX_BYTES, current.language)]
    split = bisect_size(current.low, current.high)
    if split is not None:
        (low_a, high_a), (low_b, high_b) = split
        return [
            SizeSlice(low_a, high_a, current.language),
            SizeSlice(low_b, high_b, current.language),
        ]
    if current.language is None:
        return [SizeSlice(current.low, current.high, lang) for lang in LANGUAGES]
    return []


def code_children(slice_key: str, total_count: int) -> list[str]:
    return [child.key() for child in child_size_slices(parse_size_slice(slice_key), total_count)]


def code_qualifier(slice_key: str) -> str:
    return github_size_qualifier(parse_size_slice(slice_key))


def format_created(start: date, end: date) -> str:
    return f"created:{start.isoformat()}..{end.isoformat()}"


def parse_created_range(slice_key: str) -> tuple[date, date]:
    match = CREATED_RE.fullmatch(slice_key)
    if not match:
        raise ValueError(f"bad created slice: {slice_key}")
    return date.fromisoformat(match.group(1)), date.fromisoformat(match.group(2))


def _is_month_range(start: date, end: date) -> bool:
    return start.year == end.year and start.month == end.month and start.day == 1 and start != end


def _is_year_range(start: date, end: date) -> bool:
    if start.month != 1 or start.day != 1 or start.year != end.year:
        return False
    if _is_month_range(start, end):
        return False
    return end > start


def year_slices(today: date, start_year: int = START_YEAR) -> list[str]:
    slices: list[str] = []
    for year in range(start_year, today.year + 1):
        start = date(year, 1, 1)
        end = today if year == today.year else date(year, 12, 31)
        slices.append(format_created(start, end))
    return slices


def month_slices(year: int, end_limit: date) -> list[str]:
    slices: list[str] = []
    last_month = end_limit.month if end_limit.year == year else 12
    for month in range(1, last_month + 1):
        start = date(year, month, 1)
        month_end = date(year, month, calendar.monthrange(year, month)[1])
        if end_limit.year == year and month == end_limit.month:
            month_end = min(month_end, end_limit)
        if start <= month_end:
            slices.append(format_created(start, month_end))
    return slices


def day_slices(start: date, end: date) -> list[str]:
    slices: list[str] = []
    cursor = start
    while cursor <= end:
        slices.append(format_created(cursor, cursor))
        cursor += timedelta(days=1)
    return slices


def child_created_slices(slice_key: str, total_count: int, today: date) -> list[str]:
    """Yearly created: ranges, then monthly, then daily, while a slice is over 1,000."""
    if total_count <= SEARCH_CAP:
        return []
    if not slice_key:
        return year_slices(today)
    start, end = parse_created_range(slice_key)
    if start == end:
        return []
    if _is_year_range(start, end):
        return month_slices(start.year, end)
    if _is_month_range(start, end):
        return day_slices(start, end)
    return []


def page_count(total: int) -> int:
    if total <= 0:
        return 0
    return math.ceil(min(total, SEARCH_CAP) / PER_PAGE)


def join_query(query: str, qualifier: str) -> str:
    qualifier = qualifier.strip()
    if not qualifier:
        return query
    return f"{query} {qualifier}"


# ---------------------------------------------------------------------------
# Rate limit
# ---------------------------------------------------------------------------


class RateLimiter:
    """Pace requests and honor GitHub's remaining/reset headers.

    `sleep` must move `clock` forward (time.sleep does). Long backoffs are
    scheduled here and slept on the next wait(), so a retry sleeps once.
    """

    def __init__(self, min_interval: float = CODE_SEARCH_INTERVAL, sleep=time.sleep, clock=time.time, logger=None):
        self.min_interval = min_interval
        self._sleep = sleep
        self._clock = clock
        self._log = logger or (lambda _msg: None)
        self.remaining: int | None = None
        self.reset_at: float | None = None
        self._next_ok: float | None = None

    def observe(self, response: httpx.Response) -> None:
        remaining = response.headers.get("X-RateLimit-Remaining")
        reset = response.headers.get("X-RateLimit-Reset")
        if remaining is not None and remaining.isdigit():
            self.remaining = int(remaining)
        if reset is not None and reset.isdigit():
            self.reset_at = float(reset)

    def penalize(self, delay: float) -> None:
        """Push the next request out by `delay` seconds. Does not sleep yet."""
        self.remaining = None
        if delay <= 0:
            return
        not_before = self._clock() + delay
        if self._next_ok is None or not_before > self._next_ok:
            self._next_ok = not_before

    def wait(self) -> None:
        now = self._clock()
        target = now
        if self._next_ok is not None:
            target = max(target, self._next_ok)
        if self.remaining == 0 and self.reset_at is not None:
            target = max(target, self.reset_at + 1)
            self.remaining = None
        delay = target - now
        if delay > 0:
            if delay >= 30:
                self._log(f"sleeping {delay:.0f}s for GitHub rate limit")
            self._sleep(delay)
        self._next_ok = self._clock() + self.min_interval


def is_rate_limited(response: httpx.Response) -> bool:
    if response.status_code == 429:
        return True
    if response.status_code != 403:
        return False
    if response.headers.get("Retry-After"):
        return True
    if response.headers.get("X-RateLimit-Remaining") == "0":
        return True
    text = response.text.lower()
    return "rate limit" in text or "secondary rate" in text or "abuse detection" in text


def parse_retry_after(value: str, now: float) -> float:
    try:
        return max(0.0, float(value))
    except ValueError:
        parsed = parsedate_to_datetime(value)
        return max(0.0, parsed.timestamp() - now)


def send_with_backoff(do_request, limiter: RateLimiter, max_attempts: int = 6) -> httpx.Response:
    """GET once, sleeping through 403/429 and 5xx.

    Retry-After wins. Without it, backoff starts at 60s and doubles.
    A 403 that is not a rate limit is returned to the caller.
    """
    backoff = INITIAL_BACKOFF
    last: httpx.Response | None = None
    last_error: Exception | None = None
    for _attempt in range(max_attempts):
        limiter.wait()
        try:
            response = do_request()
        except httpx.TransportError as exc:
            last_error = exc
            limiter.penalize(backoff)
            backoff *= 2
            continue
        if is_rate_limited(response):
            limiter.observe(response)
            retry_after = response.headers.get("Retry-After")
            if retry_after:
                delay = parse_retry_after(retry_after, limiter._clock())
            else:
                delay = backoff
                backoff *= 2
            limiter.penalize(delay)
            last = response
            continue
        if response.status_code >= 500:
            last = response
            limiter.penalize(backoff)
            backoff *= 2
            continue
        limiter.observe(response)
        return response
    if last_error is not None and last is None:
        raise RuntimeError(f"GitHub request failed: {last_error}") from last_error
    if last is not None and last.status_code >= 500:
        raise RuntimeError(f"GitHub {last.status_code} after {max_attempts} attempts")
    if last is not None:
        raise RuntimeError(f"GitHub rate limit persisted after {max_attempts} attempts")
    raise RuntimeError("GitHub request failed")


@dataclass
class SearchPage:
    total_count: int
    incomplete: bool
    items: list
    rejected: bool = False


def with_incomplete_retry(fetch_once, penalize, log_fn=log) -> SearchPage:
    """Retry a search page once when GitHub sets incomplete_results."""
    page = fetch_once()
    if page.rejected or not page.incomplete:
        return page
    log_fn("incomplete_results; retrying once")
    penalize(INCOMPLETE_RETRY_SECONDS)
    second = fetch_once()
    if second.rejected:
        return page
    if second.incomplete:
        log_fn("page still incomplete_results")
    return second


class GitHubClient:
    def __init__(self, token: str):
        self.calls = 0
        self._http = httpx.Client(
            base_url="https://api.github.com",
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
                "User-Agent": "serp-scout-github-leads",
            },
            timeout=httpx.Timeout(45.0),
            follow_redirects=True,
        )
        self.code_limiter = RateLimiter(CODE_SEARCH_INTERVAL, logger=log)
        self.repo_limiter = RateLimiter(REPO_SEARCH_INTERVAL, logger=log)
        self.core_limiter = RateLimiter(CORE_INTERVAL, logger=log)

    def close(self) -> None:
        self._http.close()

    def _get(self, limiter: RateLimiter, path: str, params: dict | None, accept: str | None) -> httpx.Response:
        headers = {"Accept": accept} if accept else None

        def do():
            self.calls += 1
            return self._http.get(path, params=params, headers=headers)

        response = send_with_backoff(do, limiter)
        if response.status_code == 401:
            raise SystemExit("GitHub rejected GITHUB_TOKEN (401). Use a fine-grained token with public read access.")
        return response

    def _search(self, path: str, q: str, page: int, limiter: RateLimiter, accept: str | None) -> SearchPage:
        params: dict = {"q": q, "per_page": PER_PAGE, "page": page}
        if path.endswith("/code"):
            params["sort"] = "indexed"
            params["order"] = "desc"
        else:
            params["sort"] = "created"
            params["order"] = "asc"

        def once() -> SearchPage:
            response = self._get(limiter, path, params, accept)
            if response.status_code == 422:
                log(f"query rejected (422): {q} :: {response.text[:300]}")
                return SearchPage(0, False, [], rejected=True)
            if response.status_code != 200:
                raise RuntimeError(f"GitHub {response.status_code} for {q}: {response.text[:300]}")
            payload = response.json()
            return SearchPage(
                int(payload.get("total_count") or 0),
                bool(payload.get("incomplete_results")),
                payload.get("items") or [],
            )

        return with_incomplete_retry(once, limiter.penalize, log)

    def search_code(self, q: str, page: int) -> SearchPage:
        return self._search("/search/code", q, page, self.code_limiter, "application/vnd.github.text-match+json")

    def search_repos(self, q: str, page: int) -> SearchPage:
        return self._search("/search/repositories", q, page, self.repo_limiter, None)

    def core_get(self, path: str, params: dict | None = None, accept: str | None = None) -> httpx.Response:
        return self._get(self.core_limiter, path, params, accept)


# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------


def connect(path: Path | None = None) -> sqlite3.Connection:
    conn = sqlite3.connect(path or DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    init_db(conn)
    return conn


def init_db(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS hits (
          query TEXT NOT NULL,
          slice TEXT NOT NULL,
          repo_full_name TEXT NOT NULL,
          path TEXT NOT NULL,
          sha TEXT,
          html_url TEXT,
          fragment TEXT,
          fetched_at TEXT NOT NULL,
          excluded INTEGER NOT NULL DEFAULT 0,
          exclude_reason TEXT NOT NULL DEFAULT '',
          UNIQUE(repo_full_name, path)
        );

        CREATE TABLE IF NOT EXISTS query_progress (
          kind TEXT NOT NULL,
          query TEXT NOT NULL,
          slice TEXT NOT NULL,
          page INTEGER NOT NULL,
          done INTEGER NOT NULL,
          incomplete INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (kind, query, slice, page)
        );

        CREATE TABLE IF NOT EXISTS slice_state (
          kind TEXT NOT NULL,
          query TEXT NOT NULL,
          slice TEXT NOT NULL,
          status TEXT NOT NULL,
          total_count INTEGER,
          PRIMARY KEY (kind, query, slice)
        );

        CREATE TABLE IF NOT EXISTS repos (
          full_name TEXT PRIMARY KEY,
          source TEXT,
          is_fork INTEGER,
          stars INTEGER,
          forks_count INTEGER,
          pushed_at TEXT,
          created_at TEXT,
          description TEXT,
          homepage TEXT,
          owner_login TEXT,
          owner_type TEXT,
          language TEXT,
          forked_from TEXT,
          html_url TEXT,
          discovery_queries TEXT,
          readme_text TEXT,
          readme_fetched_at TEXT,
          contributors_fetched_at TEXT,
          fetched_at TEXT,
          excluded INTEGER NOT NULL DEFAULT 0,
          exclude_reason TEXT NOT NULL DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS stargazers (
          repo_full_name TEXT NOT NULL,
          login TEXT NOT NULL,
          fetched_at TEXT NOT NULL,
          PRIMARY KEY (repo_full_name, login)
        );

        CREATE TABLE IF NOT EXISTS accounts (
          login TEXT PRIMARY KEY,
          type TEXT,
          name TEXT,
          company TEXT,
          blog TEXT,
          location TEXT,
          twitter_username TEXT,
          bio TEXT,
          public_repos INTEGER,
          followers INTEGER,
          created_at TEXT,
          fetched_at TEXT
        );

        CREATE TABLE IF NOT EXISTS account_links (
          account TEXT NOT NULL,
          related_account TEXT NOT NULL,
          relation TEXT NOT NULL,
          PRIMARY KEY (account, related_account, relation)
        );

        CREATE TABLE IF NOT EXISTS scores (
          login TEXT PRIMARY KEY,
          score INTEGER NOT NULL,
          components TEXT NOT NULL,
          segments TEXT NOT NULL,
          region TEXT NOT NULL,
          tool TEXT NOT NULL,
          excluded INTEGER NOT NULL,
          exclude_reason TEXT NOT NULL,
          scored_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS list_cursors (
          kind TEXT NOT NULL,
          repo TEXT NOT NULL,
          next_page INTEGER NOT NULL,
          done INTEGER NOT NULL,
          PRIMARY KEY (kind, repo)
        );

        CREATE INDEX IF NOT EXISTS hits_repo ON hits(repo_full_name);
        CREATE INDEX IF NOT EXISTS repos_owner ON repos(owner_login);
        """
    )
    _migrate(conn)


def _migrate(conn: sqlite3.Connection) -> None:
    """Add exclusion columns to databases created before those columns existed."""
    for table, column, ddl in (
        ("hits", "excluded", "excluded INTEGER NOT NULL DEFAULT 0"),
        ("hits", "exclude_reason", "exclude_reason TEXT NOT NULL DEFAULT ''"),
        ("repos", "excluded", "excluded INTEGER NOT NULL DEFAULT 0"),
        ("repos", "exclude_reason", "exclude_reason TEXT NOT NULL DEFAULT ''"),
    ):
        have = {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}
        if column not in have:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {ddl}")
    conn.commit()


def utcnow() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def parse_gh_time(value: str | None) -> datetime | None:
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def get_slice(conn: sqlite3.Connection, kind: str, query: str, slice_key: str) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT status, total_count FROM slice_state WHERE kind = ? AND query = ? AND slice = ?",
        (kind, query, slice_key),
    ).fetchone()


def set_slice(conn: sqlite3.Connection, kind: str, query: str, slice_key: str, status: str, total_count: int | None) -> None:
    conn.execute(
        """
        INSERT INTO slice_state (kind, query, slice, status, total_count)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(kind, query, slice) DO UPDATE SET
          status = excluded.status,
          total_count = excluded.total_count
        """,
        (kind, query, slice_key, status, total_count),
    )


def mark_page(conn: sqlite3.Connection, kind: str, query: str, slice_key: str, page: int, incomplete: bool) -> None:
    conn.execute(
        """
        INSERT INTO query_progress (kind, query, slice, page, done, incomplete)
        VALUES (?, ?, ?, ?, 1, ?)
        ON CONFLICT(kind, query, slice, page) DO UPDATE SET
          done = 1,
          incomplete = excluded.incomplete
        """,
        (kind, query, slice_key, page, 1 if incomplete else 0),
    )


def page_is_done(conn: sqlite3.Connection, kind: str, query: str, slice_key: str, page: int) -> bool:
    row = conn.execute(
        "SELECT done FROM query_progress WHERE kind = ? AND query = ? AND slice = ? AND page = ?",
        (kind, query, slice_key, page),
    ).fetchone()
    return bool(row and row["done"])


def merge_token(existing: str | None, new: str, sep: str = " || ") -> str:
    if not new:
        return existing or ""
    parts = [part for part in (existing or "").split(sep) if part]
    if new in parts:
        return sep.join(parts)
    parts.append(new)
    return sep.join(parts)


def merge_source(existing: str | None, new: str) -> str:
    parts: list[str] = []
    for token in (existing or "").split("+"):
        if token and token not in parts:
            parts.append(token)
    if new and new not in parts:
        parts.append(new)
    return "+".join(parts)


# ---------------------------------------------------------------------------
# Exhaustive search
# ---------------------------------------------------------------------------


def exhaust_search(
    conn: sqlite3.Connection,
    *,
    kind: str,
    query: str,
    fetch_page,
    children_for,
    qualifier_of,
    store_items,
) -> None:
    """Page a search query, splitting any slice whose total_count exceeds 1,000.

    Finished slices are skipped entirely, so a second run makes no requests.
    """
    terminal = {"complete", "capped", "rejected"}

    def walk(slice_key: str) -> None:
        state = get_slice(conn, kind, query, slice_key)
        if state and state["status"] in terminal:
            return
        if state and state["status"] == "split":
            for child in children_for(slice_key, int(state["total_count"] or 0)):
                walk(child)
            return
        if state and state["status"] == "pending":
            paginate(slice_key, int(state["total_count"] or 0))
            return

        full_q = join_query(query, qualifier_of(slice_key))
        page = fetch_page(full_q, 1)
        if page.rejected:
            set_slice(conn, kind, query, slice_key, "rejected", 0)
            conn.commit()
            log(f"{kind} rejected {full_q}")
            return
        total = int(page.total_count or 0)
        kids = children_for(slice_key, total)
        if kids:
            store_items(page.items, slice_key)
            set_slice(conn, kind, query, slice_key, "split", total)
            conn.commit()
            log(f"{kind} split {full_q} total={total} into {len(kids)} slices")
            for child in kids:
                walk(child)
            return
        store_items(page.items, slice_key)
        mark_page(conn, kind, query, slice_key, 1, page.incomplete)
        pages = page_count(total)
        final = "capped" if total > SEARCH_CAP else "complete"
        if pages <= 1:
            set_slice(conn, kind, query, slice_key, final, total)
            conn.commit()
            log(f"{kind} {full_q} page 1/{max(pages, 1)} total={total} items={len(page.items)}")
            if final == "capped":
                log(f"{kind} capped {full_q} at {SEARCH_CAP} of {total}")
            return
        set_slice(conn, kind, query, slice_key, "pending", total)
        conn.commit()
        log(f"{kind} {full_q} page 1/{pages} total={total} items={len(page.items)}")
        paginate(slice_key, total)

    def paginate(slice_key: str, total: int) -> None:
        pages = page_count(total)
        final = "capped" if total > SEARCH_CAP else "complete"
        full_q = join_query(query, qualifier_of(slice_key))
        for number in range(1, pages + 1):
            if page_is_done(conn, kind, query, slice_key, number):
                continue
            page = fetch_page(full_q, number)
            if page.rejected:
                set_slice(conn, kind, query, slice_key, "rejected", total)
                conn.commit()
                log(f"{kind} rejected {full_q} page {number}")
                return
            store_items(page.items, slice_key)
            mark_page(conn, kind, query, slice_key, number, page.incomplete)
            conn.commit()
            log(f"{kind} {full_q} page {number}/{pages} total={total} items={len(page.items)}")
        set_slice(conn, kind, query, slice_key, final, total)
        conn.commit()
        if final == "capped":
            log(f"{kind} capped {full_q} at {SEARCH_CAP} of {total}")

    walk("")


def fragments_of(item: dict) -> str:
    parts: list[str] = []
    for match in item.get("text_matches") or []:
        fragment = (match.get("fragment") or "").strip()
        if fragment:
            parts.append(fragment)
    return "\n---\n".join(parts)[:8000]


def store_code_hits(conn: sqlite3.Connection, query: str, slice_key: str, items: list) -> None:
    now = utcnow()
    for item in items:
        repo = ((item.get("repository") or {}).get("full_name") or "").strip()
        path = (item.get("path") or "").strip()
        if not repo or not path:
            continue
        fragment = fragments_of(item)
        existing = conn.execute(
            "SELECT query, fragment FROM hits WHERE repo_full_name = ? AND path = ?",
            (repo, path),
        ).fetchone()
        if existing:
            merged = merge_token(existing["query"], query)
            better = fragment if len(fragment) > len(existing["fragment"] or "") else existing["fragment"]
            if merged != existing["query"] or better != existing["fragment"]:
                conn.execute(
                    "UPDATE hits SET query = ?, fragment = ? WHERE repo_full_name = ? AND path = ?",
                    (merged, better, repo, path),
                )
            continue
        conn.execute(
            """
            INSERT INTO hits (query, slice, repo_full_name, path, sha, html_url, fragment, fetched_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (query, slice_key, repo, path, item.get("sha"), item.get("html_url"), fragment, now),
        )


def upsert_repo(conn: sqlite3.Connection, **fields) -> None:
    full_name = fields["full_name"]
    current = conn.execute("SELECT * FROM repos WHERE full_name = ?", (full_name,)).fetchone()
    if current is None:
        columns = [
            "full_name", "source", "is_fork", "stars", "forks_count", "pushed_at", "created_at",
            "description", "homepage", "owner_login", "owner_type", "language", "forked_from",
            "html_url", "discovery_queries", "fetched_at",
        ]
        conn.execute(
            f"INSERT INTO repos ({', '.join(columns)}) VALUES ({', '.join('?' for _ in columns)})",
            tuple(fields.get(column) for column in columns),
        )
        return
    merged = {
        "source": merge_source(current["source"], fields.get("source") or ""),
        "discovery_queries": merge_token(current["discovery_queries"], fields.get("discovery_queries") or ""),
    }
    for key in (
        "is_fork", "stars", "forks_count", "pushed_at", "created_at", "description", "homepage",
        "owner_login", "owner_type", "language", "forked_from", "html_url", "fetched_at",
    ):
        incoming = fields.get(key)
        merged[key] = current[key] if incoming is None else incoming
    assignments = ", ".join(f"{key} = ?" for key in merged)
    conn.execute(
        f"UPDATE repos SET {assignments} WHERE full_name = ?",
        (*merged.values(), full_name),
    )


def repo_fields_from_payload(item: dict, source: str, discovery_query: str = "", forked_from: str | None = None) -> dict:
    owner = item.get("owner") or {}
    parent = (item.get("parent") or {}).get("full_name")
    return {
        "full_name": item.get("full_name"),
        "source": source,
        "is_fork": 1 if item.get("fork") else 0,
        "stars": item.get("stargazers_count"),
        "forks_count": item.get("forks_count"),
        "pushed_at": item.get("pushed_at"),
        "created_at": item.get("created_at"),
        "description": item.get("description"),
        "homepage": item.get("homepage"),
        "owner_login": owner.get("login"),
        "owner_type": owner.get("type"),
        "language": item.get("language"),
        "forked_from": forked_from or parent,
        "html_url": item.get("html_url"),
        "discovery_queries": discovery_query,
        "fetched_at": utcnow(),
    }


def store_repo_items(conn: sqlite3.Connection, query: str, items: list) -> None:
    for item in items:
        if not item.get("full_name"):
            continue
        upsert_repo(conn, **repo_fields_from_payload(item, "repo", query))


def log_drift(conn: sqlite3.Connection, kind: str, queries: list[str]) -> None:
    for query in queries:
        rows = conn.execute(
            "SELECT slice, status, total_count FROM slice_state WHERE kind = ? AND query = ?",
            (kind, query),
        ).fetchall()
        if not rows:
            continue
        root = next((row for row in rows if row["slice"] == ""), None)
        if root is None or root["status"] != "split":
            continue
        if any(row["status"] in {"pending", "error"} for row in rows):
            log(f"drift {kind} {query!r}: still incomplete")
            continue
        leaves = [row for row in rows if row["status"] in {"complete", "capped"}]
        leaf_sum = sum(int(row["total_count"] or 0) for row in leaves)
        unsliced = int(root["total_count"] or 0)
        log(f"drift {kind} {query!r}: unsliced={unsliced} leaf_sum={leaf_sum} drift={leaf_sum - unsliced}")


def harvest_run(conn: sqlite3.Connection, client: GitHubClient) -> None:
    before = client.calls
    for item in CODE_QUERIES:
        log(f"harvest {item.q}")
        exhaust_search(
            conn,
            kind="code",
            query=item.q,
            fetch_page=client.search_code,
            children_for=code_children,
            qualifier_of=code_qualifier,
            store_items=lambda items, slice_key, q=item.q: store_code_hits(conn, q, slice_key, items),
        )
    log_drift(conn, "code", [item.q for item in CODE_QUERIES])
    print_fragment_report(conn)
    log(f"harvest API calls: {client.calls - before}")


def repos_run(conn: sqlite3.Connection, client: GitHubClient, today: date | None = None) -> None:
    before = client.calls
    today = today or datetime.now(timezone.utc).date()

    def children(slice_key: str, total: int) -> list[str]:
        return child_created_slices(slice_key, total, today)

    for item in REPO_QUERIES:
        log(f"repos {item.q}")
        exhaust_search(
            conn,
            kind="repo",
            query=item.q,
            fetch_page=client.search_repos,
            children_for=children,
            qualifier_of=lambda slice_key: slice_key,
            store_items=lambda items, _slice_key, q=item.q: store_repo_items(conn, q, items),
        )
    log_drift(conn, "repo", [item.q for item in REPO_QUERIES])
    pull_wrapper_network(conn, client)
    log(f"repos API calls: {client.calls - before}")


# ---------------------------------------------------------------------------
# Forks and stargazers
# ---------------------------------------------------------------------------


def repo_api_path(full_name: str, suffix: str = "") -> str:
    owner, name = full_name.split("/", 1)
    path = f"/repos/{quote(owner, safe='')}/{quote(name, safe='')}"
    if suffix:
        path = f"{path}/{suffix.lstrip('/')}"
    return path


def is_wrapper_repo(full_name: str, description: str | None = None) -> bool:
    short = full_name.split("/")[-1] if full_name else ""
    return bool(WRAPPER_REPO_RE.search(f"{short}\n{full_name}\n{description or ''}"))


def wrapper_repo_names(conn: sqlite3.Connection, limit: int = WRAPPER_LIMIT) -> list[str]:
    rows = conn.execute(
        """
        SELECT full_name, description, stars
        FROM repos
        WHERE excluded = 0
        """
    ).fetchall()
    picked = [row for row in rows if is_wrapper_repo(row["full_name"], row["description"])]
    picked.sort(key=lambda row: int(row["stars"] or 0), reverse=True)
    return [row["full_name"] for row in picked[:limit]]


def paginate_list(conn: sqlite3.Connection, client: GitHubClient, kind: str, full_name: str, path: str, on_items) -> None:
    row = conn.execute(
        "SELECT next_page, done FROM list_cursors WHERE kind = ? AND repo = ?",
        (kind, full_name),
    ).fetchone()
    if row and row["done"]:
        return
    page = int(row["next_page"]) if row else 1
    while True:
        response = client.core_get(path, params={"per_page": 100, "page": page})
        if response.status_code in {204, 404, 409, 451}:
            _finish_cursor(conn, kind, full_name, page)
            return
        if kind == "stargazers" and 400 <= response.status_code < 500:
            log(f"warning: skipping stargazers for {full_name}: HTTP {response.status_code}")
            _finish_cursor(conn, kind, full_name, page)
            return
        if response.status_code != 200:
            raise RuntimeError(f"GitHub {response.status_code} for {path}: {response.text[:300]}")
        items = response.json()
        if not isinstance(items, list):
            raise RuntimeError(f"Expected a list from {path}")
        on_items(items)
        link = response.headers.get("Link") or ""
        if not items or 'rel="next"' not in link:
            _finish_cursor(conn, kind, full_name, page)
            return
        page += 1
        conn.execute(
            """
            INSERT INTO list_cursors (kind, repo, next_page, done)
            VALUES (?, ?, ?, 0)
            ON CONFLICT(kind, repo) DO UPDATE SET next_page = excluded.next_page, done = 0
            """,
            (kind, full_name, page),
        )
        conn.commit()
        log(f"{kind} {full_name} page {page - 1}")


def _finish_cursor(conn: sqlite3.Connection, kind: str, full_name: str, page: int) -> None:
    conn.execute(
        """
        INSERT INTO list_cursors (kind, repo, next_page, done)
        VALUES (?, ?, ?, 1)
        ON CONFLICT(kind, repo) DO UPDATE SET next_page = excluded.next_page, done = 1
        """,
        (kind, full_name, page),
    )
    conn.commit()


def pull_wrapper_network(conn: sqlite3.Connection, client: GitHubClient, include_stargazers: bool = True) -> None:
    names = wrapper_repo_names(conn)
    log(f"wrapper repos: {len(names)}")
    for full_name in names:
        row = conn.execute(
            "SELECT forks_count, stars, excluded FROM repos WHERE full_name = ?",
            (full_name,),
        ).fetchone()
        if row is None or row["excluded"]:
            continue
        forks_count = row["forks_count"]
        stars = int(row["stars"] or 0)
        if forks_count != 0:
            paginate_list(
                conn,
                client,
                "forks",
                full_name,
                repo_api_path(full_name, "forks"),
                lambda items, parent=full_name: _store_forks(conn, parent, items),
            )
        if include_stargazers and stars != 0:
            paginate_list(
                conn,
                client,
                "stargazers",
                full_name,
                repo_api_path(full_name, "stargazers"),
                lambda items, parent=full_name: _store_stargazers(conn, parent, items),
            )
    if not include_stargazers:
        log("skipping stargazers for this run")


def _store_forks(conn: sqlite3.Connection, parent: str, items: list) -> None:
    for item in items:
        if not item.get("full_name"):
            continue
        upsert_repo(conn, **repo_fields_from_payload(item, "fork", forked_from=parent))


def _store_stargazers(conn: sqlite3.Connection, parent: str, items: list) -> None:
    now = utcnow()
    for item in items:
        login = item.get("login")
        if not login:
            continue
        conn.execute(
            """
            INSERT INTO stargazers (repo_full_name, login, fetched_at)
            VALUES (?, ?, ?)
            ON CONFLICT(repo_full_name, login) DO NOTHING
            """,
            (parent, login, now),
        )


# ---------------------------------------------------------------------------
# Exclusion filters. Rows stay in the database.
# ---------------------------------------------------------------------------


def query_is_broad(query: str) -> bool:
    return any(part.strip() in BROAD_QUERIES for part in (query or "").split(" || "))


def hit_matches_api(path: str, fragment: str) -> bool:
    return bool(KEEP_HIT_RE.search(f"{path or ''}\n{fragment or ''}"))


def _population_counts(conn: sqlite3.Connection) -> dict[str, int]:
    return {
        "hits": conn.execute("SELECT COUNT(*) FROM hits").fetchone()[0],
        "hits_kept": conn.execute("SELECT COUNT(*) FROM hits WHERE excluded = 0").fetchone()[0],
        "repos": conn.execute("SELECT COUNT(*) FROM repos").fetchone()[0],
        "repos_kept": conn.execute("SELECT COUNT(*) FROM repos WHERE excluded = 0").fetchone()[0],
        "accounts": conn.execute(
            """
            SELECT COUNT(DISTINCT owner_login) FROM repos
            WHERE owner_login IS NOT NULL AND owner_login != ''
            """
        ).fetchone()[0],
        "accounts_kept": conn.execute(
            """
            SELECT COUNT(DISTINCT owner_login) FROM repos
            WHERE excluded = 0 AND owner_login IS NOT NULL AND owner_login != ''
            """
        ).fetchone()[0],
    }


def apply_exclusion_filters(conn: sqlite3.Connection, report: bool = True) -> None:
    """Drop broad-query noise and forks of repos that are not AdsPower or Dolphin Anty wrappers.

    Accounts are repo owners. An owner is kept when they still own at least one repo
    that was not excluded.
    """
    before = _population_counts(conn)
    hit_updates: list[tuple] = []
    for row in conn.execute("SELECT repo_full_name, path, query, fragment, excluded, exclude_reason FROM hits"):
        if query_is_broad(row["query"]) and not hit_matches_api(row["path"], row["fragment"]):
            if row["excluded"] != 1 or row["exclude_reason"] != "broad_query_noise":
                hit_updates.append((1, "broad_query_noise", row["repo_full_name"], row["path"]))
        elif row["exclude_reason"] == "broad_query_noise":
            hit_updates.append((0, "", row["repo_full_name"], row["path"]))
    conn.executemany(
        "UPDATE hits SET excluded = ?, exclude_reason = ? WHERE repo_full_name = ? AND path = ?",
        hit_updates,
    )

    repos = conn.execute(
        "SELECT full_name, description, is_fork, forked_from, excluded, exclude_reason FROM repos"
    ).fetchall()
    by_name = {row["full_name"]: row for row in repos}
    repo_updates: list[tuple] = []
    for row in repos:
        parent_name = row["forked_from"] or ""
        parent = by_name.get(parent_name)
        wrapper = bool(row["is_fork"]) and is_wrapper_repo(
            parent["full_name"] if parent else parent_name,
            parent["description"] if parent else None,
        )
        # A fork with no parent name cannot be shown to be an AdsPower or Dolphin Anty wrapper.
        fails = bool(row["is_fork"]) and not wrapper
        if fails:
            if row["excluded"] != 1 or row["exclude_reason"] != "not_a_wrapper":
                repo_updates.append((1, "not_a_wrapper", row["full_name"]))
        elif row["exclude_reason"] == "not_a_wrapper":
            repo_updates.append((0, "", row["full_name"]))
    conn.executemany(
        "UPDATE repos SET excluded = ?, exclude_reason = ? WHERE full_name = ?",
        repo_updates,
    )
    conn.commit()
    if not report:
        return
    after = _population_counts(conn)
    print(f"Hits before filter: {before['hits']}")
    print(f"Hits after filter: {after['hits_kept']}")
    print(f"Repos before filter: {before['repos']}")
    print(f"Repos after filter: {after['repos_kept']}")
    print(f"Accounts before filter: {before['accounts']}")
    print(f"Accounts after filter: {after['accounts_kept']}")


# ---------------------------------------------------------------------------
# Enrichment. Never reads or stores email fields.
# ---------------------------------------------------------------------------


def enrich_run(conn: sqlite3.Connection, client: GitHubClient, include_stargazers: bool = True) -> None:
    before = client.calls
    apply_exclusion_filters(conn)
    _fill_hit_repos(conn, client)
    pull_wrapper_network(conn, client, include_stargazers=include_stargazers)
    apply_exclusion_filters(conn, report=False)
    _enrich_owners(conn, client)
    _enrich_contributors(conn, client)
    log(f"enrich API calls: {client.calls - before}")


def _fill_hit_repos(conn: sqlite3.Connection, client: GitHubClient) -> None:
    rows = conn.execute(
        """
        SELECT DISTINCT h.repo_full_name
        FROM hits h
        LEFT JOIN repos r ON r.full_name = h.repo_full_name
        WHERE r.full_name IS NULL
          AND h.excluded = 0
        """
    ).fetchall()
    log(f"repos to fetch from code hits: {len(rows)}")
    for row in rows:
        full_name = row["repo_full_name"]
        response = client.core_get(repo_api_path(full_name))
        if response.status_code == 404:
            upsert_repo(
                conn,
                full_name=full_name,
                source="code",
                is_fork=0,
                fetched_at=utcnow(),
                description="[missing]",
            )
            conn.commit()
            continue
        if response.status_code != 200:
            log(f"skip repo {full_name}: HTTP {response.status_code}")
            continue
        upsert_repo(conn, **repo_fields_from_payload(response.json(), "code"))
        conn.commit()


def _enrich_owners(conn: sqlite3.Connection, client: GitHubClient) -> None:
    rows = conn.execute(
        """
        SELECT DISTINCT owner_login, owner_type
        FROM repos
        WHERE owner_login IS NOT NULL AND owner_login != ''
          AND excluded = 0
        """
    ).fetchall()
    fetched = 0
    cached = 0
    for row in rows:
        if _account_cached(conn, row["owner_login"]):
            cached += 1
            continue
        enrich_login(conn, client, row["owner_login"], row["owner_type"])
        fetched += 1
    log(f"owners: {fetched} fetched, {cached} cached")


def _account_cached(conn: sqlite3.Connection, login: str) -> bool:
    row = conn.execute("SELECT fetched_at FROM accounts WHERE login = ?", (login,)).fetchone()
    return bool(row and row["fetched_at"])


def enrich_login(conn: sqlite3.Connection, client: GitHubClient, login: str, hint: str | None = None) -> None:
    if not login or _account_cached(conn, login):
        return
    quoted = quote(login, safe="")
    if hint == "Organization":
        response = client.core_get(f"/orgs/{quoted}")
        if response.status_code == 200:
            _save_account(conn, _account_from_org(response.json()))
            return
    response = client.core_get(f"/users/{quoted}")
    if response.status_code == 404:
        _save_account(conn, {"login": login, "type": "missing", "followers": 0})
        return
    if response.status_code != 200:
        log(f"skip account {login}: HTTP {response.status_code}")
        return
    payload = response.json()
    # email is intentionally ignored.
    if payload.get("type") == "Organization":
        org_response = client.core_get(f"/orgs/{quoted}")
        if org_response.status_code == 200:
            _save_account(conn, _account_from_org(org_response.json()))
            return
    _save_account(conn, _account_from_user(payload))


def _account_from_user(payload: dict) -> dict:
    return {
        "login": payload["login"],
        "type": payload.get("type") or "User",
        "name": payload.get("name"),
        "company": payload.get("company"),
        "blog": payload.get("blog"),
        "location": payload.get("location"),
        "twitter_username": payload.get("twitter_username"),
        "bio": payload.get("bio"),
        "public_repos": payload.get("public_repos"),
        "followers": payload.get("followers") or 0,
        "created_at": payload.get("created_at"),
    }


def _account_from_org(payload: dict) -> dict:
    return {
        "login": payload["login"],
        "type": "Organization",
        "name": payload.get("name"),
        "company": payload.get("company"),
        "blog": payload.get("blog"),
        "location": payload.get("location"),
        "twitter_username": payload.get("twitter_username"),
        "bio": payload.get("description"),
        "public_repos": payload.get("public_repos"),
        "followers": payload.get("followers") or 0,
        "created_at": payload.get("created_at"),
    }


def _save_account(conn: sqlite3.Connection, fields: dict) -> None:
    columns = [
        "login", "type", "name", "company", "blog", "location", "twitter_username",
        "bio", "public_repos", "followers", "created_at", "fetched_at",
    ]
    payload = dict(fields)
    payload["fetched_at"] = utcnow()
    conn.execute(
        f"""
        INSERT INTO accounts ({', '.join(columns)})
        VALUES ({', '.join('?' for _ in columns)})
        ON CONFLICT(login) DO UPDATE SET
          type = excluded.type,
          name = excluded.name,
          company = excluded.company,
          blog = excluded.blog,
          location = excluded.location,
          twitter_username = excluded.twitter_username,
          bio = excluded.bio,
          public_repos = excluded.public_repos,
          followers = excluded.followers,
          created_at = excluded.created_at,
          fetched_at = excluded.fetched_at
        """,
        tuple(payload.get(column) for column in columns),
    )
    conn.commit()


def _enrich_contributors(conn: sqlite3.Connection, client: GitHubClient) -> None:
    rows = conn.execute(
        """
        SELECT full_name, owner_login, owner_type, is_fork
        FROM repos
        WHERE contributors_fetched_at IS NULL
          AND excluded = 0
          AND (is_fork = 0 OR full_name IN (SELECT repo_full_name FROM hits WHERE excluded = 0))
        """
    ).fetchall()
    log(f"contributor lists to fetch: {len(rows)}")
    for row in rows:
        response = client.core_get(repo_api_path(row["full_name"], "contributors"), params={"per_page": 10})
        logins: list[str] = []
        if response.status_code == 200:
            payload = response.json()
            if isinstance(payload, list):
                logins = [item["login"] for item in payload if item.get("login")]
        elif response.status_code not in {204, 404, 403, 409, 451}:
            log(f"skip contributors {row['full_name']}: HTTP {response.status_code}")
            continue
        owner = row["owner_login"] or ""
        others = [login for login in logins if login.casefold() != owner.casefold()]
        owner_is_org = (row["owner_type"] or "") == "Organization"
        if owner and (owner_is_org or len(logins) >= 2):
            for login in others:
                conn.execute(
                    """
                    INSERT INTO account_links (account, related_account, relation)
                    VALUES (?, ?, 'contributor')
                    ON CONFLICT(account, related_account, relation) DO NOTHING
                    """,
                    (owner, login),
                )
                conn.commit()
                enrich_login(conn, client, login, "User")
        conn.execute(
            "UPDATE repos SET contributors_fetched_at = ? WHERE full_name = ?",
            (utcnow(), row["full_name"]),
        )
        conn.commit()


# ---------------------------------------------------------------------------
# Score
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ScoredRepo:
    full_name: str
    name: str
    description: str
    pushed_at: datetime | None
    created_at: datetime | None
    hit_files: int


@dataclass(frozen=True)
class ScoreParts:
    total: int
    components: dict[str, int]
    excluded: bool
    exclude_reason: str


def filled(value: str | None) -> bool:
    return bool(value and str(value).strip())


def is_vendor(login: str) -> bool:
    folded = login.casefold()
    return any(part.casefold() in folded for part in VENDOR_LOGIN_SUBSTRINGS)


def tutorial_text(name: str, description: str) -> bool:
    return bool(TUTORIAL_RE.search(f"{name} {description}"))


def is_tutorial(repos: list[ScoredRepo]) -> bool:
    """Flag awesome-lists, tutorials, and docs mirrors. Real multi-file code stays."""
    if not repos:
        return False
    if sum(repo.hit_files for repo in repos) > 1:
        return False
    return all(tutorial_text(repo.name, repo.description) for repo in repos)


def score_account(
    *,
    owner_type: str,
    company: str | None,
    blog: str | None,
    twitter: str | None,
    followers: int,
    account_created: datetime | None,
    login: str,
    repos: list[ScoredRepo],
    now: datetime,
) -> ScoreParts:
    recent_cutoff = now - timedelta(days=RECENT_DAYS)
    recent = any(repo.pushed_at is not None and repo.pushed_at >= recent_cutoff for repo in repos)
    extra = min(EXTRA_REPO_CAP, max(0, len(repos) - 1))
    throwaway = False
    if len(repos) == 1 and account_created is not None and repos[0].created_at is not None:
        gap = repos[0].created_at - account_created
        throwaway = timedelta(0) <= gap < timedelta(days=THROWAWAY_DAYS)
    components = {
        "org": WEIGHT_ORG if (owner_type or "").casefold() == "organization" else 0,
        "contact": WEIGHT_CONTACT if filled(company) or filled(blog) else 0,
        "recent_push": WEIGHT_RECENT if recent else 0,
        "extra_repos": extra * WEIGHT_EXTRA,
        "twitter": WEIGHT_TWITTER if filled(twitter) else 0,
        "followers": WEIGHT_FOLLOWERS if (followers or 0) >= FOLLOWER_MIN else 0,
        "throwaway": WEIGHT_THROWAWAY if throwaway else 0,
    }
    reason = ""
    if is_vendor(login):
        reason = "vendor"
    elif is_tutorial(repos):
        reason = "tutorial"
    return ScoreParts(sum(components.values()), components, bool(reason), reason)


def segment_labels(text: str) -> list[str]:
    return [name for name, pattern in SEGMENT_PATTERNS if pattern.search(text or "")]


def region_hint(location: str, text: str) -> str:
    for name, pattern in LOCATION_REGIONS:
        if pattern.search(location or ""):
            return name
    blob = text or ""
    if CYRILLIC_RE.search(blob):
        return "cyrillic"
    if CJK_RE.search(blob):
        return "cjk"
    if VIETNAMESE_RE.search(blob):
        return "vietnamese"
    return ""


def tools_from_text(text: str) -> set[str]:
    found: set[str] = set()
    if text and ADSPOWER_RE.search(text):
        found.add("adspower")
    if text and DOLPHIN_RE.search(text):
        found.add("dolphin")
    return found


def classify_tool(queries: str, texts: list[str]) -> str:
    found: set[str] = set()
    for part in (queries or "").split(" || "):
        tool = tool_for_query(part.strip())
        if tool in {"adspower", "dolphin"}:
            found.add(tool)
    for text in texts:
        found |= tools_from_text(text)
    if found == {"adspower", "dolphin"}:
        return "both"
    if "adspower" in found:
        return "adspower"
    if "dolphin" in found:
        return "dolphin"
    return "unknown"


def score_run(conn: sqlite3.Connection, client: GitHubClient, now: datetime | None = None) -> None:
    before = client.calls
    now = now or datetime.now(timezone.utc)
    apply_exclusion_filters(conn, report=False)
    grouped = _accounts_for_score(conn)
    preliminary: list[tuple[dict, ScoreParts]] = []
    readme_repos: list[str] = []
    for record in grouped:
        parts = score_account(
            owner_type=record["owner_type"],
            company=record["company"],
            blog=record["blog"],
            twitter=record["twitter"],
            followers=record["followers"],
            account_created=record["account_created"],
            login=record["login"],
            repos=record["scored_repos"],
            now=now,
        )
        preliminary.append((record, parts))
        if parts.total >= README_SCORE_MIN and not parts.excluded:
            readme_repos.extend(repo.full_name for repo in record["scored_repos"])
    ensure_readmes(conn, client, readme_repos)
    readmes = _readme_map(conn)
    vendors: list[str] = []
    for record, parts in preliminary:
        texts = _account_texts(record, readmes, include_readme=True)
        region_text = "\n".join(
            [
                record["bio"] or "",
                *[f"{repo.name} {repo.description}" for repo in record["scored_repos"]],
                *[readmes.get(repo.full_name, "") for repo in record["scored_repos"]],
            ]
        )
        segments = segment_labels("\n".join(texts))
        tool = classify_tool(record["queries"], texts)
        conn.execute(
            """
            INSERT INTO scores (login, score, components, segments, region, tool, excluded, exclude_reason, scored_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(login) DO UPDATE SET
              score = excluded.score,
              components = excluded.components,
              segments = excluded.segments,
              region = excluded.region,
              tool = excluded.tool,
              excluded = excluded.excluded,
              exclude_reason = excluded.exclude_reason,
              scored_at = excluded.scored_at
            """,
            (
                record["login"],
                parts.total,
                json.dumps(parts.components, sort_keys=True),
                json.dumps(segments),
                region_hint(record["location"], region_text),
                tool,
                1 if parts.excluded else 0,
                parts.exclude_reason,
                utcnow(),
            ),
        )
        if parts.exclude_reason == "vendor":
            vendors.append(record["login"])
    keep = [record["login"] for record, _parts in preliminary]
    if keep:
        marks = ",".join("?" for _ in keep)
        conn.execute(f"DELETE FROM scores WHERE login NOT IN ({marks})", keep)
    else:
        conn.execute("DELETE FROM scores")
    conn.commit()
    log(f"scored {len(preliminary)} accounts")
    if vendors:
        log("Vendor denylist matches (review by hand): " + ", ".join(sorted(vendors)))
    else:
        log("Vendor denylist matches (review by hand): none")
    log(f"score API calls: {client.calls - before}")


def _accounts_for_score(conn: sqlite3.Connection) -> list[dict]:
    hit_counts = {
        row["repo_full_name"]: int(row["n"])
        for row in conn.execute(
            "SELECT repo_full_name, COUNT(*) AS n FROM hits WHERE excluded = 0 GROUP BY repo_full_name"
        )
    }
    fragments: dict[str, list[str]] = {}
    for row in conn.execute("SELECT repo_full_name, query, fragment FROM hits WHERE excluded = 0"):
        fragments.setdefault(row["repo_full_name"], []).append(row["fragment"] or "")
        fragments.setdefault(row["repo_full_name"] + "::queries", [])
    hit_queries: dict[str, str] = {}
    for row in conn.execute("SELECT repo_full_name, query FROM hits WHERE excluded = 0"):
        hit_queries[row["repo_full_name"]] = merge_token(hit_queries.get(row["repo_full_name"]), row["query"])
    accounts = {
        row["login"]: row
        for row in conn.execute("SELECT * FROM accounts")
    }
    grouped: dict[str, dict] = {}
    for row in conn.execute(
        """
        SELECT * FROM repos
        WHERE owner_login IS NOT NULL AND owner_login != ''
          AND excluded = 0
        """
    ):
        login = row["owner_login"]
        bucket = grouped.get(login)
        if bucket is None:
            account = accounts.get(login)
            bucket = {
                "login": login,
                "owner_type": (account["type"] if account and account["type"] else row["owner_type"]) or "",
                "company": account["company"] if account else "",
                "blog": account["blog"] if account else "",
                "twitter": account["twitter_username"] if account else "",
                "followers": int(account["followers"] or 0) if account else 0,
                "location": account["location"] if account else "",
                "bio": account["bio"] if account else "",
                "account_created": parse_gh_time(account["created_at"]) if account else None,
                "name": account["name"] if account else "",
                "repos": [],
                "queries": "",
            }
            grouped[login] = bucket
        bucket["repos"].append(row)
        bucket["queries"] = merge_token(bucket["queries"], row["discovery_queries"] or "")
        bucket["queries"] = merge_token(bucket["queries"], hit_queries.get(row["full_name"], ""))
    records = []
    for bucket in grouped.values():
        scored_repos = []
        for repo in bucket["repos"]:
            scored_repos.append(
                ScoredRepo(
                    full_name=repo["full_name"],
                    name=repo["full_name"].split("/", 1)[-1],
                    description=repo["description"] or "",
                    pushed_at=parse_gh_time(repo["pushed_at"]),
                    created_at=parse_gh_time(repo["created_at"]),
                    hit_files=hit_counts.get(repo["full_name"], 0),
                )
            )
        bucket["scored_repos"] = scored_repos
        bucket["fragments"] = fragments
        records.append(bucket)
    return records


def _account_texts(record: dict, readmes: dict[str, str], include_readme: bool) -> list[str]:
    texts = [record["queries"] or ""]
    for repo in record["repos"]:
        texts.append(repo["full_name"] or "")
        texts.append(repo["description"] or "")
        texts.append(repo["forked_from"] or "")
        texts.extend(record["fragments"].get(repo["full_name"], []))
        if include_readme:
            texts.append(readmes.get(repo["full_name"], "") or "")
    return texts


def _readme_map(conn: sqlite3.Connection) -> dict[str, str]:
    return {
        row["full_name"]: row["readme_text"] or ""
        for row in conn.execute("SELECT full_name, readme_text FROM repos WHERE readme_fetched_at IS NOT NULL")
    }


def ensure_readmes(conn: sqlite3.Connection, client: GitHubClient, full_names: list[str]) -> None:
    seen: set[str] = set()
    for full_name in full_names:
        if full_name in seen:
            continue
        seen.add(full_name)
        row = conn.execute(
            "SELECT readme_fetched_at FROM repos WHERE full_name = ?",
            (full_name,),
        ).fetchone()
        if row is None or row["readme_fetched_at"]:
            continue
        response = client.core_get(repo_api_path(full_name, "readme"), accept="application/vnd.github.raw")
        if response.status_code == 200:
            text = response.text[:README_LIMIT]
        elif response.status_code in {403, 404}:
            text = ""
        else:
            log(f"skip readme {full_name}: HTTP {response.status_code}")
            continue
        conn.execute(
            "UPDATE repos SET readme_text = ?, readme_fetched_at = ? WHERE full_name = ?",
            (text, utcnow(), full_name),
        )
        conn.commit()


# ---------------------------------------------------------------------------
# Fragment report
# ---------------------------------------------------------------------------


def _clean_token(value: str) -> str:
    return value.strip().strip(TRAILING_PUNCT)


def _skip_host(host: str) -> bool:
    host = host.lower()
    return host == "github.com" or host.endswith(".github.com") or host.endswith("githubusercontent.com")


def plausible_host(host: str) -> bool:
    host = host.lower().strip(".")
    if _skip_host(host):
        return False
    name, _sep, _port = host.partition(":")
    if name == "localhost":
        return True
    if "." not in name:
        return False
    tld = name.rsplit(".", 1)[-1]
    if tld in CODE_EXTENSIONS or not tld.isalpha() or len(tld) < 2:
        return False
    return True


def fragment_url_stats(fragments: list[str], limit: int = 20) -> tuple[list[tuple[str, int]], list[tuple[str, int]]]:
    urls: Counter[str] = Counter()
    hosts: Counter[str] = Counter()
    for fragment in fragments:
        text = fragment or ""
        found_urls = [_clean_token(match) for match in URL_RE.findall(text)]
        for url in found_urls:
            host = (urlparse(url).hostname or "").lower()
            if host and not _skip_host(host):
                urls[url] += 1
                hosts[host] += 1
        stripped = URL_RE.sub(" ", text)
        for match in HOST_RE.findall(stripped):
            host = _clean_token(match).lower()
            if plausible_host(host):
                hosts[host.split(":")[0]] += 1
    return urls.most_common(limit), hosts.most_common(limit)


def print_fragment_report(conn: sqlite3.Connection) -> None:
    fragments = [row["fragment"] or "" for row in conn.execute("SELECT fragment FROM hits")]
    urls, hosts = fragment_url_stats(fragments)
    log("Most common URLs in hit fragments:")
    if not urls:
        log("  (none)")
    for url, count in urls:
        log(f"  {count:4}  {url}")
    log("Most common hosts in hit fragments:")
    if not hosts:
        log("  (none)")
    for host, count in hosts:
        log(f"  {count:4}  {host}")


# ---------------------------------------------------------------------------
# Export
# ---------------------------------------------------------------------------


def export_run(conn: sqlite3.Connection) -> None:
    apply_exclusion_filters(conn, report=False)
    hits = conn.execute("SELECT COUNT(*) AS n FROM hits WHERE excluded = 0").fetchone()["n"]
    repos = conn.execute("SELECT COUNT(*) AS n FROM repos WHERE excluded = 0").fetchone()["n"]
    scored = conn.execute("SELECT COUNT(*) AS n FROM scores").fetchone()["n"]
    if scored == 0 and (hits or repos):
        raise SystemExit("No scores yet. Run `python leads.py score` first.")
    _write_leads(conn)
    _write_repos(conn)
    _print_summary(conn)


def _write_leads(conn: sqlite3.Connection) -> None:
    repos_by_owner: dict[str, list[sqlite3.Row]] = {}
    for row in conn.execute("SELECT * FROM repos WHERE owner_login IS NOT NULL AND excluded = 0"):
        repos_by_owner.setdefault(row["owner_login"], []).append(row)
    related = _related_map(conn)
    accounts = {row["login"]: row for row in conn.execute("SELECT * FROM accounts")}
    scores = conn.execute("SELECT * FROM scores ORDER BY score DESC, login ASC").fetchall()
    with LEADS_CSV.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=LEAD_COLUMNS)
        writer.writeheader()
        for score in scores:
            if score["excluded"]:
                continue
            login = score["login"]
            account = accounts.get(login)
            owned = sorted(
                repos_by_owner.get(login, []),
                key=lambda row: (row["pushed_at"] or "", int(row["stars"] or 0)),
                reverse=True,
            )
            top = []
            for repo in owned[:3]:
                top.append(repo["html_url"] or f"https://github.com/{repo['full_name']}")
            last_push = owned[0]["pushed_at"] if owned else ""
            segments = "|".join(json.loads(score["segments"] or "[]"))
            writer.writerow(
                {
                    "login": login,
                    "type": (account["type"] if account else "") or "",
                    "name": (account["name"] if account else "") or "",
                    "company": (account["company"] if account else "") or "",
                    "blog": (account["blog"] if account else "") or "",
                    "twitter": (account["twitter_username"] if account else "") or "",
                    "location": (account["location"] if account else "") or "",
                    "score": score["score"],
                    "segments": segments,
                    "matched_repo_count": len(owned),
                    "top_repos": "|".join(top),
                    "last_push": last_push or "",
                    "tool": score["tool"],
                    "related_accounts": "|".join(sorted(related.get(login, []))),
                    "excluded": score["excluded"],
                    "exclude_reason": score["exclude_reason"] or "",
                }
            )
    log(f"wrote {LEADS_CSV}")


def _related_map(conn: sqlite3.Connection) -> dict[str, set[str]]:
    related: dict[str, set[str]] = {}
    for row in conn.execute("SELECT account, related_account FROM account_links"):
        related.setdefault(row["account"], set()).add(row["related_account"])
        related.setdefault(row["related_account"], set()).add(row["account"])
    return related


def _write_repos(conn: sqlite3.Connection) -> None:
    files: dict[str, list[sqlite3.Row]] = {}
    for row in conn.execute(
        "SELECT repo_full_name, path, html_url, query, fragment FROM hits WHERE excluded = 0"
    ):
        files.setdefault(row["repo_full_name"], []).append(row)
    with REPOS_CSV.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=REPO_COLUMNS)
        writer.writeheader()
        for repo in conn.execute("SELECT * FROM repos WHERE excluded = 0 ORDER BY stars DESC, full_name ASC"):
            matched = files.get(repo["full_name"], [])
            texts = [
                repo["discovery_queries"] or "",
                repo["full_name"] or "",
                repo["description"] or "",
                repo["forked_from"] or "",
                repo["readme_text"] or "",
            ]
            queries = repo["discovery_queries"] or ""
            for hit in matched:
                queries = merge_token(queries, hit["query"] or "")
                texts.append(hit["fragment"] or "")
            writer.writerow(
                {
                    "full_name": repo["full_name"],
                    "url": repo["html_url"] or f"https://github.com/{repo['full_name']}",
                    "owner_login": repo["owner_login"] or "",
                    "owner_type": repo["owner_type"] or "",
                    "source": repo["source"] or "",
                    "is_fork": repo["is_fork"] or 0,
                    "forked_from": repo["forked_from"] or "",
                    "stars": repo["stars"] if repo["stars"] is not None else "",
                    "language": repo["language"] or "",
                    "pushed_at": repo["pushed_at"] or "",
                    "created_at": repo["created_at"] or "",
                    "description": repo["description"] or "",
                    "homepage": repo["homepage"] or "",
                    "tool": classify_tool(queries, texts),
                    "matched_files": "|".join(hit["path"] for hit in matched),
                    "matched_urls": "|".join(hit["html_url"] or "" for hit in matched if hit["html_url"]),
                }
            )
    log(f"wrote {REPOS_CSV}")


def _print_summary(conn: sqlite3.Connection) -> None:
    hits = conn.execute("SELECT COUNT(*) AS n FROM hits WHERE excluded = 0").fetchone()["n"]
    repos = conn.execute("SELECT COUNT(*) AS n FROM repos WHERE excluded = 0").fetchone()["n"]
    accounts = conn.execute("SELECT COUNT(*) AS n FROM scores").fetchone()["n"]
    stars = conn.execute("SELECT COUNT(*) AS n FROM stargazers").fetchone()["n"]
    rows = conn.execute("SELECT * FROM scores").fetchall()
    actionable = [row for row in rows if not row["excluded"]]
    vendor = sum(1 for row in rows if row["exclude_reason"] == "vendor")
    tutorial = sum(1 for row in rows if row["exclude_reason"] == "tutorial")
    by_tool: Counter[str] = Counter(row["tool"] or "unknown" for row in actionable)
    by_segment: Counter[str] = Counter()
    by_region: Counter[str] = Counter()
    for row in actionable:
        for segment in json.loads(row["segments"] or "[]"):
            by_segment[segment] += 1
        if row["region"]:
            by_region[row["region"]] += 1
    print(f"Hits: {hits}")
    print(f"Unique repos: {repos}")
    print(f"Unique accounts: {accounts}")
    print(f"Actionable accounts: {len(actionable)}")
    print(f"Excluded vendor: {vendor}")
    print(f"Excluded tutorial: {tutorial}")
    print(f"Stargazers cached: {stars}")
    print("By tool:")
    for name, count in sorted(by_tool.items()):
        print(f"  {name}: {count}")
    print("By segment:")
    if not by_segment:
        print("  (none)")
    for name, count in by_segment.most_common():
        print(f"  {name}: {count}")
    print("By region:")
    if not by_region:
        print("  (none)")
    for name, count in by_region.most_common():
        print(f"  {name}: {count}")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


@contextmanager
def open_db():
    conn = connect()
    try:
        yield conn
    finally:
        conn.close()


@contextmanager
def open_client():
    load_dotenv(APP_DIR / ".env")
    load_dotenv(APP_DIR.parent / ".env")
    token = os.environ.get("GITHUB_TOKEN", "").strip()
    if not token:
        raise SystemExit("Set GITHUB_TOKEN in github-leads/.env or the environment.")
    client = GitHubClient(token)
    try:
        yield client
    finally:
        log(f"GitHub API calls this run: {client.calls}")
        client.close()


def _guard(fn) -> None:
    try:
        fn()
    except KeyboardInterrupt:
        log("Stopped. Re-run the same command to resume.")
        raise SystemExit(130)


@app.command()
def harvest() -> None:
    """Search code for AdsPower and Dolphin Anty API calls."""
    def run() -> None:
        with open_db() as conn, open_client() as client:
            harvest_run(conn, client)
    _guard(run)


@app.command()
def repos() -> None:
    """Search repository names, descriptions, topics, forks, and stargazers."""
    def run() -> None:
        with open_db() as conn, open_client() as client:
            repos_run(conn, client)
    _guard(run)


@app.command()
def enrich(
    skip_stargazers: bool = typer.Option(False, "--skip-stargazers", help="Do not collect stargazers."),
) -> None:
    """Fetch repo, owner, and contributor profiles. Emails are not stored."""
    def run() -> None:
        with open_db() as conn, open_client() as client:
            enrich_run(conn, client, include_stargazers=not skip_stargazers)
    _guard(run)


@app.command()
def score() -> None:
    """Flag vendors and tutorials, then score and tag each account."""
    def run() -> None:
        with open_db() as conn, open_client() as client:
            score_run(conn, client)
    _guard(run)


@app.command()
def export() -> None:
    """Write leads.csv and repos.csv, then print the summary."""
    def run() -> None:
        with open_db() as conn:
            export_run(conn)
    _guard(run)


@app.command(name="all")
def run_all() -> None:
    """Run harvest, repos, enrich, score, and export."""
    def run() -> None:
        with open_db() as conn, open_client() as client:
            harvest_run(conn, client)
            repos_run(conn, client)
            enrich_run(conn, client)
            score_run(conn, client)
            export_run(conn)
    _guard(run)


def main() -> None:
    app()


if __name__ == "__main__":
    main()
