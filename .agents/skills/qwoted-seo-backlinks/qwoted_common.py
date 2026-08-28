"""
Shared helpers for the Qwoted SEO Backlinks skill.

What lives here
---------------
* `qwoted_home()` — per-account state (`~/.qwoted`, or `QWOTED_HOME`).
* Config, client metadata (real browser UA), Algolia cred cache.
* Cookie helpers and authenticated HTTP (used only when we must).
* CSRF / user-id extractors from Qwoted HTML.
"""

from __future__ import annotations

import html as html_lib
import json
import os
import random
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests

try:
    from dotenv import load_dotenv

    load_dotenv(Path(__file__).resolve().parent / ".env")
except Exception:
    pass

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
QWOTED_BASE = "https://app.qwoted.com"

# Fallback only. Prefer the UA captured from the real Chrome session.
FALLBACK_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_2) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36"
)
USER_AGENT = FALLBACK_USER_AGENT  # backward compat for `from qwoted_common import USER_AGENT`

SESSION_FILENAME = "storage_state.json"
PITCHES_FILENAME = "sent_pitches.json"
PROFILE_FILENAME = "profile_state.json"
CLIENT_FILENAME = "client.json"
CONFIG_FILENAME = "config.json"
ALGOLIA_FILENAME = "algolia_creds.json"
RATE_LOG_FILENAME = "search_rate.json"

DEFAULT_CONFIG: dict[str, Any] = {
    "min_seconds_between_searches": 90,
    "max_searches_per_window": 6,
    "rate_window_seconds": 3600,
    "algolia_ttl_seconds": 21600,
    "min_seconds_after_login_before_search": 3600,
    "max_hits_cap": 40,
    "default_max_hits": 20,
    "hits_per_page": 20,
    "prefer_browser_search": True,
    "require_warm_profile": True,
    "cdp_port": 9333,
    "page_delay_min_s": 0.8,
    "page_delay_max_s": 2.2,
    "pre_search_jitter_min_s": 8,
    "pre_search_jitter_max_s": 25,
}

_REACT_PROPS_RE = re.compile(
    r'data-react-class="source_requests/top_level_search"\s+data-react-props="([^"]+)"'
)


def log(msg: str, **extra: Any) -> None:
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    if extra:
        msg = f"{msg} | {json.dumps(extra, default=str)}"
    print(f"[{ts}] {msg}", flush=True, file=sys.stderr)


def result_line(payload: dict[str, Any]) -> None:
    print(f"RESULT: {json.dumps(payload, default=str)}", flush=True)


# ---------------------------------------------------------------------------
# State directory
# ---------------------------------------------------------------------------
def qwoted_home() -> Path:
    override = os.environ.get("QWOTED_HOME")
    if override:
        p = Path(override).expanduser().resolve()
    else:
        p = Path.home() / ".qwoted"
    p.mkdir(parents=True, exist_ok=True)
    return p


def session_file() -> Path:
    return qwoted_home() / SESSION_FILENAME


def pitches_file() -> Path:
    return qwoted_home() / PITCHES_FILENAME


def profile_file() -> Path:
    return qwoted_home() / PROFILE_FILENAME


def client_file() -> Path:
    return qwoted_home() / CLIENT_FILENAME


def config_file() -> Path:
    return qwoted_home() / CONFIG_FILENAME


def algolia_file() -> Path:
    return qwoted_home() / ALGOLIA_FILENAME


def rate_log_file() -> Path:
    return qwoted_home() / RATE_LOG_FILENAME


def opportunities_dir() -> Path:
    p = qwoted_home() / "opportunities"
    p.mkdir(parents=True, exist_ok=True)
    return p


def drafts_dir() -> Path:
    p = qwoted_home() / "drafts"
    p.mkdir(parents=True, exist_ok=True)
    return p


# ---------------------------------------------------------------------------
# Config / client metadata
# ---------------------------------------------------------------------------
def load_config() -> dict[str, Any]:
    cfg = dict(DEFAULT_CONFIG)
    fp = config_file()
    if fp.exists():
        try:
            saved = json.loads(fp.read_text())
            if isinstance(saved, dict):
                cfg.update(saved)
        except Exception as e:
            log(f"WARNING: could not parse {fp}: {e}")
    env_map = {
        "min_seconds_between_searches": "QWOTED_MIN_SEARCH_INTERVAL",
        "max_searches_per_window": "QWOTED_MAX_SEARCHES_PER_WINDOW",
        "rate_window_seconds": "QWOTED_RATE_WINDOW_SECONDS",
        "algolia_ttl_seconds": "QWOTED_ALGOLIA_TTL",
        "min_seconds_after_login_before_search": "QWOTED_LOGIN_WAIT",
        "max_hits_cap": "QWOTED_MAX_HITS_CAP",
        "default_max_hits": "QWOTED_DEFAULT_MAX_HITS",
        "hits_per_page": "QWOTED_HITS_PER_PAGE",
        "cdp_port": "QWOTED_CDP_PORT",
    }
    for key, env_name in env_map.items():
        raw = os.environ.get(env_name)
        if raw is None or raw == "":
            continue
        try:
            cfg[key] = type(DEFAULT_CONFIG[key])(raw)
        except (TypeError, ValueError):
            log(f"WARNING: ignoring invalid {env_name}={raw!r}")
    if os.environ.get("QWOTED_PREFER_BROWSER_SEARCH", "").lower() in ("0", "false", "no"):
        cfg["prefer_browser_search"] = False
    if os.environ.get("QWOTED_REQUIRE_WARM_PROFILE", "").lower() in ("0", "false", "no"):
        cfg["require_warm_profile"] = False
    return cfg


