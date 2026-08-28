# Learnings from the 2026-07-03 Qwoted run

Read this file before running any script in this skill. It is local to
serp-scout. The upstream playbook in `SKILL.md` still pushes speed and
volume; that playbook is what got an account disabled.

Source conversation: [Icelake carousel + Qwoted run](3294b196-bb4a-4d3f-ab5f-be19f2b44e1c)
(Cursor chat originally titled "Model carousel logo issue", in
`icelake-client`, 3 July 2026.)

---

## What happened

The Qwoted skill was installed and run inside the **Icelake marketing
repo**, in the **same Cursor chat** that had just been doing carousel
icon fixes, a PR to `dev`, and mobile layout work. That mixing is part
of the failure, not a footnote.

### Timeline (CDT, 3 July 2026)

| Time | Event |
|------|--------|
| 1:12–2:30 PM | Unrelated Icelake marketing work (carousel logos, mobile CSS, PRs into `dev`) |
| 4:43 PM | User asks if a Claude Code skill can run in Cursor |
| 4:45 PM | User: create branch `qwoted`; install `Bomx/qwoted-seo-backlinks-skill` after a security review |
| 4:48 PM | User: "set me up on qwoted now" |
| ~4:48–5:15 PM | Playwright Chromium login. First attempt timed out (5 min, no sign-in). Chromium crashed. |
| 5:15 PM | User: "try again. Looks like the chromium window crashed" |
| 5:18 PM | User: "now we're logged in. Can you just go ahead and start identifying pitch opportunities now?" |
| 5:20:16–5:21:34 PM | Agent ran **20 Algolia searches in ~78 seconds** via bash `for` loops |
| 5:21 PM | Agent presented 153 "tech-relevant" opportunities and a shortlist of 6 |
| 5:34 PM | User: Qwoted email — **"Your account has been temporarily disabled."** Contact `support@qwoted.com`. |

No pitches were sent. There is no `sent_pitches.json`. The expert
profile was never created — the user was asked for name/email/bio and
skipped ahead to search. Session cookies and a Playwright Chromium
profile were written to `~/.qwoted/` and are still there.

The skill files were copied to
`icelake-client/.agents/skills/qwoted-seo-backlinks/` but **never
committed**. The `qwoted` git branch is just the marketing branch it
was cut from. The skill later disappeared from that working tree.

### The 20 searches (UTC timestamps on the JSON dumps)

Each `qwoted_search.py` call also GETs `app.qwoted.com/source_requests`
to scrape Algolia keys, then hits Algolia. Twenty of those in 78
seconds is what the anti-bot system saw.

First burst (`--max-hits 15`):

- 22:20:16 `AI privacy`
- 22:20:18 `generative AI`
- 22:20:20 `ChatGPT`
- 22:20:21 `artificial intelligence`
- 22:20:22 `AI chatbot`
- 22:20:25 `data privacy technology`

Probe:

- 22:20:55 `AI` (`--max-hits 5`)

Second burst (`--max-hits 20`):

- 22:21:01 `privacy`
- 22:21:02 `technology`
- 22:21:03 `software`
- 22:21:05 `startup`
- 22:21:08 `cybersecurity`
- 22:21:09 `marketing AI`
- 22:21:10 `SaaS`

Third burst (`--max-hits 25`):

- 22:21:24 `ChatGPT`
- 22:21:26 `large language model`
- 22:21:28 `AI chat`
- 22:21:30 `data privacy`
- 22:21:32 `consumer AI`
- 22:21:34 `AI tools workplace`

Dumps remain at `~/.qwoted/opportunities/`. Do not re-run search
against a live account just to refresh them.

### Why Qwoted likely disabled the account

Not content, not pitches. Automation fingerprint + volume:

1. Login through **Playwright Chromium**, not a normal browser
2. Cookies written to `~/.qwoted/storage_state.json` and reused by
   headless `requests`
3. **20 scripted searches in 78 seconds**, each fetching the logged-in
   app page plus Algolia
4. User-agent string in `qwoted_common.py` is a generic Chrome UA, not
   the Playwright browser that just logged in
5. New-looking account + first session was entirely automated

The in-product copy was: "Our system automatically disables accounts
for various reasons." Timing matches the search burst, not a human
review of pitches (none were sent).

