# Plan: scale guest-post outreach to 60 email pitches/day

Status: **draft for review** · 2026-11-07 · scope: HotelHotTubs (HHT) now, kitchens next

Phase 1 covers discovery, processing, the backlog, model tiering and a
form-submission agent. Phase 2 is human-sounding article writing and is only
outlined here.

---

## 0. Tracker: every category and its next step

Updated 2026-11-08. Counts come from `Guest Post Master Tracker.xlsx` unless
noted. "Pitchable" means the site invites guest posts, is active and passed
every check (tracker verdict PURSUE).

### Backlog: sites already evaluated (5,108)

| # | Category | Count | What it means | Next step | Who | Status |
|---|---|---|---|---|---|---|
| B1 | Pitchable, email draft in outreach tool | live count in outreach app | Step 1 emails waiting in the outreach tool. Count is read live from the app (not a running total: many earlier drafts are already handled). Pushed 2026-11-08: 6 recovered (B8), 23 first-hand (B2), 20 clip redrafts (B3) | Send and follow up | Kai | Ongoing |
| B2 | Pitchable, needed first-hand experience | 33 | Site asked for proof the writer had been there | Done 2026-11-08: 23 email pitches pushed as step 1 drafts (fictional details, disclaimer line kept). The 9 form or unconfirmed-route ones stay in `HHT-firsthand-2026-11-07/drafts.md` | Kai sends | Pushed (23) |
| B3 | Pitchable, blocked on other materials | ~36 | Site wants clips, a resume, a bio or (rarely) photos | Done 2026-11-08: 38 redrafted with the 7 clips (`HHT-clips-redraft-2026-11-08/drafts.md`). 19 emails pushed as step 1 drafts (now in B1); 12 form pitches ready (now in B4); 90summers held (needs Claire's own no-AI statement); 4 still blocked (danaberez and theblondeabroad need original photos, roamingtheamericas inactive, escapebyroad no real email); Bustle and Afar skipped. AI-writing bans flagged in reviewer notes: audubon, thelocalpalate, phillymag | Kai sends | Done |
| B4 | Pitchable, form-only | 50 | Pitch goes through a website form, not email | Kai submits by hand for now; the browser form agent takes over later (section 6) | Kai, then form agent | Waiting |
| B5 | Pitchable, article-first (article drafted) | 49 | Site wants the finished article with the first contact | Kai reviews; Phase 2 rewrites for a human voice | Kai | Waiting on Phase 2 |
| B6 | Pitchable, "Not sent" judgment holds | 29 | Doubts such as a dormant site or conflicting rules | Quick re-triage: pitch, or close as skip | Claude | Not started |
| B7 | Masked email addresses | 32 | Address hidden from scrapers (Cloudflare, "name (at) site") | Done: 31 read in the browser (`exports/guest-post-outreach/unmasked-emails-2026-11-07.csv`). splendry.com shows a robot check, so Kai opens it by hand. These sites now move on with their B2 to B6 category | Kai for splendry.com | 31 of 32 done |
| B8 | Never decided: page wouldn't load | 886 | Bot walls, JavaScript-only pages, slow sites | Done. Re-fetched: 381 load, 505 set aside with a reason (`HHT-refetch-stuck-2026-11-07/refetch-results.csv`). Haiku on the 381: 13 pitchable, 2 paid-only, 15 review, 351 skip (`haiku-results.csv`). Opus check while drafting: 7 real. 6 emails pushed as step 1 drafts (now in B1); Appetito form answers in `HHT-recovered-2026-11-07/drafts.md` (now in B4). The 15 review sites: 11 have no page text (set aside), atlantamagazine, downeast, tucson, hipcamp need a look | Kai submits Appetito form | Done |
| B9 | Never decided: search or tool errors | 325 | Search rate limits and tool failures in old lanes | Done 2026-11-08 (`HHT-b9-rerun-2026-11-08/`): 317 load, 8 set aside. Haiku 4 pitchable, Opus downgraded all 4 plus travelscanvas (tip lines, ad sales, legal terms). 0 pitches. Tracker updated | n/a | Done, 0 yield |
| B10 | Never decided: genuinely unclear | ~70 | Ambiguous page or no route found | Second-opinion pass, then Kai | Claude, then Kai | Not started |
| B11 | Paid only | 25 | Only route is a paid sponsored post | Decided: skip | n/a | Closed |
| B12 | Skipped | ~3,600 | Failed a check (no invitation, closed, inactive and so on) | None | n/a | Closed |

### New discovery: finding and evaluating new sites

| # | Category | What it means | Next step | Who | Status |
|---|---|---|---|---|---|
| D1 | Keyword queue | Which searches we pull from Semrush | Built 2026-11-08: 24 templates across 5 buckets (travel, romance, weddings, wellness, lifestyle) × 300 metros, 50 states, 42 regions. `pnpm hht:opp guest-templates` previews; `--enqueue --limit=N` volume-checks (free) and queues for `guest-frontier`. Not yet run for real | Kai OKs first enqueue | Built |
| D2 | Search pulls (SERPs) | Top 100 results per keyword | Keep full 1–100 pulls (position analysis done, section 3.4) | Claude | Decided |
| D3 | Lookalike sites | Blogs similar to the 371 pitchable ones | Pilot run 2026-11-08 via the Semrush MCP: 40 seeds, 46,400 units (~3,600 of 50k left). 545 new guest_post leads → Haiku 5 PURSUE, 2 PAID_ONLY, 143 no page text → Opus kept 2 (belizehub email pushed, bolivianlife form drafted). Yield 0.4% vs ~3.6% for SERP discovery; candidates skew to restaurants, resorts and businesses | Kai: decide whether to keep spending on it | Pilot done, low yield |
| D4 | New topic areas for HHT | Romance, weddings, wellness, regional magazines | OK'd 2026-11-08: romance and couples, weddings and honeymoons, wellness and spa, regional magazines. Built into D1 as buckets | Claude | Approved |
| D5 | Evaluating new sites | Deciding pitchable or not | Decided Haiku. Now making it the skill's standard step (`classify_batch.py`, SKILL.md chain) | Claude | In progress |
| D6 | Routing new pitchable sites | Same buckets as B1 to B11 | Automatic once D5 is settled | Claude | Uses the existing skill today |
| D7 | Kitchens | Second vertical | Needs site, brand and persona from Kai, then a 30-keyword pilot (section 7) | Kai, then Claude | Waiting |
| D8 | Experiment: no-invitation publications | Active sites that don't invite guest posts (54% of evaluated leads) pitched another way: freelance pitch, add-to-article, expert source. Sponsored/paid excluded | Scoped pilot started 2026-11-09 (section 3.5): cap 15 emails/week, max 45 total, tracked as its own category | Claude runs, Kai reviews weekly | Started |

### Terms

- **Clip:** a published article with the writer's name on it, shared as a link
  to show an editor you can write. Claire has two:
  [Castles and Turrets](https://castlesandturrets.com/2026/10/05/ruthin-castle-hotel-spa-a-historic-castle-in-northern-wales/)
  and [10,000 Birds](https://www.10000birds.com/birds-and-bathwater-the-birds-youll-find-in-four-american-hot-spring-towns.htm).
  Her bylined posts on hotelhottubs.com count too.
- **Pitch-first vs. article-first:** whether the site wants an idea first or
  the finished article with the first contact.
- **Masked email:** an address shown in a form scrapers can't read. A browser
  reveals it.

---

## 1. Where we are (measured, not estimated)

Source: `exports/guest-post-outreach/Guest Post Master Tracker.xlsx` and
`keyword-yields-2026-11-04.csv`.

| Metric | Value |
|---|---|
| Domains evaluated (tracker rows) | 5,108 |
| PURSUE verdicts | 371 (≈7% of evaluated) |
| → step 1 email drafts in outreach tool | 184 (50% of PURSUE) |
| → blocked, missing materials (clips, photos, author email) | 69 |
| → article-first, drafted, awaiting review | 49 |
| → form-only, not submitted | 37 |
| → other (not sent, no email, dupes) | 32 |
| NEEDS_REVIEW / tooling failures, never resolved | ~1,300 (incl. FETCH_BLOCKED 728, SLOW_SITE_CAPPED 117, JS_RENDERED 37, search rate limits ~70) |
| Discovery keywords tried | 352 (234 fetched, **105 returned NO_DATA**, 12 exhausted) |
| Keywords with zero pitchable yield | 209 of 352 |
| Pitchable per fetched keyword | ≈1.0 overall, 1.3+ for the best templates |
| New domains per fetched keyword | 25 (Oct 21) → 15 (Nov 4), decaying |
| Best day | ~1,500 domains evaluated, ~55 pitchable |

**Best and worst keyword buckets** (pitchable per keyword):
`things to do in <city>` 1.35 · `weekend getaways from <city>` 1.33 ·
`<state> road trip` 0.93 · `weekend in <city>` 0.85 · broad travel 0.85 ·
packing lists 0.28 · getaway/hotel follow-ups 0.0–0.1 · write-for-us
footprints **0.0** (confirms the decision to retire them).

### What the numbers say

1. Discovery isn't short of SERPs. It's short of *the right* SERPs. 30% of
   keywords return no data, and 60% yield nothing pitchable. Destination
   templates (`things to do in X`, `weekend getaways from X`, `X road trip`)
   do 4–5× better than topic ideas like packing lists.
2. Processing loses about 25% of domains to fetch and tooling failures, and that
   isn't a judgment call. Most of it is bot walls, JS rendering, slow sites and
   the shared `web_search` rate limit.
3. Half of PURSUE sites never become an email draft. The cheapest wins are the
   **69 sites blocked on missing materials**, which one asset kit unblocks, and
   the **37 form-only sites**, which need the browser agent.

---

## 2. The 60/day math

Working backwards from 60 email drafts per day:

| Stage | Today's rate | Needed / day | With Phase 1 fixes |
|---|---|---|---|
| Email drafts | 50% of PURSUE | 60 | 60 |
| PURSUE | ~6% of evaluated | 120 | ~85 (email share → 70% via asset kit) |
| Domains evaluated | ~15 new per keyword | ~2,000 | ~1,200 (pitch rate → ~7% via better keywords and recovering failed fetches) |
| Keywords fetched | 1.0 pitchable / kw | ~120 | ~70 (template-selected, volume-checked) |

Sending capacity is a separate limit. There are two inboxes today, Claire and
Shelby. 60/day means about 30 new cold emails per inbox per day, plus
follow-ups. That's at the upper end of what a warmed mailbox tolerates. At a
conservative 15–20 each, two inboxes support 30–40/day, so reaching 60/day
probably needs a third or fourth mailbox or careful warm-up. Shelby's details
are still to come: persona, voice, and which sites she pitches versus Claire.

**Supply ceiling.** 352 keywords surfaced 6,280 unique domains, and the number
of new domains per keyword is already falling. At ~85 PURSUE/day, travel-only
SERPs could run dry within a few months. Section 3 addresses this with
lookalike expansion and adjacent verticals, so supply grows with demand.

---

## 3. Bottleneck 1: finding the right keywords

### 3.1 Template × entity generation (replaces most ad-hoc ideas)

The best buckets are all **template + place**. Make that explicit:

- `packages/core/src/hht-opp/guest-templates.ts`: templates such as
  `things to do in {city}`, `weekend getaways from {city}`, `{state} road trip`,
  `weekend in {city}`, `romantic getaways in {state}`, `{city} itinerary`,
  `hidden gems in {region}` and `day trips from {city}`.
- Entity lists already exist in the geography corpus (`pnpm ingest:geo`): the
  top ~300 US metros, 50 states and ~40 tourism regions. That's ~3,000+
  candidate keywords with no LLM involved.
- Each template carries a **running yield prior** (pitchable per keyword, new
  domains per keyword) from `hht_opp_guest_keywords`. The queue ranks
  candidates as *template prior × entity tourism weight × novelty*, where novelty
  is low when the keyword sits in a saturated SERP neighborhood. The existing
  `guestKeywordFetchDecision` already computes that.
- **Volume gate before Semrush.** Skip anything Google Ads reports as zero
  volume (`volumeIsZero` exists but the current seeds bypass it). This targets
  the 105 NO_DATA calls.
- Templates whose prior drops below ~0.3 after 10 fetches are retired
  automatically. Packing lists would have been retired after about 10 keywords
  instead of 71.

### 3.2 Lookalike expansion from the 371 PURSUE sites (new channel)

Pitchable blogs cluster, so sites similar to a PURSUE site are much more likely
to be pitchable than a random SERP domain. Three signals, all Semrush or
scraping, no footprints:

1. **Organic competitors** of each PURSUE domain (`domain_organic_organic`).
   Small travel blogs compete with other small travel blogs. The HHT BL pipeline
   already calls this report.
2. **Guest-author graph.** Guest authors on PURSUE sites usually list other
   sites they've written for in their bio. The `authors.ts` modules already
   extract bylines; add bio-link extraction.
3. **Outbound links and blogrolls** from PURSUE sites' "resources",
   "favorite blogs" and collaboration pages.

Expected hit rate: unknown until measured. Run 50 PURSUE seeds, then compare
pitchable per new domain against the SERP baseline (~3.6%). If it beats 2×,
make it a standing source.

### 3.3 Adjacent verticals for HHT (supply ceiling)

Travel is one audience for in-room hot tubs. These also fit HHT naturally:
romance and couples (anniversary and date ideas), weddings and honeymoons,
wellness and spa, regional and city lifestyle magazines (already producing
PURSUEs, for example arlingtonmagazine.com), and luxury lifestyle. Each is a
`bucket` with its own templates and topical regex. The `TRAVEL_BLOG` regex in
`guest-frontier.ts` becomes per-bucket configuration.

### 3.4 Measure SERP position

**Done (2026-11-07).** I joined 24,281 stored SERP rows against the tracker,
taking each domain's best position:

| Best position | Domains | PURSUE | PURSUE rate (decided rows) |
|---|---|---|---|
| 1–10 | 912 | 65 | 9.5% |
| 11–20 | 651 | 40 | 8.0% |
| 21–30 | 640 | 29 | 6.2% |
| 31–50 | 1,147 | 70 | 8.2% |
| 51–75 | 1,102 | 75 | 9.4% |
| 76–100 | 468 | 22 | 5.9% |

The pitch rate is flat by position, and positions 31–100 supply over half of
all PURSUE sites. Keep full 1–100 pulls. A shallower slice would roughly halve
yield per keyword.

---


### 3.5 Experiment: no-invitation publications (started 2026-11-09)

**Question.** Do active publications that don't invite guest posts convert well
enough by another route to be worth emails? Kai's prior: probably much worse
than guest posts, so this stays small until the numbers say otherwise.

**Channels** (classified by Haiku from page text we already have, no Semrush cost):
- `freelance_pitch`: the site takes pitches or story ideas from outside writers without calling them guest posts.
- `add_to_article`: an existing roundup (where to stay, romantic getaways, hot-tub hotels) could add one hotel and a link to Claire's guide.
- `expert_source`: the site quotes outside experts or runs roundups and interviews; Claire is offered as a source.
- Sponsored or paid placements are out of scope.

**Limits.** At most 15 experiment emails a week, never more than about 10% of
the week's guest-post drafts, and at most 45 in total. Never more than one
experiment email per domain. Only active sites (content within 6 months).

**Tracking.** A distinct category everywhere:
- Outreach campaign: "EXPERIMENT: add-to-article" (`d39441ed-9da2-4098-a87f-6a22af45ace0`), same inboxes and send window as guest posts, so reply rates show per campaign on /campaigns.
- Outreach payload: `contact.attributes.source = "hht-exp-noinvite"`, `attributes.channel = <channel>`, `batch = "EXP-noinvite-<date>"`.
- Tracker: `verdict = EXPERIMENT`, `code = EXP_<CHANNEL>`, `batch = EXP-noinvite-<date>`, so these rows never mix into guest-post counts.
- Results file: `exports/guest-post-outreach/EXP-noinvite-results.csv` (sent, reply, positive reply, placement, per channel), compared with guest-post drafts sent in the same weeks.

**Decision rule** (per channel, reviewed weekly with Kai):
- Kill: 0 positive replies after 15 sends.
- Keep testing: some positives, but under half the guest-post positive-reply rate.
- Scale: positive-reply rate at least half of guest posts after 15+ sends; then raise the cap.

**Weekly review** (Mondays, when Kai asks):
1. For each experiment email (from `EXP-noinvite-*/drafts/outreach-push-*/outreach-outcomes.json`) and each guest-post step 1 email pushed in the same weeks, read its status in the outreach app (pending review / sent / replied / bounced / rejected) and whether a reply is positive.
2. Refresh `EXP-noinvite-results.csv` (domain, channel, email_id, pushed, status, reply, positive, placement_url) and append a dated line per channel to `EXP-noinvite-weekly.md`.
3. Apply the decision rule above per channel and recommend; nothing changes without Kai.

**Week 1 (2026-11-09) channel sizing** from 378 no-invitation sites, Haiku on saved page text, no Semrush cost: add_to_article 38 (27 medium/high), expert_source 12 (mostly off-topic), freelance_pitch 6 (almost all newspaper news-tip lines), none 322. So the pilot starts with add_to_article only.

## 4. Bottleneck 2: processing pages

Today each 25-domain batch is a Claude Code lane that does fetching, web
search, judgment and writing in one long session. That design causes the
30-minute cancellations, the shared `web_search` rate limit, the hung
`send_message` lookups and the ~1,300 tooling failures.

### 4.1 Split the pipeline into a worker plus LLM calls

```
discover (Semrush) ─► dedupe/junk (deterministic) ─► fetch (HTTP → headless fallback)
   ─► extract signals (deterministic) ─► classify (Haiku, structured JSON)
   ─► escalate ambiguous (Sonnet) ─► PURSUE queue ─► write pitch (Opus/Sonnet, Claude Code)
   ─► push drafts (existing push_run_drafts.py) / form queue / article queue
```

- Move `research_tools.py` stages (seed, discover, variants) into the
  repo's existing worker/queue pattern (a `scan_runs`-style Postgres table, so
  no Redis) and let them run continuously, not in lanes.
- **Headless fetch fallback** (Playwright, real Chrome UA, still honoring
  robots, crawl-delay and per-host spacing) for FETCH_BLOCKED, JS_RENDERED and
  Cloudflare email masks. This is the main lever on the 728 + 37 failures.
  Don't bypass CAPTCHAs or access denials: those stay recorded as blocked.
- **Replace the in-session `web_search` call** with a SERP API query for the one
  `site:` search. Semrush can't do `site:`, so this needs a cheap search API
  such as Brave or Serper. That removes the ~30 s/call cost and the shared
  rate limit.
- Classification runs through the Claude API directly (Message Batches where
  latency doesn't matter) with a strict JSON schema mirroring Part A's fields:
  invitation, route, closed, staff-only, paid, region, last activity date,
  article-first vs pitch-first, email vs form, requirements.
- Claude Code sessions are kept only for writing and NEEDS_REVIEW exceptions.

**Target:** ~2,000 domains/day evaluated unattended, with NEEDS_REVIEW
below 8% (from ~25%).

### 4.2 Which work goes to cheaper models

| Task | Needs an LLM? | Model | Confidence |
|---|---|---|---|
| SERP fetching, dedupe, junk filter, robots, sitemap probing | **No**, deterministic code | none | Confirmed. Already deterministic today |
| Activity date extraction | Mostly no (date parsing); LLM only when no machine-readable date | Haiku | High |
| Region pre-screen | Rules + light LLM | Haiku | High |
| **Is this page an open invitation for outside writers?** (gates G1–G3, closed and staff traps) | Yes | **Haiku**, escalating low-confidence and fence cases to Sonnet | **Likely; must confirm with an eval** (below) |
| Requirements extraction (word count, links, fees, photos, bio, delivery) | Yes, structured extraction | Haiku → Sonnet on failure | Likely |
| Keyword template proposals for new verticals | Occasional | Sonnet | High |
| Angle selection and pitch writing | Yes, quality-critical | Opus (or Sonnet if blind review can't tell them apart) | Unchanged |
| Form mapping and filling (browser agent) | Yes | Sonnet | High |
| Full articles (Phase 2) | Yes | Opus | Unchanged |

**First result (2026-11-07, 182 of 196 sites, Haiku helper agents in-session):
Haiku fails as-is.** PURSUE recall was 37.5%, or 72% if escalations to
review count as caught. False PURSUE was 2.7%. Most misses are fixable:
13 "no route found" (masked or contact-page emails), 12 "insufficient
evidence" (the test's page window dropped the invitation page), and 9 wrong
"inactive" calls (date misreads; move date parsing into code). The real
judgment misses were 11 of 72. Next: fix those three issues, then rerun Haiku
and Sonnet on the same set. Full report:
`exports/guest-post-outreach/eval/results-haiku-agents.md`.

**Full comparison (2026-11-07, 450 sites, after fixes, in-session agents):**

| Model | Pitchable caught | False pitchable | Email vs. form | Pitch- vs. article-first |
|---|---|---|---|---|
| Haiku | 79.4% | 3.4% | 95.3% | 85.8% |
| Sonnet | 73.1% | 2.8% | 97.4% | 88.9% |
| Opus | 80.0% | 3.1% | 95.3% | 93.8% |

The models agree with each other on 93% to 94% of sites. 20 of 160 old
pitchable verdicts were rejected by all three, and on reading they are mostly
generous old calls rather than model errors. Decision: Haiku evaluates; the
Opus writing step confirms submission stage and route. Results:
`exports/guest-post-outreach/eval/v2/`.

**How to confirm the Haiku hand-off.** The 5,108 tracker rows are a labeled
dataset. Take a stratified sample of 400 (all PURSUE codes, the common SKIP
codes and fence cases), replay saved `evidence/<domain>/*.txt` through the Haiku
classifier and measure:

- PURSUE recall ≥ 95%. Missing a pitchable site is the costly error.
- False-PURSUE rate ≤ 10%. A cheap Sonnet second pass can catch these.
- Agreement on email vs form vs article-first ≥ 95%.

If Haiku misses the bar, use Haiku as a pre-filter that only removes obvious
SKIP_NO_INVITATION and SKIP_NOT_PUBLICATION cases (~55% of all rows), with
Sonnet judging the rest. Either way, the expensive model stops reading
thousands of homepages. Cost per evaluated domain will be computed from current
API pricing during the eval, not guessed here.

---

## 5. The backlog

| Bucket | Count | Action | Unblocked by |
|---|---|---|---|
| FETCH_BLOCKED / JS_RENDERED / SLOW_SITE_CAPPED | ~880 | Re-run through headless fetch + classifier | §4.1 |
| Tooling and search-limit failures | ~250 | Re-run `site:` search via SERP API + classifier | §4.1 |
| AMBIGUOUS_PAGE / NEEDS_REVIEW (true judgment) | ~70 | Sonnet second opinion, then Kai | §4.2 |
| Blocked: missing materials | 69 | **Claire asset kit** (below), then push | Kai |
| Form-only PURSUE | 37 | Browser agent with approval queue | §6 |
| Article-first, drafted | 49 | Review queue now; rewrite in Phase 2 | Kai / Phase 2 |
| "Draft pushed in error" in the Full Articles tab | 8 | Reject in `/review` (already flagged) | Kai |

**Asset kit (per persona: Claire, and Shelby once defined).** Counts below are
keyword matches over the 76 blocked rows' notes (rows can need several items),
so they're approximate. The headshot (8) and author email (2) are already
covered. They were never the main blockers.

| Item | Blocked rows | Notes |
|---|---|---|
| Published writing clips: 3–5 live bylined articles | ~55 | HHT blog posts with a byline and author page count. Each guest post that goes live becomes another clip. |
| Original photos we hold rights to | ~54 | Many sites ask for 8+ high-res photos per idea, taken by the writer. Hotel-supplied photos need written permission. |
| First-hand travel log: places actually visited, when, where stayed | ~50 (overlaps with clips) | Local and regional magazines want proven experience of the city. This lets us route a Seattle site only to someone who's really been there. |
| Bio in fixed lengths (25/50/100 words) and an author page URL | ~38 | Some forms demand an exact word count. |
| Short writing CV / background paragraph | ~29 | Freelance-style outlets ask for experience. |
| Business mailing address and phone for forms | ~9 | HHT's business details are fine. |
| Rate/terms policy for paying freelance outlets | a few (Bustle, Afar, Essence, Hawaii Magazine) | These are freelance journalism outlets, not guest-post blogs. Low odds and links are rarely allowed, so deprioritize. |

Backlog recovery could plausibly add 100+ PURSUE sites without spending any
new Semrush units. That's a guess until the re-run reports actual numbers.

---

## 6. Form submissions: a browser agent plus an approval queue in outreach

No separate tool is needed. Filling a form is a browser-agent job, the same
browser I already use for unmasking emails. The missing piece is approval, and
that belongs in the outreach tool as its own **Form outbound** section next to
the email drafts.

**Flow**

1. **Draft.** Evaluation writes the form answers (the same way it writes email
   pitches) and pushes them to the outreach tool's Form outbound section with
   the form URL, each field's answer and the site's rules. This needs a new
   endpoint or record type in the outreach app (a separate repo/deploy from
   this one).
2. **Approve.** Kai approves or edits each entry in Form outbound, the same way
   he approves email drafts.
3. **Submit.** A browser agent picks up approved entries, opens the form, fills
   each field, screenshots the filled form, submits it, and screenshots the
   confirmation page. Both screenshots and the outcome are written back to the
   outreach record and the tracker.
4. **Set aside, don't block.** A CAPTCHA, login wall, payment step or a
   required field with no honest answer marks the entry "needs a human" with
   the reason, and the agent moves to the next one.

**Limits:** never solve or bypass CAPTCHAs, never create accounts, and submit
once per domain (dedupe against outreach history).

**Backlog this clears:** 37 form-only sites plus the 8 form pitches in
`HHT-firsthand-2026-11-07`. Until it exists, Kai pastes the prepared answers.

---

## 7. Kitchens (and any later vertical)

The pipeline is hard-wired to HHT in four places. Make each one a **vertical
config** (`config/guest-post/<vertical>.yml`):

| Hard-wired today | Becomes |
|---|---|
| `TRAVEL_BLOG` / `OFF_TOPIC` regexes, seed keywords | Per-vertical topical rules and templates |
| Claire Bennett persona and playbook B | Per-vertical persona and writing guide |
| Outreach campaign `guest post outreach` | Per-vertical campaign and sending mailboxes |
| Tracker workbook, exclusions | Per-vertical tracker (shared global "already contacted" dedupe) |

Kitchen discovery will look different: home improvement, renovation, interior
design, cooking and food blogs, and real-estate and home lifestyle
publications. Templates would include `kitchen remodel ideas`,
`small kitchen ideas`, `{style} kitchen` and `{city} home renovation`. We should
run a 30-keyword pilot before committing.

---

## 8. Phase 2 (outline only)

Human-sounding articles for the 49+ article-first sites and higher-quality
pitches. Likely ingredients: Kai-written style exemplars, site-specific voice
matching from the two posts the playbook already reads, real HHT data and
first-hand details from the asset kit, a detector-independent human review
rubric, and a blind A/B of reply rates. Not designed here.

---

## 9. Sequencing

| Week | Deliverable | Exit check |
|---|---|---|
| 1 | Haiku classifier + eval on 400 labeled rows; position analysis (§3.4) | Recall/precision report; go/no-go on model tiering |
| 1 | Claire asset kit (Kai) | 69 blocked rows re-checked and pushed or still-blocked with reasons |
| 2 | Headless fetch + SERP-API `site:` search; backlog re-run | NEEDS_REVIEW < 8% on backlog; new PURSUE count |
| 2 | Template × entity generator with yield priors and volume gate | NO_DATA < 10%; ≥ 1.2 pitchable/kw on a 30-kw batch |
| 3 | Continuous worker (discover → classify → PURSUE queue); daily writing session | 30 drafts/day sustained for 3 days |
| 3 | Lookalike expansion pilot (50 seeds) | Pitch rate vs SERP baseline |
| 4 | Browser form agent with approval queue; clear the 37 form-only sites | 37 resolved (submitted or human-handoff) |
| 4 | Adjacent-vertical buckets for HHT; sending-mailbox capacity confirmed | 60 drafts/day sustained |
| 5+ | Vertical config refactor; kitchens pilot | Kitchen pilot yield report |

Interaction with the current `AGENTS.md` rule ("pause after each discovery
batch and wait for Kai"): this rule caps throughput at whatever Kai can review.
Weeks 3–4 assume it is relaxed to **a daily report plus automatic pause on
anomalies** (yield collapse, error spike, Semrush budget). That needs Kai's
sign-off.

---

## 10. Decisions needed from Kai

1. **Autonomy:** OK to replace "pause after every discovery batch" with a daily
   report and anomaly-triggered pauses once the eval passes?
2. **Sending capacity:** two inboxes (Claire, Shelby). What daily limits are
   they warmed to, and are more mailboxes an option?
3. **Asset kit:** clips, owned photos, a first-hand travel log, bio lengths
   and a CV paragraph (headshot and author email are done). Who are Claire and
   Shelby behind the bylines, so first-hand claims are true?
4. **New spend:** a SERP API for `site:` searches and Playwright running on the
   worker host. Any budget ceiling for Semrush units and API spend per day?
5. **Forms:** approve-every-submission to start (recommended), or
   auto-submit simple forms from day one?
6. **Verticals:** OK to add romance, wedding, wellness and regional-magazine
   buckets to HHT discovery?
7. **Kitchens:** which site and brand, and which persona will pitch?
