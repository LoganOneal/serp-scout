"""
Qwoted login — real Chrome, isolated profile, cookie snapshot.

Preferred:
    python3 qwoted_login.py --start-chrome
    # sign up / sign in in THAT window, fill your Source profile, click around
    python3 qwoted_login.py --browse

`--start-chrome` launches Google Chrome with a dedicated user-data-dir
and DevTools on port 9333. Later scripts attach over CDP instead of
using Playwright's bundled Chromium (the fingerprint that got an
account disabled on 2026-07-03).

`--browse` attaches, opens /source_requests, waits until you are logged
in, snapshots cookies + the real user-agent, and harvests Algolia keys
from the page HTML so search does not need a Python GET to Qwoted.
"""

from __future__ import annotations

import argparse
import shutil
import sys
import time
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from qwoted_common import (  # noqa: E402
    load_cookies,
    log,
    qwoted_home,
    result_line,
    session_file,
)
from qwoted_browser import (  # noqa: E402
    LOGIN_URL,
    SOURCE_REQUESTS_URL,
    chrome_profile_dir,
    chromium_profile_dir,
    connect_or_launch,
    harvest_algolia_from_page,
    is_logged_in_url,
    snapshot_session,
    start_chrome,
)

DEFAULT_LOGIN_TIMEOUT_S = 300


def _cookies_on_disk() -> bool:
    return bool(load_cookies())


def run_start_chrome() -> dict:
    info = start_chrome(url=LOGIN_URL)
    print("\n" + "=" * 70, file=sys.stderr)
    print(
        "  Chrome is open with an isolated Qwoted profile.\n"
        "  Sign up / log in IN THAT WINDOW, then fill your Source profile\n"
        "  in the Qwoted UI and click around opportunities for a few minutes.\n"
        "  Leave Chrome open. When you're done:\n"
        "      python3 qwoted_login.py --browse\n",
        file=sys.stderr,
    )
    print("=" * 70 + "\n", file=sys.stderr)
    return info


def _wait_until_logged_in(session, timeout_s: int) -> bool:
    deadline = time.time() + timeout_s
    last_logged_url = None
    next_status_log = time.time() + 5.0
    while time.time() < deadline:
        try:
            current = session.page.url
            if is_logged_in_url(current):
                return True
            if time.time() >= next_status_log:
                if current != last_logged_url:
                    log(f"  waiting... Chrome is on: {current}")
                    last_logged_url = current
                else:
                    log(f"  still waiting on: {current}")
                next_status_log = time.time() + 5.0
        except Exception:
            pass
        time.sleep(1.0)
    return False


def run_interactive(
    *,
    browse: bool,
    force: bool,
    reset: bool,
    headless: bool,
    chromium: bool,
    timeout_s: int,
) -> bool:
    if reset:
        for folder in (chrome_profile_dir(), chromium_profile_dir()):
            if folder.exists():
                log(f"--reset: wiping {folder}")
                shutil.rmtree(folder)
                folder.mkdir(parents=True, exist_ok=True)
        try:
            session_file().unlink()
        except FileNotFoundError:
            pass

    if not reset and not force and not browse and _cookies_on_disk():
        log(
            "cookie jar already exists — skipping browser. "
            "Use --browse to snapshot from the live Chrome window, "
            "--force to re-open, --reset to wipe."
        )
        return True

    session = connect_or_launch(headless=headless, chromium=chromium)
    try:
        target = SOURCE_REQUESTS_URL if browse else LOGIN_URL
        log(f"opening {target}")
        try:
            session.page.goto(target, wait_until="domcontentloaded", timeout=60_000)
        except Exception as e:
            log(f"ERROR navigating: {e}")
            return False

        time.sleep(2.0)
        if is_logged_in_url(session.page.url):
            log(f"already logged in at {session.page.url}")
        else:
            if headless:
                log("ERROR: --headless but not logged in. Re-run headed.")
                return False
            print("\n" + "=" * 70, file=sys.stderr)
            print(
                "  Sign in to Qwoted IN THIS Chrome window (not your daily Chrome).\n"
                f"  Timeout: {timeout_s}s.",
                file=sys.stderr,
            )
            print("=" * 70 + "\n", file=sys.stderr)
            if not _wait_until_logged_in(session, timeout_s):
                log(f"ERROR: did not detect login within {timeout_s}s")
                return False
            log(f"detected logged-in URL: {session.page.url}. Settling...")
            time.sleep(3.0)

        if browse:
            if "source_requests" not in (session.page.url or ""):
                session.page.goto(
                    SOURCE_REQUESTS_URL, wait_until="domcontentloaded", timeout=60_000
                )
                time.sleep(2.0)
            print("\n" + "=" * 70, file=sys.stderr)
            print(
                "  Click around opportunities in this window like a normal user.\n"
                "  This script will snapshot cookies + Algolia keys in 20s\n"
                "  (or sooner if the search page is already loaded).",
                file=sys.stderr,
            )
            print("=" * 70 + "\n", file=sys.stderr)
            time.sleep(20.0)

        snapshot_session(session, mark_login=True)
        if browse:
            harvest_algolia_from_page(session)
        return True
    finally:
        session.close()


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        description="Log into Qwoted via real Chrome and snapshot the session."
    )
    p.add_argument(
        "--start-chrome",
        action="store_true",
        help="Launch isolated Google Chrome with DevTools on port 9333 and exit. "
             "Sign in there, then run --browse.",
    )
    p.add_argument(
        "--browse",
        action="store_true",
        help="Attach to that Chrome, open /source_requests, snapshot cookies "
             "and harvest Algolia keys from the page (no Python GET to Qwoted).",
    )
    p.add_argument(
        "--chromium",
        action="store_true",
        help="LAST RESORT: Playwright bundled Chromium. This is the fingerprint "
             "that triggered a disable on 2026-07-03.",
    )
    p.add_argument("--headless", action="store_true")
    p.add_argument(
        "--reset",
        action="store_true",
        help="Wipe the isolated Chrome profile and cookie jar.",
    )
    p.add_argument(
        "--force",
        action="store_true",
        help="Open/attach even if a cookie jar already exists.",
    )
    p.add_argument("--timeout", type=int, default=DEFAULT_LOGIN_TIMEOUT_S)
    args = p.parse_args(argv)

    log("qwoted_login", home=str(qwoted_home()), start_chrome=args.start_chrome, browse=args.browse)

    try:
        if args.start_chrome:
            info = run_start_chrome()
            result_line({"status": "chrome_ready", **info})
            return 0
        ok = run_interactive(
            browse=args.browse,
            force=args.force,
            reset=args.reset,
            headless=args.headless,
            chromium=args.chromium,
            timeout_s=args.timeout,
        )
    except Exception as e:
        log(f"FAILED: {e}")
        result_line({"status": "error", "error": str(e)})
        return 1

    if ok:
        result_line({
            "status": "logged_in",
            "cookie_jar": str(session_file()),
            "home": str(qwoted_home()),
        })
        return 0
    result_line({"status": "error", "error": "login failed; see logs above"})
    return 1


if __name__ == "__main__":
    sys.exit(main())
