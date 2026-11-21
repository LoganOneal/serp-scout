# QA checklist → qa.md

Copy this into `qa.md`, mark each line, and fix every failure before handing over.

## Rewrite (SKILL.md step 8a)
- [ ] `post.md` is the version rewritten by a Chinese open-source model; `post.draft.md` holds the original
- [ ] Model, version and date recorded here
- [ ] Every number, price, count, date and URL in `post.draft.md` is still in `post.md`, unchanged; no new claims
- [ ] Front matter, headings, links, image lines and Photo credits unchanged

## Search basics
- [ ] Target keyword in title tag (≤ 60 chars), H1, slug, first 100 words, one H2, meta description (≤ 155 chars)
- [ ] Every must-cover topic from the teardown has a section
- [ ] Every question in the teardown's list is answered somewhere (FAQ or a section)
- [ ] Word count within the teardown's target range

## Booking-page overlap (references/cannibalization.md)
- [ ] `blog_tools.py cannibal <slug>` reports nothing: no booking-intent phrase in the target,
  secondaries, title, H1 or H2s
- [ ] "Where to stay" H2 is "Where to stay in <place>: our picks…"; inn sections stay short

## Facts
- [ ] Every number, price, count and travel time traced to a source read today (list them in qa.md)
- [ ] No fact taken only from a competitor
- [ ] Counts phrased as the site supports them ("of the ryokan we've researched" unless the denominator is stated)
- [ ] No `[KAI]` flags in the post; first-hand passages listed under "Written as Kai" in qa.md

## Links
- [ ] Funnel (linking-rules "Funnel"): at-a-glance table with linked picks and CTA; a CTA ending
  each major section; one H3 per inn with "See rooms and rates" line; filtered destination links
  with counts checked today; comparison section; "Book your … ryokan" H2 end
- [ ] Counts: internal links, destination-page links (target 8+), links per inn (target 2+)
- [ ] Every named inn links to its inn page, and every link resolves (HTTP 200)
- [ ] One or two hub links where relevant; no OTA links

## Author
- [ ] `author:` is a registry id; preview shows the byline under the date and "About the author" at the end
- [ ] The render output says `"author": "<id>"`, not "NOT IN REGISTRY"

## Schema (set when the post is added to the site)
- [ ] `site-package <slug>` built: article .ts has `hero_image_url` (self-hosted WebP) and
  `author`; no `upload.wikimedia.org` URLs left in it
- [ ] No FAQPage markup needed: Google shows FAQ rich results only for government and health sites

## Site preview
- [ ] `blog_tools.py render <slug>` run; preview.html viewed at desktop and mobile width,
  scrolled to the end so every image loaded; no warnings in the review panel
- [ ] Title = H1; no blockquotes; images show with captions

## Photos
- [ ] Every photo in photos.json with source, license page, license, attribution, alt, placement
- [ ] No disallowed source (see photo-rules.md); no NC or ND licenses
- [ ] Hero at least 1600 px wide, landscape, of the place itself
- [ ] All credits in the "Photo credits" section at the end; none under photos
- [ ] Every recommended inn has its photo under its H3 (linked) and a thumbnail in the at-a-glance table

## Writing
- [ ] Answer-first opening, at-a-glance table, at least one table, FAQ; inns only in the
  at-a-glance table and their H3s (no third inn table)
- [ ] At least one first-hand passage from Kai (or flagged for Kai)
- [ ] None of the "Avoid" phrases in writing-standard.md
- [ ] No sentence copied or closely paraphrased from a competitor

## Scorecard against the top-3 articles
Score our post and each top-3 article (from the teardown) on each criterion. We must win at
least four of the six against every one of them.

| Criterion | Ours | #1 | #2 | #3 |
| --- | --- | --- | --- | --- |
| Answers the main question in the first screen | | | | |
| Covers the must-cover topics and the real questions | | | | |
| Specific, current facts (prices, counts, times, dated) | | | | |
| Helps the reader choose where to stay (reasons, table) | | | | |
| First-hand expertise | | | | |
| Photos and layout (tables, scannable) | | | | |
