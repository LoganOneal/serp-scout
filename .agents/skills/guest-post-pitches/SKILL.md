---
name: guest-post-pitches
description: "Use for guest-post feasibility, evaluating travel-blog leads, and writing pitches as Claire Bennett of Hotel Hot Tubs. Also run it automatically right after any hht-opp (Semrush) discovery that produces new guest-post leads. Deduplicate both tabs of the local master XLSX, retain every draft in batch Markdown, and create eligible step 1 email drafts in the outreach tool, never send."
---

# Guest-post evaluation, writing, and local routing

## Required reading and precedence

The supplied evaluation and writing playbook is split, verbatim, into four files
in `references/` (concatenated in this order they are the complete original).
Read each part when its phase starts, not all up front:

| Phase | Read before starting it |
|---|---|
| Research and evaluation | [playbook-0-principles.md](./references/playbook-0-principles.md) and [playbook-a-feasibility.md](./references/playbook-a-feasibility.md) |
| Writing (only when the batch has at least one PURSUE) | [playbook-b-writing.md](./references/playbook-b-writing.md) |
| Routing (only when something will be pushed, held or tracked) | [playbook-c-routing.md](./references/playbook-c-routing.md) |

Writing subagents need only the principles file, Part B and the group's research
data. Phased reading changes when text is loaded, never which rules apply: preserve
the playbook's research, hard gates, evidence, activity, angle quality, Claire
profile, writing style, word-count validation, sign-off, reviewer-note, API,
duplicate handling, and no-send requirements.

Dofollow only (Kai, 2026-11-09): a site whose guidelines explicitly say contributor
links are nofollow, sponsored or ugc tagged, byline or author credit only, or not
allowed fails gate G4b (`SKIP_NO_DOFOLLOW`), whatever the publisher's reputation. A
site silent on links passes. Opus writers re-check this on the guideline page before
writing a pitch.

This skill replaces the supplied playbook's Google storage and routing
requirements, and its embedded fallback credential, with the local rules below.
When the reference says Google Sheet, Google Doc, Drive folder, Doc-only, or
Full Articles tab, apply these replacements. No Google integration is required.
Do not execute any Google storage instructions from the reference.

The reference's repeated Requirements and context confirmation requests are also
superseded. UI visibility is a one-time integration check, not a per-batch task.
Kai has already confirmed the current outreach integration displays the box.
Do not ask again for normal batches. Revisit only after a relevant integration
change or an observed missing-note/display failure. Continue validating each
payload's reviewer note against the tracker and reporting actual API results.

## Inputs and canonical tracker

- Accept XLSX, CSV, or domains. Normalize domains and deduplicate before research.
- Use a working copy of the supplied master XLSX as the canonical tracker.
  Preserve the input download unchanged, both existing tabs, every existing
  column and record, and workbook formatting wherever supported.
- Check both the main tracker tab and `Full Articles` before selecting domains.
  Existing sites are not re-evaluated or re-pushed unless Kai explicitly asks.
- Do not maintain an independently editable CSV and XLSX as competing masters.
  Optional CSV exports are snapshots only.
- Take approximately 25 unprocessed domains per batch, in input order unless
  Kai specifies otherwise. Use an unambiguous source-and-batch label.
- Keep deliverables in `exports/guest-post-outreach/` in this project. Use a
  persistent working master and one subdirectory per batch. Existing batches
  and previous review text must not be overwritten.
- If an expected input, required tab, or workbook dependency is unavailable,
  report it explicitly rather than deduplicating against incomplete data.

## Research and evaluation

Apply Part A of the reference in full, including the India/Pakistan pre-screen,
the complete invitation search before `SKIP_NO_INVITATION`, six-month activity
evidence, exact quotes, supplied-URL verification, and all skip/review codes.
Discovery CSV verdicts are unverified hints, not permission to pitch.

Use the actual triage date. Evidence must include source URLs and fetched text.
Do not bypass robots, paywalls, access denials, or organization restrictions.
Blocked or incomplete evidence must be recorded honestly. Do not call an
unfinished invitation search `SKIP_NO_INVITATION`.

Keep a structured per-domain research file in the batch directory, containing
all Part A fields, search logs, rules, example posts, candidate angles and the
batch angle ledger. This is separate from the clean draft document. The helper
below creates and maintains it as `domains/<domain>.json`.

**Verdicts come from Haiku (decision D5, 2026-11-07).** Scripts fetch and
extract; Haiku subagents apply the Part A gates as written in
[haiku-rules.txt](./references/haiku-rules.txt) to the saved page text; only
PURSUE sites go to the writing step. There is no separate Opus confirmation
pass: the Opus writer re-reads the live guidelines page while drafting and
downgrades false positives (closed, staff-only, sponsorship-only, no real
invitation, article-first rather than pitch-first) by updating that domain's
record and tracker row with the correct verdict and code.

