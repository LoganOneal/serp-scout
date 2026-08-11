# Inbound HVAC voice agent — architecture & build plan

A Twilio number rings. An AI answers, triages for genuine emergencies, qualifies
the caller, books or escalates, and the lead lands in this repo's Postgres before
the caller has hung up.

**Decisions already made** (2026-08-03):

| | |
|---|---|
| Orchestration | **Vapi** — managed, but component-swappable |
| Lead target | **This repo** — Postgres + `apps/web` |
| Shape | **Multi-tenant from day one** — one number per rented site |
| Telephony | Existing Twilio number, imported into Vapi |

---

## The honest read on "can't tell it's AI"

This is the goal, so it gets addressed first rather than buried.

**Latency is not the main tell.** Three things give an agent away, in order of how
often they actually do it:

1. **Uniform turn-taking.** A human's response gap varies — 150ms for "yeah," 900ms
   for "let me think." An agent that answers everything in a flat 800ms reads as
   machine even when 800ms is objectively fast. Variance matters more than the median.
2. **Numbers and addresses read wrong.** "Twelve thousand four hundred BTU," "four
   one four five five five oh one two three," "one hundred eighty nine dollars." One
   badly spoken address destroys more realism than 300ms of latency.
3. **Dead-air silence.** A totally silent line between turns is unnatural — real phone
   calls have room tone. Vapi's `backgroundSound: 'office'` is on by default for
   phone and should stay on.

Latency is fourth. It matters, and the plan below drives it as low as the managed
path allows, but do not expect latency alone to buy the illusion.

**What is achievable on the Vapi path:** p50 turn gap ~500–700ms, p95 ~900ms–1.2s.
Callers will not consciously flag that as robotic. What is *not* achievable on the
managed path today is the last ~200ms, because closing it requires eager
end-of-turn speculative LLM prefetch and single-region colocation of every leg —
control that only self-hosting (LiveKit Agents / Pipecat) gives you.

**So: the hedge is portability, not platform choice.** Every piece of intelligence —
tenant config, prompt template, tool contract, lead schema — lives in *this repo*,
never in Vapi's dashboard. Vapi becomes a transport. If you later need the last
200ms, you swap transport and keep everything else. Design for that from commit one;
retrofitting it is a rewrite. This is the single most important structural decision
in this document.

---

## Latency budget

Twilio's own published budget for a voice agent turn, and where the plan spends it:

| Leg | Twilio target | Upper limit | This stack |
|---|---|---|---|
| Carrier + edge in | 40–70ms | — | Twilio edge → Vapi |
| Speech-to-text **incl. end-of-turn** | 350ms | 500ms | **Deepgram Flux ~260ms p50** |
| LLM time-to-first-token | 375ms | 750ms | small fast model + cache, target ≤300ms |
| TTS time-to-first-byte | 100ms | 250ms | **Cartesia Sonic 3 — 40–90ms** |
| Playback + return path | ~70ms | — | — |
| **Mouth-to-ear turn gap** | **1,115ms** | 1,400ms | **target ≤700ms p50** |

Twilio's own ConversationRelay measures p50 491ms / p95 713ms — and that figure
*excludes* your LLM. The budget above beats Twilio's target by ~400ms, and it does
it in two places.

### Where the wins come from

**1. Deepgram Flux, for endpointing — the biggest single win.**
In a conventional pipeline, end-of-turn detection is the long pole: a VAD silence
timer waits 500–800ms of quiet before it dares call the turn over, because calling
it early means talking over the caller. Flux is a conversational speech recognition
model with *model-integrated* end-of-turn detection — it decides the turn is over
from the semantics and prosody, not from a stopwatch. Deepgram reports ~260ms p50,
and 200–600ms saved versus STT+VAD. Configure `eotThreshold ≈ 0.7`,
`eotTimeoutMs` 500–700.

That number carries a tail: Flux p95 end-of-turn is reported around 1.5s. So the
p95 experience is dominated by endpointing, not by anything downstream. Budget
accordingly and measure p95 separately — a good p50 with an ugly p95 is exactly
what "sometimes it feels weirdly laggy" is.

