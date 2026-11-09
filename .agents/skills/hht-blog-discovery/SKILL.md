---
name: hht-blog-discovery
description: >-
  Discovers HotelHotTubs guest-post blogs and hot-tub ranking pages for link
  insertion. Use for HHT opportunity discovery, topical travel SERP discovery,
  guest-post prospecting, or link-insertion leads. Current topical seed queries are
  in blog_discovery_seed_queries.csv beside this file. Follow this playbook
  exactly, including Semrush MCP, the top 100 US organic results, batches of
  about 15, priority 1 before priority 2, and stopping after the first
  priority-1 batch until the user says to continue.
---

# Task: Discover publications through topical travel SERPs

Seed file: `blog_discovery_seed_queries.csv` in this skill directory.

## Context
The default strategy is topical travel discovery, not contribution-footprint
searches. The October 21 replacement list of 100 broad travel topics has already
been attempted. The CSV now holds the latest 12 approved packing and staycation
follow-ups, also defined in `packages/core/src/hht-opp/guest-keywords.ts`.
The live `hht_opp_guest_keywords` table records fetch status and prior yield;
inspect it before proposing the next batch. Never restart historical queries.
Legacy pending queues are retired, not deleted. Never seed or expand discovery
with write-for-us, guest-post, contributor or submission footprints. Those
phrases remain appropriate only for verifying invitations on discovered sites.

Columns: `id, query, bucket, priority, lead_type`.

## What to do

1. **Inspect the live queue** and use the current topical CSV as the default seed
   list. Preserve existing records and fetch history. Activate only approved
   proposed topics. Do not revive retired or already-fetched queries.

2. **Run in priority order.** Run all `priority = 1` queries first, then `priority = 2`. Pull the top 100 organic results per query (US results, English). Run in batches of about 15 queries and pause between batches so I can review yield.

3. **Dedupe by registrable domain** before any LLM work. Skip a domain if it already appears in the CRM or leads table in any status, or in the skipped list. Never re-triage a domain.

4. **Discard junk results** without triage:
   - agencies or marketplaces selling guest posts ("buy guest post", "sponsored post packages", SEO link-building services)
   - "write for us" aggregator or listicle pages on SEO sites
   - forums, social platforms, Wikipedia, Pinterest, YouTube, Reddit
   - large media sites with staff-only programs
   - non-English sites and non-US-oriented audiences

5. **Route by `lead_type`:**
   - `guest_post`: immediately run the `guest-post-pitches` skill end to end,
     including both-tab tracker deduplication, invitation and activity evidence,
     writing, and eligible step 1 outreach draft creation. Never send.
   - `link_insertion`: the ranking pages are roundups of hotels with hot tubs. Do not triage them as guest-post targets. Store each ranking URL as a link-insertion lead (page URL, page title, author or editor if visible, last updated date, whether HHT is already listed) so I can pitch "add HHT to this list". Use the same CRM, with `lead_type = link_insertion`.

6. **Log yield per query.** After each batch update `results_seen`, `new_domains` (not seen before), `qualified_domains` (passed triage), and `pitched_domains`. Write a batch summary table sorted by `qualified_domains`.

7. **Prune and adapt.**
   - Mark a query `exhausted` if it returned 0 new domains.
   - After each bucket has run, report which bucket and which modifiers yielded best.
   - Propose follow-up topical queries modeled on the best-yielding topics and
     modifiers, never contribution footprints. Store them as `status = proposed`
     and do not run them until approved.

8. **Constraints.** Use the Semrush MCP connector for SERP data. Contact discovery is scraping only. All LLM calls run inside this session. Send the notification email to kai@useterrace.ai when each batch finishes, with the yield summary.

## Output after each batch
- Queries run, new domains found, qualified domains, and leads created
- Top 5 and bottom 5 queries by qualified domains
- Any domain you were unsure about, with a one-line reason
- Suggested next batch

Stop after the first batch of priority 1 queries and wait for my go-ahead before continuing.

Use `pnpm hht:opp guest-frontier --max=12 --no-expand` for the latest approved
batch. Refresh tracker exclusions before export. Scope exports with
`pnpm hht:opp export-leads --keyword-ids=<IDs fetched in this batch>` so older
SERP backlog is not mistaken for new discoveries. Evaluate all newly exported
guest-post leads, then pause with one combined discovery and outreach report.