## Fast research pipeline (bundled scripts)

Use the tested scripts in [scripts/](./scripts/) directly. Do not rewrite, copy or
re-derive them per batch. Run them with the batch directory as the working
directory (or `HHT_BATCH_DIR=<batch dir>`). They read `batch-input.json`:
`{"selected": [{"domain": "...", "supplied_urls": ["..."]}]}`. Every fetch keeps
robots rules, `Crawl-delay`, two-second per-host spacing, one retry and saved
evidence. Domains run in parallel; `--jobs 12` is a good default.

**Hard timeouts (Kai, 2026-11-10).** Each headless-browser fetch runs in its own child
process and is killed with its Chrome after `HHT_BROWSER_HARD_TIMEOUT_S` (60s). A domain
still running after `HHT_DOMAIN_HARD_CAP_S` (default max(300s, 3x the stage budget)) is
logged as `ERROR HardTimeout` and abandoned with its saved progress, so one hung site
cannot stall a run (one did for 37 minutes on 2026-11-10).

**Run-level fast path (Kai, 2026-11-09).** For a whole run, do not walk batches one
at a time. `scripts/run_pipeline.py` runs the scripted steps for every pending batch
at once and writes plans for fanning out the model work:

- `run_pipeline.py research <run id>` runs steps 1 to 4 plus the gated
  `needs-search` for all batches (6 batches at a time, `--parallel`), then writes
  `<run>/search-plan.json`: the domains still needing a web search, in chunks of 40.
  Give each chunk to its own search subagent (Sonnet is enough), all launched
  together, with the prompt "Read
  .agents/skills/guest-post-pitches/references/websearch-chunk-task.md and follow it
  with RUN=<run dir> CHUNK=<n>". Searches inside
  one agent stay one at a time, and the whole run is normally well under the
  200-search turn cap.
- `run_pipeline.py prep <run id>` preps every batch and writes `<run>/haiku-plan.json`.
  Launch one Haiku subagent per prompt, all at once (at most 20 in flight).
- `run_pipeline.py finish <run id>` fixes null routes, then merges and applies every
  batch whose results are complete, and lists PURSUE sites for the writing step.
- `run_pipeline.py status <run id>` shows where each batch is.

The per-step commands below stay the reference and are what a single batch or a
re-run of one domain uses.

1. `research_tools.py seed --browser --jobs 12` fetches homepage, about and
   contact pages (`--browser` re-fetches refused or JavaScript-only pages in
   headless Chrome).
2. Step 0: `classify_batch.py region <batch dir>` pre-screens every domain from
   the saved text: `.in`/`.pk` ccTLD is excluded; two or more strong
   India/Pakistan signals (+91, +92, ₹, INR, PKR, Pvt Ltd) or two or more
   audience signals (rupees, lakh, crore, trips from Indian or Pakistani cities,
   advice for Indian or Pakistani travelers) is unclear; anything else is clear.
   The rule is audience, not domain: any site written primarily for Indian or
   Pakistani readers is excluded whatever its TLD, and Haiku's G0 makes that
   call on unclear sites. It writes `region.json` and keeps
   any region already recorded (`--force` overwrites). Override single domains
   with `research_tools.py region <domain> --set ... --note "..."`.
3. `research_tools.py discover --browser --jobs 12` reads supplied URLs and the
   nav, footer, about, contact, work and advertise links.
4. `research_tools.py variants --browser --jobs 12` (background command) probes
   the top invitation paths, then the first readable root sitemap. Never wait
   with `sleep` loops or polling; you are notified when it finishes.
5. Run Step 1.6 web searches only where they can still matter (see below).
6. `classify_batch.py prep <batch dir>` writes `haiku/RULES.txt`,
   `haiku/sites/<domain>.txt` (evidence built by `classifier.build_evidence`,
   invitation pages first, with the code-computed activity line),
   `haiku/batch-NN.json` (18 domains each), `haiku/prompt-NN.txt` and
   `haiku/prep.json`. Domains with no page text or an excluded region are listed,
   not batched.
7. Launch one Haiku subagent per batch (Agent tool, `model: "haiku"`, at most 20
   at once), passing the contents of `haiku/prompt-NN.txt` as the prompt. The
   template, with `{haiku}` the absolute `haiku/` path:

   ```text
   You are classifying guest-post targets. Use only the Read and Write tools, no web access.
   1. Read {haiku}/RULES.txt and follow it exactly.
   2. Read {haiku}/batch-{nn}.json, a JSON list of {count} domains.
   3. For each domain, read {haiku}/sites/<domain>.txt and decide from that file only.
   4. Write {haiku}/results/batch-{nn}.jsonl: exactly one JSON object per line, one line per domain,
      in batch order, with exactly these keys: domain, verdict, code, pitch_url, route, contact,
      submission_stage, last_activity_date, evidence_quote, confidence. Use null where RULES.txt allows it.
      evidence_quote must be copied exactly from the site file. Write no other files.
   Reply with only: done {count}
   ```