def load_client() -> dict[str, Any]:
    fp = client_file()
    if not fp.exists():
        return {}
    try:
        data = json.loads(fp.read_text())
        return data if isinstance(data, dict) else {}
    except Exception as e:
        log(f"WARNING: could not parse {fp}: {e}")
        return {}


def patch_client(updates: dict[str, Any]) -> dict[str, Any]:
    data = load_client()
    data.update(updates)
    data["updated_at"] = datetime.now(timezone.utc).isoformat()
    client_file().write_text(json.dumps(data, indent=2, default=str))
    return data


def effective_user_agent() -> str:
    ua = (load_client().get("user_agent") or "").strip()
    return ua or FALLBACK_USER_AGENT


def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def parse_iso(ts: str | None) -> datetime | None:
    if not ts:
        return None
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        return None


def seconds_since(ts: str | None) -> float | None:
    dt = parse_iso(ts)
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - dt).total_seconds()


def jitter_sleep(lo: float, hi: float, why: str) -> float:
    lo = max(0.0, float(lo))
    hi = max(lo, float(hi))
    delay = random.uniform(lo, hi)
    log(f"jitter {delay:.1f}s ({why})")
    time.sleep(delay)
    return delay


# ---------------------------------------------------------------------------
# Algolia cred cache
# ---------------------------------------------------------------------------
def parse_algolia_credentials(html: str) -> dict[str, str] | None:
    m = _REACT_PROPS_RE.search(html)
    if not m:
        return None
    try:
        props = json.loads(html_lib.unescape(m.group(1)))
    except Exception:
        return None
    creds = {
        "app_id": props.get("algoliaAppId"),
        "search_key": props.get("algoliaSearchKey"),
        "index_name": props.get("indexName"),
    }
    if not all(creds.values()):
        return None
    return creds


def load_algolia_credentials() -> dict[str, str] | None:
    fp = algolia_file()
    if not fp.exists():
        return None
    try:
        data = json.loads(fp.read_text())
    except Exception as e:
        log(f"WARNING: could not parse {fp}: {e}")
        return None
    fetched = parse_iso(data.get("fetched_at"))
    if fetched is None:
        return None
    if fetched.tzinfo is None:
        fetched = fetched.replace(tzinfo=timezone.utc)
    ttl = int(data.get("ttl_seconds") or load_config()["algolia_ttl_seconds"])
    age = (datetime.now(timezone.utc) - fetched).total_seconds()
    if age > ttl:
        log(f"Algolia creds expired ({int(age)}s old, ttl={ttl}s)")
        return None
    creds = {
        "app_id": data.get("app_id"),
        "search_key": data.get("search_key"),
        "index_name": data.get("index_name"),
    }
    if not all(creds.values()):
        return None
    log(f"using cached Algolia creds ({int(age)}s old)")
    return creds


def save_algolia_credentials(creds: dict[str, str]) -> None:
    ttl = int(load_config()["algolia_ttl_seconds"])
    payload = {
        **creds,
        "fetched_at": iso_now(),
        "ttl_seconds": ttl,
    }
    algolia_file().write_text(json.dumps(payload, indent=2))
    log(f"cached Algolia creds for {ttl}s at {algolia_file()}")


# ---------------------------------------------------------------------------
# Warm / login gates for search
# ---------------------------------------------------------------------------
def profile_looks_warm() -> bool:
    client = load_client()
    if client.get("has_source"):
        return True
    fp = profile_file()
    if not fp.exists():
        return False
    try:
        data = json.loads(fp.read_text())
        sources = (data.get("entities") or {}).get("sources") or []
        return bool(sources)
    except Exception:
        return False


