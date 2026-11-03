# Part C. Route the work: outreach tool, Doc, or Full Articles tab

As soon as a batch's pitches and articles are written, route each one by its `submission_stage` and contact route:

- **pitch-first with a readable email address:** push to Kai's outreach tool as a step 1 draft, with its requirements note in the draft's `reviewer_note` field. A draft is not mail: nothing is sent until Kai approves it in the tool. Creating drafts emails Kai one notification per request.
- **article-first, in any delivery form:** never push to the outreach tool. This covers an article that the site wants pasted into the email text, an article attached as a document, an article linked as a shared document, and an article submitted through a form. The article is written into the batch Google Doc and tracked in the Full Articles tab (Step C2b), because the article itself needs a separate review (real photos, fact checks) before anything is sent.
- **everything else** (forms, applications, masked or unreadable addresses): the batch Google Doc.
- **SKIP_REGION_EXCLUDED sites:** nothing is routed. No draft, no Doc section, no Full Articles row. They appear only in the tracker's main tab and the batch report.

## Connection and limits

- Base URL `https://outreach-ten-plum.vercel.app`. Every request sends `Authorization: Bearer <token>` and `Content-Type: application/json`.
- Token: read env var `GENERATOR_SECRET` when it is set, otherwise use the fallback `REMOVED_FROM_PORTABLE_SKILL_USE_GENERATOR_SECRET` (Kai said to use it as given). Never print it in replies.
- Only three routes are allowed: `GET /api/generator/campaigns`, `GET /api/generator/followups-due`, `POST /api/generator/drafts`. Never call cron, approve, reject or send routes.
- Never call `/api/backlink` for these email drafts. That is a separate API with a separate key (`BACKLINK_ENGINE_API_KEY`), and email pitches created through the generator route are not backlink opportunities.
- If the host is blocked by the environment's network policy (curl `CONNECT tunnel failed, response 403`), or the token gets `401`, push nothing, set those rows' `outreach_status` to "Not pushed (tool unreachable)", put those pitches in the batch Doc instead, and tell Kai what failed.

## Step C1. Find the campaign

`GET /api/generator/campaigns?include=paused` and pick the campaign named "guest post outreach" (match case-insensitively, ignore surrounding spaces; confirmed in the tool on 2026-10-09). Note its `id` and that step 1 exists. If it is missing, push nothing, put the email pitches in the batch Doc, and ask Kai to create or rename the campaign in the tool (the API cannot create campaigns). A paused campaign still accepts drafts; say it is paused so Kai knows they will not send until it is active. Step 1 only: no follow-up drafts until Kai asks for them.

## Step C2. Choose what to push

- Push every PURSUE site whose `submission_stage` is pitch-first and whose Send to is an email address.
- Do not push article-first sites, even when they take the article by email. This holds whether the article would sit in the email text, be attached, or be linked. See Step C2b.
- Do not push form-only, application or structured-form sites, or sites whose address could not be read. Set their `outreach_status` to "In Doc (form only)" or "In Doc (no email)". They go in the batch Doc.
- Never push a site whose contact email is on a `.in` or `.pk` domain (or an `.co.in`, `.com.pk` style domain) or whose site was flagged SKIP_REGION_EXCLUDED. If one slipped through to this step, stop, mark it SKIP_REGION_EXCLUDED and leave it out.
- When several addresses are listed, push to the one the guidelines name for pitches.
- Do not push earlier batches unless Kai asks.

## Step C2b. Article-first sites: tracked separately, never pushed

For every article-first PURSUE site, whatever the delivery method (`in email text`, `attached document`, `linked document` or `form`):

1. Write the full article package in Part B (cover note, article, form answers, photo list) into the batch Google Doc, one H2 section per site with a checkbox, exactly as in Part B output.
2. Add a row to the **Full Articles** tab of the "Guest Post Master Tracker" (create the tab if it is missing), with these columns: `site, batch, send_to, required_subject, article_delivery (in email text, attached document, linked document or form), doc_link (link to the site's section in the batch Doc), title, word_count_required, photos_required, bio_and_headshot_required, link_rules, fee_risk, status, date_drafted, date_reviewed, date_sent, notes`. `status` runs: Drafted, In review, Revised, Approved, Sent, Declined. A new row starts at Drafted.
3. On the main tab set `outreach_status` to "Article for review (not pushed)" and `submission_stage` to article-first.
4. Do not create a draft in the outreach tool, and do not send anything. This includes a cover note that carries the article text and an email whose body is the article itself. The article is sent only after Kai has reviewed and approved it and asks for it to be sent.
5. When Kai approves an article and asks to send it by email, push the approved text (exactly as he approved it) as a step 1 draft following Step C3 and Step C3b. If the site wants the article attached or linked rather than in the email text, the draft carries the short cover note only and Kai attaches or links the document himself, which the reviewer note says. Set the Full Articles `status` to Sent when Kai confirms it was sent. Form-based articles are submitted by Kai by hand; update `status` when he says so.
6. In the chat reply, list the article-first sites in a short sentence or two with what each needs before review (real photos, headshot, fee risk), and say they were not pushed.