### Collateral damage in the Icelake chat

Same thread also:

- Cut `qwoted` off a dirty marketing branch (`newlanding`) instead of
  an isolated workspace
- Installed a PR/backlink scraper next to production marketing code
- Followed the skill's "you are running a 4-stage playbook, not a
  chatbot" rule, so "go ahead and start identifying" became a bulk
  scrape instead of one careful query
- Left Playwright Chromium running, then killed it to unblock the
  session file — more process-level weirdness on a brand-new login

Earlier in that same chat (before Qwoted), a "mobile-only" layout pass
rewrote desktop. Separate bug, same pattern: the agent over-executed a
vague "go" against a playbook that rewards speed.

---

## Rules this repo will follow

These override the upstream skill. `qwoted_search.py` now enforces the
rate limits in code. Do not work around them.

1. **Stop if the account is disabled or unhealthy.** No login, search,
   profile, or pitch scripts. Draft a support email if asked. Do not
   "just try one more query."
2. **One search per turn, then show results.** Never a `for q in ...`
   loop. Never 15 queries because the first list looked messy.
3. **Hard rate limit:** at least **60 seconds** between searches, at
   most **3 searches per 15 minutes**. The script exits `rate_limited`
   if you ignore this. There is no agent-facing bypass flag.
4. **Login in a real browser when possible.** Prefer the user signing
   in with their normal Chrome, then confirming the Qwoted UI still
   loads, before any scripted traffic. Playwright login is a last
   resort, in the user's own terminal, and **do not search in the same
   hour** after a Playwright login.
5. **Do not search on a brand-new session.** Finish Stage 1 (profile
   get/create with explicit field approval) and have the user click
   around the real site first.
6. **Never `--send` a pitch** unless the user names the opportunity ID
   and says to send that one. Dry-run is the default; keep it.
7. **Do not mix Qwoted work with product/marketing work.** This skill
   lives in serp-scout so Icelake (or any other app repo) is not on
   the table. Do not create stats pages inside unrelated apps. Do not
   commit `~/.qwoted/` cookies.
8. **Do not treat "go" / "just start" as permission to burst.** Propose
   **one** query, wait for the JSON, rank, then ask before a second
   query.
9. **If Chromium crashes or a login hangs,** stop. Do not `--reset`
   and immediately scrape. Tell the user to finish login themselves.
10. **Stats pages are optional and slow.** Do not start building HTML
    in a product repo because the upstream heuristic said `+6`.

---

## What to tell Qwoted support (if asked)

Keep it factual. Do not pretend it was normal browsing.

> I was testing a third-party helper that logged in via an automated
> browser and ran several opportunity searches. I believe that
> triggered your automated systems. I am a real source, I did not
> send pitches, and I will use the site manually. Please review and
> reinstate. Account email: [x].

---

## Local state still on this machine

| Path | What it is | Commit? |
|------|------------|---------|
| `~/.qwoted/storage_state.json` | Session cookies from the Playwright login | **Never** |
| `~/.qwoted/chromium-profile/` | Isolated Chromium profile | **Never** |
| `~/.qwoted/opportunities/*.json` | The 20 search dumps from 3 July | **Never** (stale; may contain reporter briefs) |

Wiping `~/.qwoted/chromium-profile` is fine. Do not reuse that
Playwright profile against a reinstated account. Treat
`storage_state.json` as a password.

---

## What we changed in serp-scout (2026-08-14)

Implemented so a new free account can be warmed without the old
fingerprint:

- Real Google Chrome via `--start-chrome` (isolated profile + CDP
  port 9333). `--browse` snapshots cookies and Algolia keys from the
  page. Playwright Chromium is `--chromium` last resort.
- Search defaults to in-page Algolia. Cached keys for 6 hours. No
  Python GET `/source_requests` unless `--http`.
- Caps: default 20 hits, hard cap 40, empty query refused, 90s gap,
  6 searches/hour, 8–25s pre-search jitter, 0.8–2.2s between pages.
- Warm gates: Source on file, wait 1 hour after scripted login
  (overridable on throwaways).
- Pitch default is a local JSON file. `--create-draft` / `--send`
  are explicit.
- `QWOTED_HOME` + `TRIAL.md` for throwaway isolation. Do not reuse
  `~/.qwoted` from this incident.

