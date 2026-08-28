"""
Real-Chrome session for Qwoted.

Preferred path: the user runs Chrome with an isolated profile and a
DevTools port (`qwoted_login.py --start-chrome`). Scripts then attach
over CDP so traffic comes from a real Chrome binary, not Playwright's
bundled Chromium.

Fallback: Playwright `channel="chrome"` persistent context (still a
real Chrome binary, still isolated from the user's daily profile).
Playwright Chromium is last resort (`--chromium`).
"""

from __future__ import annotations

import os
import shutil
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from qwoted_common import (
    FALLBACK_USER_AGENT,
    QWOTED_BASE,
    iso_now,
    load_config,
    log,
    parse_algolia_credentials,
    patch_client,
    qwoted_home,
    save_algolia_credentials,
    session_file,
)

LOGIN_URL = f"{QWOTED_BASE}/users/sign_in"
SOURCE_REQUESTS_URL = f"{QWOTED_BASE}/source_requests"
CHROME_PROFILE_DIRNAME = "chrome-profile"
LEGACY_CHROMIUM_PROFILE = "chromium-profile"


def chrome_profile_dir() -> Path:
    p = qwoted_home() / CHROME_PROFILE_DIRNAME
    p.mkdir(parents=True, exist_ok=True)
    return p


def chromium_profile_dir() -> Path:
    p = qwoted_home() / LEGACY_CHROMIUM_PROFILE
    p.mkdir(parents=True, exist_ok=True)
    return p


def cdp_port() -> int:
    return int(load_config()["cdp_port"])


def cdp_endpoint() -> str:
    override = os.environ.get("QWOTED_CDP_URL")
    if override:
        return override.rstrip("/")
    return f"http://127.0.0.1:{cdp_port()}"


def chrome_executable() -> Path | None:
    candidates = [
        Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
        Path("/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary"),
        Path("/Applications/Chromium.app/Contents/MacOS/Chromium"),
    ]
    for path in candidates:
        if path.exists():
            return path
    for name in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser"):
        found = shutil.which(name)
        if found:
            return Path(found)
    return None


def cdp_is_up(url: str | None = None, timeout: float = 1.0) -> bool:
    endpoint = url or cdp_endpoint()
    try:
        urllib.request.urlopen(f"{endpoint}/json/version", timeout=timeout)
        return True
    except (urllib.error.URLError, TimeoutError, OSError):
        return False