8. `classify_batch.py merge <batch dir>` requires exactly one valid line per
   batched domain (it lists problems and writes nothing otherwise; re-run only
   the named batches). No-text sites become NEEDS_REVIEW / INSUFFICIENT_EVIDENCE
   and excluded regions SKIP / SKIP_REGION_EXCLUDED. It writes
   `haiku-results.json` and `.csv`, with `quote_found` per site.
9. `classify_batch.py apply <batch dir>` writes each verdict into
   `domains/<domain>.json` in Part A shape (verdict, skip_code or review_reason,
   pitch_url, route, contact, stage, activity, evidence), adds `Not pursued` /
   `Not pushed` rows to `tracker-rows.json` for non-PURSUE domains without a row,
   and rebuilds `research.json`. A Haiku SKIP_NO_INVITATION without a full
   on-site search becomes NEEDS_REVIEW (`SLOW_SITE_CAPPED` or
   `INVITATION_SEARCH_INCOMPLETE`); run `variants <domain> --full` and re-classify
   those. Re-running `apply` never overwrites a record whose Haiku result is
   unchanged, so run it again after the writing step to rebuild `research.json`.
10. Writing step (Opus) for PURSUE only, as in "Writing". Use
    `research_tools.py overview <domain>` or targeted reads of
    `evidence/<domain>/*.txt`, and `research_tools.py fetch <domain> --url <URL>`
    to re-read the live guidelines page before drafting.

**Early stop.** `discover` and `variants` record `invitation_candidates` when a
dedicated invitation page (write-for-us, guest, contribute, submissions,
freelance or writer-guideline path) has its own text that invites outside writers,
gives a route and is not closed. Once one is confirmed, the remaining path probes
and sitemap candidates are skipped and logged under `invitation_search.early_stop`,
consistent with Step 1 (the full search is required before concluding no route
exists). Haiku still reads that page and applies every gate. If the page is
rejected (soft 404, wording trap, staff role, sponsorship only), run
`research_tools.py variants <domain> --full` and the web searches before any
`SKIP_NO_INVITATION`. Pages flagged in `closed_signals` are evidence for
SKIP_CLOSED review, not invitations.

## Light invitation search (Kai, 2026-10-24)

Kai approved a lighter Step 1 to trade a little recall for speed. It replaces the
exhaustive parts of Part A Step 1.4 to 1.6. Every other Part A rule still applies.

- Step 1.4 probes only the top invitation paths: write-for-us, guest-post,
  guestpost, contribute, contributors, submissions, contributor-guidelines,
  work-with-us. Contact, about, advertise and press pages are already read in
  Steps 0 to 1.3, which also follow at most 10 nav/footer candidates (invitation
  links first).
- Step 1.5 reads the first readable root sitemap, at most two page or
  contributor child maps, and at most six candidate pages.
- Step 1.6 runs one web search: the `site:` query.
- **Slow-site cap.** Each helper stage stops a domain after `--budget` seconds
  (default 90), for example because of a long robots `Crawl-delay`. A capped
  domain's `invitation_search.stopped` explains the cap. It is never a
  completed search, so it cannot be `SKIP_NO_INVITATION`. Run its web search;
  if no invitation turns up, record NEEDS_REVIEW with review reason
  `slow site; on-site search capped`.
- `SKIP_NO_INVITATION` therefore needs `invitation_search.full = true` under
  this light policy, plus the one search, and the search log must name the policy.
- Use `--thorough` on `variants` and `needs-search` only when Kai asks for the
  full playbook search on specific domains.

## Step 1.6 web search

The prescribed query is only for finding an invitation page that the site
visit did not surface. The `web_search` tool is slow, typically about 30 seconds
per call, and its rate limit (about 20 calls per minute) is shared by every lane, so:

- After `discover`, run `research_tools.py needs-search`. It writes
  `needs-search.json` with each listed domain's reason and its exact query.
  Domains with a confirmed on-site invitation, and region-excluded domains, are
  not listed. **Publication gate (Kai, 2026-11-09):** only sites whose homepage,
  about or contact text reads like a publication (two or more signals such as
  magazine, editor, contributors, staff writer, newsroom, freelance, and at most one
  booking/pricing signal), plus blocked or unreadable sites, are listed. Others go
  to `gated_out` with the signals found. Across 767 leads the web search found the
  pitch page for only two PURSUE sites the on-site probes missed, both
  publication-like, so the gate cut searches from 740 to about 120 with no PURSUE
  lost. A gated-out site is still evaluated from its on-site evidence, and
  `needs-search --all` restores the old behavior. Record those with
  `websearch_log.py skipped <domain> --invitation <URL>`.