**2. Cartesia Sonic 3, for TTS.**
40ms TTFB on the turbo/real-time model, ~90ms on the full-quality model — the
lowest published in the market, because Cartesia's state-space architecture emits
audio tokens in parallel instead of autoregressively. Cartesia is a default TTS
option on Vapi as of 2026, so this costs nothing but a config field.

For comparison, ElevenLabs Flash v2.5 is ~75ms pure inference but ~150ms
end-to-end. That is a 60–110ms swing, per turn, for free. Take it.

**3. A small LLM with a short, cached system prompt.**
TTS cannot start until the first LLM token lands, so TTFT is the only LLM metric
that matters here — total generation speed is irrelevant. Anchor the system prompt
at the top and unchanged so provider prompt caching hits; Vapi passes the call
through to the upstream provider, so caching works if the provider supports it.
Keep the prompt under ~1,200 tokens. Every 1,000 tokens of prompt bloat is real
TTFT.

If TTFT is still the bottleneck after tuning, a fast-inference host (Groq /
Cerebras, ~180ms TTFT p50) on an open model is the escape hatch — but try prompt
discipline first, it is usually enough and it does not cost you instruction-following.

### The three latency traps specific to HVAC

**Trap 1 — mid-call availability lookups.** The obvious design is "caller asks for
Tuesday, agent queries the calendar, agent answers." That query is 200–800ms of
dead air *inside* a turn, and it lands at the worst possible moment: the caller is
waiting on a direct question. Fix: fetch the availability window **at call connect**,
in parallel with the greeting, cache it on the call record, and offer slots from
cache. Confirm the booking asynchronously after the call. A slot that turns out to
be taken is a rescheduling text; 800ms of silence is a hang-up.

**Trap 2 — synchronous lead-save tool calls.** Marking the `save_lead` tool
synchronous blocks speech on your own HTTP round trip. Make it fire-and-forget
(`async: true`). The agent keeps talking; your endpoint writes the row.

**Trap 3 — cross-country region stacking.** Vapi's documented US SIP IPs
(`44.229.228.186`, `44.238.177.138`) are in AWS **us-west-2**. If the HVAC client is
in Wisconsin, the caller's audio crosses the country to Oregon and back — and if
your LLM, STT, and TTS regions are each chosen independently, you can stack three
more crossings on top. Pin every leg to the same coast and **verify with a real
call**, not with a vendor datasheet. This is worth 100–200ms and nobody finds it by
reading docs.

---

## Architecture

```
  PSTN caller
      │
      ▼
  Twilio number  ──── imported into Vapi (or Elastic SIP trunk, see below)
      │
      ▼
  Vapi assistant  ── Deepgram Flux (STT + end-of-turn)
      │              Cartesia Sonic 3 (TTS)
      │              small fast LLM (BYO key)
      │
      ├── tool: save_lead        (async, fire-and-forget) ──┐
      ├── tool: get_slots        (pre-warmed at connect)    │
      ├── tool: transfer_to_oncall (emergencies)            │
      │                                                     ▼
      └── webhook: end-of-call-report ──────────►  apps/web  /api/voice/*
                                                        │
                                                        ▼
                                              Postgres  (this repo)
                                              voice_tenants
                                              calls
                                              leads
                                              call_events
                                              lead_deliveries  ◄── IS the queue
                                                        │
                                                        ▼
                                              pnpm worker → SMS/email to contractor
```

### Number attachment: import vs SIP trunk

Start with **number import** — paste the number plus your Twilio Account SID and
auth token into Vapi, or `POST /phone-numbers/import`. It works in minutes.

**Twilio Elastic SIP Trunking → Vapi** is the alternative: create the trunk,
whitelist Vapi's static IPs, add origination URI
`sip:YOUR_NUMBER@<credential_id>.sip.vapi.ai`. Vapi's docs do *not* claim a latency
or cost benefit for this, so treat any such claim as unverified until you measure
it yourself. The one documented gotcha: a termination hostname cannot identify
inbound traffic, so inbound requires whitelisting Twilio's numeric signaling
networks, not just the hostname. Do not spend Phase-1 time here.

