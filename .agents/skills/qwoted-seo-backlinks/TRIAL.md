# How to trial this skill without repeating the 2026-07-03 disable

Throwaway Qwoted accounts are fine. The old `~/.qwoted` Playwright
profile is not — do not reuse it.

## 1. Isolated home

```bash
cd .agents/skills/qwoted-seo-backlinks
python3 -m pip install -r requirements.txt
playwright install chromium   # only needed for the --chromium fallback

export QWOTED_HOME="$HOME/.qwoted-trial-1"
# optional for a brand-new account you are willing to burn:
# export QWOTED_SKIP_LOGIN_WAIT=1
```

## 2. Real Chrome, not Playwright Chromium

```bash
python3 qwoted_login.py --start-chrome
```

A dedicated Chrome window opens (profile under `$QWOTED_HOME/chrome-profile`,
DevTools on port 9333). In **that** window:

1. Sign up / log in.
2. Create your Source persona in the Qwoted UI (name, bio, site URL).
3. Click around opportunities for a few minutes like a normal user.
4. Leave Chrome open.

Then:

```bash
python3 qwoted_login.py --browse
```

That snapshots cookies + the real user-agent and harvests Algolia keys
from the page. It does not GET `/source_requests` from Python.

Confirm the profile:

```bash
python3 qwoted_profile.py --action get
```

## 3. One search

Default: Chrome-path Algolia, `--max-hits 20`, 90s minimum gap, 6
searches per hour, 8–25s jitter, refuses empty query, refuses search
if no Source is on file or login was < 1 hour ago.

```bash
python3 qwoted_search.py --query "privacy" --max-hits 20
```

If you are on a throwaway account and just filled the profile:

```bash
QWOTED_SKIP_LOGIN_WAIT=1 python3 qwoted_search.py --query "privacy" --max-hits 20
```

Do not loop. Do not `--http` unless you are deliberately testing the
old cookie-replay path on an account you can lose.

## 4. Pitch later

Default writes `~/.qwoted-trial-1/drafts/*.json` and hits Qwoted **zero
times**. `--create-draft` opens a server draft. `--send` notifies the
journalist — only when you name the opportunity ID.

```bash
python3 qwoted_pitch.py --source-request-id 123 --pitch-text-file /tmp/p.txt
```

## Tunables

Copy into `$QWOTED_HOME/config.json` or set env vars. Defaults live in
`qwoted_common.py` (`DEFAULT_CONFIG`).

| Key / env | Default | Meaning |
|-----------|---------|---------|
| `min_seconds_between_searches` / `QWOTED_MIN_SEARCH_INTERVAL` | 90 | Gap between searches |
| `max_searches_per_window` / `QWOTED_MAX_SEARCHES_PER_WINDOW` | 6 | Cap per window |
| `rate_window_seconds` / `QWOTED_RATE_WINDOW_SECONDS` | 3600 | Window length |
| `min_seconds_after_login_before_search` / `QWOTED_LOGIN_WAIT` | 3600 | Warm-up after scripted login |
| `QWOTED_SKIP_LOGIN_WAIT=1` | off | Skip that wait (throwaway only) |
| `QWOTED_SKIP_WARM_CHECK=1` | off | Search without a Source on file |
| `prefer_browser_search` | true | Algolia via live Chrome |
| `algolia_ttl_seconds` | 21600 | Reuse harvested keys for 6h |

## If the account gets disabled again

Stop. Note which command you ran (`--start-chrome` / `--browse` /
`--http` / `--create-draft` / `--send`). That is the data we need to
tighten the next lever. Do not immediately retry on the same persona.
