# HHT Backlink Pipeline: Codex Session Handoff

Read this entire file before doing anything. Then continue the work immediately. Do not redesign the pipeline, rerun completed Semrush requests, or spend a long time explaining the plan.

## User Objective

Continue the site-first HotelHotTubs.com backlink research run:

1. Identify a large universe of successful hotel/travel domains.
2. Validate those domains with Semrush organic metrics.
3. Expand the universe using organic and backlink competitors.
4. Select high-value, transferable independent sites.
5. Collect referring domains and detailed follow backlinks.
6. Preserve every response and resume cleanly when Semrush credentials change.
7. Continue the local crawl, link analysis, opportunity scoring, clustering, and export stages after collection.

The user explicitly wants speed and scale. Use Semrush's supported maximum of 10 concurrent calls, persist every completed batch immediately, and continue until the currently connected account reaches its credit boundary. Do not ask for approval between normal batches. Account swapping is manual inside Codex, not in the web application.

Any hotel/travel site may be relevant. Do not limit discovery to hot-tub or unusual-hotel keywords. Include independent travel publishers, hotel discovery and affiliate sites, destination guides, booking startups, boutique/luxury/romantic/family/spa/resort/cabin/glamping/accessible/pet-friendly travel sites, and programmatic hotel directories. Prefer strategies transferable to an independent web business. Large platforms may be retained as discovery bridges but should score poorly for transferability.

V0 ends with research, ranked opportunities, and campaign candidates. Do not build automated outreach, contact enrichment, email sending, form submission, purchasing, or negotiation.

## Required Source Documents

Read these before making product or pipeline changes:

- `/Users/kaisulkin/.codex/attachments/beff664a-6815-4986-a4f9-81829ffc4926/pasted-text.txt`
- `/Users/kaisulkin/.codex/attachments/d0cea0d2-be03-47d6-a973-26bf559eef49/pasted-text.txt`

The implementation intentionally uses the repository's existing TypeScript, Next.js, Drizzle, and PostgreSQL stack instead of the Python stack suggested in the specification.

## Repository Checkpoint

- Workspace: `/Users/kaisulkin/serp-scout`
- Branch: `feat/bl-semrush-automation`
- HEAD: `a39749d` (`feat: enhance HHT BL dashboard and job management`)
- Remote branch: `origin/feat/bl-semrush-automation`
- Worktree was clean when this handoff was written.
- Main at the time this project started: `844f035`
- Dashboard route/tab: `/hht-bl`, labeled `HHT BL analysis`
- Durable pipeline CLI: `pnpm hht:bl`
- Active database run: `run_id = 1`

Important implementation files:

- `packages/data/src/scripts/hht-links.mts`
- `packages/data/src/hht-bl/jobs.ts`
- `packages/data/src/hht-bl/import.ts`
- `packages/data/src/hht-bl/semrush.ts`
- `packages/data/src/hht-bl/dashboard.ts`
- `packages/data/src/hht-bl/scoring.ts`
- `packages/core/src/hht-bl/types.ts`
- `config/hht-bl/pipeline.yml`
- `apps/web/src/app/hht-bl/page.tsx`

## Exact Durable Run State

Run `pnpm hht:bl status` first to confirm the checkpoint. At handoff time it reported:

```text
Run #1 RUNNING at competitor_discovery
serp_discovery       complete  jobs 250  records 765
competitor_discovery pending   jobs 44   records 120
site_enrichment      pending   jobs 301  records 80
backlink_matrix      complete  jobs 3    records 100
backlink_collection  complete  jobs 16   records 530
Candidates 346; research sites 8; backlinks 356; opportunities 44
```

Exact job breakdown:

```text
phrase_organic             COMPLETE 111, CANCELLED 139
domain_rank                COMPLETE 40,  PENDING 260
backlinks_comparison       COMPLETE 1
domain_organic_organic     COMPLETE 6,   PENDING 16
backlinks_competitors      COMPLETE 6,   PENDING 16
backlinks_matrix           COMPLETE 3
backlinks_refdomains       COMPLETE 8
backlinks                  COMPLETE 8
```

