# Conversation-flow agents, generated from one long prompt

Generate a Retell **conversation flow** per market from a single trade-level script,
attach the phone number to it, and keep the dashboard as the place you tune wording and
voice afterwards.

Today `createAgentForSite` produces a `retell-llm` single-prompt agent. That shipped and
works, and this plan replaces it for new markets rather than deleting it — see
[Migration](#8-migration-and-the-agent-already-created).

---

## 1. The one thing that cannot be done through the API

**Retell's AI builder — "describe your agent and it draws the flow" — is dashboard-only.
There is no endpoint that takes a description and returns a node graph.** Checked against
the API reference, the conversation-flow overview, and the changelog; `create-conversation-flow`
takes an explicit `nodes` array and nothing else generates one.

So the choice is not "API vs app". It is:

| | Where the graph comes from | Cost |
|---|---|---|
| Retell AI builder | Their dashboard, by hand, per market | Manual forever; nothing versioned here |
| **This plan** | **Our code, from the trade script** | We own the generator |

Everything *else* in the pipeline is API-reachable, and this is the complete list of what
we need:

| Step | Endpoint | Status |
|---|---|---|
| Create shared sub-flows | `POST /create-conversation-flow-component` | new client method |
| Create the flow | `POST /create-conversation-flow` | new client method |
| Create the agent | `POST /create-agent` | **already built** |
| Publish a version | `POST /publish-agent-version/{id}` | new, see §7 |
| Attach the DID | `POST /import-phone-number` | **already built** |
| Re-read and audit | `GET /get-conversation-flow` | **already built** |

Nothing in the runtime path requires the dashboard. The dashboard remains where a human
edits wording, swaps the voice, and watches the flow run — which is what you asked for.

---

## 2. Why this is worth doing — and which of your two reasons actually holds

You gave two: *faster*, and *saves all the data correctly*. They are not equally supported.

**"Saves all the data correctly" — yes, and this is the real prize.** A `conversation`
node **cannot hold a tool at all**; tools live on `function` and `subagent` nodes. A
`function` node *executes* — it is not the model choosing to call `save_lead`, it is the
graph reaching a node whose entire purpose is that call. So lead capture stops being
"the model remembered" and becomes "the call reached node 4". That is a categorical
improvement over the single-prompt agent, where every save is a judgement call the model
makes mid-sentence while a caller talks over it.

**"Faster" — unproven, and measurable.** Retell's docs claim predictability and control,
not latency. Per-node prompts are much smaller than a 14k-character system prompt, which
usually helps time-to-first-token, but nobody has measured it here. You already persist
`latency_e2e_p50_ms` and `latency_e2e_p95_ms` per call — so run ten calls on each agent
type and compare, exactly as `docs/telephony.md` prescribes for termination URIs. Do not
take the speedup on faith; it is one query away from being a fact.

A third reason neither of us said out loud, which may matter more than both: a flow is
**inspectable**. When a market underperforms you can look at which node callers drop from.
A single prompt gives you a transcript and a shrug.

---

## 3. Architecture: a fixed skeleton, generated branches

Do **not** hand the whole graph to an LLM. The parts that carry data must be identical in
every market, or "saves all the data correctly" is back to chance.

```
                        ┌─────────────────────────────────────────┐
   SKELETON             │  hand-authored, identical every market  │
   (never generated)    └─────────────────────────────────────────┘

   start ──► greet ──► capture_contact ──► [save_lead] ──► hazard_check
                                             function          branch
                                                                 │
                        ┌────────────────────────────────────────┤
                        ▼                                        ▼
                   hazard_script                            describe_problem
                   (safety wording)                              │
                        │                                        ▼
                   [save_lead]                    ┌──────────────────────────┐
                    function                      │   GENERATED PER TRADE    │
                        │                         │  branch nodes from the   │
                        │                         │  long prompt (§4)        │
                        │                         └──────────────────────────┘
                        │                                        │
                        └────────────┬───────────────────────────┘
                                     ▼
                          capture_address ──► [save_lead] ──► authorization
                                                function            │
                                                                    ▼
                                              urgency ──► [save_lead] ──► close ──► end
                                                            function
```

Five `save_lead` function nodes at fixed checkpoints. A caller who hangs up after the
address has already had three of them fire. That is the property the single-prompt agent
cannot guarantee.

**Skeleton nodes are code, not prompt output.** They live in
`packages/core/src/voice/flow-skeleton.ts` as typed objects, unit-tested for graph
integrity (§6). The generator may only fill the `describe_problem` subtree.

---

## 4. The generator: long prompt → branch nodes

Input: one long trade script (the plumbing one you supplied is exactly the right shape —
it already has branches A–M).

Output: a `conversation`/`subagent` node per branch, with edges whose
`transition_condition` is a prompt describing when that branch applies.

Two ways to produce it. **Build (a) first; (b) is an upgrade, not a prerequisite.**

**(a) Deterministic — parse the script's own structure.** Your script is already a node
graph in prose: `## BRANCH E — WATER HEATER` with a question list under it. A parser that
turns each `BRANCH x` heading into a node and each question into an instruction line is
~150 lines, fully testable, and produces the same graph on every run. No model, no
nondeterminism, no spend.

**(b) LLM-authored — Claude generates the subtree.** For scripts that are not already
sectioned. Feed the long prompt plus the node JSON schema to Claude, get back nodes and
edges, then **validate before POSTing**: every `destination_node_id` resolves, no orphans,
no cycles back into the skeleton, no node carries a tool the skeleton owns. A generated
graph that fails validation is discarded, not repaired — see §6.

Either way the generator is ours, runs in our app, and the result is stored on the site
row before it is sent, so a bad flow is diffable against the last good one.

---

## 5. Shared components: build the capture blocks once

Retell has **conversation flow components** — reusable sub-flows stored standalone, linked
into many flows, with `linked_conversation_flow_ids` tracking who uses them. Edits
propagate to every linked flow.

That maps onto this problem almost too neatly:

- `save_lead` capture block → one shared component, referenced by every market's flow
- hazard/safety block → one per trade (plumbing's water-electrical wording differs from
  HVAC's gas/CO wording)

**The payoff:** fixing a capture bug becomes one component update instead of re-generating
every flow in the portfolio. With twenty markets live, that difference is the whole
maintenance story.

**The risk, stated plainly:** a shared component is a single point of failure across every
market at once. A bad edit breaks twenty phone lines simultaneously, and the blast radius
of the current design is one. Mitigation is the same as everywhere else in this repo —
re-read after write, and never edit a component without a test call. Ship per-flow copies
first (phase 2), move to components once the node design has stopped changing (phase 4).

---

## 6. Validation: the part that keeps this safe

A flow is POSTed as one blob. There is no partial failure and no undo, so validation
happens before the request, not after.

Graph checks, as pure functions in `@rnr/core`, unit-tested:

1. Every `destination_node_id` exists.
2. `start_node_id` exists and is reachable-from by nothing (it is the root).
3. Every node is reachable from the start node — an unreachable branch is a question that
   never gets asked, and it looks fine in the dashboard.
4. At least one `end` node, and every path terminates at one.
5. **Every `save_lead` function node points at `${PUBLIC_BASE_URL}/api/retell/tool/save-lead`.**
   The existing `retarget-tools` refusal on localhost applies here too.
6. No `conversation` node carries a tool — the API would reject it, but a clear local
   error beats a 400 with a field path.
7. The skeleton's five capture checkpoints are all present and in order.

Then, after the POST: **re-read the flow and re-run the audit**, exactly as
`createAgentForSite` already does. `auditAgent` needs no change — it reads tool names and
URLs from a flow already, which is the path that existed before single-prompt agents.

---

## 7. Publishing, and the version question we still have not answered

The created agent will be `v0` with `is_published: false` — that is what happened with the
San Jose agent. For inbound, `import-phone-number` without an `agent_version` follows
*latest*, so v0 answers and calls work.

The hazard is what happens once someone edits in the dashboard: if editing produces a new
draft, "latest" follows the **draft**, and unpublished edits go live on a real business
line the moment they are typed.

Decide this explicitly, per market:

- **Pin `agent_version: "latest_published"` on import** and call `publish-agent-version`
  as the last step of provisioning. Dashboard edits then stay inert until published.
  Correct for a line customers actually dial.
- **Leave it unpinned** while tuning a market that has no traffic yet.

This is a real decision with a wrong answer, not a detail. It applies to the *existing*
single-prompt agent too.

---

## 8. Migration, and the agent already created

`agent_3b52631735fc765b0a6ebdd734` (San Jose, single-prompt) is correctly wired and has
never taken a real call. Options, in order of preference:

1. **Provision the number first, place the ten calls, record the latency.** It is the only
   baseline you will ever get cheaply, and it costs one afternoon. Then build the flow
   agent and compare against a real number rather than an assumption.
2. Replace it outright once flows work.

Either way `createAgentForSite` currently **refuses** when `sites.retell_agent_id` is set —
deliberately, so a second create cannot orphan a live billable agent. Replacement therefore
needs an explicit path: clear the field, or a `replaceAgent` that records the old id in
`notes` before overwriting. Do not weaken the refusal into an overwrite.

---

## 9. Phases

Each phase ends somewhere you could stop.

**Phase 1 — client and validation (no behaviour change).**
`createConversationFlow` and `createConversationFlowComponent` on `RetellClient`; the
`VoiceProviders` seam and fixture impls; the graph validators in `@rnr/core` with tests.
Nothing calls them yet.

**Phase 2 — skeleton + deterministic generator, per-flow copies.**
`flow-skeleton.ts`, the branch parser (§4a), `createFlowAgentForSite`. One flow per site,
no shared components. Ship behind a UI toggle: *Single prompt* / *Conversation flow*.
**Stop here and place real calls before going further.**

**Phase 3 — publishing and version pinning.**
`publish-agent-version`, `agent_version` on import, the §7 decision surfaced in the UI.

**Phase 4 — shared components.**
Extract the capture block to a component, relink existing flows, prove an edit propagates.

**Phase 5 — LLM-authored branches (§4b), if 4a proves too rigid.**
Only if a real script resists structural parsing.

---

## 10. Open questions

- **Does `create-agent` return a published or draft agent?** Still unanswered by the docs;
  the San Jose create says draft (`v0`, `is_published: false`). Whether an *edit* creates
  v1-draft or mutates v0 determines whether §7's hazard is real. One dashboard edit and one
  `get-agent` settles it.
- **Do `function` nodes block on the HTTP call?** `save_lead` runs inside the caller's turn
  and the tool is configured `speak_during_execution: false`. If a function node waits
  synchronously on a slow response, five of them per call is five opportunities for dead
  air. Measure with the existing `timeout_ms: 15000` before committing to five checkpoints.
- **Does the generated graph survive a dashboard edit?** If a human rearranges nodes and we
  later regenerate, their work is destroyed. Likely answer: regeneration is a create, never
  an update — a new flow and a new agent version, with the old one left intact.

---

## Sources

[Conversation flow overview](https://docs.retellai.com/build/conversation-flow/overview) ·
[Create Conversation Flow](https://docs.retellai.com/api-references/create-conversation-flow) ·
[Create Conversation Flow Component](https://docs.retellai.com/api-references/create-conversation-flow-component) ·
[Create Agent](https://docs.retellai.com/api-references/create-agent) ·
[Publish Agent](https://docs.retellai.com/api-references/publish-agent) ·
[Import Phone Number](https://docs.retellai.com/api-references/import-phone-number) ·
[Agent versioning](https://docs.retellai.com/agent/version)
