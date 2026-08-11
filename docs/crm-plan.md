# Sites & CRM — turning research into revenue

The research modules answer *which domain should I buy*. This adds the other half:
**what happened after I bought it.** A site, its calls, its recordings, its leads.

```
  scan_runs ──► scan_targets ──► shortlist_items ──► sites ──► calls ──► leads
  (research, today)              (the decision)      (NEW: the asset and its revenue)
```

---

## Why this belongs in this repo and not in a separate app

`shortlist_items` already freezes `difficulty_at_save`, `verdict_at_save`, and
`weight_covered_at_save` at decision time, and the README is explicit that modelled
rent is *a prior until outcome data says otherwise*. Today the only outcome data is
`outcomes.position` — did it rank.

**Ranking is not the outcome. Calls are.** A site at position 3 that produces two
calls a month falsifies the rent model just as loudly as one that never ranked, and
right now nothing in the system can see that.

Once `sites` carries `locality_id`, `niche_id`, and an optional `shortlist_item_id`,
the CRM stops being a side feature and becomes **the measurement layer for
`priors.ts`**. "HVAC in a 100k-population city yields 14 calls/month at $X/lead" is
computed from `calls`, not modelled. That feeds `calibration.ts` the same way
`outcomes` does.

Build it anywhere else and that loop stays open forever.

---

## The one new trap, and it is the repo's founding bug again

The README's origin story is a Start-scan button that silently did nothing, because a
queue nobody polled is indistinguishable from a queue with nothing in it.

The exact same failure is waiting here: **a Retell number whose webhook URL was never
pasted in produces real calls, sends nothing, and renders as `0 calls`.** Zero calls
and never-connected look identical on a dashboard. You would sit there believing the
site gets no traffic.

So, as a hard requirement carried into the schema and the UI:

> **A site that has never received a webhook must say so, loudly, and must never
> render as a site with zero calls.**

`sites.first_webhook_at` is nullable and drives a permanent banner until it is set.
Same rule as `difficulty` sorting last: absence of measurement is displayed as
absence, never as a zero.

---

## How multi-tenancy actually works: one agent, many sites

You built one agent. You do not need one per site, and you should not make one per
site — N copies of a prompt drift, and Retell's dashboard becomes the source of truth
instead of Postgres.

The mechanism is Retell's **inbound call webhook**. It fires *before* the call
connects and lets your server inject per-site context:

```
 caller dials (414) 555-0134
        │
        ▼
 Retell ── POST /api/retell/inbound ──►  your handler
        │                                  to_number → sites row
        │                                  │
        │   ◄── 200 { call_inbound: {  ────┘
        │            dynamic_variables: { business_name, city, niche,
        │                                 hours, service_area, dispatch_fee },
        │            metadata: { site_id: 42 } } }
        ▼
 agent answers "Thanks for calling Kenosha Air, ..."
```

Your agent prompt uses `{{business_name}}`, `{{city}}`, `{{dispatch_fee}}`. One
prompt, one agent, every site correct. Adding a site is an INSERT plus a number, not
a new agent.

### `metadata.site_id` is the join key — freeze it, don't re-derive it

`metadata` set here flows through every later webhook for that call. Use it as the
only way `calls` learns its `site_id`.

**Do not resolve the site by phone number at report time.** Numbers get reassigned
between sites, and a lookup-at-report-time silently reattributes every historical
call the moment you move a number. Resolving once at ring time and freezing it is the
same discipline as `difficulty_at_save`.

### When the inbound webhook fails

Retell allows 10s, retries 3×, then falls back to the number's default agent **with
no dynamic variables**. Two consequences to build for:

1. **The prompt must degrade gracefully.** An agent that opens with
   `"Thanks for calling {{business_name}}"` and no variable says the braces out loud.
   Give every variable a neutral fallback in the prompt itself.
2. **The call arrives with no `site_id`.** It must land in `calls` with
   `site_id = NULL` and `unattributed_reason` set, and appear in an *Unattributed*
   view. Never dropped, never guessed.

---

## Schema

Six tables. Conventions copied from `packages/data/src/schema.ts` — `serial` ids,
`bigint` micros, `now()` helper, nullable-means-unmeasured, comments that say why.

