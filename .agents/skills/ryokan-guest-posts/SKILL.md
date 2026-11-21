---
name: ryokan-guest-posts
description: Find, evaluate and pitch guest-post sites for Ryokan Society (ryokansociety.com), written as Kai. Use for any Ryokan Society lead discovery, Semrush SERP pulls, Authority Scores or pitches. Never the Hotel Hot Tubs / Claire pipeline.
---

# Ryokan Society guest posts

This is a separate lead set from Hotel Hot Tubs (HHT). It reuses the guest-post-pitches
evaluation scripts, pointed at its own folders, rules and persona by `env.sh`.

## Hard rules

- **Never mix with HHT.** No Claire or Shelby, no HHT campaign, no outreach-tool push.
  Do not run `push_run_drafts.py`, `run_tools.py exclusions` or `run_tools.py commit`
  (they write HHT-global files or need HHT outreach IDs). The AGENTS.md
  "discovery always chains into evaluation" rule for HHT does not apply here; this file does.
- **Never send anything.** Pitches are local Markdown files. Kai sends them himself.
- **Semrush through the Semrush MCP tools only.** Never the repo's API key or engine login.
- **Dofollow links only have value.** Note link policy when you see it.
- **Japan Times: on hold** until Owen Ziegler replies. Don't draft for japantimes.co.jp.
- **No captcha bypass.** Record the site as blocked and move on.
- Keep Kai's personal details out of external services (search queries, forms).
- Invented first-hand details get a `[KAI: invented]` flag. Facts about inns come only
  from ryokansociety.com pages, read the same day.

## Setup (every session)

```bash
source .agents/skills/ryokan-guest-posts/env.sh
```

