"""Real-browser fallback fetch for research_tools.py.

Used only when the plain HTTP fetch was refused (401/403/429), hit an
interstitial, or returned a JavaScript shell with almost no text. It renders
the page in the locally installed Google Chrome (headless, its own default
user agent) and returns the final HTML and text.

Rules it keeps:
- robots.txt is still checked by the caller before any fetch.
- No CAPTCHA solving, no stealth plugins, no user-agent spoofing, no clicks.
  If a challenge or CAPTCHA page is still showing after the page settles, the
  result stays "challenge" and the caller records it and moves on.

One browser per worker thread (Playwright's sync API is not thread-safe).
Enable with HHT_BROWSER_FALLBACK=1 or research_tools.py --browser.
"""

from __future__ import annotations

import atexit
import os
import re
import threading

CHALLENGE = re.compile(
    r"just a moment|verify you are human|verifying that you|enable javascript and cookies to continue|"
    r"checking your browser|robot challenge|are you a robot|captcha|attention required",
    re.I,
)
SETTLE_MS = int(os.environ.get("HHT_BROWSER_SETTLE_MS", 2500))
NAV_TIMEOUT_MS = int(os.environ.get("HHT_BROWSER_TIMEOUT_MS", 25000))

_local = threading.local()
_all: list = []
_lock = threading.Lock()


def enabled() -> bool:
    return os.environ.get("HHT_BROWSER_FALLBACK", "") not in ("", "0", "false")


def _browser():
    if getattr(_local, "browser", None) is None:
        from playwright.sync_api import sync_playwright

        pw = sync_playwright().start()
        channel = os.environ.get("HHT_BROWSER_CHANNEL", "chrome")
        browser = pw.chromium.launch(channel=channel or None, headless=True)
        _local.pw, _local.browser = pw, browser
        with _lock:
            _all.append((pw, browser))
    return _local.browser


@atexit.register
def _close_all() -> None:
    with _lock:
        for pw, browser in _all:
            try:
                browser.close()
                pw.stop()
            except Exception:
                pass
        _all.clear()


def fetch(url: str) -> dict:
    """Render url. Returns {status, content_type, html, final_url, result, error}."""
    try:
        context = _browser().new_context(java_script_enabled=True)
    except Exception as exc:  # browser could not start
        return {"result": "browser_unavailable", "error": str(exc)}
    page = context.new_page()
    try:
        response = page.goto(url, wait_until="domcontentloaded", timeout=NAV_TIMEOUT_MS)
        try:
            page.wait_for_load_state("networkidle", timeout=SETTLE_MS * 4)
        except Exception:
            page.wait_for_timeout(SETTLE_MS)
        status = response.status if response else None
        content_type = (response.headers.get("content-type") if response else None) or ""
        if "html" in content_type or not content_type:
            html = page.content()
        else:
            html = response.text()
        text = page.inner_text("body") if "html" in content_type or not content_type else html
        if status in (401, 403, 429, 451):
            result = "access_denied"
        elif status in (404, 410):
            result = "404"
        elif status and status >= 400:
            result = "error"
        elif CHALLENGE.search(page.title() or "") or CHALLENGE.search(text[:3000]):
            result = "challenge"
        else:
            result = "ok"
        return {"status": status, "content_type": content_type, "html": html,
                "final_url": page.url, "result": result}
    except Exception as exc:
        return {"result": "error", "error": str(exc)[:500]}
    finally:
        try:
            context.close()
        except Exception:
            pass