The 139 cancelled SERP jobs were deliberately parked when discovery changed from keyword-first to site-first. Do not resume them. Their 111 completed counterparts and 765 rows are preserved.

The eight currently selected research sites are:

```text
1 capturencrave.com
2 thehoteljournal.com
3 bookishwayfarer.com
4 hotelsromantic.com
5 youshouldgohere.com
6 thehotelguru.com
7 myboutiquehotel.com
8 poconomountains.com
```

Their backlink collection is already complete. Do not repurchase it.

## Semrush Connection State

The Semrush plugin is `semrush@openai-curated-remote`. The user should attach it to the new session with:

```text
[@semrush](plugin://semrush@openai-curated-remote)
```

The expected tools include `semrush_get_report_schema` and `semrush_execute_report`, plus report discovery tools for domain overview, organic research, competitors, and backlinks.

The user sees 49,990 units in the newly selected Semrush account. In the old Codex session on 2026-08-16, both a `domain_rank` schema request and a direct one-row `domain_rank` report incorrectly returned the Semrush "active subscription but not enough API units" message. No response was imported and no durable job changed. This appears to be a stale or mismatched connector authorization in that session.

In this new session, do not spend time diagnosing the old session. Attach Semrush and immediately test the actual report using the first pending job. The first pending job at handoff was:

```text
job 698
report: domain_rank
target: tripadvisor.com
limit: 1
estimated maximum cost: 10 units
```

Print its exact request with:

```bash
pnpm hht:bl request --job-id=698
```

Execute exactly that report and params through Semrush. If it succeeds, wrap and import it immediately. If job 698 is no longer pending, query the next pending `domain_rank` job and use that instead. If the same insufficient-units response appears even though the user sees 49,990, report the mismatch concisely and ask the user to reattach/reconnect Semrush in that new session. Do not alter the queue or fabricate data.

## Semrush Execution Contract

Never call Semrush from application code. Codex invokes Semrush MCP; the CLI owns durable planning, filtering, imports, checkpoints, and errors.

For every job:

1. Run `pnpm hht:bl request --job-id=N` and use the exact emitted report and params.
2. The request command applies provider filters. For `backlinks`, it adds a provider-side follow filter before the API call. Never remove or weaken that filter.
3. Call `semrush_execute_report` with that report and params.
4. Preserve the returned CSV/text body losslessly.
5. Import the result before starting the next batch.

Use up to 10 concurrent calls with `Promise.allSettled`. Do not launch the entire queue at once. One batch is 10 jobs so completed responses can be persisted even if the next batch hits the account boundary.

Persist each batch as JSON under `exports/hht-bl/`, using this shape:

```json
[
  {
    "jobId": 698,
    "envelope": {
      "report": "domain_rank",
      "params": {},
      "body": "exact Semrush response body",
      "estimatedUnitsConsumed": 10
    }
  }
]
```

Then import it:

```bash
pnpm hht:bl import --run-id=1 --file=exports/hht-bl/<batch-file>.json
```

Use the actual params, body, and estimated units for every entry. Estimate units from returned data rows, not the requested maximum. Header-only or `NOTHING FOUND` results consume zero unless Semrush states otherwise. Existing cost assumptions are:

```text
domain_rank                 10 units per returned row
domain_organic_organic      40 units per returned row
backlinks_competitors       40 units per returned row
backlinks_refdomains        40 units per returned row
backlinks                   40 units per returned row
backlinks_matrix            40 units per returned row
phrase_organic              10 units per returned row
```

Treat these messages as credential boundaries: insufficient units, not enough API units, API units balance is zero, payment required, unauthorized, access denied, or ERROR 132. Import all successful responses from the batch first. For affected jobs run:

```bash
pnpm hht:bl mark-error --job-id=N --message="<exact Semrush credential error>"
```

This marks them `WAITING_FOR_CREDENTIALS` and shows the alert in the dashboard. After the user swaps the authorized account in Codex, resume each affected job with:

```bash
pnpm hht:bl resume --job-id=N
```

Then retry from its saved offset. Never repeat completed jobs or previously imported pages.