def start_chrome(*, url: str = LOGIN_URL) -> dict[str, Any]:
    exe = chrome_executable()
    if exe is None:
        raise FileNotFoundError(
            "Google Chrome not found. Install Chrome, or pass --chromium "
            "to use Playwright's bundled browser (worse fingerprint)."
        )
    port = cdp_port()
    profile = chrome_profile_dir()
    if cdp_is_up():
        log(f"Chrome CDP already up at {cdp_endpoint()}")
        return {
            "status": "already_running",
            "cdp": cdp_endpoint(),
            "profile": str(profile),
            "executable": str(exe),
        }
    cmd = [
        str(exe),
        f"--remote-debugging-port={port}",
        f"--user-data-dir={profile}",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-sync",
        url,
    ]
    log("launching Chrome", cmd=cmd)
    subprocess.Popen(
        cmd,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    for _ in range(40):
        if cdp_is_up():
            return {
                "status": "started",
                "cdp": cdp_endpoint(),
                "profile": str(profile),
                "executable": str(exe),
            }
        time.sleep(0.25)
    raise TimeoutError(
        f"Chrome launched but CDP did not come up on port {port}. "
        "Close other Chrome instances using that profile and retry."
    )


def _import_playwright():
    try:
        from playwright.sync_api import sync_playwright
        return sync_playwright
    except ImportError:
        raise RuntimeError(
            "Playwright is not installed.\n"
            "    pip install playwright\n"
            "    playwright install chromium"
        )


def is_logged_in_url(url: str) -> bool:
    try:
        path = urlparse(url).path or "/"
    except Exception:
        return False
    if path.startswith("/users/sign_in"):
        return False
    if path.startswith("/users/password"):
        return False
    return True


@dataclass
class BrowserSession:
    playwright: Any
    context: Any
    page: Any
    via_cdp: bool
    channel: str

    def close(self) -> None:
        if self.via_cdp:
            try:
                self.playwright.stop()
            except Exception:
                pass
            return
        try:
            self.context.close()
        except Exception:
            pass
        try:
            self.playwright.stop()
        except Exception:
            pass


def connect_or_launch(
    *,
    headless: bool = False,
    chromium: bool = False,
) -> BrowserSession:
    sync_playwright = _import_playwright()
    pw = sync_playwright().start()

    if not chromium and cdp_is_up():
        log(f"attaching to Chrome over CDP {cdp_endpoint()}")
        browser = pw.chromium.connect_over_cdp(cdp_endpoint())
        context = browser.contexts[0] if browser.contexts else browser.new_context()
        page = context.pages[0] if context.pages else context.new_page()
        return BrowserSession(pw, context, page, True, "chrome-cdp")

    if chromium:
        log("WARNING: launching Playwright Chromium — this fingerprint got an account disabled")
        context = pw.chromium.launch_persistent_context(
            user_data_dir=str(chromium_profile_dir()),
            headless=headless,
            viewport={"width": 1280, "height": 900},
            args=["--no-first-run", "--no-default-browser-check"],
        )
        page = context.pages[0] if context.pages else context.new_page()
        return BrowserSession(pw, context, page, False, "playwright-chromium")

    log("launching persistent Google Chrome (isolated Qwoted profile)")
    try:
        context = pw.chromium.launch_persistent_context(
            user_data_dir=str(chrome_profile_dir()),
            channel="chrome",
            headless=headless,
            viewport={"width": 1280, "height": 900},
            args=["--no-first-run", "--no-default-browser-check"],
        )
    except Exception as e:
        pw.stop()
        raise RuntimeError(
            f"Could not launch Google Chrome ({e}). Install Chrome, run "
            "`python3 qwoted_login.py --start-chrome`, or pass --chromium."
        ) from e
    page = context.pages[0] if context.pages else context.new_page()
    return BrowserSession(pw, context, page, False, "playwright-chrome")


def snapshot_session(session: BrowserSession, *, mark_login: bool = False) -> dict[str, Any]:
    try:
        session.context.storage_state(path=str(session_file()))
        log(f"saved cookie jar to {session_file()}")
    except Exception as e:
        log(f"ERROR saving cookie jar: {e}")
        raise

    ua = FALLBACK_USER_AGENT
    try:
        ua = session.page.evaluate("() => navigator.userAgent")
    except Exception as e:
        log(f"WARNING: could not read navigator.userAgent: {e}")

    updates: dict[str, Any] = {
        "user_agent": ua,
        "login_method": session.channel,
        "via_cdp": session.via_cdp,
        "last_url": session.page.url,
    }
    if mark_login:
        updates["logged_in_at"] = iso_now()
    return patch_client(updates)


def harvest_algolia_from_page(session: BrowserSession) -> dict[str, str] | None:
    html = session.page.content()
    creds = parse_algolia_credentials(html)
    if creds:
        save_algolia_credentials(creds)
        log("harvested Algolia creds from live Chrome page (no Python GET)")
    else:
        log("WARNING: this page did not contain Algolia search props")
    return creds


def algolia_query_in_page(
    session: BrowserSession,
    creds: dict[str, str],
    query: str,
    page: int,
    hits_per_page: int,
) -> dict[str, Any]:
    """Run the Algolia query inside the live page so TLS/UA/referer are Chrome's."""
    encoded = (
        f"query={urllib.parse.quote(query or '')}"
        f"&hitsPerPage={hits_per_page}&page={page}"
    )
    return session.page.evaluate(
        """async ({appId, searchKey, indexName, params}) => {
            const url = `https://${appId}-dsn.algolia.net/1/indexes/${indexName}/query`;
            const res = await fetch(url, {
                method: "POST",
                headers: {
                    "X-Algolia-API-Key": searchKey,
                    "X-Algolia-Application-Id": appId,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ params }),
            });
            if (!res.ok) {
                const text = await res.text();
                throw new Error(`Algolia ${res.status}: ${text.slice(0, 300)}`);
            }
            return await res.json();
        }""",
        {
            "appId": creds["app_id"],
            "searchKey": creds["search_key"],
            "indexName": creds["index_name"],
            "params": encoded,
        },
    )