### `sites` — the asset

```ts
export const sites = pgTable('sites', {
  id: serial('id').primaryKey(),
  /** The domain you bought. Lowercased, no scheme, no www. The natural key. */
  domain: text('domain').notNull(),

  /** Asked on the create form. NOT NULL: these are what make the list sortable
   *  and what let call volume roll up into calibration by locality and niche. */
  localityId: integer('locality_id').notNull().references(() => localities.id),
  nicheId: integer('niche_id').notNull().references(() => niches.id),

  /**
   * NULLABLE. Set when the site came from a scan, which is the common path.
   * This is the link that turns `calls` into outcome data for the rent model --
   * without it a site is revenue with no prediction to falsify.
   */
  shortlistItemId: integer('shortlist_item_id')
    .references(() => shortlistItems.id, { onDelete: 'set null' }),

  status: text('status').$type<SiteStatus>().notNull().default('parked'),
  displayName: text('display_name'),          // "Kenosha Air" -- spoken by the agent
  trackingNumber: text('tracking_number'),    // E.164. NULL = not wired up yet.
  retellAgentId: text('retell_agent_id'),
  retellAgentVersion: integer('retell_agent_version'),

  /** Agent context. Rendered into dynamic_variables on every inbound call. */
  timezone: text('timezone').notNull().default('America/Chicago'),
  hours: jsonb('hours').$type<WeeklyHours>(),
  serviceAreaZips: jsonb('service_area_zips').$type<string[]>(),
  dispatchFeeMicros: bigint('dispatch_fee_micros', { mode: 'bigint' }),
  onCallNumber: text('on_call_number'),
  leadAlertNumber: text('lead_alert_number'),

  /**
   * NULL = Retell has never called us for this site.
   *
   * Drives a permanent "not connected" banner. Without this, a number whose
   * webhook URL was never pasted in is indistinguishable from a site nobody
   * has called -- the same silent-dead-button failure the queue design exists
   * to prevent.
   */
  firstWebhookAt: timestamp('first_webhook_at', { withTimezone: true }),
  lastWebhookAt: timestamp('last_webhook_at', { withTimezone: true }),

  purchasedAt: timestamp('purchased_at', { withTimezone: true }),
  notes: text('notes'),
  createdAt: now(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  domainUq: uniqueIndex('sites_domain_uq').on(t.domain),
  // Partial unique in a raw migration: one ACTIVE site per tracking number.
  // History must survive a number being reassigned, so this cannot be a plain uq.
  trackingIdx: index('sites_tracking_idx').on(t.trackingNumber),
  cellIdx: index('sites_cell_idx').on(t.localityId, t.nicheId),
}))
```

`SiteStatus = 'parked' | 'building' | 'live' | 'rented' | 'dropped'` in
`@rnr/core/types.ts`.

**Two state machines — resolve it now, not later.** `shortlist_items.state` is
already `'watching' | 'building' | 'ranking' | 'rented'`. Overlapping lifecycles that
both claim to be authoritative diverge silently.

The rule: **`shortlist_items.state` is research-side bookkeeping; `sites.status` is
authoritative once a site row exists.** Creating a site sets the linked shortlist item
to `'building'` exactly once and never touches it again. The shortlist UI, where a
site exists, renders `sites.status` and stops offering the state selector. One
sentence in the schema comment; hours saved.

### `calls`

