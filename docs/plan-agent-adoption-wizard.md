# Adopting a Retell-built agent: a wizard, and switching numbers between agents

Build the agent in Retell — by hand, with their AI builder, with a template, however you
like — then adopt it into the app in a guided sequence that ends with a real call and a
green row. And make "point this number at that agent instead" a button with a preflight,
not a CLI run and a prayer.

This inverts [plan-conversation-flow-agents.md](plan-conversation-flow-agents.md), which
had us generating flows. That plan is not wrong, but this one is cheaper, ships sooner,
and leaves conversation design where it is already good: in their builder.

---

## 1. First, a premise that has quietly gone false

`/agent` opens with:

> **One agent answers every site.** Per-site context is injected at ring time by the
> inbound webhook resolving the dialled number, **so there is no second agent to keep in
> sync.**

There are now two: `agent_57f4e034…` (Tucson, conversation-flow) and
`agent_3b52631735fc…` (San Jose, retell-llm). The one-agent premise held while every site
was HVAC. It broke the moment a second trade arrived, and it cannot come back — a plumbing
call cannot be served by a furnace script no matter how good the dynamic variables are.

So the model is now **one agent per site** (strictly: per trade, shared by sites in that
trade), and two things follow:

- `/agent` stops being *the* agent page and becomes a **fleet view**: every agent, which
  sites use it, which numbers point at it, and whether each passes its audit.
- The adopt/switch wizard lives **on the site page**, where the number and the agent are
  already shown together.

This is not cosmetic. A global page that says "one agent" while two exist is the kind of
stale interface that makes someone edit the wrong script at 11pm.

---

## 2. What already exists

More than you would expect. The wizard is mostly assembly.

| Capability | Where | State |
|---|---|---|
| Read an agent + its flow, store a snapshot | `pullAgent` | **built** |
| Audit: webhook, save_lead tool, analysis fields | `auditAgent` | **built** |
| Write webhook + analysis fields | `applyIntegration` | **built** |
| Retarget flow tool URLs to this host | `updateConversationFlowTools` | **built**, CLI-only |
| Attach a DID to the trunk, import into Retell | `sites:provision` | **built**, CLI-only |
| **Point an imported number at a different agent** | `updatePhoneNumberWebhook` | **built, no UI at all** |
| Signed fixture call end-to-end | `sendTestEventAction` | **built** |
| Record agent id on a site | `saveTelephonyAction` | **built**, free-text field |

Genuinely missing: a way to **see what is in your Retell account**. `listAgents()` exists
on the client, but `/agent` only lists agents already *pulled*, so adopting one means
copying a 30-character id out of a dashboard URL and pasting it into a text box. That is
the single worst step in the current flow and the wizard's first job.

---

## 3. The wizard

Lives on the site page, replacing the "No Retell agent yet" block. Seven steps, each with
one job and a verifiable exit condition. **Every step is re-runnable and the wizard is
resumable** — it derives its position from stored state rather than remembering where you
were, so closing the tab loses nothing.

```
 1 PICK ─► 2 AUDIT ─► 3 FIX OURS ─► 4 SAVE_LEAD ─► 5 BIND ─► 6 NUMBER ─► 7 PROVE
   live       read-      webhook +     the manual     site.      trunk +      test event
   list       only       analysis      step           agent_id   import       + real call
```

### Step 1 — Pick the agent

A dropdown from **`list-agents`**, not a text field. Show name, engine type, version,
published state, and whether we have seen it before. Sorted most-recently-modified first,
because the one you just built is the one you want.

*New:* `listLiveAgentsAction` → `providers.listAgents()`, parsed through `parseAgent`.

> **Why this matters more than it looks:** the id in a dashboard URL and the id of the
> agent you were looking at are not always the same thing once versions are involved.
> Picking from a list removes an entire class of "I connected the wrong agent" that is
> invisible until a call comes in with the wrong greeting.

### Step 2 — Audit (read-only)

Run the existing audit and show the three checks. Nothing is written. This is the step
that tells you what the rest of the wizard is going to do, before it does it.

### Step 3 — Fix what this repo owns

