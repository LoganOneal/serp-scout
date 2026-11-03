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
- After each discovery batch and its evaluation, pause with one combined report
  and wait for Kai before running the next discovery batch.