- Issue the listed queries in parallel, about 10 to 20 calls per turn, while
  `variants` runs in the background. Send exactly the listed query per domain,
  with no extra discovery, activity or rephrased searches through `web_search`.
  If a call is rate-limited, retry that call once later in the turn sequence. Do
  not add more lanes to compensate.
- Fetch same-domain result URLs with the helper's `fetch` mode, then log them
  with `websearch_log.py add <domain> <same-domain URLs...> [--site-operator-failed]`.
- Never treat a search result snippet as evidence. Fetch and read the page.

## Experiment lane: no-invitation publications (Kai, 2026-11-09)

A scoped experiment, not a standing channel. Spec and decision rule: `docs/plan-guest-post-scale.md` section 3.5.
- After each batch's Haiku merge, run the channel pass over that batch's `SKIP_NO_INVITATION` sites. Use the saved page text with `references/channel-rules.txt`; this costs no Semrush units.
- Draft only the channels Kai has kept open. On 2026-11-09 that is `add_to_article` only. Freelance and expert-source sizing was too thin.
- Cap: at most 15 experiment emails a week, never more than about 10% of that week's guest-post drafts, and at most 45 in total until Kai reviews results. Count what is already in `exports/guest-post-outreach/EXP-noinvite-results.csv` before drafting more.
- Push to the separate outreach campaign "EXPERIMENT: add-to-article" (`d39441ed-9da2-4098-a87f-6a22af45ace0`), never the guest-post campaign; `push_drafts.py` enforces this by source.
- Tag every payload `contact.attributes.source = "hht-exp-noinvite"` and `attributes.channel = <channel>`. Start each reviewer_note with "EXPERIMENT (<channel>, not a guest post)."
- Tracker rows use `verdict = EXPERIMENT` and `code = EXP_<CHANNEL>`. Append one row per pushed email to `EXP-noinvite-results.csv`.
- Never use paid or sponsored routes. Report experiment counts separately from guest-post counts in the combined report.

## Chained after hht-opp discovery (Kai, 2026-10-24)

Whenever new leads are obtained from Semrush with the repo's `hht-opp` CLI, run
them through this skill immediately afterwards, with no separate request needed.
Discovery does no LLM triage of its own: this skill decides every verdict.

1. Before planning, refresh the tracker exclusions and verdicts, then rebuild the
   keyword yields so keyword choice learns from every evaluated batch:
   `python3 scripts/run_tools.py exclusions` (writes the exclusions CSV and
   `exports/handoff/exclusions/tracker-verdicts.csv`, including batches not yet in
   the master), then `pnpm hht:opp keyword-yields` (writes
   `exports/guest-post-outreach/keyword-yields-<date>.csv`, which `guest-templates`
   and the template retire rule read).
2. Discovery batch. Semrush is reached only through the Semrush MCP tools in this
   session, never the repo API key or engine login (Kai, 2026-11-08):
   `pnpm hht:opp guest-frontier --plan --max=15 --no-expand --refill` writes
   `exports/guest-frontier/serp-plan-*.json`. `--refill` first tops the queue up to
   30 yield-ranked template keywords (free Google Ads volume check; about 30% of each
   top-up tests templates with under 10 fetches, the rest goes to the best yields;
   templates under 0.3 pitchable per keyword after 10 fetches retire automatically).
   Template keywords run before leftover Google Ads keyword ideas. Kai does not need
   to choose keywords. If the plan comes back empty or `refill.error` is set (Google
   Ads down), say so in the report and plan from what is queued. Pull each request with
   `execute_report(report, params)` exactly as listed and save
   `{"<keyword>": {"data": <data>, "units": <metadata.usage.api_units>}}`
   (report units per call). If credits run out (`no_api_units`), stop pulling and tell
   Kai in one line that Semrush needs a top-up; ingest what was pulled. Low credits are
   routine: mention them only when a pull fails for lack of units. Then `pnpm hht:opp guest-frontier --serp-from=<file>`,
   then `pnpm hht:opp export-leads`. That writes `exports/handoff/hht-guest-serp-<date>-*.csv`
   and `hht-link-insertion-<date>-*.csv`.
