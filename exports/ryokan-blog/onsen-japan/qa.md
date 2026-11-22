# QA: onsen-japan (2026-11-21)

## Rewrite (SKILL.md step 8a)
- [x] `post.md` is the rewrite; `post.draft.md` holds the original, `post.prose.md` the prose-only stage
- [x] Writer: `deepseek.v3.2` on Amazon Bedrock (us-west-2), 2026-11-21. Checker: Claude Sonnet 4.6 on Bedrock, verdicts only (none of its words are in the post)
- [x] Prose (`rewrite_post.py`): 43 of 58 passages rewritten and passed every check; the rest keep the draft wording (reasons in `rewrite-log.json`)
- [x] Headings, FAQ questions, captions, CTAs, Baths lines, table cells, meta description (`rewrite_extras.py`): 55 of 56 rewritten, rechecked against the original. Left as written by the skill's rules: title/H1, "Where to stay" / "Book your" / FAQ H2s, inn names, "See rooms and rates" and "Compare all" lines, table headers, image alt text, link text
- [ ] 50% of the body's words still sit in runs of 4+ words copied from the draft
- [x] `rewrite_post.py onsen-japan --check` passes (heading levels, table shape, URLs, images, numbers, credits); re-rendered; `cannibal` reports nothing
- [ ] Read the changed headings and inn H3 tags before publishing

## Search basics
- [x] Target "onsen japan": title "Onsen in Japan: Etiquette, Tattoos and the Best Towns" (53 chars), H1 = title, slug /blog/onsen-japan, first sentence, H2 "The best onsen towns in Japan, by region" and H2 "Onsen in Japan FAQ", meta description (140 chars)
- [x] Every must-cover topic from the teardown has a section (definition, onsen vs sento, steps, rules, bath types, tattoos, private baths, towns, where to stay, when to go, how long, day trip in FAQ). Health and minerals are covered only as the legal definition plus the water-handling table; no health claims made.
- [x] Every teardown question answered (meaning, etiquette, what to wear, tattoos, private, vs sento, cost, best/where to go, near Tokyo, mixed, kids, periods, where to stay)
- [x] Word count 2,970 including tables (about 2,700 of prose); target 2,300 to 2,900. The preview panel counts 3,098 because it includes alt text and table labels.

## Booking-page overlap
- [x] `blog_tools.py cannibal onsen-japan`: "OK: no booking-intent overlap" (two H2s were renamed to pass)
- [x] Where-to-stay H2 is "Where to stay in Japan for your first onsen: our picks for each kind of trip"; inn sections are short

## Facts (all read 2026-11-21 unless noted)
| Fact | Source |
| --- | --- |
| 2,839 hot-spring areas with lodging, 27,899 springs; Hokkaido 226 areas; Oita 5,094 springs | env.go.jp/nature/onsen/pdf/6-7_p_1.pdf (FY2024, as of end of March 2025) |
| 25°C or one of 19 listed substances | Hot Springs Act Art. 2, via prefectural pages |
| 2,598 ryokan; 1,700 with hot-spring water; 1,580 in every bath; 726 bath in room; 996 private to book; 1,331 tattoos privately; 25 tattoos fine; 8 private-onsen tattoo-fine; 1,107 onsen hotels | ryokansociety.com/ryokans filters, /private-onsen?tattoos=fine, /onsen-hotels |
| Town counts and price ranges (13 towns); Kurokawa 10 + 2, Yufuin 27 + 13 private | each destination page |
| Kinosaki public baths allow tattoos | Kinosaki research, read 2026-11-20 |
| Nishimuraya Honkan: Ansei era, 29 rooms, baths open to 24:30, room baths not spring water, 10+, 15 min walk, Two Michelin Keys | inn page |
| Gora Hanaougi: spring bath in every room, tattoos allowed, private dining, from $780, children in some rooms, shared baths closed 10:00 to 15:00 | inn page |
| Mount View Hakone: 37 rooms, Owakudani water outdoors, groundwater indoors, 4 private baths 45 min free to ¥3,000, tattoos allowed, from $172, Japanese rooms without bath | inn page |
| Hanaingen: 2016, 99 steps from Yubatake, 100% Kusatsu water, 4 free private baths 24 h, mostly breakfast-only plans | inn page |
| Oyado Noshiyu: 11 rooms, 5 free private spring baths, children only in Azami and Shion, adults-only annex rooms, some water added | inn page |
- [x] No fact taken only from a competitor. Competitor-only claims left out: entry prices, towel rental price, water temperatures, the child age limit, the pregnancy advice, and the 2005 water-handling disclosure date.
- [x] Counts phrased as "ryokan we list"
- [x] No `[KAI]` flags (`render` reports kai_notes 0)

