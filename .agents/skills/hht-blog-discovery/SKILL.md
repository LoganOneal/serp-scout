---
name: hht-blog-discovery
description: >-
  Discovers HotelHotTubs guest-post blogs and hot-tub ranking pages for link
  insertion. Use for HHT opportunity discovery, blog discovery, write-for-us
  queries, guest-post prospecting, or link-insertion leads. Seed queries are
  in blog_discovery_seed_queries.csv beside this file. Follow this playbook
  exactly, including Semrush MCP, the top 100 US organic results, batches of
  about 15, priority 1 before priority 2, and stopping after the first
  priority-1 batch until the user says to continue.
---

# Task: Expand blog discovery with a new seed query list

Seed file: `blog_discovery_seed_queries.csv` in this skill directory.

## Context
You are extending the HHT (HotelHotTubs.com) backlink opportunity engine. So far, SERP discovery has used queries like `travel write for us`, `family travel write for us`, `luxury travel write for us`, `honeymoon write for us` and `travel blogs that accept guest posts`. Those worked, but they are narrow. The attached `blog_discovery_seed_queries.csv` holds about 100 new queries built by varying topic, footprint phrase, operator syntax, US geography, and a separate link-insertion bucket.

Columns: `id, query, bucket, priority, lead_type`.

## What to do

1. **Load the CSV** and add its queries to the discovery query table (or equivalent). Do not overwrite existing queries. Skip any query that already exists (case-insensitive match). Add columns if missing: `status`, `last_run_at`, `results_seen`, `new_domains`, `qualified_domains`, `pitched_domains`.

2. **Run in priority order.** Run all `priority = 1` queries first, then `priority = 2`. Pull the top 100 organic results per query (US results, English). Run in batches of about 15 queries and pause between batches so I can review yield.

3. **Dedupe by registrable domain** before any LLM work. Skip a domain if it already appears in the CRM or leads table in any status, or in the skipped list. Never re-triage a domain.

4. **Discard junk results** without triage:
   - agencies or marketplaces selling guest posts ("buy guest post", "sponsored post packages", SEO link-building services)
   - "write for us" aggregator or listicle pages on SEO sites
   - forums, social platforms, Wikipedia, Pinterest, YouTube, Reddit
   - large media sites with staff-only programs
   - non-English sites and non-US-oriented audiences

5. **Route by `lead_type`:**
   - `guest_post`: send each new domain through the `guest-post-feasibility` skill. Keep its existing stance: err toward pitching, and skip only closed programs, staff or team-writer roles, non-publications, or clearly misaligned audiences.
   - `link_insertion`: the ranking pages are roundups of hotels with hot tubs. Do not triage them as guest-post targets. Store each ranking URL as a link-insertion lead (page URL, page title, author or editor if visible, last updated date, whether HHT is already listed) so I can pitch "add HHT to this list". Use the same CRM, with `lead_type = link_insertion`.

6. **Log yield per query.** After each batch update `results_seen`, `new_domains` (not seen before), `qualified_domains` (passed triage), and `pitched_domains`. Write a batch summary table sorted by `qualified_domains`.

7. **Prune and adapt.**
   - Mark a query `exhausted` if it returned 0 new domains.
   - After each bucket has run, report which bucket and which modifiers yielded best.
   - Propose 20 to 30 follow-up queries modeled on the best-yielding patterns (same footprint and topic style, new modifiers). Add them to the table as `status = proposed`. Do not run them until I approve.

8. **Constraints.** Use the Semrush MCP connector for SERP data. Contact discovery is scraping only. All LLM calls run inside this session. Send the notification email to kai@useterrace.ai when each batch finishes, with the yield summary.

## Output after each batch
- Queries run, new domains found, qualified domains, and leads created
- Top 5 and bottom 5 queries by qualified domains
- Any domain you were unsure about, with a one-line reason
- Suggested next batch

Stop after the first batch of priority 1 queries and wait for my go-ahead before continuing.
