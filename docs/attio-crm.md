# Attio outreach CRM

GitHub is authoritative for **targets**. Attio is authoritative for **outreach state**.
Nothing in this pipeline sends email.

```
GitHub data → Attio Company lists → research → (human/agent send) → Gmail
        → reply detection → follow-up tasks → outcome tracking
```

## Source datasets

| Workstream | Canonical source | Identity |
|---|---|---|
| Editor's Choice | Hotel Hot Tubs `content/editors-choice.json` + `content/inventory.json.gz` + `content/editors-choice-press-contacts.csv` | `editor-choice:<slug>` |
| Backlink Targets | Postgres `hht_px_prospect_pages` where `is_prospectable` (existing SERP classifier) | `backlink:<canonical-article-url>` |
| Guest Post Targets | Postgres `hht_opp_opportunities` of type `editorial_guest` / `paid_guest_post`, plus `config/attio/guest-post-submission-rules.csv` | `guest-post:opp-<id>` or `guest-post:<domain>:<guidelines-url>` |

Inventory `sourceUrl` / `bookingUrl` are scrape and affiliate links, **not** hotel websites. Official hotel domains come from the press-contacts CSV.

## Campaign columns

These are source-owned list attributes. After `attio:setup --apply` and a resync, add them as columns on the Attio table view (the default view does not auto-show new attributes).

| List | Column | Source | Honest gaps |
|---|---|---|---|
| Editor's Choice | Hotel Website | `editors-choice-press-contacts.csv` `hotel_website` | Blank when the CSV has no official site (OTA URLs are rejected). |
| Editor's Choice | HHT Listing URL | `content/editors-choice.json` slug/href | Always present for membership hotels. |
| Editor's Choice | Press / Media Page | CSV `press_contact_page` | Blank when unknown. |
| Editor's Choice | Primary Contact | `hotel-press-prospects-*.csv` `pr_email` / `pr_name` | Blank when that scrape has no email for the hotel. `editors-choice-press-contacts.csv` is only website + press page. |
| Backlink Targets | Target Article URL | `hht_px_prospect_pages` canonical URL | Page, not root domain. |
| Backlink Targets | SERP Keyword / Position / Volume | best `hht_px_page_keyword_matches` row | Highest-volume keyword that page ranks for. |
| Backlink Targets | Authority | Semrush `authority_score` on the prospect domain | **Not Moz DA.** |
| Backlink Targets | Referring Domains | Semrush referring domains | Inbound, not outbound. |
| Backlink Targets | Outbound Links | `hht_opp_crawled_pages.external_link_count` when the same URL was crawled | Usually blank — SERP prospect pages are not crawled for outbound links. |
| Guest Post Targets | Target Page URL | `relevant_article_url` or guidelines URL | Page, not root domain. |
| Guest Post Targets | Outbound Links | crawled page, else domain `avg_external_links` | Null if neither exists. |
| Guest Post Targets | Authority | Semrush `authority_score` | **Not Moz DA.** |
| Guest Post Targets | SERP Keyword / Position / Volume | join to `hht_px_prospect_pages` on the same URL | Blank unless that page also appears in HHT prospecting. |

## Outreach touch columns

These are CRM-owned dates on **all three** Company lists. GitHub sync never overwrites them once set.

| Column | Slug | Meaning |
|---|---|---|
| 1st Contact | `contact_1_date` | First outbound email |
| 2nd Contact | `contact_2_date` | First follow-up send |
| 3rd Contact | `contact_3_date` | Second follow-up send |
| 4th Contact | `contact_4_date` | Third follow-up send |
| Replied At | `replied_at` | First inbound reply from the lead |
| Outreach Date | `outreach_date` | Mirrors 1st Contact when blank (used by follow-up tasks) |

Backfill from Gmail (`claire@hotelhottubs.com` sent mail) with:

```bash
pnpm attio:outreach --dry-run
pnpm attio:outreach --apply
```

