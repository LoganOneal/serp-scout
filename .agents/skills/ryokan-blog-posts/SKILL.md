---
name: ryokan-blog-posts
description: Research, brief and write a Ryokan Society (ryokansociety.com) blog post built to outrank the current Google top 10 — SERP teardown, gap plan, internal links to inn and destination pages, license-safe photos, QA. Use for any Ryokan Society blog post or the blog calendar.
---

# Ryokan Society blog posts

One post at a time, end to end: pick the keyword, take apart the pages that rank for it,
plan how to be clearly better, write it as Kai, route readers to the right inn and destination
pages, add photos we're allowed to use, and check it before Kai publishes.

**The standard:** a reader who lands on our post should not need to click back to Google.
"Copy what works" means copy *coverage and format* (the questions answered, the structure that
fits the intent), never wording. "Improve on it" means facts nobody else has: Ryokan Society's
own inn-by-inn data, prices, private baths, tattoo rules and dinner plans, plus Kai's
perspective as someone raised in Japanese hospitality.

## Hard rules

- **Never publish.** Output is local files in `exports/ryokan-blog/<slug>/`. Kai reviews and publishes.
- **No invented facts.** Every number, price, count and inn detail comes from a page you read
  today (ryokansociety.com first, then official sources).
- **Kai's voice is confirmed by default** (Kai, 2026-11-20). First-hand passages written as
  Kai (how to read a dinner plan, how to ask about tattoos, what he looks for) go in with no
  `[KAI]` flag and no confirmation step, using only the persona facts in
  `.agents/skills/ryokan-guest-posts/references/kai-persona.md`. List them under "Written as
  Kai" in qa.md for reference, not as blockers. Never invent a credential, a family detail
  beyond the persona, a number, a price or an inn fact.
- **Never compete with our booking pages** (Kai, 2026-11-21). Booking-intent phrases ("<town>
  ryokan", "where to stay in <town>", "private onsen ryokan") belong to the destination or hub
  page, never a post's target, secondary, title or headings. See `references/cannibalization.md`;
  `python3 $T cannibal <slug>` must report nothing.
- **No copied text** from competitors, not even rephrased paragraph by paragraph. Take their
  coverage, write our own.
- **Photos only from the sources in `references/photo-rules.md`.** Never Google Images,
  competitor sites, Instagram, Pinterest or Reddit.
- **Semrush through the Semrush MCP tools only** (never the repo API key). Units are tight;
  one SERP pull is about 100 units.
- Ryokan Society work never uses Claire, Shelby or the Hotel Hot Tubs pipeline.
- **Every post is rewritten by a Chinese open-source model before it's published** (Kai,
  2026-11-21), for example Qwen, DeepSeek or Kimi. See step 8a. A post that hasn't been
  rewritten isn't ready to hand over.

## Setup

```bash
T=.agents/skills/ryokan-blog-posts/scripts/blog_tools.py
python3 $T next                 # next calendar post without a post.md: slug, target, secondaries
python3 $T site-index           # cached crawl of destinations + inn links (add --refresh monthly)
```

The calendar (order, targets, secondaries, volumes) is
`exports/ryokan-blog-keywords/calendar-data.json`, published as the "Ryokan Blog Calendar"
artifact. Do posts in calendar order unless Kai names one.

## Workflow for one post

Write each step's output into `exports/ryokan-blog/<slug>/` before moving on, so a later
session can resume.

### 1. SERP pull
`python3 $T serp-plan <slug> --keyword "<target>"` prints the Semrush MCP call
(`execute_report`, `report: "phrase_organic"`, top 10, US). Save the response as
`<slug>/serp.json`: `{"keyword": ..., "pulled": "<date>", "data": "<csv text>"}`.
If Semrush is out of units, use WebSearch for the target keyword and save
`serp.json` as a list of `{"position", "domain", "url"}` instead; note it in the teardown.

### 2. Take apart the ranking pages
`python3 $T pages <slug>` fetches each result and records type (blog/editorial,
big guide site, official, encyclopedia, forum, OTA, video), word count, outline (H2/H3),
images, tables, schema, dates and author. It writes `pages.json` and `pages-summary.json`.

Then **read every beatable article in full** (`beatable_articles` in the summary, plus any
official page that answers the query well). Pages the script couldn't fetch (403 from Reddit,
TripAdvisor, Klook) are read with WebFetch or the in-app browser. Read the Reddit thread if
one ranks: its questions and complaints are what travelers actually worry about.

### 3. Questions people ask
`python3 $T questions <slug> --keyword "<target>"` pulls Google autocomplete
("is kinosaki onsen worth it", "kinosaki onsen 1 or 2 nights", "...tattoo friendly").
Add People Also Ask questions from one WebSearch, and questions from the Reddit thread.

### 4. Teardown and win plan → `teardown.md`
Follow `references/serp-teardown-template.md`. It must end with **at least five specific,
material improvements** over the best article. Each one must name what we add and where the
fact comes from.