```ts
export const calls = pgTable('calls', {
  id: serial('id').primaryKey(),
  /** Retell's id. UNIQUE -- this is the idempotency key for 3x webhook retries. */
  retellCallId: text('retell_call_id').notNull(),

  /**
   * NULLABLE. Frozen from metadata.site_id at ring time, never re-derived from
   * to_number later (a reassigned number would rewrite history).
   * NULL + unattributedReason = the inbound webhook did not resolve. Visible,
   * never dropped, never guessed.
   */
  siteId: integer('site_id').references(() => sites.id, { onDelete: 'set null' }),
  unattributedReason: text('unattributed_reason'),

  direction: text('direction').notNull().default('inbound'),
  fromNumber: text('from_number'),
  toNumber: text('to_number'),
  agentId: text('agent_id'),

  /**
   * Row is created on `call_started`, NOT on `call_ended`.
   *
   * A caller who hangs up at four seconds is a MEASUREMENT -- abandon rate is how
   * you learn the greeting is too slow or too obviously synthetic. Create the row
   * at end-of-call and every abandoned call vanishes and the funnel looks perfect.
   */
  startedAt: timestamp('started_at', { withTimezone: true }),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  durationMs: integer('duration_ms'),
  disconnectionReason: text('disconnection_reason'),

  /** 'started' | 'ended' | 'analyzed' -- how far the webhook sequence got. */
  ingestState: text('ingest_state').notNull().default('started'),

  transcript: text('transcript'),
  transcriptObject: jsonb('transcript_object'),

  /** Retell's post-call analysis, stored raw for audit. */
  analysis: jsonb('analysis'),
  userSentiment: text('user_sentiment'),
  /** NULLABLE three-state. NULL = not analyzed yet, which is not "unsuccessful". */
  callSuccessful: boolean('call_successful'),
  inVoicemail: boolean('in_voicemail'),

  /**
   * Retell reports latency percentiles per call (e2e / llm / tts). Persisted
   * because "callers can't tell it's AI" is a claim that needs a number, and p95
   * is the one that generates complaints -- see voice-agent-plan.md.
   */
  latencyE2eP50Ms: integer('latency_e2e_p50_ms'),
  latencyE2eP90Ms: integer('latency_e2e_p90_ms'),
  latencyE2eP95Ms: integer('latency_e2e_p95_ms'),

  costMicros: bigint('cost_micros', { mode: 'bigint' }),

  /** Retell's S3 link. Expires -- see the recordings section. Not a source of truth. */
  recordingUrlUpstream: text('recording_url_upstream'),
  /** NULL = we do not have the audio. Never render a play button on a NULL. */
  recordingPath: text('recording_path'),
  recordingBytes: integer('recording_bytes'),
  recordingFetchedAt: timestamp('recording_fetched_at', { withTimezone: true }),
  /** Why we don't have it. NULL + NULL path = not attempted yet. */
  recordingMissingReason: text('recording_missing_reason'),

  createdAt: now(),
}, (t) => ({
  retellUq: uniqueIndex('calls_retell_call_id_uq').on(t.retellCallId),
  siteTimeIdx: index('calls_site_time_idx').on(t.siteId, t.startedAt),
  unattributedIdx: index('calls_unattributed_idx').on(t.siteId, t.createdAt),
}))
```

### `leads`

The nullable discipline is the whole point of this table.

```ts
export const leads = pgTable('leads', {
  id: serial('id').primaryKey(),
  siteId: integer('site_id').references(() => sites.id, { onDelete: 'set null' }),
  callId: integer('call_id').references(() => calls.id, { onDelete: 'set null' }),
  /** NULL for a future web-form lead. */
  source: text('source').notNull().default('call'),

  name: text('name'),
  phone: text('phone'),
  email: text('email'),
  addressLine: text('address_line'),
  city: text('city'),
  zip: text('zip'),

  problem: text('problem'),
  systemType: text('system_type'),
  systemAgeYears: integer('system_age_years'),

  /**
   * ============ NULL IS NOT FALSE, AND THIS ONE CAN HURT SOMEONE ============
   * NULL = the agent never established urgency. Rendering that as "routine"
   * is how a no-heat call at 11pm in January gets queued for Tuesday.
   * ========================================================================
   */
  isEmergency: boolean('is_emergency'),
  /** NULL = zip never validated. An unvalidated zip is not an in-area zip. */
  inServiceArea: boolean('in_service_area'),
  /** NULL = never determined. Renters usually cannot authorize work. */
  isOwner: boolean('is_owner'),
  /** NULLABLE, sorts LAST -- exactly like scan_targets.difficulty. */
  qualified: boolean('qualified'),

  /**
   * Which fields the agent actually ASKED AND CONFIRMED, independent of their
   * values. "address is null" and "address was never asked" are different bugs
   * and only one of them is the agent's fault.
   */
  capturedFields: jsonb('captured_fields').$type<string[]>().notNull().default(sql`'[]'::jsonb`),

  /** 'tool' (mid-call, authoritative) | 'analysis' (post-call backfill). */
  capturedVia: text('captured_via').notNull(),
  /** Set when post-call analysis disagreed with the mid-call tool. A prompt bug. */
  reconcileConflict: jsonb('reconcile_conflict'),

  appointmentAt: timestamp('appointment_at', { withTimezone: true }),
  createdAt: now(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  callIdx: index('leads_call_idx').on(t.callId),
  siteTimeIdx: index('leads_site_time_idx').on(t.siteId, t.createdAt),
}))
```