### Multi-tenancy

One Vapi assistant per tenant, **generated from a template in this repo**, never
hand-edited in the dashboard. A dashboard edit is an untracked config change that
silently diverges from Postgres — the same class of failure this codebase already
guards against everywhere else.

Resolution path: inbound call → `phoneNumberId` → `voice_tenants` row → prompt
built from that row's fields. One prompt template, per-tenant variables:
business name, service area (zip list), hours, after-hours policy, on-call number,
dispatch/diagnostic fee, brands serviced, residential/commercial, booking windows.

Provisioning a new rented site becomes one script: insert tenant row → create Vapi
assistant from template → import number → attach. Target: under 5 minutes per site.

---

## Schema

The rule this codebase is organised around applies directly here:

> **Never let an unmeasured signal read as a good one.**

For leads that means: **a lead whose address was never captured must not read as a
complete lead.** Concretely —

- **`is_emergency` is nullable, not `false`.** The caller never being *asked* is not
  the same as the caller saying no. A null that renders as "not an emergency" is how
  a no-heat call at 11pm in January gets queued for Tuesday.
- **`in_service_area` is nullable.** Unvalidated zip is not an in-area zip.
- **`qualified` is nullable and sorts last**, exactly like `difficulty` in
  `scan_targets`.
- **`calls` rows are created on first webhook, not at end-of-call.** A caller who
  hangs up at 4 seconds is a *measurement* — abandoned-call rate is the number that
  tells you the greeting is too slow or too obviously synthetic. If the row only
  exists on completion, those calls vanish and the funnel looks perfect.
- **`captured_fields` is explicit.** Store which fields the agent actually asked and
  confirmed, separately from their values. "Address is null" and "address was never
  asked" are different bugs.

Tables, following the existing `packages/data/src/schema.ts` conventions:

| Table | Purpose | Notes |
|---|---|---|
| `voice_tenants` | one per rented site | prompt variables, hours, service-area zips, on-call number, fee |
| `calls` | one per call | created on first webhook; `vapi_call_id` UNIQUE for idempotency; per-turn latency p50/p95, `ended_reason`, recording URL, transcript |
| `leads` | one per qualified caller | written mid-call, updated as fields fill; nullable everything that can be unmeasured |
| `call_events` | append-only webhook log | idempotent by Vapi message id — lets you replay a call's state machine |
| `lead_deliveries` | fanout attempts | **is the queue.** Consumed by `pnpm worker`, same as `scan_runs`. No Redis. |

`lead_deliveries` also mirrors `spend_ledger`'s discipline: a row per attempt with
status, so "did the contractor actually get this lead" is *reconcilable* rather than
merely assumed. A lead captured perfectly and never delivered is a lost lead.

---

## Lead ingest — two paths, both required

**Path 1: mid-call tool call.** The agent calls `save_lead` as soon as it has name +
number, then again as fields fill. Fire-and-forget. This is what makes leads survive
a hang-up — and in HVAC, the caller who hangs up after giving their name and "my
furnace is dead" is still a lead worth money.

**Path 2: `end-of-call-report` webhook.** Reconciliation, not primary capture:
transcript, recording, duration, cost, and Vapi's post-call structured outputs.

Do **not** make structured outputs the primary path. They are computed *after* the
call ends by analyzing the transcript — which means they add seconds of delay, they
can disagree with what the agent actually confirmed with the caller, and they
produce nothing at all for an abandoned call. Use them to backfill and to
cross-check Path 1. Where the two disagree, Path 1 wins and the disagreement gets
logged; a systematic disagreement is a prompt bug worth knowing about.

Webhook endpoints in `apps/web`:

