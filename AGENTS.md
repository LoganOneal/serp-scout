# Agent instructions

## Guest-post leads: discovery always chains into evaluation

Whenever you obtain new leads from Semrush with the `hht-opp` CLI (for example
`pnpm hht:opp guest-frontier` followed by `pnpm hht:opp export-leads`), immediately
load the `guest-post-pitches` skill (`.agents/skills/guest-post-pitches/SKILL.md`)
and run every new guest-post lead through it end to end. Kai does not need to ask
separately. Follow the skill's "Chained after hht-opp discovery" section:

- Refresh tracker exclusions before exporting (`run_tools.py exclusions`).
- Evaluate only `guest_post` leads; link-insertion leads stay as link-insertion leads.
- Create step 1 outreach drafts automatically under the skill's rules; never send.
- Do not pause between discovery batches (Kai, 2026-11-09). After each batch and
  its evaluation, post a short progress update and start the next batch. Keep
  going until Semrush units run out (`no_api_units`) or something genuinely needs
  Kai (disk full, Google Ads or outreach auth down, a decision only Kai can make),
  then give one combined report covering every batch.