### `webhook_events` — append-only

```ts
export const webhookEvents = pgTable('webhook_events', {
  id: serial('id').primaryKey(),
  provider: text('provider').notNull().default('retell'),
  eventType: text('event_type').notNull(),
  retellCallId: text('retell_call_id'),
  siteId: integer('site_id').references(() => sites.id, { onDelete: 'set null' }),
  payload: jsonb('payload').notNull(),
  signatureValid: boolean('signature_valid').notNull(),
  /** NULL = handled cleanly. Set = the handler threw; the row is the retry record. */
  handlerError: text('handler_error'),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // Retell's documented idempotency key: event + call_id.
  dedupeUq: uniqueIndex('webhook_events_dedupe_uq').on(t.eventType, t.retellCallId),
  callIdx: index('webhook_events_call_idx').on(t.retellCallId),
}))
```

Insert first, process second. A handler that throws still leaves the payload on disk,
so every bug is replayable instead of lost — the same reason `spend_ledger` stores a
row per purchase rather than a running total.

### `voice_jobs` — the queue, same pattern as `scan_runs`

```ts
export const voiceJobs = pgTable('voice_jobs', {
  id: serial('id').primaryKey(),
  /** 'fetch_recording' | 'deliver_lead' | 'backfill_call' */
  kind: text('kind').notNull(),
  callId: integer('call_id').references(() => calls.id, { onDelete: 'cascade' }),
  leadId: integer('lead_id').references(() => leads.id, { onDelete: 'cascade' }),
  status: text('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  /** Backoff. The claim query only takes rows whose time has come. */
  runAfter: timestamp('run_after', { withTimezone: true }).notNull().defaultNow(),
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  claimedBy: text('claimed_by'),
  lastError: text('last_error'),
  createdAt: now(),
}, (t) => ({
  claimIdx: index('voice_jobs_claim_idx').on(t.status, t.runAfter),
}))
```

Same `FOR UPDATE SKIP LOCKED` claim as `claimNextRun`, same redrive-stuck sweep, and
**the same single consumer** — `pnpm worker`. No Redis, no second system, no
dispatcher to forget.

### `lead_deliveries`

One row per delivery attempt, mirroring `spend_ledger`'s discipline: whether the
contractor actually received the lead becomes *reconcilable* rather than assumed. A
lead captured perfectly and never delivered is a lost lead, and a summary counter
would hide it.

### One migration to an existing table

`spend_ledger` gains a nullable `site_id`. Retell's `call_cost.combined_cost` arrives
in cents; convert with `centsToMicros` and write a ledger row with endpoint
`retell/call`. Voice spend then reconciles through the exact same path as DataForSEO
spend, and **cost-per-lead per site** — the number that decides whether a rank-and-rent
site is worth keeping — is a join rather than a spreadsheet.

---

## Endpoints

All under `apps/web/src/app/api/retell/`. Node runtime, not edge — signature
verification needs the raw body.

| Route | Fires | Does |
|---|---|---|
| `POST /api/retell/inbound` | before connect | `to_number` → site → returns `dynamic_variables` + `metadata.site_id`. **Must answer in <10s.** |
| `POST /api/retell/events` | started / ended / analyzed | verify → insert `webhook_events` → upsert `calls` → enqueue `fetch_recording` |
| `POST /api/retell/tool/save-lead` | mid-call | upsert `leads`, enqueue `deliver_lead`, return a short string |

### The inbound handler is inside the caller's ring time

It runs while the phone is ringing. One indexed lookup by `tracking_number` and a
JSON response — no analytics writes, no lead-history queries, no cold Postgres
connection. Budget under 100ms. If the site is missing or `status = 'dropped'`,
return `{}` rather than `reject: true`; the default agent picking up with a generic
greeting beats a dead line, and the resulting unattributed call is your alert that
something is misconfigured.