| Route | Purpose |
|---|---|
| `POST /api/voice/tool` | mid-call tool calls (`save_lead`, `get_slots`) |
| `POST /api/voice/events` | server events → `call_events`, upsert `calls` |
| `POST /api/voice/report` | `end-of-call-report` reconciliation |

All three: verify Vapi's signature, dedupe by message id, respond in <100ms.
`/api/voice/tool` is inside the caller's turn budget even when async — return
immediately and do the work after responding.

---

## Conversation design

This is where the illusion is actually won or lost, and it deserves more of your
time than the latency tuning does.

### Safety carve-outs — hard-coded, not LLM discretion

**Gas smell, CO alarm, or burning-electrical smell is not a booking conversation.**
The agent must say the safety line — leave the building, call the gas utility or
911 from outside, do not operate switches — and escalate. This must be a deterministic
branch, triggered on keyword match, that does not depend on the model choosing
correctly. An LLM that is right 99% of the time is not acceptable when the 1% is a
gas leak.

Same treatment, lower stakes: active water leak / flooding, and no-heat below
freezing with an infant or elderly occupant. These go to `transfer_to_oncall`
immediately, ahead of qualification.

### Emergency triage before qualification

Ask about urgency *before* collecting the full intake. A homeowner with no AC in a
heat advisory does not want to spell their email address first. Triage, escalate or
reassure, *then* collect.

### Intake fields

Name · callback number (**confirm it back, chunked**) · service address + zip ·
the problem in their words · system type (furnace / AC / heat pump / mini-split /
boiler) · approximate age · **owner or renter** (renters usually cannot authorize
work — catching this saves a wasted truck roll) · residential or commercial ·
home warranty (usually a decline) · access notes.

Rank-and-rent bonus: "how did you find us" is redundant — the number they dialed
*is* the attribution. Store `tenant_id` and skip the question. One less turn.

### The dispatch fee must be spoken

If the contractor charges a diagnostic or trip fee, the agent says the number out
loud and gets an acknowledgment. Skipping it produces booked jobs that cancel at
the door, and the contractor blames the AI. Non-negotiable.

### Out-of-area callers still get saved

A caller outside the service-area zips gets a polite decline — and a `leads` row
with `in_service_area = false`. In a rank-and-rent business those are inventory.

### Turn-taking realism

- `startSpeakingPlan.waitSeconds` default is 0.4s. With Flux doing semantic
  endpointing, push this down and let Flux carry the decision.
- `stopSpeakingPlan.numWords: 0` gives instant barge-in but false-triggers on
  "yeah" / "mhm" / "okay". Set `numWords: 2`, `voiceSeconds ~0.2`,
  `backoffSeconds ~1.0`, then tune against real recordings. Targets from production
  runbooks: barge-in success >96%, false barge-in <2%.
- **Vary the response gap deliberately.** Short acknowledgments fast, substantive
  answers slightly slower. Uniformity is the tell.
- **Write TTS-speakable text in the prompt.** `$189` → "one eighty-nine";
  phone numbers in 3-3-4 chunks; addresses spelled out. Instruct this explicitly
  and test it on the tenant's actual street names.
- Keep `backgroundSound: 'office'`.

### One compliance note

You want callers not to know. Worth knowing before launch: several US states have
bot-disclosure and/or two-party recording-consent requirements, and they vary by
state. The practical resolution that costs you nothing: don't volunteer it, answer
honestly if a caller asks directly, and include the recording notice in the greeting
where the tenant's state requires it. Cheap to build in now, expensive to retrofit
after a complaint. Check the specific states you operate in.

---

## Verification — how you'll know it's actually good

Do not accept vendor latency numbers, including the ones in this document. Third-party
tests routinely land higher than vendor claims, and the gap depends entirely on what
each test measured.

**Instrument.** Vapi call reports expose per-turn latency; Twilio Voice Insights has a
ConversationRelay dashboard for the carrier leg. Persist p50 **and p95** per turn onto
the `calls` row. Given Flux's ~1.5s p95 endpointing tail, p95 is the number that will
actually generate complaints — track it as a first-class metric, not an afterthought.

**Metrics with targets:**