One button, existing `applyIntegration`: sets `webhook_url` and `post_call_analysis_data`,
then **re-reads** to confirm. Plus, for conversation-flow agents, retarget `save_lead` tool
URLs at this host — the `retarget-tools` logic, lifted out of the script into a function
that takes an agent id instead of reading `RETELL_AGENT_ID` from env.

*New:* extract `retargetTools(agentId)` into `packages/data/src/voice/`, have both the CLI
and the action call it.

### Step 4 — `save_lead`, the step that stays manual

For a conversation-flow agent this cannot be automated and the reason is in `agent-audit.ts`:
a tool fires only from the nodes it is attached to, and guessing nodes either does nothing
or corrupts the flow. The page already documents this well — name, URL, both speak settings
off, which nodes, where to get the parameter schema. The wizard's addition is a
**"Re-check" button** that re-pulls and re-audits, so you can alt-tab to Retell, wire it,
and get a green row without navigating anywhere.

For a `retell-llm` agent this step **auto-passes** — the tool is on `general_tools` and is
always available. Say so, rather than showing a step that does nothing.

### Step 5 — Bind the agent to the site

Write `sites.retell_agent_id`. Today that is a free-text input; here it is the id you
picked in step 1, so it cannot be mistyped.

**Refuse to bind an agent that fails step 2's webhook check.** A site bound to an agent
with no webhook produces calls that happen and a CRM that stays empty — the exact silent
failure this repo is built to prevent. Allow an explicit override with the consequence
spelled out, because a half-configured agent on a site with no number hurts nobody.

### Step 6 — The number

Three cases, and the wizard should name which one it is in rather than showing one form:

- **No number yet** → the `sites:provision` sequence: attach to trunk, import into Retell
  with `inbound_webhook_url`, record on the site. Keep the dry-run/confirm split — this is
  the one step that changes live call routing. Surface the *current* Twilio config and the
  trunk blockers (DR URL, origination) exactly as the CLI prints them.
- **Number already imported, same agent** → nothing to do; show the state.
- **Number already imported, different agent** → §4, the switch.

### Step 7 — Prove it

Two buttons and one instruction that no button can replace:

1. **Send test event** (existing) — proves signature verification, routing, ingest, lead
   write. Fails loudly on a wrong `RETELL_API_KEY` or `PUBLIC_BASE_URL`.
2. **Call the number from a real phone.** Nothing before this validates SIP.

The step completes when `sites.first_webhook_at` is set **from a call that is not a
fixture** — which means the fixture path must stop setting it, or the wizard must
distinguish the two. It currently does not, and that is why San Jose looked connected
while its number was never provisioned. Track `first_real_call_at` separately, or record
the fixture flag on the call row and read through it.

---

## 4. Switching a number to a different agent

The primitive exists and has never been called from anything:

```ts
updatePhoneNumberWebhook({ phoneNumber, inboundWebhookUrl, inboundAgentId })
```

It PATCHes `inbound_agents` and the webhook and touches nothing about trunk topology —
deliberately narrow, because getting `termination_uri` or the SIP credentials wrong takes
the line down.

### The design

A **Switch agent** control on the site page, next to the bound agent. Pick a new agent
from the same live list, see a diff, confirm.

**Preflight — refuse by default, and this is the whole value of the feature.** Before
switching a number that real customers dial:

1. Target agent must pass the **webhook** check. Otherwise every call after the switch is
   invisible to the CRM.
2. Target agent must pass the **save_lead** check, or you accept losing mid-call capture
   in writing. A flow with no `save_lead` still answers the phone perfectly — it just never
   writes a lead until post-call analysis, and never at all for a hang-up.
3. Target agent should be **published**, or you accept that dashboard edits go live
   instantly (see §5).

Failing any of these is a warning with an explicit override, not a hard block — switching
to a half-built agent on a market with no traffic is a legitimate thing to do at 2pm on a
Tuesday. The point is that you cannot do it *by accident*.

### Make it reversible

