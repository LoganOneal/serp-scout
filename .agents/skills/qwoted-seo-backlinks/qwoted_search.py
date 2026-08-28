"""
Qwoted opportunity search.

Default path (after 2026-07-03 disable):
  1. Refuse empty-query dumps and agent for-loops (rate limit + caps).
  2. Prefer running the Algolia query inside a live Chrome page.
  3. If Chrome is not up, use cached Algolia keys (harvested by
     `qwoted_login.py --browse`) and do NOT GET /source_requests.
  4. `--http` is the old cookie-replay path and is opt-in.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path

import requests

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from qwoted_common import (  # noqa: E402
    QWOTED_BASE,
    authed_get,
    effective_user_agent,
    jitter_sleep,
    load_algolia_credentials,
    load_config,
    log,
    looks_like_login_page,
    opportunities_dir,
    parse_algolia_credentials,
    rate_log_file,
    require_cookies,
    result_line,
    save_algolia_credentials,
    search_preflight,
)

HITS_PER_PAGE = 20


def _safe_filename(query: str) -> str:
    import re
    s = re.sub(r"[^a-zA-Z0-9_-]+", "_", (query or "all").strip()).strip("_")
    return s.lower() or "all"


def enforce_search_rate_limit() -> dict | None:
    cfg = load_config()
    min_gap = float(cfg["min_seconds_between_searches"])
    max_n = int(cfg["max_searches_per_window"])
    window = float(cfg["rate_window_seconds"])

    now = time.time()
    path = rate_log_file()
    stamps: list[float] = []
    if path.exists():
        try:
            raw = json.loads(path.read_text())
            stamps = [float(x) for x in raw.get("timestamps", [])]
        except (OSError, ValueError, json.JSONDecodeError, TypeError):
            stamps = []

    cutoff = now - window
    stamps = [t for t in stamps if t >= cutoff]

    if stamps:
        since_last = now - max(stamps)
        if since_last < min_gap:
            wait = int(min_gap - since_last) + 1
            return {
                "status": "rate_limited",
                "error": (
                    f"Refusing search: last search was {int(since_last)}s ago. "
                    f"Minimum gap is {int(min_gap)}s."
                ),
                "retry_after_seconds": wait,
                "searches_in_window": len(stamps),
            }

    if len(stamps) >= max_n:
        wait = int(min(stamps) + window - now) + 1
        return {
            "status": "rate_limited",
            "error": (
                f"Refusing search: {len(stamps)} searches in the last "
                f"{int(window)}s (max {max_n})."
            ),
            "retry_after_seconds": max(wait, 1),
            "searches_in_window": len(stamps),
        }

    stamps.append(now)
    path.write_text(json.dumps({"timestamps": stamps}, indent=2))
    return None


def _normalise_hit(hit: dict) -> dict:
    pub = hit.get("publication") or {}
    shared = hit.get("shared_article") or {}
    hashtags = [h.get("hashtag", "") for h in (hit.get("hashtags") or []) if h.get("hashtag")]
    share_url = hit.get("share_url") or ""
    src_path = hit.get("source_request_path") or ""
    full_url = (
        share_url if share_url.startswith("http")
        else (f"{QWOTED_BASE}{src_path}" if src_path else share_url)
    )
    source_request_id = None
    obj_id = hit.get("objectID")
    if obj_id and str(obj_id).isdigit():
        source_request_id = int(obj_id)

    return {
        "source_request_id": source_request_id,
        "object_id": obj_id,
        "name": hit.get("name", ""),
        "details": hit.get("details", ""),
        "request_type": hit.get("request_type_text", ""),
        "request_sub_type": hit.get("request_sub_type_text_filtered", ""),
        "deadline": hit.get("source_request_submit_date", ""),
        "no_deadline": hit.get("no_deadline", False),
        "deadline_approaching": hit.get("deadline_approaching", False),
        "published_at": hit.get("published_at", ""),
        "want_pitches": hit.get("want_pitches", False),
        "free_to_pitch": hit.get("source_request_free_to_pitch", False),
        "paid": hit.get("paid", False),
        "is_new": hit.get("is_new", False),
        "easy_win": hit.get("easy_win", False),
        "pitch_count_category": hit.get("pitch_count_category", ""),
        "publication": {
            "name": pub.get("name", ""),
            "logo_url": pub.get("logo_url", ""),
            "publication_path": pub.get("publication_path", ""),
            "top_publication": pub.get("top_publication", False),
            "region": pub.get("region"),
        },
        "shared_article": {
            "title": shared.get("title"),
            "publication_name": shared.get("publication_name"),
            "content_excerpt": shared.get("content_excerpt"),
            "image_url": shared.get("image_url"),
        },
        "hashtags": hashtags,
        "url": full_url,
    }


def _algolia_query_http(creds: dict[str, str], query: str, page: int,
                        hits_per_page: int) -> dict:
    url = f"https://{creds['app_id']}-dsn.algolia.net/1/indexes/{creds['index_name']}/query"
    headers = {
        "X-Algolia-API-Key": creds["search_key"],
        "X-Algolia-Application-Id": creds["app_id"],
        "Content-Type": "application/json",
        "User-Agent": effective_user_agent(),
        "Referer": f"{QWOTED_BASE}/",
        "Origin": QWOTED_BASE,
    }
    encoded = urllib.parse.urlencode({
        "query": query or "",
        "hitsPerPage": hits_per_page,
        "page": page,
    })
    r = requests.post(url, headers=headers, json={"params": encoded}, timeout=30)
    if r.status_code != 200:
        raise RuntimeError(f"Algolia returned {r.status_code}: {r.text[:300]}")
    return r.json()


def _fetch_algolia_credentials_http() -> dict[str, str] | None:
    cookies = require_cookies()
    r = authed_get("/source_requests", cookies)
    log(f"/source_requests → status {r.status_code}, len {len(r.text)}")
    if r.status_code != 200 or looks_like_login_page(r.text):
        return None
    creds = parse_algolia_credentials(r.text)
    if not creds:
        log("ERROR: could not find Algolia react props on /source_requests")
        return None
    save_algolia_credentials(creds)
    return creds


def _collect_hits(
    fetch_page,
    query: str,
    max_hits: int,
    cfg: dict,
    start_page: int = 0,
) -> tuple[list[dict], int | None, int]:
    all_hits: list[dict] = []
    seen_ids: set[str] = set()
    nb_total: int | None = None
    pages_fetched = 0
    page = max(0, int(start_page))
    while len(all_hits) < max_hits:
        data = fetch_page(page)
        hits = data.get("hits") or []
        nb_total = data.get("nbHits", nb_total)
        nb_pages = data.get("nbPages", 0)
        pages_fetched += 1
        log(
            f"page {page} → {len(hits)} hits "
            f"(running total {len(all_hits)}/{max_hits}, index nbHits={nb_total})"
        )
        if not hits:
            break
        new_count = 0
        for h in hits:
            obj_id = h.get("objectID")
            if not obj_id or obj_id in seen_ids:
                continue
            seen_ids.add(obj_id)
            normalised = _normalise_hit(h)
            normalised["scraped_from_page"] = page
            all_hits.append(normalised)
            new_count += 1
            if len(all_hits) >= max_hits:
                break
        if new_count == 0:
            break
        if nb_pages and page + 1 >= nb_pages:
            break
        page += 1
        jitter_sleep(cfg["page_delay_min_s"], cfg["page_delay_max_s"], "between Algolia pages")
    return all_hits, nb_total, pages_fetched


def _write_out(
    query: str,
    creds: dict,
    all_hits: list,
    nb_total,
    pages_fetched,
    out_dir: Path,
    source: str,
    start_page: int = 0,
) -> dict:
    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    out_path = out_dir / f"{_safe_filename(query)}_{ts}.json"
    payload = {
        "query": query,
        "scraped_at": datetime.now(timezone.utc).isoformat(),
        "source": source,
        "algolia_index": creds["index_name"],
        "algolia_app_id": creds["app_id"],
        "nb_hits_total_in_index": nb_total,
        "pages_fetched": pages_fetched,
        "start_page": start_page,
        "count": len(all_hits),
        "opportunities": all_hits,
    }
    out_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False))
    log(f"wrote {len(all_hits)} opportunities to {out_path}")
    return {
        "status": "ok",
        "out_path": str(out_path),
        "count": len(all_hits),
        "nb_hits_total_in_index": nb_total,
        "query": query,
        "source": source,
        "start_page": start_page,
    }


def search_via_browser(
    query: str,
    max_hits: int,
    out_dir: Path,
    cfg: dict,
    chromium: bool,
    start_page: int = 0,
) -> dict:
    from qwoted_browser import (
        SOURCE_REQUESTS_URL,
        algolia_query_in_page,
        connect_or_launch,
        harvest_algolia_from_page,
        snapshot_session,
    )

    session = connect_or_launch(chromium=chromium)
    try:
        if "source_requests" not in (session.page.url or ""):
            log(f"opening {SOURCE_REQUESTS_URL} in Chrome")
            session.page.goto(SOURCE_REQUESTS_URL, wait_until="domcontentloaded", timeout=60_000)
            jitter_sleep(1.5, 4.0, "after loading opportunities page")
        creds = load_algolia_credentials() or harvest_algolia_from_page(session)
        if not creds:
            raise RuntimeError(
                "Could not harvest Algolia keys from the Chrome page. "
                "Make sure you are logged in, then run qwoted_login.py --browse."
            )
        snapshot_session(session, mark_login=False)

        hits_per_page = max(1, int(cfg.get("hits_per_page") or HITS_PER_PAGE))

        def fetch_page(page: int) -> dict:
            return algolia_query_in_page(session, creds, query, page, hits_per_page)

        all_hits, nb_total, pages_fetched = _collect_hits(
            fetch_page, query, max_hits, cfg, start_page=start_page
        )
        return _write_out(
            query, creds, all_hits, nb_total, pages_fetched, out_dir, "chrome-algolia",
            start_page=start_page,
        )
    finally:
        session.close()


def search_via_cached_http(
    query: str,
    max_hits: int,
    out_dir: Path,
    cfg: dict,
    allow_html_fetch: bool,
    start_page: int = 0,
) -> dict:
    creds = load_algolia_credentials()
    if creds is None and allow_html_fetch:
        log("WARNING: --http fetching /source_requests with Python requests (cookie replay)")
        creds = _fetch_algolia_credentials_http()
    if creds is None:
        raise PermissionError(
            "No cached Algolia creds. Run `python3 qwoted_login.py --browse` "
            "while logged in, or pass --http to cookie-replay /source_requests "
            "(that path is what tripped Qwoted before)."
        )

    hits_per_page = max(1, int(cfg.get("hits_per_page") or HITS_PER_PAGE))

    def fetch_page(page: int) -> dict:
        return _algolia_query_http(creds, query, page, hits_per_page)

    all_hits, nb_total, pages_fetched = _collect_hits(
        fetch_page, query, max_hits, cfg, start_page=start_page
    )
    source = "cached-algolia" if not allow_html_fetch else "http-algolia"
    return _write_out(
        query, creds, all_hits, nb_total, pages_fetched, out_dir, source,
        start_page=start_page,
    )


def main(argv: list[str] | None = None) -> int:
    cfg = load_config()
    p = argparse.ArgumentParser(description="Search Qwoted opportunities.")
    p.add_argument("--query", default="", help="Search term. Required unless --dump-index.")
    p.add_argument(
        "--max-hits",
        type=int,
        default=int(cfg["default_max_hits"]),
        help=f"Max opportunities (default {cfg['default_max_hits']}, cap {cfg['max_hits_cap']}).",
    )
    p.add_argument("--out-dir", default=None)
    p.add_argument(
        "--http",
        action="store_true",
        help="Cookie-replay /source_requests + Python Algolia. Opt-in; worse fingerprint.",
    )
    p.add_argument(
        "--via-browser",
        action="store_true",
        help="Force the Chrome path even if prefer_browser_search is false in config.",
    )
    p.add_argument("--chromium", action="store_true", help="Use Playwright Chromium (not recommended).")
    p.add_argument("--skip-warm-check", action="store_true")
    p.add_argument("--skip-login-wait", action="store_true")
    p.add_argument(
        "--dump-index",
        action="store_true",
        help="Allow empty --query (full index). Do not use on a fresh account.",
    )
    p.add_argument(
        "--start-page",
        type=int,
        default=0,
        help="Algolia page to start from (0 = first 20). Use 1 for the next 20, etc.",
    )
    args = p.parse_args(argv)

    query = args.query
    if not query and not args.dump_index:
        result_line({
            "status": "error",
            "error": "Refusing empty --query. Pass a real term, or --dump-index on a warmed account.",
        })
        return 2

    cap = int(cfg["max_hits_cap"])
    max_hits = min(max(1, args.max_hits), cap)
    if args.max_hits > cap:
        log(f"clamping --max-hits {args.max_hits} → {cap}")

    blocked = search_preflight(
        skip_warm=args.skip_warm_check,
        skip_login_wait=args.skip_login_wait,
    )
    if blocked is not None:
        result_line(blocked)
        return 2

    limited = enforce_search_rate_limit()
    if limited is not None:
        log(f"RATE LIMITED: {limited['error']}")
        result_line(limited)
        return 2

    jitter_sleep(cfg["pre_search_jitter_min_s"], cfg["pre_search_jitter_max_s"], "pre-search")

    out_dir = Path(args.out_dir) if args.out_dir else opportunities_dir()
    out_dir.mkdir(parents=True, exist_ok=True)

    use_browser = (args.via_browser or cfg["prefer_browser_search"]) and not args.http
    log(
        "starting Qwoted search",
        query=query,
        max_hits=max_hits,
        start_page=args.start_page,
        via_browser=use_browser,
        http=args.http,
    )

    try:
        if use_browser:
            try:
                result = search_via_browser(
                    query, max_hits, out_dir, cfg, chromium=args.chromium,
                    start_page=args.start_page,
                )
            except Exception as e:
                log(f"browser search failed ({e}); falling back to cached Algolia if available")
                result = search_via_cached_http(
                    query, max_hits, out_dir, cfg, allow_html_fetch=False,
                    start_page=args.start_page,
                )
        else:
            result = search_via_cached_http(
                query, max_hits, out_dir, cfg, allow_html_fetch=args.http,
                start_page=args.start_page,
            )
    except PermissionError as e:
        log(f"AUTH FAILED: {e}")
        result_line({"status": "error", "error": str(e)})
        return 1
    except Exception as e:
        log(f"ERROR: {e}")
        result_line({"status": "error", "error": str(e)})
        return 1

    result_line(result)
    return 0


if __name__ == "__main__":
    sys.exit(main())