| Metric | Target |
|---|---|
| Turn gap p50 | ≤700ms |
| Turn gap p95 | ≤1,200ms |
| Barge-in success | >96% |
| False barge-in | <2% |
| Abandoned <10s | <5% |
| Lead field completeness | >90% on name + number + address |
| Emergency mis-triage | **0** |

**The acceptance test for your actual goal:** play 10 real call recordings to 10
people who don't know what they're listening for and ask "was that a person?" Track
the rate. That is the only measurement that answers the question you asked, and no
latency dashboard substitutes for it.

---

## Cost

| Component | Rate |
|---|---|
| Vapi platform fee | $0.05/min (applies regardless of BYO keys) |
| Twilio inbound local | ~$0.0085/min |
| Deepgram Flux | usage-based, verify at your volume |
| Cartesia Sonic | ~$0.03/min equivalent |
| LLM | at-cost via BYO key, no Vapi markup |
| **All-in, typical** | **$0.10–0.30/min** |

A 4-minute HVAC intake call costs roughly **$0.40–$1.20**. A booked HVAC job is
worth $150–$800 and a qualified lead resells for $50–$200.

**The conclusion that follows: stop optimizing this stack for cost.** At 200x
headroom, every trade between cost and quality should go to quality — the expensive
TTS, the eager endpointing that fires 50–70% extra LLM calls, the redundant lead
delivery. Cost only becomes a real input above ~50,000 min/month, and at that
volume the answer is the self-hosted path, which is the same off-ramp you're already
designing for.

---

## Phases

**Phase 1 — Postgres + webhooks (1–2 days).**
Five tables in `packages/data/src/schema.ts`. Three routes in `apps/web`. Signature
verification, idempotency by message id. Fixture-backed tests, no live calls — this
repo's `LIVE_CALLS_ENABLED` discipline extends here: a missing env var must route to
fixtures, not to a live Vapi account that spends money on every test run.

**Phase 2 — one tenant, end to end (1 day).**
Hardcode one HVAC tenant. Vapi assistant with Flux + Sonic 3. Import the Twilio
number. Goal: a real call to a real number writes a real `leads` row. Do not tune
anything yet.

**Phase 3 — latency tuning (2 days).**
The region check first — it is the cheapest 100–200ms available. Then endpointing
thresholds, prompt length and cache anchoring, barge-in config. Measure after every
change; p50 and p95 separately. Stop when p50 ≤700ms.

**Phase 4 — conversation design (parallel with 3).**
Safety carve-outs as deterministic branches. Triage-before-intake ordering. Fee
disclosure. TTS-speakable formatting against real local street names. This phase
buys more perceived realism per hour than Phase 3 does.

**Phase 5 — multi-tenant provisioning (2 days).**
Prompt template + variable substitution from `voice_tenants`. One script:
row → assistant → number → attached. Under 5 minutes per new site.

**Phase 6 — delivery + reconciliation (1 day).**
`lead_deliveries` as queue, consumed by the existing `pnpm worker`. SMS to the
contractor within 5s of `save_lead`. Retry with backoff. Reconcile so undelivered
leads are visible, not silent.

**Phase 7 — eval + blind test (ongoing).**
Scripted call suite for the metrics table. Then the 10-listener blind test. Then the
`apps/web` dashboard: calls, leads, latency, abandoned rate per tenant.

**Roughly 7–9 working days to a tuned, multi-tenant agent**, with a real call landing
a real lead by end of day 3.

---

## The one thing to get right in Phase 1

Keep the prompt template, tenant config, tool contract, and lead schema in this repo.
Vapi holds a rendered copy; Postgres holds the truth. Do that and the choice between
managed and self-hosted stays open forever — and the day you need the last 200ms, it
is a transport swap instead of a rebuild.

---

## Sources

