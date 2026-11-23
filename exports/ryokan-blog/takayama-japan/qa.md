# QA: Takayama, Japan (2026-11-23)

## Rewrite (step 8a)
- [x] `post.md` is the DeepSeek rewrite; `post.draft.md` keeps the original.
- [x] Prose pass: deepseek.v3.2 on Bedrock, 2026-11-23. 38 of 56 passages were rewritten. The rest kept the original text because a number or detail didn't survive the rewrite. The judge was Claude Sonnet 4.6.
- [x] Extras pass (`--fresh`), then `--check`: ok, no issues.
- [x] Six H2s were put back to the draft wording after the rewrite, so the keyword headings survive: "Things to do in Takayama" (a secondary keyword), "How to get to Takayama", "When to visit Takayama", "Does Takayama have onsen?…", "How many days in Takayama?" and "Is Takayama worth visiting?". `--check` still passes.
- [x] One edit after the rewrite, made in both the draft and the post: links added to Wat Hotel & Spa and Hida Hanasatonoyu Ouan.

## Search basics
- [x] **Title and H1:** "Takayama, Japan: How Many Days, What to Do and When to Go" (57 characters).
  - The first idea ended "…Where to Stay". `blog_tools.py cannibal` flagged "where to stay" as booking intent, so it was dropped.
- [x] **Target keyword placement:** in the title, the H1, the slug `/blog/takayama-japan`, the first sentence, the H2 "What is Takayama?" (as "Takayama") and the meta description.
- [x] **Meta description:** 143 characters.
- [x] **Must-cover topics:** each has a section.
  - old town, morning markets
  - the festival and the floats hall
  - Hida Folk Village, Jinya, Higashiyama
  - sake, Hida beef, onsen
  - Shirakawa-go, Okuhida and Kamikochi
  - how many days, where to stay
- [x] **Teardown questions:** each is answered in a section or the FAQ. The exception is "does Takayama station have lockers", which wasn't verified and is left out.
- [x] **Length:** about 3,800 words of prose. The preview counts 3,856 with table text. Target 3,000–3,800.

## Booking-page overlap
- [x] `cannibal takayama-japan`: "OK: no booking-intent overlap".
- [x] The H2 is "Where to stay in Takayama: our picks for each kind of trip".

## Facts and sources (all read 2026-11-23 unless noted)
| Fact | Source |
| --- | --- |
| 24 ryokan, 13 onsen hotels, 4 machiya, 3 minshuku; most $90–$460 for two, middle about $190 | ryokansociety.com/takayama |
| Filter counts: bath=room 4, bath=private 15, tattoos=private 15. These include onsen hotels; each was opened in the browser | /takayama filters |
| Inn details: rooms, ratings, baths, meals, children, access, $581 for Koto No Yume, $323 for Murayama | 11 inn pages, last checked by the site 16–17 Nov |
| Kaminaka a Registered Tangible Cultural Property (2012); Hachibei about half the middle price; Wanosato One Michelin Key 2026 | /takayama editors' picks |
| Tokyo about 4.5 h | /takayama |
| Nagoya 2 h 30 by express or 2 h 45 by bus; Toyama 90 min; Matsumoto bus 2 h 50; Route 158 notice; snow notices | hidatakayama.or.jp home page |
| Shirakawa-go about 50 min by Nohi bus, reservation needed | kankou-gifu.jp model course (Gifu Prefecture) |
| Hirayu to Kamikochi about 30 min | hidatakayama.or.jp pamphlet (search snippet) |
| Shinhotaka Ropeway closed 24–27 Nov 2026; allow extra time in autumn | nouhibus.co.jp/english |
| Jinya: 500 yen, free for 18 and under, hours, closed 29 Dec–3 Jan, shoe bags, no slippers or heating in winter | jinya.gifu.jp/en/guide/info |
| Miyagawa market 7:00 (Apr–Nov) or 8:00 (Dec–Mar) to noon; between the Kajibashi and Yayoi bridges; fewer stalls in winter or rain | West JR, Navitime, Mapple |
| Festivals: 14–15 Apr (Hie Shrine, 12 floats) and 9–10 Oct (Sakurayama Hachimangu, 11 floats); UNESCO 2016 | MLIT multilingual database, JNTO-linked page |
| Floats hall at Sakurayama Hachimangu, rotating autumn floats | Lonely Planet, japan.travel (search) |
| Hida Folk Village: 30+ buildings, mostly Edo period; about 700 yen | Several guides agree (secondary sources) |
| Seven sake breweries, all over 100 years old, mostly in Sanmachi | japan.travel (JNTO) |
| Sugidama green when new, brown as it matures | Travel accounts (search) |
| Higashiyama course about 3.5 km, about 2 h, passes the castle site | Several guides (search) |
| Hida beef, hoba miso, Takayama ramen, mitarashi dango | JNTO Hida beef article plus guides (search) |
| Comparison counts and ranges for Kanazawa, Matsumoto, Okuhida, Gero and Hakone | site-index.json (our destination pages) |