## Written as Kai
- "How to tell if a bath is real hot-spring water": the hotel-family opening, reading the changing-room sign, the four-phrase table and the advice to ask the inn.
- "Onsen with tattoos", the "How to ask" paragraph: "When I book for friends, I send one short line before paying…"
- "The best onsen towns…" intro: "These are the onsen towns I'd send a first-timer to…"

## Links
- [x] Funnel: at-a-glance table with 5 linked picks and a bold CTA; a CTA ends each major section; one H3 per inn with "See rooms and rates"; filtered links with today's counts; the region table works as the comparison section; ends on "Book your onsen stay in Japan"
- [x] 72 internal links. 13 destination pages plus /near-tokyo and /destinations. /ryokans with filters appears 18 times. Each inn page has 4 to 5 links.
- [x] All 30 unique internal URLs return HTTP 200 (checked today); the env.go.jp PDF returns 200
- [x] Hubs: /private-onsen, /onsen-hotels, /destinations, /near-tokyo. No OTA links.
- [ ] Other blog posts: the Kinosaki guide isn't live yet. Add a link to /blog/kinosaki-onsen from the Kinosaki row and the tattoo section once it's published.

## Author
- [x] `author: kai`; the render output says `"author": "kai"`; the preview shows the byline and "About the author"

## Schema
- [x] `site-package onsen-japan` built: `hero_image_url: "/blog/onsen-japan/hero.webp"`, author kaiSulkin, 0 `upload.wikimedia.org` URLs left (inn photos stay on static.cupid.travel, as in Kinosaki)
- [x] No FAQPage markup

## Site preview
- [x] Rendered and viewed at desktop and 375 px mobile: all 17 images load, no horizontal scroll, the panel's Check section says "None"
- [x] Title = H1; 0 blockquotes; captions show

## Photos
- [x] All in photos.json with source, license page, license, attribution, alt and placement
- [x] Commons only, with CC0, CC BY 2.0, CC BY 3.0 and CC BY-SA 2.0 licenses (no NC or ND). Inn photos come from the inn pages.
- [x] Hero is 4032 px (1920 thumb), landscape, and shows the Kusatsu Yubatake
- [x] All credits are in "Photo credits" at the end
- [x] Each of the 5 inns has a linked photo under its H3 and a 360 px thumbnail at a glance

## Writing
- [x] Answer-first opening with the unique number (1,700 of 2,598) and the official count; at-a-glance table; four other tables; FAQ; inns appear only at a glance and in their H3s
- [x] First-hand passages (above)
- [x] None of the avoid phrases, no em dashes, no "Yes," opening (the "Yes" answers in the FAQ and under the "Can you bathe privately?" heading answer a visible question)
- [x] Nothing copied or closely paraphrased

## Scorecard against the top-3 articles
#1 japan-experience.com, #2 japan-guide.com, #3 Lonely Planet.

| Criterion | Ours | #1 | #2 | #3 |
| --- | --- | --- | --- | --- |
| Answers the main question in the first screen | Win | Tie | Lose | Tie |
| Covers the must-cover topics and the real questions | Win | Partial | Lose | Partial (thin on tattoos and private baths) |
| Specific, current facts (prices, counts, times, dated) | Win | Lose | Lose | Partial (entry prices, no sources) |
| Helps the reader choose where to stay | Win | Lose | Lose | Lose |
| First-hand expertise | Win (reading the water sign, asking about tattoos) | Lose | Lose | Partial (writer's anecdotes) |
| Photos and layout (tables, scannable) | Win (5 tables) | Partial | Partial (ratings grid) | Partial (no tables) |

We win at least 5 of 6 against each top-3 article.