### Signature verification, without a bypass

Verify `x-retell-signature` with `Retell.verify(rawBody, apiKey, signature)` on
`/events` and `/tool/*`. Persist `signature_valid` on the event row.

**Do not add a `SKIP_SIGNATURE` env var.** That flag ships to production eventually
and turns the CRM into an open write endpoint — anyone could POST fabricated leads.
The simulator below signs its payloads with the same key instead, so the verified
path is the only path and it is also the tested path.

The tool endpoint is a write endpoint reachable from the public internet. Rate-limit
per `call_id` and reject a `call_id` with no matching `calls` row.

---

## Recordings must be re-hosted

Retell's `recording_url` is an S3 link whose lifetime the docs do not specify — and
if you enable *Opt-Out of Personal and Sensitive Data Storage*, the docs are explicit
that the link **is accessible for 10 minutes and then deleted**.

A CRM whose headline feature is "recordings of every call" cannot be built on a URL
someone else expires. So on `call_analyzed`: store the upstream URL, enqueue
`fetch_recording`, and let the worker download the WAV into `RECORDINGS_DIR`
(`{site_id}/{yyyy-mm}/{retell_call_id}.wav`). Local disk for v1 — the path is a
column, so S3 later is a writer swap, not a migration.

Served through `GET /api/recordings/[callId]`, which authorizes and streams from
`recording_path`. Never a direct filesystem path in HTML.

**The UI rule:** a `NULL recording_path` renders as "Recording unavailable" plus
`recording_missing_reason` — never a play button that 404s. Same rule as everywhere
else in this codebase: absence of data is displayed as absence.

---

## Lead capture: two paths, one winner

**Path 1 — mid-call custom function (authoritative).** `save_lead` on the Retell
agent, pointed at `/api/retell/tool/save-lead`, called as soon as name + phone exist
and again as fields fill. Upsert on `retell_call_id`.

Set **Speak During Execution = off.** An agent narrating "let me just save that for
you" while it writes to your database is pure tell, and it costs a turn. Speak After
Execution off too for this function; the agent should already be asking the next
question.

Path 1 is what makes a lead survive a hang-up — and the caller who gives a name plus
"my furnace is dead" and then hangs up is still worth $50–200 in this business.

**Path 2 — `call_analyzed` (backfill and cross-check).** Retell's
`custom_analysis_data` extracts a configured schema from the transcript after the
call. Use it to fill fields Path 1 missed and to *check* the ones it captured.

Post-call analysis is not the primary path: it produces nothing for an abandoned
call, it lands seconds late, and it can disagree with what the agent actually
confirmed with the caller. **Where they disagree, Path 1 wins and the disagreement is
written to `reconcile_conflict`.** A recurring conflict on the same field is a prompt
bug, and this is the only place it becomes visible.

---

## UI

### `/sites` — the list

Columns: **Domain · Locality · Niche · Status · Calls 30d · Leads 30d · Cost/lead ·
p95 latency · Number**.

Create form: domain (normalized and validated), locality via the existing
`LocalityPicker`, niche from a select of active `niches`, optional "link to shortlist
item" prefilled when arriving from `/shortlist`, display name, timezone, purchase
date. Reuse `Bits.tsx` and the existing server-action pattern in `actions.ts`.

Rendering rules that follow from the governing rule:
- `first_webhook_at IS NULL` → the row shows **"Not connected"**, not `0`.
- `tracking_number IS NULL` → **"No number"**, not `0`.
- Cost/lead over a period with zero leads is an **em dash**, not `$0.00` and not ∞.

### `/sites/[siteId]` — the dashboard

1. **Header** — domain, locality, niche, status, tracking number. If
   `first_webhook_at IS NULL`, a permanent banner: *"Retell has never contacted this
   site. Calls may be happening and going unrecorded."* This banner is the single most
   important element on the page.
2. **KPI row** — calls, answered, abandoned <10s, leads, emergencies, cost/lead,
   e2e p50 / **p95**. Every tile shows an em dash rather than a zero when the
   underlying measurement is absent.
