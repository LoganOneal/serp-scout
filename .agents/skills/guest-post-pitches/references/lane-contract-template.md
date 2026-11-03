LANE CONTRACT (rendered by run_tools.py prepare)

SKILL = /Users/kaisulkin/serp-scout/.agents/skills/guest-post-pitches   (read SKILL.md fully; it is authoritative)
SCRIPTS = $SKILL/scripts
RUN_DIR = {RUN_DIR}
Triage date: the actual current date (`date +%F`). Format examples (FORMAT only, never content):
/Users/kaisulkin/serp-scout/exports/guest-post-outreach/HHT-batch07-11-2026-10-23-B01/

TIME LIMIT: background workers are cancelled at about 30 minutes. Keep every step short,
write files incrementally (per-domain JSON as soon as a verdict is final, progress.json often),
and prefer small scripts over long single-turn generations. Never sleep or poll.

HARD RULES
- Never call send_message, create_session, or tool_search_tool. Report only via BATCH_DIR/progress.json
  (batch, total_domains, finalized_domains, research_in_progress, pitches_drafted, outreach_created,
  current_stage, blocker, updated_at ISO with offset). Stages: research, writing, validation, routing,
  ready_to_commit.
- Use the bundled scripts directly (cwd = BATCH_DIR). Default light policy, 90 s slow-site cap, one
  web search per listed domain (see SKILL.md "Light invitation search").
- Never edit the master workbook. The parent commits with $SCRIPTS/run_tools.py commit.
- Push only with `python3 $SCRIPTS/push_drafts.py $BATCH_DIR`, exactly once per batch, after
  draft-validation passes. If outreach-post-attempt.json already exists, NEVER run it again: use
  outreach-outcomes.json as the confirmed result.
- timing.json: ISO timestamps for started, research_done, writing_done, validation_done, pushed,
  ready_to_commit (keep existing values when resuming; add resumed_at).

REQUIRED OUTPUTS (the parent's validator checks them exactly)
1. domains/<domain>.json for all 25 with every Part A field: domain verdict skip_code review_reason
   region_check supplied_urls supplied_url_result pitch_url url_corrected submission_mechanism
   submission_stage article_delivery contact_route email_obfuscated payment link_policy corporate_stance
   requirements_summary last_post_date activity outside_contributors_seen restrictions fit_rationale
   suggested_angle evidence_quotes evidence_urls steps_completed search_log confidence notes (+ rules,
   example_posts, candidate_angles for pursuits). search_log, evidence_urls, evidence_quotes non-empty
   for EVERY domain. verdict in PURSUE, PAID_ONLY, NEEDS_REVIEW, SKIP; specific code in skip_code /
   review_reason. SKIP_NO_INVITATION only when invitation_search.full is true.
2. research.json = {"batch", "sites": [...]}, each site json-equal to its domains/<domain>.json (write last).
3. drafts.md with `## <domain>` headings per the skill's Markdown rules.
4. outreach-payload.json (array, may be []): {campaign_id "8cc518fd-9635-41fe-a3a9-fc4e2e4f2a20",
   contact{email, first_name, last_name, company, title, website, attributes{source "guest-post-pitches",
   batch, domain, guidelines_url}}, step_number 1, subject, body, reviewer_note}; subject/body verbatim
   in drafts.md.
5. draft-validation.json {"passed": true, "editorial_readthrough_passed": true, "stage": "final", "sites": [...]}
   only when every check genuinely passes.
6. outreach-outcomes.json (from push_drafts.py).
7. tracker-rows.json {"main": [25 rows], "full_articles": [...]}. Main keys only: site, source_sheet, batch,
   sheet_score, verdict, code, confidence, pitch_url, submission_mechanism, contact_route,
   needs_human_input, draft, outreach_status, date_triaged, notes, outreach_email_id, source_query,
   submission_stage, requirements_note. draft = "<BATCH>/drafts.md#<anchor>" or null. outreach_status in:
   "Draft in outreach tool" (confirmed created email_id in outreach_email_id; requirements_note exactly the
   payload reviewer_note), "Article for review (not pushed)", "In Markdown (form only)",
   "In Markdown (no email)", "Blocked (requirements incomplete; not pushed)",
   "Not pushed (tool unreachable)", "Not pursued". Full Articles keys only: site, batch, send_to,
   required_subject, article_delivery, doc_link ("<BATCH>/drafts.md#<anchor>"), title,
   word_count_required, photos_required, bio_and_headshot_required, link_rules, must_replace,
   fact_checks_needed, fee_risk, status ("Drafted"), date_drafted, date_reviewed, date_sent, notes.
8. report.md and summary.json per the skill's report rules.
9. progress.json current_stage "ready_to_commit" when all is final.

End your turn with: verdict counts, drafts created (domain -> email_id), article holds, blockers,
elapsed minutes.

CODE COLUMN (tracker-rows main.code), use exactly: "PURSUE" for PURSUE; "PAID_ONLY" for PAID_ONLY;
the bare skip code for SKIP (SKIP_NO_INVITATION, SKIP_INACTIVE, SKIP_CLOSED, SKIP_MISALIGNED, SKIP_DEAD,
SKIP_REGION_EXCLUDED, SKIP_NOT_PUBLICATION, SKIP_STAFF_ROLE, SKIP_NO_COMPANIES); the bare review code for
NEEDS_REVIEW (FETCH_BLOCKED, SLOW_SITE_CAPPED, NO_ROUTE_FOUND, AMBIGUOUS_PAGE, ...), never prefixed with
"NEEDS_REVIEW:". Never null.

PRIOR WORK: batch-input entries carry prior_status/prior_batch from the stopped 2026-10-23 runs. Their
old research may exist under ../<prior_batch>/domains/<domain>.json; you may read it as a hint, but
research fresh with the bundled helper and cite only evidence fetched in this batch. Never reuse or push
an old payload; nothing from the prior runs was pushed for these domains.

TIMESTAMPS: write real clock times only (run `date -Iseconds`); never estimate.

DUPLICATES: if push_drafts.py reports an existing live draft for a contact, record outreach_status
"Duplicate (live draft already in outreach tool; not overwritten)" and never retry.