Matching is email-first (Primary Contact person), then unique company domain. Shared inboxes (`gmail.com`) and ambiguous parent companies (several hotels on `vestahospitality.com`) are left unmatched rather than guessed. Status moves New → Contacted → Replied only; Positive / Won / Rejected are never overwritten.

Existing Attio People lists (`Editor's Choice` / `press_outreach`, `Backlinks (purchase & request)` / `content_co_creation`, `Guest Post Request` / `content_co_creation_3`) are left untouched as legacy data. New Company lists:

- `editors_choice_targets`
- `backlink_targets`
- `guest_post_targets`

## Commands (serp-scout)

```bash
pnpm attio:setup --dry-run
pnpm attio:setup --apply

pnpm attio:sync --source=backlinks --dry-run
pnpm attio:sync --source=guest-posts --dry-run
pnpm attio:sync --source=all --apply

pnpm attio:followups --dry-run
pnpm attio:followups --apply

pnpm attio:outreach --dry-run
pnpm attio:outreach --apply
```

`--apply` is required to mutate Attio. Passing neither `--apply` nor `--dry-run` still dry-runs (`dryRun = !opts.apply`).

Without `ATTIO_API_KEY`, setup/sync still print an offline plan of lists and source record counts. They do not call Attio. Follow-ups and Gmail outreach backfill need the key even in dry-run because they read live list entries.

Editor's Choice from this repo needs `HHT_REPO=/path/to/hottub-hotels`. Production EC sync runs in the Hotel Hot Tubs repository so Actions never checks out the other private repo.

## Manual secret setup

Cursor cannot create GitHub repository secrets. Do this once:

1. In Attio: **Workspace settings → Developers → API keys** (or [developer settings](https://app.attio.com)). Create a **workspace access token**.
2. Grant these scopes (from the current `/v2` docs):

   **Required for setup + sync**
   - `list_configuration:read-write` — create/update lists, attributes, statuses, select options
   - `list_entry:read-write` — create/update list entries
   - `record_permission:read-write` — upsert Companies and People
   - `object_configuration:read` — read object/attribute configuration
   - `note:read-write` — source-context notes on Companies

   **Required for follow-up tasks**
   - `task:read-write`
   - `user_management:read`

   **Optional, reply detection only** (alpha `GET /v2/emails`; content is never returned)
   - `email:read`
   - Plus workspace enablement: contact [support@attio.com](mailto:support@attio.com) if the emails endpoint is still gated.

3. Add `ATTIO_API_KEY` as a GitHub Actions secret on **both** `LoganOneal/serp-scout` and `LoganOneal/hottub-hotels`.
4. On **serp-scout** also add `DATABASE_URL` (same Postgres the app uses) so backlink/guest-post sync can read `hht_px_*` / `hht_opp_*`.
5. Run setup once, then both sync jobs:

```bash
# from serp-scout
pnpm attio:setup --apply
pnpm attio:sync --source=backlinks --apply
pnpm attio:sync --source=guest-posts --apply

# from hottub-hotels
npm run attio:setup -- --apply
npm run attio:sync -- --apply
```

`ATTIO_SEND_ENABLED` must stay unset/`false`. Follow-up Actions create Tasks only.

## Reply detection

`GET /v2/emails` returns `direction: inbound | outbound` and `sent_at`, which is enough to answer “did this person/company reply after Outreach Date?” when the alpha endpoint is enabled. If Attio returns 403/404, the detector records nothing and does not guess. Gmail MCP can implement the same `ReplyDetector` interface later.

## Follow-up cadence

Defaults, overridable:

```
ATTIO_FOLLOWUP_FIRST_DAYS=6
ATTIO_FOLLOWUP_SECOND_DAYS=7
```

Tasks include `[hht-followup:<source-key>:1]` then `:2`. Duplicates are skipped.

## Configure this in Attio

The API can create list attributes. It **cannot** add those attributes as columns on a table view, connect Gmail, or turn on sequences. Do this in the UI once per list.

### Show the new columns on each table

Attio's default list view is usually just **Company**. New attributes exist on the records but stay hidden until you pin them.

For **Editor's Choice Targets**, **Backlink Targets**, and **Guest Post Targets**:

1. Open the list.
2. Switch to (or create) a **Table** view.
3. Click **View settings** (or the **+** at the right of the column header row).
4. **Add column** for each of: Status, Sequence, **Suppress Outreach**, Primary Contact, **1st Contact**, **2nd Contact**, **3rd Contact**, **4th Contact**, **Replied At**, Outreach Date, Next Follow-up, then the campaign fields you care about (Hotel Website, SERP Keyword, etc.).
5. Save the view so everyone sees the same columns.

Do not add the nested Primary Contact fields (Name / Email / Job title) as separate columns unless you want them; the parent **Primary Contact** column is the person record.

### Connect Gmail so future sends show on the record

This backfill is a one-time snapshot of `claire@hotelhottubs.com`. Ongoing mail needs Attio's own Gmail connection:

1. In Attio: **Workspace settings → Email** (or **Integrations → Gmail**).
2. Connect **claire@hotelhottubs.com**.
3. Enable syncing sent and received mail onto People / Company records.
4. Optional: on a Person record, use **Log email** / **Send email** so outbound from Attio is tied to that contact automatically.

Until that connection exists, 2nd/3rd/4th Contact and Replied At will not fill themselves. Either re-run `pnpm attio:outreach --apply` after exporting a fresh `config/attio/gmail-outreach.json`, or set the dates by hand on the row.

### Sequences / follow-ups

**Attio Sequences are not free.** They are [Pro and Enterprise only](https://attio.com/help/reference/automations/sequences/create-a-sequence). Free and Plus cannot run them. Pro is $79/user/month billed annually ($99 monthly) as of Attio's public pricing page.

Attio also says Sequences are the wrong tool for cold or high-volume outreach, and every sequence email must include an unsubscribe link. Editor's Choice press mail is 1:1 PR, so we do not buy Pro for this.

**Free auditable flow** (what this repo uses):

1. Copy lives in `config/attio/email-flow.json`. Editor's Choice has three tracks, classified from the **first email Claire actually sent** (not from the scraped CSV contact):
   - **New contact** — four touches. Email 1 is recognition + fact-check only; the Press/Awards ask waits until email 3.
   - **Asked backlink** — hotels whose first email already asked for a Press/Awards placement. Follow-ups: forget the backlink → badge assets → soft return to the original ask.
   - **Fact-check** — hotels whose first email only asked to verify rooms/photos. Follow-ups: easy confirmation → recognition + photos/badge → first placement ask.
   Cadence is +2 days. **Due follow-ups always fill the daily 30-email cap before any new first-touch.** Existing threads that have already waited longer than 2 days are still due today (one catch-up email). After that send, the next step in the same thread waits 2 days — never two sequence steps to the same hotel on the same day. Every send requires a first name (or hotel-team greeting) and listing URL. New-contact email 1 also needs a property-specific blurb. Fact-check follow-up 1 needs `fact_to_verify` from the live listing. Missing personalization blocks the draft. Claire reviews Gmail drafts the night before; 9am Eastern sends only drafts that were left in the folder.
2. We create **Gmail drafts** from that file. Nothing sends until a human hits send in Gmail.
3. After send, 1st–4th Contact / Replied At / Sequence stamp from the mailbox. Matching uses the sent hotel name and `hotelhottubs.com` listing URL, so a thread still lands on the hotel even if To: is an agency inbox that was not in the scraped CSV.
4. `pnpm attio:followups` still only creates **Tasks**. `ATTIO_SEND_ENABLED` stays unset.

If you later pay for Pro, Sequences can mirror the same cadence. Do not enrol until the JSON copy is signed off.

### Manual date entry

On any row: click the 1st/2nd/3rd/4th Contact or Replied At cell and pick a date. That value is CRM-owned; the next GitHub sync will not blank it.