## Execution Order

### 1. Validate the current candidate universe

Run all 260 pending one-row `domain_rank` jobs in 10-call batches. Maximum expected cost is about 2,600 units. This establishes whether each candidate has meaningful US organic visibility.

### 2. Expand through competitors

Run the 16 pending `domain_organic_organic` jobs and 16 pending `backlinks_competitors` jobs in 10-call batches. Each requests at most 10 rows. Maximum expected cost is about 12,800 units.

These 32 jobs are already queued from the strongest existing seed domains. Do not queue duplicates before finishing them.

### 3. Validate newly discovered domains

After competitor imports complete:

```bash
pnpm hht:bl queue-domain-validation --run-id=1 --limit=1000
pnpm hht:bl status
```

Run every newly created `domain_rank` job in 10-call batches.

### 4. Classify and rank candidates

Use the existing broad travel/hotel heuristic. Include transferable independent publishers, destination/editorial sites, hotel discovery/affiliate sites, amenity specialists, and achievable directories. Exclude obvious non-travel noise, social/search platforms, hotel chains and individual property sites as research targets, spam/PBNs, dead sites, and giant generic platforms whose backlink playbook is not transferable. Large platforms can remain recorded as discovery evidence.

Preserve classifications through the existing `import-site-classifications` command; do not overwrite raw Semrush data. Then run:

```bash
pnpm hht:bl rank-sites --run-id=1
pnpm hht:bl select-sites --run-id=1 --limit=20
```

Inspect the selected domains for actual research usefulness before buying backlinks. Existing selected sites remain idempotently selected.

### 5. Queue and collect follow backlinks

Queue up to 20 total selected sites:

```bash
pnpm hht:bl queue-backlinks --run-id=1 --site-limit=20 --refdomain-limit=10 --backlink-limit=50
```

The existing eight sites should not produce duplicate jobs. For approximately 12 new sites, the maximum expected cost is:

```text
referring domains: 12 x 10 x 40 = 4,800 units
detailed backlinks: 12 x 50 x 40 = 24,000 units
maximum total: 28,800 units
```

Run `backlinks_refdomains` first, then `backlinks`. Detailed backlink requests must contain the provider-side follow filter emitted by `pnpm hht:bl request`. The importer also rejects nofollow rows defensively, but filtering at request time prevents wasting credits.

### 6. Continue local downstream stages

After collection, run local stages without repurchasing Semrush data:

```bash
pnpm hht:bl crawl --run-id=1 --limit=75 --concurrency=5
pnpm hht:bl analysis-queue --run-id=1
```

Process/import link-context and acquisition-mechanism analyses using the existing JSONL contract, then:

```bash
pnpm hht:bl score-opportunities --run-id=1
pnpm hht:bl cluster-strategies --run-id=1
pnpm hht:bl export --run-id=1
```

Repeat crawl/analysis batches until no eligible records remain. Do not couple these local stages to new Semrush calls.

## Verification and Communication

- Run `pnpm hht:bl status` after every imported Semrush batch and report concise progress periodically.
- Run `pnpm hht:bl cost` to show cumulative estimated usage recorded by the pipeline. It spans all accounts and is not the current account's remaining balance.
- The account's live remaining balance is owned by Semrush, not calculated by the application.
- Alert the user immediately when Semrush reports the credit boundary and give the exact waiting job IDs and resume command.
- Do not ask the user to approve each normal tool call. If database CLI commands require sandbox escalation, request it through the tool and continue after auto-review.
- Keep all successful raw responses. Do not delete existing files in `exports/hht-bl/`.
- Do not revert unrelated user changes.
- Focus updates on completed jobs, imported rows, estimated units, new candidates, and the exact next stage.

## First Message for the New Session

The user can start the new session with:

```text
Read /Users/kaisulkin/serp-scout/HHT_BL_SESSION_HANDOFF.md in full. Attach and use @semrush. Continue run 1 immediately from the saved queue, beginning with the one-row canary described there. Do not repeat completed work, and continue in persisted 10-call batches until the connected account reaches its Semrush credit boundary.
```