## Step C3. Build each draft

```json
{
  "campaign_id": "<id from C1>",
  "contact": {
    "email": "editor@site.com",
    "first_name": "Mollie",
    "last_name": null,
    "company": "<site name>",
    "title": null,
    "website": "https://site.com",
    "attributes": { "source": "guest-post-pitches", "batch": "C1-B1", "domain": "site.com", "guidelines_url": "<pitch_url>" }
  },
  "step_number": 1,
  "subject": "<the pitch subject line, or the subject the site requires>",
  "body": "<plain-text body>",
  "reviewer_note": "<requirements note from Step C3b>"
}
```

- `first_name` and `last_name` only when the editor's name is known from the site, otherwise `null`. Never put `{{first_name}}` or other merge tags in the copy; they are sent literally. The greeting is written into the body itself: "Hi <first name>," or, with no name, "Hi <Site name> team,". Before posting, check that no body starts with a bare "Hi," or "Hello,".
- The body is the pitch as written in Part B, as plain text: greeting through the closing line, paragraphs separated by a blank line (`\n\n`), any requested bio kept inside it. The body ends with the line "Best regards," and nothing after it.
- Add no name, title or signature block, unsubscribe line, tracking pixel or rewritten links. The tool appends the inbox signature.
- No markdown, and no square brackets in the body. Run the scan below for `[` and `]` and for `](`; a hit blocks the push.
- Links are written as plain URLs (hotelhottubs.com stays as written).
- Pre-push scan of every body, with a script: parenthetical or labelled word counts (patterns such as `\(\s*(about\s+)?[\d,]+\s*words?\s*\)` and labels like `Bio (50 words):`); assurances about commercial status (`non-?commercial`, `not sponsored`, `unsponsored`, `no affiliate`, `affiliate links`, `not selling`, `on behalf of`, `not (a|an) (company|business|brand|agency)`, `not promotional`, `no strings`, `purely editorial`); process announcements and spec lists (`request an assignment`, `assignment`, `before I write anything`, `before writing anything`, `as your guidelines`, `per your guidelines`, `your submission process`, `pitch first`, `royalty-free`, `internal links`, `with headings`, `table of`, `photos attached`); article-in-the-email markers (`Title:`, `Full article`, `Photo list`, `Photos:`, `Cover note`, `Author bio`, several subheadings, or a body over about 400 words), which mean an article slipped into a pitch, so stop and route that site per Step C2b instead; the about-Claire paragraph (find the paragraph containing hotelhottubs, flag it when it is over about 80 words, flag it when the paragraph right before or after it also talks about Claire's own background with words such as `career`, `marketing`, `hostel`, `traveled`, `my husband`, and flag it when it contains self-praise words such as `seasoned`, `experienced`, `avid`, `passionate`); the words "founder" and "word count"; em dashes; and a closing line other than "Best regards,". Also check the recipient: block the push if the contact email or website ends in `.in` or `.pk` (including `.co.in`, `.com.pk`, `.org.pk`). Fix every other hit before posting, then read each pitch once more asking whether a real writer would type every sentence unprompted and whether the editor reaches the idea before reading much about Claire.
- The generator route accepts `campaign_id`, the contact, `step_number`, `subject`, `body` and the optional `reviewer_note`. Do not add any other field to the payload. The requirements and context go only in `reviewer_note`, never in the body or subject, and never in the contact `attributes` (those stay as shown above, for contact-level research only).

## Step C3b. Requirements note (`reviewer_note`)

For every pitch pushed, write a short plain-text note for the person reviewing the draft and send it as the draft's top-level `reviewer_note` string in the same create call. Kai sees it above the body on /review in a read-only box labeled "Requirements and context" (line breaks kept, http(s) URLs clickable). It is never part of the email body, subject or headers, and it does not block approval. This is where the site's word counts, link rules, deliverable specs (headings, tables, links, images) and process rules belong, not in the pitch.

Content, only the points that exist for that site:

- Guidelines page URL and where and how to submit, including any required subject line or required first line, and whether the site wants a pitch or assignment request first.
- Every quoted rule: word count, photo rules, link and bio rules, topics wanted and rejected, exclusivity, payment or fees.
- A "Link rule" line whenever the guidelines restrict commercial, promotional, sponsored or affiliate links, or exclude companies, quoting the wording and saying the pitch does not address it, so Kai can decide before approving.
- The proposed angle in one line (the hook), and which sites or posts it was checked against.
- Fee or paid-placement risk, and any site requirement a reviewer should know (for example a site that rejects pitches sent by AI). No line about invented details or things to confirm.

The requirements come from the triage record (`requirements_summary`, `evidence_quotes`). The note is plain text with line breaks (`\n`), no markdown, at most 4,000 characters after trimming (typically 600 to 2,100). Do not send null, a non-string or an over-length value: the API skips that draft with `Invalid draft`. An empty string is stored as no note.

- Also store the same note in the tracker's `requirements_note` column on the site's row (add the column if missing), as the backup record.
- Do not replace drafts that are already in the tool just to attach or change a note, because replace overwrites the subject and body and resets the review diff, which wipes any edits Kai made in Review. Only add or change a note on an existing draft when Kai asks for it. In that case, first ask Kai to export the pending queue as CSV from /review and use his exact current subject and body from it, never the Doc text.
- The create response does not echo the note. In the chat reply, ask Kai to confirm that the first pushed draft shows the "Requirements and context" box in /review. If it does not, the deployed tool does not have the field yet: tell Kai, and keep notes in the tracker only until he confirms.
- Mention in the chat reply that the requirements notes were pushed as reviewer notes and are also in the tracker's `requirements_note` column.

## Step C4. Send

`POST /api/generator/drafts` with a JSON array (create mode), at most 100 drafts per request; split larger batches. Check each item in `results` by `index`:

- `ok: true, outcome: "created"`: write `email_id` to the tracker's `outreach_email_id` column (add the column if missing) and set `outreach_status` to "Draft in outreach tool".
- `ok: false`: set `outreach_status` to "Not pushed", write the `error` in `notes`, and put the pitch in the batch Doc (except for the already-drafted and already-enrolled cases below). Do not retry `Contact is suppressed` or a closed enrollment. `Already has a live draft for this step` or `Already enrolled in this campaign` means the contact already has a draft or was pitched there: record it and move on. For `Invalid draft`, check subject, body, email and the `reviewer_note` length and type, fix the cause and retry once.
- Report the response's `notification` value (`sent`, `skipped`, `failed`) in the reply.

## Follow-ups and the reviewer note

Step 1 only until Kai asks for follow-ups. When he does, `GET /api/generator/followups-due` returns each sent email with its `reviewer_note` (string or null), so the original requirements are visible when writing step 2. Notes are not copied automatically to a new follow-up draft: include `reviewer_note` explicitly in the create call when it should accompany that draft.

## Fixing a pitch that is already in the tool

To change copy that is still pending review, POST `{"mode": "replace", "replace_only": true, "drafts": [ ... ]}` with the same campaign, email and step. `replaced` keeps the same `email_id`. Omit `reviewer_note` to leave the existing note unchanged, send a new string to update it, or send an empty string to clear it. `Draft is approved`, `Draft is sending` or `Draft is sent` means it can no longer be edited: tell Kai, who can unapprove it in the campaign queue. Replace only when Kai asks for a copy change, never to tidy wording, because replacing overwrites any edits Kai has made in Review. The API cannot delete or reject a draft: if a draft should not be in the tool (for example an article that was pushed by mistake, or a site later found to be based in India or Pakistan), tell Kai to reject it in /review.

## Part C report

In the batch reply: how many pitch drafts were created in the outreach tool, how many items went into the Doc and why (form only, no email, push failed), which article-first sites were added to the Full Articles tab, how each wants the article delivered (in the email text, attached, linked or form), and what each needs before review, any API skips, whether the owner notification went out, which pitches carry a "Link rule" flag in the reviewer note, how many domains were skipped as Indian or Pakistani sites and which domains had an unclear region check, and the request that Kai confirm the requirements box shows on the first draft in /review. Link the Doc only when one was created.