3. Immediately run `python3 scripts/run_tools.py prepare <the new guest CSVs> --run-id HHT-<label>-<date>`.
   Link-insertion rows are never evaluated here; they stay link-insertion leads.
   `prepare` dedupes against both tracker tabs, every researched batch and all
   outreach history before research. It also applies `scripts/prefilter.py`
   (Kai, 2026-11-09): wedding-bucket leads and business-type domain names
   (photographers, venues, hotels, resorts, lodges, tours, rentals, studios) are
   dropped unless the name looks like a publication (mag, news, journal, post,
   press, guide...). Those were 491 of 1,787 evaluated leads with zero PURSUE.
   Dropped domains are listed in `<run>/prefiltered.json`; `--no-prefilter` keeps them.
   The automatic template refill no longer draws wedding keywords for the same
   reason (`GUEST_REFILL_BUCKET_IDS`; `--buckets=weddings` still runs them on purpose).

   **Blog-intent templates (Kai, 2026-11-10).** City templates were saturating (new
   domains per keyword fell from about 37 to 15) while blog-intent families yielded
   1-2.7 pitchable per keyword. The template set now includes `{city|state|region}
   travel blog`, `hidden gems in {city|state}`, `where to stay in {city|region}`,
   `is {city} worth visiting`, `{city} in winter` and `{city} on a budget`, each
   starting from its family's measured yield (`priorHint`). Brunch, anniversary
   ideas and places to elope are retired outright (`GUEST_TEMPLATES_RETIRED`).
   Same-phrase templates are told apart by the captured place (state name, curated
   region, else city).

   **Feedspot lane (Kai, 2026-11-10; no Semrush).** Feedspot's ranked "Top N blogs"
   lists are live blogs. Run `python3 scripts/feedspot_leads.py --defaults` (or name
   list slugs such as `texas_travel_blogs`), then `run_tools.py prepare` on the CSV it
   writes (`exports/handoff/hht-guest-feedspot-<date>.csv`) and evaluate as usual. The
   default set (21 lists) gave 707 blogs, 482 of them new to the tracker. Tourism
   boards (visitX, Xtourism, travel+state) are dropped at import. A slug Feedspot lacks
   is reported (404) and skipped.
   Pilot (HHT-feedspot-eval-2026-11-10a, top 60 new by list count and rank): 57
   evaluated, 2 PURSUE (loveandroad.com, nomadisbeautiful.com), 7 NEEDS_REVIEW,
   about 3.5% pitchable, close to SERP's ~4% but with zero Semrush units. The top
   ranks are famous blogs that often say they take no guest posts (bucketlistly,
   dangerous-business, ytravelblog, bemytravelmuse); evaluate further down the ranks
   next. Feedspot blogs already in the tracker before the lane existed were PURSUE or
   PAID_ONLY 29 times out of 197, so the lower ranks may do better.

   Second round (HHT-feedspot-eval-2026-11-10b, 89 blogs ranked below 20): 2 PURSUE
   (westmichiganwoman.com form, which prefers local writers; thehappytrip.com article),
   about 2.2%. Combined Feedspot yield so far: 4 of 146 (2.7%), below SERP. The
   hotel_blogs list (hotel software vendors) and spa_blogs list (med spas, hot tub
   stores) gave 0 of 37 and were removed from the defaults on 2026-11-10.

   Blog-intent SERP batch (HHT-serp-eval-2026-11-10e, 2026-11-10): 18 keywords
   planned, 10 returned Semrush no_data (9 of the 10 `{place} travel blog`
   keywords: too low volume for Semrush to track, no units charged), 8 pulled for
   8,650 units. 48 new domains evaluated, 2 PURSUE (recipestravelculture.com,
   storyhunt.io): 0.25 pitchable per pulled keyword, about the same as the
   city templates' 0.24 in the batches just before. Not yet better; the
   template yields will keep updating as batches are evaluated.

   **Lookalike and blogroll lanes: measured, not worth units.** `pnpm hht:lookalike`
   (organic competitors of PURSUE sites, guest-author bio links, blogroll links)
   ran on 40 seeds on 2026-11-08: 538 domains evaluated, 0 PURSUE (organic
   competitor 251, author bio 187, blogroll 100). Do not spend Semrush units on the
   organic-competitor signal again without Kai's say-so. The free signals
   (`--no-semrush --signals=author_bio,blogroll`) may be retried on new seeds, but
   half their leads ended INSUFFICIENT_EVIDENCE (dead or unfetchable blogs).

   **Backlink lane.** Sites that already link to a successful travel site from an
   article are proven niche publishers, and the linking article is evidence for the
   pitch. Pull a competitor's `backlinks` report through the Semrush MCP
   (`target_type: root_domain`, `display_sort: page_authority_score_desc`,
   `export_columns: page_authority_score, source_url, source_title, anchor, nofollow`,
   and dofollow links only: `display_filter: [{"field": "type", "operation": "",
   "value": "follow", "sign": "+"}]`; about 40 units per row). Kai (2026-11-09): only
   dofollow links have value, and a dofollow link to a competitor is the best evidence
   that a site gives dofollow links. The importer also drops any nofollow row, save each response's `data` to a file, then run
   `python3 scripts/backlink_leads.py <competitor> <files...>`. It drops the
   competitor itself, OTAs and platforms, homepage/sitewide links (hotel "as
   featured in" badges) and hotel booking pages, and writes
   `exports/handoff/hht-guest-backlinks-<competitor>-<date>.csv` for `prepare`.
   Pick competitors whose links come from articles, not from the hotels they review:
   thehotelguru.com's top backlinks are mostly reviewed hotels and OTAs, and the
   article links that survived the filters (storygrid.uk, irelandbulletin.com) were a
   paid link-placement network (PAID_ONLY). Prefer competitors that earn bylined
   guest posts, such as travel bloggers who write for other sites.
   Test result (2026-11-09, about 9,500 units): the closest search competitors
   (tubhotels.com, tubstays.com, excellent-romantic-vacations.com) have almost no
   editorial dofollow links. 200 rows gave 11 article domains; the rest were Yahoo/Bing
   result pages, Pinterest and spam link directories. Of the 7 new domains: 0 PURSUE,
   1 PAID_ONLY (breakingtravelnews.com, £99 release; tubhotels' AS 42 link came that
   way). Exclude search engines and Pinterest in the pull (`{"field": "refdomain",
   "operation": "contains", "value": "yahoo", "sign": "-"}`, same for bing and
   pinterest). The `type` filter needs `"operation": ""`; "equals" is rejected. This
   lane is not worth more units until a competitor with real guest-post links is found.
   thehotelguru.com pull (2026-11-10, about 6,000 units, dofollow only, search engines,
   Pinterest and OTAs excluded): newest-first rows are mostly spam; page-authority rows
   past the top 24 are mostly Good Hotel Guide reviews and hotels, plus ~10 Substack
   travel newsletters and small blogs. 18 new domains: 1 PURSUE (restless.co.uk Writers
   Corner, article-first), 17 skips (no invitation). Live rel checks matched Semrush.
   Substack newsletters are kept per subdomain (`PER_SUBDOMAIN_HOSTS`).
   Next page (offset 124-223, page_ascore 13-16, 4,000 units) was nearly all junk:
   Grokipedia, AI-written travel pages, Korean/Arabic aggregators, betting spam, Good
   Hotel Guide, hotel homepages, plus big outlets already in the master. 2 new
   domains, 0 PURSUE. A competitor's backlinks run out of value after roughly the top
   125 dofollow rows by page authority; move to the next competitor there.
4. Evaluate the whole run with `run_pipeline.py research`, the parallel search
   agents from `search-plan.json`, `run_pipeline.py prep`, the Haiku agents from
   `haiku-plan.json` (at most 20 at once) and `run_pipeline.py finish` (see "Fast
   research pipeline"). Then write only the PURSUE sites with Opus (lanes, see
   below), re-checking each live guidelines page while drafting, and stage
   eligible step 1 drafts locally. Lanes never push independently: small waves generate unwanted email
   notifications. Wait until every lane is ready, then upload the whole discovery
   run with `python3 scripts/push_run_drafts.py <run dir>`, at most 100 drafts per
   request. Normally this is one request and one owner notification. Drafts are never sent.
5. After reconciling the consolidated upload, commit each batch with `run_tools.py commit`
   (verdict-only batches included, so the master always has every evaluated domain),
   post a short progress update, and start the next discovery batch at step 1 without
   waiting (Kai, 2026-11-09). Stop only when Semrush units run out or something needs
   Kai (disk full, Google Ads or outreach auth down, a decision only Kai can make).
   Then give one combined report across all batches: discovery yield (queries run,
   results, new domains, junk, link-insertion leads, units used) plus the guest-post
   results (verdict counts, drafts created per inbox, holds, decisions needed).

## Run setup, lanes and commit (bundled scripts)

- `scripts/run_tools.py prepare` creates the run folder and batches of 25, renders
  `lane-contract.md` from [the template](./references/lane-contract-template.md),
  backs up the tracker and snapshots it. Every lane worker gets that contract.
- Workers never push. They write `outreach-outcomes.json` as `{}` and use
  `Awaiting consolidated push` / null ID for eligible email drafts. In their
  Markdown use the exact plain line `Routing status: Awaiting consolidated push`.
  Their final progress stage is `ready_for_run_push`.
- The parent waits for all lanes and calls `scripts/push_run_drafts.py <run dir>`
  once. It validates every lane, combines eligible drafts, checks cross-lane
  duplicates, and uses the bundled POST helper in groups of at most 100.
  Results and notification status are persisted once per request and distributed
  back to each lane's outcomes, tracker rows and local Markdown. No small-wave uploads.
- The parent commits with `scripts/run_tools.py commit <run dir> <batch id>`
  (`validate` checks without committing). It appends rows only after verifying
  every pre-run row and style, one main row per domain and confirmed draft IDs.
- If any run fails or is cancelled, resume from the saved files. Never repeat a
  run or batch push whose `outreach-post-attempt.json` exists; reconcile instead.

## Parallel lanes and status updates

Workers (sessions or subagents running one batch) never call `send_message`,
`create_session`, or `tool_search_tool` to find them. Those lookups have hung for
30 minutes at a time. If a needed tool is not already loaded, do not search for it
repeatedly; record the blocker and continue.

- Each worker reports only through `<batch>/progress.json`: `batch`,
  `total_domains`, `finalized_domains`, `research_in_progress`,
  `pitches_drafted`, `outreach_created`, `current_stage`, `blocker`, `updated_at`.
  Write it after every stage change and finalized domain, using `ready_for_run_push`
  when local work is complete. The parent sets `committed` after uploading and
  appending the tracker. Then end the turn with a concise batch result.
- Only the parent session launches lanes and relays to Kai. About every 15
  minutes it runs `scripts/lane_status.py <run batch dirs>` and reports progress,
  stale lanes and blockers. When a lane reaches `ready_for_run_push`, its research
  slot is released and the parent starts the next batch itself. Do not wait for
  workbook commits to launch queued lanes: uploads and commits wait for all lanes.
- **Stagger lanes.** Run at most four lanes, and start each one about three
  minutes after the previous one so their web-search bursts do not collide on the
  shared rate limit. A new lane can start whenever another lane leaves its
  research stage.
- Background workers are cancelled at about 30 minutes. Workers save each
  domain's final JSON as soon as its verdict is decided, keep `progress.json`
  current, and avoid long single-turn generations, so a cancelled lane can be
  resumed from disk without repeating network work.
- Writes to the shared master workbook stay sequential (one writer at
  a time), append-only and verified as described below.

## Writing

Apply Part B of the reference in full. In particular:

- Read two guest posts or recent posts and check archive coverage before writing.
- Generate at least three angles and select a site-specific gap, not a generic
  destination list. Carry the angle ledger across groups of five to eight.
- Use Claire's profile, the short required about-Claire paragraph, English,
  plain professional language, and the exact `Best regards,` closing.
- Meet site requirements without reciting them in the email. Keep research,
  link restrictions, fees, process details and requirements in reviewer notes.
- Programmatically count words and paragraphs against site limits, then perform
  the full pre-push scan and human-style reading check.
- Article-first means a completed article accompanies the first submission,
  regardless of email, attachment, shared-document or form delivery.
- First-hand experience: per playbook-b-writing.md Step B5, invented personal experiences end with the fictional note, which Kai deletes at review if he chooses. Follow the reference's treatment of personal anecdotes; never fabricate
  sources, URLs, contact information, credentials, interviews, or harmful claims.

## Local Markdown replaces every batch Google Doc

Create `drafts.md` in the batch directory. Retain a local copy of **every**
completed pitch and article package, including emails successfully pushed.
This intentionally supersedes the reference's "not copied into the Doc" rule.

Each site gets a stable heading and an unchecked task item:

1. Site/domain heading and an unchecked review/submission checkbox.
2. `Guidelines page:` with the verified guidelines URL.
3. `Send to:` with the selected email or exact form URL, and any required subject.
4. `Routing status:` distinguishing email draft, form/application, article review,
   unreadable email, push failure, or duplicate already in the outreach tool.
5. Subject and exact email body, or form-ready answers/full article package.

Keep the actual email copy clean and paste-ready, with blank lines between
paragraphs. Use a fenced plain-text block for email subject/body so Markdown
formatting cannot accidentally enter the outreach payload. The body itself has
no Markdown, brackets, appended signature, compliance marks or research notes.

Use Markdown headings and links instead of Google Docs API styling. Google
paragraph spacing, checkbox bullets, blue/underlined links and Drive placement
are not local requirements. Do not use HTML import or create Google Docs.
Required article images are an honest photo list, not fabricated image files
or invented photo-folder URLs.

Do not add research, angle rationale, separate unsolicited bios, placeholder
lists or invented-detail flags to the draft copy. Put reviewer requirements in
the workbook and structured research file, never in the email body.

## Tracker replacements

Append one main-tab row for every evaluated domain, including skips. Preserve
existing names such as `site`, `contact_route`, `code`, `draft`, and
`sheet_score`. Add columns only when a required field has no existing equivalent.

Record the batch, score, verdict/code, confidence, guidelines URL, route,
submission stage, triage date, reasons/evidence, draft location, outreach
status, returned email ID and the exact reviewer note. A `draft` reference is
the relative path to `drafts.md` plus its site heading anchor.

For every article-first PURSUE site:

- Add a `Full Articles` row, retaining the workbook's existing columns.
- Store the local Markdown section path in the existing `doc_link` column.
  Despite the legacy column name, this is now a local file reference.
- Record delivery, title, word count, photos, bio/headshot rules, link policy,
  fee risk, fact checks and status; start at `Drafted`.
- Set the main status to `Article for review (not pushed)`.
- Never create an outreach draft for the article or its cover note until Kai
  has approved the article and explicitly asks for it to be routed.

For pitch-first email sites, preserve `Draft in outreach tool` and store the
returned `outreach_email_id` only after a confirmed create result.
Use `In Markdown (form only)`, `In Markdown (no email)`, or
`Not pushed (tool unreachable)` for the corresponding local fallback.
Skips and unresolved review sites get no invented draft or article.

## Outreach authentication and safety

- Base URL: `https://outreach-ten-plum.vercel.app`.
- Use `GENERATOR_SECRET` as a bearer token. A credential explicitly supplied
  by Kai may be read from protected session-local storage when the environment
  variable is absent. Never store a fallback token in the skill or repository.
- This repo already configures `GENERATOR_SECRET` in its root `.env`. Python
  helpers do not load dotenv automatically. Launch them from a Node wrapper
  that loads `dotenv/config` and passes its environment to the Python process,
  or use the existing owner-only credential file via `GENERATOR_SECRET_FILE`.
  Check this setup before asking Kai to supply the credential again; never
  print the token or include the environment in logs.
- Never print credentials, persist authorization headers in logs, or include
  secrets in deliverables or a portable skill archive.
- First make a read-only `GET /api/generator/campaigns?include=paused`
  (`scripts/preflight.py`, which reads `GENERATOR_SECRET` or an owner-only file
  named by `GENERATOR_SECRET_FILE`). Find `guest post outreach`
  case-insensitively and verify step 1 exists.
- Only the reference's three generator routes are allowed: campaigns,
  followups-due, and drafts. No backlink API, approval, rejection, cron or send.
- Create only step 1 drafts for qualifying pitch-first readable-email routes.
  Keep the original payload schema and reviewer-note constraints.
- If mandatory submission materials are unavailable (for example, required real
  writing clips), retain the draft locally, record explicit `push_blockers`,
  and mark it `Blocked (requirements incomplete; not pushed)`. Do not invent
  materials or push an incomplete draft as ready. This is a readiness hold,
  not an unsupported feasibility skip.
- Draft creation can notify Kai; it is not permission to send email.
- Do not overwrite any existing outreach draft unless Kai specifically asks.
- Persist each response and returned ID immediately, without authorization
  headers. Reconcile known results before retrying after interruptions.
- For a timeout or uncertain POST outcome, do not blindly retry: record the
  uncertainty and reconcile through permitted read-only evidence or human review.
- Apply the reference's duplicate, suppression, invalid-draft and failure rules.
  All drafts remain in Markdown, including failures; log individual outcomes.
- If auth fails or the campaign/step is missing, push nothing. Keep the local
  work, report the blocker and never imply successful integration.

## Completion and validation

Before reporting completion:

1. Reopen the saved workbook and verify both tabs, all prior records, exactly
   one main row per evaluated domain, correct statuses and article routing.
2. Verify Markdown sections match the actual finalized draft payloads.
3. Validate site-specific lengths, required fields, style scans, reviewer notes,
   email recipients, article-first exclusion and response IDs.
4. Keep a redacted API result record and report notifications and skips.
5. Report verdict counts, review reasons, corrected URLs, region exclusions and
   unclear regions, low-confidence pursuits, pitch/article counts, routing,
   article review needs and any unresolved blockers.
6. Link the canonical workbook, batch Markdown and research report. Report that
   reviewer notes were included and backed up in the tracker, without repeating
   the already-completed UI visibility check.

Finally, regenerate the master list of everything waiting on Kai:
`python3 scripts/manual_queue.py`. It writes `exports/guest-post-outreach/Manual Intervention Queue.md`
from the live /forms queue, every form run's site files and the tracker. Every set-aside item needs its reason
recorded in the tracker or site file so it shows up there. Link that file in the report.

Do not claim an unfinished batch is complete. Persist partial progress and say
exactly which domains and stages remain when blocked or interrupted.