Latency budgets and architecture:
[Twilio — Core Latency in AI Voice Agents](https://www.twilio.com/en-us/blog/developers/best-practices/guide-core-latency-ai-voice-agents) ·
[Twilio ConversationRelay docs](https://www.twilio.com/docs/voice/twiml/connect/conversationrelay) ·
[Twilio ConversationRelay product page](https://www.twilio.com/en-us/products/conversational-ai/conversationrelay) ·
[LiveKit — Understand and improve agent latency](https://livekit.com/blog/understand-and-improve-agent-latency) ·
[Telnyx — Voice AI agents compared on latency](https://telnyx.com/resources/voice-ai-agents-compared-latency)

STT and end-of-turn detection:
[Deepgram Flux quickstart](https://developers.deepgram.com/docs/flux/quickstart) ·
[Deepgram — Flux Multilingual GA](https://deepgram.com/learn/deepgram-launches-flux-multilingual-press-release) ·
[Deepgram — Measuring streaming latency](https://developers.deepgram.com/docs/measuring-streaming-latency) ·
[LiveKit — Turn detection: VAD, endpointing, model-based](https://livekit.com/blog/turn-detection-voice-agents-vad-endpointing-model-based-detection) ·
[Coval — Best STT providers 2026](https://www.coval.ai/blog/best-speech-to-text-providers-in-2026-independent-benchmarks-and-how-to-choose/)

TTS:
[Gradium — TTS latency benchmark 2026](https://gradium.ai/content/tts-latency-benchmark-2026) ·
[Cartesia vs ElevenLabs — latency, quality, cost](https://burki.dev/blog/41-cartesia-vs-elevenlabs-tts) ·
[Cekura — Best TTS APIs for voice agents 2026](https://www.cekura.ai/blogs/best-tts-for-ai-voice-agents)

Architecture choice (cascaded vs speech-to-speech):
[LiveKit — Realtime models](https://docs.livekit.io/agents/models/realtime/) ·
[Context Studios — GPT-Live vs cascaded pipeline](https://www.contextstudios.ai/comparisons/gpt-live-vs-cascaded-voice-pipeline)

Vapi:
[Speech configuration](https://docs.vapi.ai/customization/speech-configuration) ·
[Import number from Twilio](https://docs.vapi.ai/phone-numbers/import-twilio) ·
[Twilio SIP integration](https://docs.vapi.ai/advanced/sip/twilio) ·
[Server URLs](https://docs.vapi.ai/server-url) · [Server events](https://docs.vapi.ai/server-url/events) ·
[Structured outputs](https://docs.vapi.ai/assistants/structured-outputs-quickstart) ·
[Call analysis](https://docs.vapi.ai/assistants/call-analysis) ·
[FutureAGI — Optimizing Vapi latency](https://futureagi.com/blog/how-to-optimize-vapi-latency-2026/) ·
[Cekura — Vapi pricing 2026](https://www.cekura.ai/blogs/vapi-ai-pricing)

Platform comparison and the self-hosted off-ramp:
[Particula — Vapi vs Retell vs LiveKit vs Pipecat](https://particula.tech/blog/vapi-vs-retell-vs-livekit-vs-pipecat-voice-agent-platform) ·
[Cekura — Retell vs Vapi](https://www.cekura.ai/blogs/retell-vs-vapi) ·
[Softcery — 12 voice agent platforms compared](https://softcery.com/lab/choosing-the-right-voice-agent-platform-in-2026) ·
[LiveKit telephony docs](https://docs.livekit.io/agents/start/telephony/)

Conversation design and turn-taking:
[Hamming — Voice agent interruption handling runbook](https://hamming.ai/resources/voice-agent-interruption-handling-runbook) ·
[FutureAGI — Barge-in and turn-taking 2026](https://futureagi.com/blog/voice-ai-barge-in-turn-taking-2026/)

HVAC domain:
[LeadLock — AI voice agents for HVAC 2026](https://www.leadlock.ai/blog/ai-voice-agents-for-hvac-and-home-services-book-more-jobs-24-7/) ·
[MarketingCode — HVAC after-hours call data](https://www.marketingcode.com/hvac-ai-receptionist-60-percent-unanswered-summer-jun-2026/)