- **Facts from secondary sources only:** Hida Folk Village, the Higashiyama course, the food and the sugidama come from several independent guides. None is from an official page, so the post words them softly ("about 700 yen"). Kai may want to confirm the Folk Village fee before publishing.
- [x] **Japan-guide-only claims were rechecked.** Its "from around 6:00" market time was replaced with the 7:00 and 8:00 times.
- [x] **Counts are phrased as the site supports them.** "We list…"; filter counts say "with onsen hotels included".
- [x] **No `[KAI]` flags in the post.** `render` reports kai_notes 0.

## Written as Kai (unflagged, confirmed by default)
1. The breakfast-only plan: "I grew up in Tokyo in a hotel family…", in "What to eat".
2. How to ask an inn about tattoos: ask about reserving the kashikiri-buro, not whether tattoos are allowed. In the onsen section.
3. "I prefer visiting in autumn…", in "When to visit".

## Links
- [x] **Funnel:**
  - the at-a-glance table, with 4 linked picks and thumbnails, then the CTA
  - a CTA at the end of each major section
  - 9 inn H3s, each with a "See rooms and rates" line
  - filtered links (counts checked today)
  - the comparison table
  - the "Book your Takayama ryokan" H2
- [x] **Counts:**
  - 64 lines link to ryokansociety.com, about 84 links by the preview's count.
  - /takayama in 20 places.
  - Every picked inn has 4–7 links. Onyado Yuinosho and Yatsusankan (named in day trips) have 1 each.
- [x] **Link check:** all 41 unique URLs return 200. /blog/onsen-japan went live in the same deploy (2026-11-23), and /blog/kinosaki-onsen is live.
- [x] **Hub and external links:** /private-onsen is linked. External links are only the tourism office and Nohi Bus. No OTA links.

## Author
- [x] `author: kai`; the render output says `"author": "kai"`.

## Schema
- [x] `site-package takayama-japan` built. Published with onsen-japan in crakseo-directories PR #51, deployed 2026-11-23: 200, no noindex, datePublished 2026-11-23, in /blog and the sitemap, all 23 images load.

## Site preview
- [x] `render` run; preview viewed at desktop and 375 px mobile.
  - 19 images, none broken.
  - No horizontal scroll; no blockquotes.
  - Review panel: "Check: None".
- [x] Title = H1.

## Photos
- [x] **photos.json:** 4 Commons photos and 9 inn photos, each with its source, page, license, attribution, alt and placement.
- [x] **Licenses:** CC BY 2.0, CC BY-SA 2.0 and CC0 ×2. No NC or ND.
- [x] **Hero:** the Sanmachi street, 3872 px wide, landscape.
- [x] **Credits:** all in "Photo credits" at the end.
- [x] **Inn photos:** every recommended inn has a linked photo under its H3. The 4 at-a-glance picks have 360 px thumbnails.
  - Hoshokaku's photo is its terrace foot bath, not an in-room bath. The gallery has no room-bath photo.

## Writing
- [x] Answer-first opening, at-a-glance table, 4 tables (glance, access, seasons, comparison) and an FAQ. Inns appear only in the glance table and their H3s.
- [x] No phrases from the "Avoid" list and no em dashes.
- [x] Nothing copied from competitors. Coverage was taken from their outlines; the wording is ours.

## Scorecard against the top 3
#1 Wikipedia, #2 japan.travel, #3 japan-guide (non-encyclopedia rankings by position).

| Criterion | Ours | Wikipedia | japan.travel | japan-guide |
| --- | --- | --- | --- | --- |
| Answers the main question in the first screen | ✔ | ✘ | ✘ | partly |
| Must-cover topics and real questions | ✔ | ✘ | ✘ | partly (no days, no stay advice) |
| Specific, current, dated facts | ✔ (Jinya 500 yen, 2026 notices) | partly | ✘ | ✘ |
| Helps choose where to stay | ✔ (9 inns with reasons) | ✘ | ✘ | ✘ (Booking ads) |
| First-hand expertise | ✔ | ✘ | ✘ | ✘ |
| Photos and layout | ✔ | partly | ✔ | ✔ |

We win at least 5 of 6 against each of them.