3. **Calls table** — time, from, duration, outcome, sentiment, recording, linked lead.
   Row expands to transcript with tool calls.
4. **Leads table** — with `qualified IS NULL` sorting last, and emergencies pinned.
5. **Form entries** — an honest empty state that says *not yet implemented*. Not a
   zeroed chart; a zeroed chart is a claim that there were no submissions.
6. **Connection panel** — the exact URLs to paste into Retell (inbound webhook,
   events webhook, `save_lead` URL), the resolved agent id, last webhook received,
   and a **Send test event** button that POSTs a signed fixture payload at your own
   endpoint and reports what came back. This is what stops the silent-misconfiguration
   failure from ever being silent.

### Where research meets revenue

On `/sites/[siteId]`, when `shortlist_item_id` is set, show **predicted vs actual**
side by side: `verdict_at_save` and modelled rent against real calls and real
cost-per-lead. That single panel is the payoff for building this inside the repo, and
it is the input `calibration.ts` has been missing.

---

## Fixtures — the whole CRM must be developable with no phone calls

The existing `Providers` seam defaults to fixtures so a missing env var fails toward
$0. Extend the idea:

- `RetellClient` behind an interface, with a fixture implementation for outbound reads
  (`get_call`, recording download) built on the existing `prng.ts` so output is
  deterministic.
- **`pnpm voice:simulate <domain>`** — generates a plausible HVAC call (inbound →
  started → `save_lead` → ended → analyzed), signs each payload with
  `RETELL_API_KEY`, and POSTs them at your own running app in order.

That script is how the dashboard gets built and how the e2e test covers the whole
ingest path without a Retell account or a real phone call. Extend `pnpm e2e` to assert
`spend === 0` across it, exactly as the scan pipeline does.

`LIVE_CALLS_ENABLED` keeps its meaning — it gates *outbound* spend (recording
downloads, `get_call` backfill). Inbound webhooks are free and must always be
accepted, or you would drop real calls whenever the flag was off.

### New env vars

```
RETELL_API_KEY=            # signature verification + API reads
RETELL_AGENT_ID=           # default agent, overridable per site
PUBLIC_BASE_URL=           # what you paste into Retell; ngrok/cloudflared in dev
RECORDINGS_DIR=./.recordings
```

---

## Retell-side setup (once)

**Telephony lives in [`telephony.md`](./telephony.md).** The numbers stay in Twilio and
reach Retell over a Twilio **Elastic SIP Trunk** — there is no "connect your Twilio
account" shortcut, and `termination_uri` is required on Retell's import API even though
this is inbound-only. That doc also covers the Disaster Recovery URL, which is a hard
requirement: without it a Retell outage is a dead business phone line.

The one thing worth repeating here, because it changes this plan: **`inbound_webhook_url`
is a field on `POST /import-phone-number`.** The multi-tenant webhook gets wired at
provisioning time, in the same call that creates the number — so the "forgot to paste
the URL into the dashboard" failure is structurally gone, and
`sites.first_webhook_at` demotes from primary defense to backstop.

Agent-side, once:

1. **Agent → Webhook URL** → `{PUBLIC_BASE_URL}/api/retell/events`.
2. Rewrite the v1 prompt to use `{{business_name}}`, `{{city}}`, `{{niche}}`,
   `{{hours}}`, `{{dispatch_fee}}`, `{{service_area}}` — each with a neutral fallback
   for the degraded path.
3. Add the `save_lead` custom function, speak-during and speak-after both off.
4. Configure post-call analysis fields matching the `leads` columns
   (`is_emergency` bool, `system_type` enum, `zip` text, …).
5. Enable recording. Decide on the PII opt-out — and if you enable it, the
   `fetch_recording` job has a **10-minute** deadline, so the worker must be running.

**Keep the prompt text in this repo** (`packages/core/src/voice/prompt.ts`) and push
it to Retell, rather than editing it in the dashboard. A dashboard edit is an
untracked config change that silently diverges from the row that claims to describe
it — and it forfeits the portability hedge from `voice-agent-plan.md`.

---

## Phases