This sets `HHT_EXPORTS=exports/ryokan-guest-post`, `HHT_MASTER` (the Ryokan tracker xlsx),
`HHT_HAIKU_RULES` (Kai's fit rules), `RS_HANDOFF=exports/handoff/ryokan`, `$GPP` (the
guest-post-pitches scripts) and `$RSP` (this skill's scripts). Every Bash call is a new
shell, so prefix each command with the `source`, e.g.
`source .agents/skills/ryokan-guest-posts/env.sh && python3 $RSP/rs_leads.py report`.

**Preflight:** check that the Semrush MCP tools (`execute_report`, `get_report_schema`)
are loaded. If not, stop and tell Kai to run `/mcp` and sign in to Semrush. Then run the
tests once:

```bash
python3 -m unittest discover -s .agents/skills/ryokan-guest-posts/scripts
```

## Files

| Path | What it is |
| --- | --- |
| `exports/ryokan-guest-post/keyword-queue.json` | Keywords to pull, with status (`pending`, `done`, `no_data`, `failed`). Add new keywords here as `pending`. |
| `exports/ryokan-guest-post/keyword-log.jsonl` | One line per pulled keyword: units, counts per class. |
| `exports/ryokan-guest-post/authority-scores.json` | Semrush Authority Score cache, root domain. |
| `exports/ryokan-guest-post/*overrides*.json` | Writer verdict overrides. They win over Haiku verdicts in the report. |
| `exports/ryokan-guest-post/RS Guest Post Leads.md` / `.csv` | The lead report. Regenerate after every run. |
| `exports/handoff/ryokan/` | CSVs from `ingest`: guest-post leads, link-insertion competitors, outlets. |
| `references/known-domains.json` | Domains already classed (`self`, `skip`, `link_insertion`, `outlet`). Add to it when you learn something. |
| `references/haiku-rules-ryokan.txt` | Fit rules the Haiku classifiers read (via `HHT_HAIKU_RULES`). |
| `references/kai-persona.md` | Who Kai is and how pitches are signed. |

## The discovery loop

One run = one batch of keywords, evaluated end to end. Then report and start the next
batch, until the unit budget or the queue runs out.

**Unit budget.** A SERP pull costs about 10 units per returned row (about 400 per
keyword at `display_limit` 40). An Authority Score costs 40. Default cap per run:
3,000 units (about 7 keywords) unless Kai sets another. Stop the loop when a pull
returns `no_api_units`, or when the total since the start of the session passes
Kai's cap. Note the remaining balance in the final report if a pull shows it.

1. **Plan.** `python3 $RSP/rs_leads.py plan --max 7` prints the next pending keywords
   and the exact MCP params for each (`phrase_organic`, database `us`).
2. **Pull.** For each request, call the Semrush MCP `execute_report` with
   `report: "phrase_organic"` and the printed params. Run them in parallel.
   Save all responses into one JSON file,
   `exports/ryokan-guest-post/pulled-<label>.json`, shaped as
   `{"<keyword>": {"data": "<the CSV text the tool returned>", "units": <n>}}`, or
   `{"<keyword>": {"error": "<error text>"}}` on failure. Use units = 10 × rows returned.
3. **Ingest.** `python3 $RSP/rs_leads.py ingest exports/ryokan-guest-post/pulled-<label>.json --label <label>`.
   It classifies every domain, writes three CSVs to `exports/handoff/ryokan/`, and
   marks the queue. It prints a summary: how many guest-post leads came out.
   If 0 new guest-post leads, skip to step 6.
4. **Prepare batches.**
   `python3 $GPP/run_tools.py prepare exports/handoff/ryokan/ryokan-guest-serp-<label>.csv --run-id RS-serp-<label>`.
   This dedupes against every domain already evaluated under `exports/ryokan-guest-post`.
5. **Evaluate** with the guest-post-pitches fast path, all with env.sh sourced:
   - `python3 $GPP/run_pipeline.py research RS-serp-<label>`, then one search subagent
     (Sonnet) per chunk in `<run>/search-plan.json`, all at once, each told:
     "Read .agents/skills/guest-post-pitches/references/websearch-chunk-task.md and
     follow it with RUN=<run dir> CHUNK=<n>". Tell each agent the lead set is Ryokan
     Society and that Kai, not Claire, is the author.
   - `python3 $GPP/run_pipeline.py prep RS-serp-<label>`, then one Haiku subagent
     (`model: "haiku"`) per prompt in `<run>/haiku-plan.json`, at most 20 at once.
     `prep` copies Kai's rules (from `HHT_HAIKU_RULES`) into each batch's
     `haiku/RULES.txt`; check one says "Kai" and not "Claire" before launching.
   - `python3 $GPP/run_pipeline.py finish RS-serp-<label>`.
   - **Re-read every PURSUE yourself** (open the site's write-for-us or contact page).
     Write the result to `exports/ryokan-guest-post/RS-serp-<label>-overrides.json`,
     same shape as `pilot-overrides-2026-11-18.json`:
     `{"domain": {"final": "PURSUE" | "DOWNGRADE" | "SKIP_<reason>", "class": "...", "why": "..."}}`.
     Downgrade when it's really a paid-freelance outlet, pay-to-post only,
     a women-only or other audience Kai can't write for, or the invitation is stale (before 2023).
6. **Score.** `python3 $RSP/rs_leads.py missing-as` lists PURSUE and NEEDS_REVIEW
   domains with no Authority Score. Pull each with the MCP `execute_report`,
   `report: "backlinks_overview"`, params
   `{"target": "<domain>", "target_type": "root_domain", "export_columns": ["authority_score"]}`,
   then `python3 $RSP/rs_leads.py set-as domain1=NN domain2=NN`. Score PURSUE always;
   NEEDS_REVIEW only if the budget allows.
7. **Report.** `python3 $RSP/rs_leads.py report` rewrites `RS Guest Post Leads.md/.csv`.
8. **Progress update** (two or three lines: keywords pulled, units, new PURSUE with AS),
   then go back to step 1 without waiting for Kai.

**Outlets and link-insertion CSVs** from `ingest` are not evaluated by this loop. List
the new high-AS outlets in the final report; they are source-pitch targets (see
`exports/ryokan-guest-post/japan-based-pitches-2026-11-19.md` for the approach).

## Which keywords work

From the 2026-11-18 pilot and Kai's HHT history:
- **Best:** `things to do in <onsen or ryokan town>` (shape `townttd`). Small-town blogs
  rank for these and many take contributors.
- **Testing:** `where to stay in <town>`, `is <town> worth it`. Pull the queued tests and
  compare yield (new PURSUE per 1,000 units) in `keyword-log.jsonl` before adding more.
- **Retired:** `<town> day trip`, `<town> itinerary` (low yield in the pilot).
- When the queue is empty, add 20 to 30 more ryokan or onsen towns that have ryokan on
  ryokansociety.com, as `pending`, shape `townttd`. Mark `no_data` keywords and move on.

## Writing pitches (PURSUE sites only)

Use Opus. Read `references/kai-persona.md` first. For each PURSUE site:
1. Re-read its guidelines page live. Note: pitch-first or article-first, word count,
   link policy (dofollow, nofollow, none), fees. Pay-to-post → don't pitch, downgrade.
2. Pick an angle that fits the site's readers and that Ryokan Society data can back
   (tattoo rules and private baths, a town's ryokan by budget, kaiseki dinner, booking
   tips). Read the matching ryokansociety.com town and inn pages the same day.
3. Write the pitch (and, for article-first sites, an outline of the article) in
   `exports/ryokan-guest-post/pitches-<label>.md`: one section per site with the
   route (email, form URL), subject, body, and the link target (homepage or the
   relevant town page). Mark anything Kai must check with `[KAI: ...]`.
4. Never submit a form or send an email. Kai does.

## Final report to Kai

One combined message at the end: keywords pulled and units used, new PURSUE sites
ranked by Authority Score with their route, notable outlets found, the pitch file path,
and anything blocked (captcha, masked email, failed fetch). Then the paths to
`RS Guest Post Leads.md` and the pitches file.