Record the previous agent id on the site before overwriting — a `previous_retell_agent_id`
column, or an entry in `notes` — and offer **Switch back** for as long as it is set. The old
agent is not deleted by a switch; it stays live and billable in Retell, which is exactly
what makes rollback instant if the new one greets someone wrong.

Then **re-read the number from Retell** after the PATCH and show which agent it reports,
rather than showing what we asked for. Same discipline as `applyIntegration` re-pulling
instead of trusting its own request body.

### What a switch does not do

- It does not delete or unpublish the old agent. Say so in the UI, or you accumulate live
  agents nobody is tracking and a bill nobody can explain.
- It does not change the trunk, the DR URL, or the termination URI.
- It does not migrate call history. Past calls keep pointing at the site, which is right —
  the site is the business, the agent is an implementation detail of how it answers.

---

## 5. Version pinning, decided once and surfaced everywhere

Unresolved from the last plan and it belongs here, because the wizard is where it becomes
visible.

`import-phone-number` without `agent_version` follows **latest**. If a dashboard edit
creates a draft, latest follows the draft, and unpublished edits go live on a real business
line as they are typed.

Put a single toggle in step 6, defaulted per site status:

- `status = 'live'` → pin `agent_version: "latest_published"`. Dashboard edits stay inert
  until you publish. **This is the safe default for a line customers dial.**
- otherwise → unpinned, so tuning is immediate while nobody is calling.

Show which version is currently answering on the site page. "Published v2, draft v3 exists"
is the sentence that prevents an hour of confusion about why an edit did nothing — or why
an edit did something.

---

## 6. What `/agent` becomes

A fleet view, one row per agent:

| Agent | Engine | Version | Audit | Sites | Numbers |
|---|---|---|---|---|---|
| Roger — Old Pueblo | conversation-flow | v3 draft / v2 published | 2 pass 1 fail | Tucson HVAC | +1 520 369 4399 |
| Site #11 — San Jose | retell-llm | v0 unpublished | 3 pass | San Jose Plumber | — |

Sites and numbers come from `sites.retell_agent_id` and Retell's `list-phone-numbers`.
**Cross-referencing those two is the check nobody runs today**, and it catches the two
worst states directly: a number pointing at an agent no site claims, and a site claiming an
agent no number reaches. Both are silent right now.

Keep the global pull/upload panel — it is still how you inspect an agent before adopting it.

---

## 7. Phases

**Phase 1 — see your agents.** `listLiveAgentsAction`, the picker, and the fleet table on
`/agent`. Read-only, no writes, immediately useful: it answers "what is actually in this
account and which of it is wired up".

**Phase 2 — the switch.** `switchAgentAction` over the existing `updatePhoneNumberWebhook`,
with preflight, re-read, and `previous_retell_agent_id` + Switch back. Small, self-contained,
and the thing you asked for most directly.

**Phase 3 — the wizard shell.** Steps 1–5 and 7 on the site page, deriving position from
stored state. Step 6 links to the CLI at first.

**Phase 4 — provisioning in the UI.** Lift `provision-site.ts`'s body into a shared function
so the wizard and the CLI cannot diverge, then run step 6 in-app with the dry-run/confirm
split preserved.

**Phase 5 — honest connection state.** Separate fixture-driven `first_webhook_at` from a
real call, so step 7 cannot go green on a test event.

Phases 1 and 2 are worth doing even if the wizard never gets built.

---

## 8. Open questions

- **Does `list-agents` return one row per version?** It did in our probe — Roger appeared
  four times, v0–v3. The picker must collapse by `agent_id` and show the newest, or the
  dropdown is unusable at ten agents.
- **Can we detect `save_lead` parameter mismatches?** `FIELD_ALIASES` absorbs the common
  renames, but a flow using genuinely novel names produces `200 saved:true` with every
  field null. The audit could compare the flow's declared tool parameters against
  `SAVE_LEAD_SCHEMA` and warn on unrecognised names — a real check, and cheap.
- **Should a switch bump the site's `prompt_fingerprint`?** It currently records the script
  we sent when we created an agent. For an agent built in Retell there is no script of ours,
  so the fingerprint is meaningless and should probably be nulled rather than left stale.