**Phase 1 — schema + sites list (1–2 days).**
Six tables plus the `spend_ledger.site_id` migration. `SiteStatus` and `WeeklyHours`
in `@rnr/core`. Queries in `queries.ts`, actions in `actions.ts`, `/sites` with the
create form. *Done when:* you can add a bought domain with locality and niche and see
it listed. No Retell yet.

**Phase 2 — the simulator (0.5 day, do it before real webhooks).**
`pnpm voice:simulate` plus signed fixture payloads. *Done when:* one command produces
a complete fake call in Postgres. Every later phase is now debuggable offline, and
this ordering is what keeps you out of "call the number again and squint at logs".

**Phase 3 — webhook ingest (1–2 days).**
The three routes, signature verification, `webhook_events` dedupe, call upsert across
started/ended/analyzed, cost → `spend_ledger`, latency percentiles onto the row.
*Done when:* the simulator drives a call to `analyzed` and the fixture 10-minute
recording expiry is handled correctly.

**Phase 4 — site dashboard (1–2 days).**
KPI row, calls table, transcript expansion, recording playback via
`/api/recordings/[callId]`, leads table, unattributed view, connection panel with
**Send test event**. *Done when:* every zero on the page is provably a measured zero.

**Phase 5 — telephony + go live on one site (1 day).**
Twilio Elastic SIP Trunk, origination/termination, **Disaster Recovery URL and
`/api/twilio/failover` first**, then `pnpm sites:provision` for one number. Rewrite the
prompt for dynamic variables, add `save_lead`, call it from a real cell phone. Full
runbook and verification order in [`telephony.md`](./telephony.md). *Done when:* a real
call produces a call row, a recording you own, and a lead — the banner is gone — and
you have deliberately broken origination once to confirm failover reaches the on-call
cell.

**Phase 6 — worker jobs + delivery (1 day).**
Extend `tick()` in `worker/main.ts` to drain `voice_jobs` after `scan_runs`.
Recording download with backoff, lead SMS to `lead_alert_number` within 5s,
`lead_deliveries` reconciliation. *Done when:* killing the worker mid-call and
restarting it still ends with a stored recording and a delivered lead.

**Phase 7 — the loop back to research (0.5 day).**
Predicted-vs-actual panel; calls-per-month by locality/niche fed to
`calibration.ts`. *Done when:* `priors.ts` can be argued about with data.

**~6–8 working days.** A real call lands in the CRM at the end of Phase 5, roughly
day 5. Web form entries are a `source = 'form'` insert into the same `leads` table
whenever you want them — that is why `source` exists now.

---

## Decisions I made that you may want to overrule

1. **One Retell agent for every site**, contextualized by inbound webhook, rather
   than one agent per site. Reverse it only if sites need genuinely different
   conversation *flows*, not just different names and hours.
2. **Recordings to local disk** rather than S3. `recording_path` is a column, so this
   is a writer swap later. On a single box it is strictly simpler.
3. **`sites.status` authoritative over `shortlist_items.state`** once a site exists,
   with a one-way sync at creation. The alternative — merging them — is cleaner in
   theory and a bigger change to the research UI than it is worth.
4. **Mid-call tool as the authoritative lead source, post-call analysis as backfill.**
   Costs a public write endpoint. Buys leads from abandoned calls, which in HVAC is a
   large share of the value.
5. **`locality_id` and `niche_id` NOT NULL on `sites`.** Slightly more friction on the
   create form; it is what makes the research loop close, so it is not optional.

---

## Sources

[Retell webhooks (events, payloads, signature, idempotency)](https://docs.retellai.com/features/webhook) ·
[Inbound call & SMS webhook](https://docs.retellai.com/features/inbound-call-webhook) ·
[Custom functions](https://docs.retellai.com/build/single-multi-prompt/custom-function) ·
[Get Call API (latency, cost, recording, analysis fields)](https://docs.retellai.com/api-references/get-call) ·
[Post-call analysis consumption](https://docs.retellai.com/features/post-call-analysis-consumption) ·
[Dynamic variables](https://docs.retellai.com/build/dynamic-variables) ·
[Import a number](https://docs.retellai.com/deploy/setup-phone-number)

Companion doc: [`voice-agent-plan.md`](./voice-agent-plan.md) — latency budget, TTS/STT
choices, HVAC conversation design, safety carve-outs.