def search_preflight(
    *,
    skip_warm: bool = False,
    skip_login_wait: bool = False,
) -> dict[str, Any] | None:
    """Return a RESULT-shaped error dict if search should not run yet."""
    cfg = load_config()
    skip_warm = skip_warm or os.environ.get("QWOTED_SKIP_WARM_CHECK", "").lower() in (
        "1",
        "true",
        "yes",
    )
    skip_login_wait = skip_login_wait or os.environ.get(
        "QWOTED_SKIP_LOGIN_WAIT", ""
    ).lower() in ("1", "true", "yes")

    if not load_cookies():
        return {
            "status": "error",
            "error": (
                f"No Qwoted session at {session_file()}. "
                "Run: python3 qwoted_login.py --start-chrome"
            ),
        }

    client = load_client()
    wait_s = int(cfg["min_seconds_after_login_before_search"])
    age = seconds_since(client.get("logged_in_at"))
    method = client.get("login_method") or "unknown"
    if (
        not skip_login_wait
        and wait_s > 0
        and age is not None
        and age < wait_s
        and method != "manual-ui"
    ):
        remaining = int(wait_s - age) + 1
        return {
            "status": "too_soon_after_login",
            "error": (
                f"Login was {int(age)}s ago via {method}. Wait {remaining}s "
                f"(or set QWOTED_SKIP_LOGIN_WAIT=1 on a throwaway account) before "
                "scripted search. Browse the live site in the Qwoted Chrome window first."
            ),
            "retry_after_seconds": remaining,
            "login_method": method,
        }

    if cfg["require_warm_profile"] and not skip_warm and not profile_looks_warm():
        return {
            "status": "not_warmed",
            "error": (
                "No Source persona on file. Fill your expert profile in the Qwoted "
                "Chrome window (or run qwoted_profile.py --action get after that), "
                "then search. Throwaway override: --skip-warm-check."
            ),
        }
    return None


# ---------------------------------------------------------------------------
# Cookie helpers
# ---------------------------------------------------------------------------
def load_cookies() -> dict[str, str] | None:
    fp = session_file()
    if not fp.exists():
        return None
    try:
        state = json.loads(fp.read_text())
        cookies = state.get("cookies") or []
        if not cookies:
            return None
        return {c["name"]: c["value"] for c in cookies if "name" in c and "value" in c}
    except Exception as e:
        log(f"WARNING: could not parse cookie jar at {fp}: {e}")
        return None


def require_cookies() -> dict[str, str]:
    cookies = load_cookies()
    if not cookies:
        raise FileNotFoundError(
            f"No Qwoted session found at {session_file()}.\n"
            f"Run: python3 qwoted_login.py --start-chrome\n"
            f"(then re-run this command)."
        )
    return cookies


# ---------------------------------------------------------------------------
# Page-level extractors
# ---------------------------------------------------------------------------
_CSRF_META_RE = re.compile(r'<meta\s+name="csrf-token"\s+content="([^"]+)"')

_USER_ID_RES: list[re.Pattern[str]] = [
    re.compile(r'userId&quot;:(\d+)'),
    re.compile(r"['\"]userId['\"]\s*,\s*(\d+)"),
    re.compile(r'data-user-id=["\'](\d+)["\']'),
    re.compile(
        r'name="source\[represented_sources_attributes\]\[0\]\[user_id\]"[^>]*value="(\d+)"'
    ),
    re.compile(
        r'value="(\d+)"[^>]*name="source\[represented_sources_attributes\]\[0\]\[user_id\]"'
    ),
]

_USER_SLUG_RE = re.compile(r"/pr_users/([a-z0-9-]+)")


def extract_csrf(html: str) -> str | None:
    m = _CSRF_META_RE.search(html)
    return m.group(1) if m else None


def extract_user_id(html: str) -> int | None:
    for rx in _USER_ID_RES:
        m = rx.search(html)
        if m:
            try:
                return int(m.group(1))
            except ValueError:
                continue
    return None


def extract_user_slug(html: str) -> str | None:
    m = _USER_SLUG_RE.search(html)
    return m.group(1) if m else None


def looks_like_login_page(text: str) -> bool:
    head = text[:6000].lower()
    if "users/sign_in" in head:
        return True
    return "welcome back" in head and "password" in head


# ---------------------------------------------------------------------------
# HTTP helpers (authenticated) — last resort; prefer the real Chrome session
# ---------------------------------------------------------------------------
def common_headers(csrf: str | None = None, referer: str | None = None) -> dict[str, str]:
    h = {
        "User-Agent": effective_user_agent(),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Origin": QWOTED_BASE,
    }
    if csrf:
        h["X-CSRF-Token"] = csrf
        h["X-Requested-With"] = "XMLHttpRequest"
    if referer:
        h["Referer"] = referer
    return h


def authed_get(
    path_or_url: str,
    cookies: dict[str, str],
    accept: str | None = None,
    timeout: int = 30,
) -> requests.Response:
    url = path_or_url if path_or_url.startswith("http") else f"{QWOTED_BASE}{path_or_url}"
    headers = common_headers()
    if accept:
        headers["Accept"] = accept
    return requests.get(
        url, cookies=cookies, headers=headers, timeout=timeout, allow_redirects=True
    )


def fetch_session_context() -> dict[str, Any]:
    cookies = require_cookies()
    r = authed_get("/source_requests", cookies)
    if r.status_code != 200 or looks_like_login_page(r.text):
        raise PermissionError(
            "Qwoted session expired. Run: python3 qwoted_login.py --start-chrome"
        )
    csrf = extract_csrf(r.text)
    user_id = extract_user_id(r.text)
    user_slug = extract_user_slug(r.text)
    if not csrf:
        raise RuntimeError("Could not find CSRF token on /source_requests")
    creds = parse_algolia_credentials(r.text)
    if creds:
        save_algolia_credentials(creds)
    return {
        "cookies": cookies,
        "csrf": csrf,
        "user_id": user_id,
        "user_slug": user_slug,
        "page_url": r.url,
    }