### 5. Our own assets
- `python3 $T links <words>` finds the destination page and every inn page for the subject
  (e.g. `links kinosaki`). Read the destination page and the 5 to 10 most relevant inn pages
  today. Note prices, private baths, dinner plans and tattoo rules.
- Hub pages: `/private-onsen`, `/onsen-hotels`, `/ryokans`, `/how-we-choose`, `/how-we-verify`,
  `/destinations`.
- Kai's angle: `.agents/skills/ryokan-guest-posts/references/kai-persona.md`.

### 5b. Keyword check
Before the brief, drop booking-intent secondaries and check the target against
`references/cannibalization.md`. If the target itself is booking intent, stop and tell Kai
(the topic belongs on the booking page).

### 6. Brief → `brief.md`
Follow `references/brief-template.md`: title tag, H1, slug, meta description, the
answer-first opening, the outline with each H2 mapped to a question or secondary keyword,
the word target, the internal link plan (`references/linking-rules.md`), the photo plan and
schema. Stop and show Kai the brief only if he asked to review briefs; otherwise go straight on.

### 7. Photos → `photos.json`
Follow `references/photo-rules.md`. In priority order: the site's own destination photos
(already credited, in `site-index.json`), the best gallery photo of every recommended inn (under its H3 and in the at-a-glance table),
then Wikimedia Commons and Openverse via
`python3 $T photos <slug> "<query>"`. Record every chosen photo with its exact
attribution line, alt text and placement.

### 8. Write → `post.md`
Follow `references/writing-standard.md` and the brief. Markdown with front matter.

### 8a. Rewrite with a Chinese open-source model
Every post goes through a rewrite by a Chinese open-source model (Qwen, DeepSeek, Kimi or
similar) before QA, so QA checks the text that will actually be published.
- Copy the finished `post.md` to `post.draft.md` first and keep it.
- Send the model the body only. Front matter, headings, links, image lines, table cells and
  the "Photo credits" section stay exactly as written. Ask it to rewrite the prose in Kai's
  voice following `references/writing-standard.md`: American English, the same facts, no new
  facts, and none of the "Avoid" phrases.
- Save the result as `post.md` and record the model, its version and the date in `qa.md`.
- Compare it with `post.draft.md`. Every number, price, count, date and URL must still be
  there and unchanged, and no new claim may appear. Restore anything the model changed or
  dropped, and remove anything it added.
- Then render, run `cannibal` and do QA on the rewritten post.
- If no such model is available in the session, stop before QA and tell Kai. Don't hand over
  an unrewritten post as finished.

### 8b. Preview as it will look live
`python3 $T render <slug>` writes `content.html` (the HTML for the CMS) and `preview.html`:
the post inside the live site's real header, footer, CSS and fonts (copied from
ryokansociety.com/blog and the site repo's `blog-content.css`; `--refresh-template` re-copies
them). Serve it with the launch config `ryokan-blog-preview` (port 8787) and open
`http://localhost:8787/<slug>/preview.html`. A panel at the bottom right shows the Google
snippet, link counts, warnings and KAI notes (highlighted in yellow in the text). Review there,
not in an artifact. Scroll to the end so lazy images load before judging photos.

### 8c. Author page
Authors live in `exports/ryokan-blog/_authors/<id>/` (`author.md` and the headshot).
`python3 $T render-author <id>` writes the proposed `/authors/<id>` page in the same live-site
shell (`preview.html`), its `content.html`, and `person-schema.json`, and lists the author's
posts. Re-run it after each new post. Bios use only facts Kai has approved (see
`.agents/skills/ryokan-guest-posts/references/kai-persona.md` and
`exports/ryokan-guest-post/qwoted-bio.md`); never invent credentials.

### 9. QA → `qa.md`
Run `references/qa-checklist.md`. Every box must pass, and the scorecard must show we beat
each top-3 article on at least four of the six criteria. Fix and re-check before handing over.

### 10. Hand over
Tell Kai: the post path, the target keyword and its volume, the top competitor and how we
beat it, the "Written as Kai" passages (for information), any site fixes found, and confirm
every credit is in the "Photo credits" section. Then `python3 $T next` gives the following post.

### 11. Site package
`python3 $T site-package <slug>` writes `<slug>/site/`, laid out at the site repo's own paths:
the article `.ts` (local article with `hero_image_url` and `author` set, which feed the
BlogPosting image, og:image and Person author), the author constant, every Commons photo
self-hosted as 1440 px WebP with width/height (hero loads first), the author photo, and a
README with the two registry lines (`local-articles.ts` ARTICLES and the editorial gate).
Downloads are cached in `<slug>/images/` (Wikimedia throttles fast clients). Never write to
the site repo itself; a developer copies the package in.

## Scale and pacing

Write posts one at a time with this whole process. Don't batch-generate drafts: a run of
similar, thinly researched pages is what Google's scaled-content spam policy targets. The
calendar's default pace is two posts a week.
