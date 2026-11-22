# QA: kinosaki-onsen (2026-11-20)

## Rewrite (SKILL.md step 8a)
- [x] `post.md` is the rewrite; `post.draft.md` holds the original, `post.prose.md` the prose-only stage
- [x] Writer: `deepseek.v3.2` on Amazon Bedrock (us-west-2), 2026-11-21. Checker: Claude Sonnet 4.6 on Bedrock, verdicts only (none of its words are in the post)
- [x] Prose (`rewrite_post.py`): 53 of 65 passages rewritten and passed every check; the rest keep the draft wording (reasons in `rewrite-log.json`)
- [x] Headings, FAQ questions, captions, CTAs, Baths lines, table cells, meta description (`rewrite_extras.py`): 49 of 56 rewritten, rechecked against the original. Left as written by the skill's rules: title/H1, "Where to stay" / "Book your" / FAQ H2s, inn names, "See rooms and rates" and "Compare all" lines, table headers, image alt text, link text
- [ ] 51% of the body's words still sit in runs of 4+ words copied from the draft
- [x] `rewrite_post.py kinosaki-onsen --check` passes (heading levels, table shape, URLs, images, numbers, credits); re-rendered; `cannibal` reports nothing
- [ ] Read the changed headings and inn H3 tags before publishing

## Written as Kai (confirmed by default, Kai 2026-11-20)
- "How to ask an inn" (tattoo section): the polite note to send when booking.
- "From Kai: how to read a Kinosaki dinner plan": crab plans priced by amount and grade, Tajima
  beef as the alternative, and what a fixed early dinner seating says about the kitchen.

## Site fixes found (for the developer; not blockers)
1. /kinosaki-onsen says "about 2 hours 50 minutes from Kyoto"; Ekitan (July 2026) says about 2 h 30.
2. /kinosaki-onsen's spring card says cherry blossoms "early to mid April"; Visit Kinosaki says the
   last week of March to the first week of April.

## Resolved 2026-11-20
- Inn photos from our inn pages approved and used. Commons photos self-hosted as WebP in the site
  package. Hero image and author set (`site/`, see its README).
- Inn comparison table removed; its facts are now a Baths / Ages / Known for line under each inn.

## Booking-page overlap (2026-11-21)
- [x] `cannibal kinosaki-onsen`: OK. Title now "Kinosaki Onsen Guide: 7 Baths, Bath Pass, Is It Worth It?" (57);
  dropped "kinosaki onsen ryokan" / "kinosaki ryokan" for travel-question secondaries; "Where to stay
  in Kinosaki: our picks for each kind of trip". The town name stays the target: its top 10 is
  travel results (official site, Reddit, TripAdvisor, Wikipedia, Klook), not inn lists.

## Search basics
- [x] Target keyword in title (50 chars), H1, slug, first 100 words, H2s ("Where to stay: the best
  Kinosaki Onsen ryokan...", "Getting to Kinosaki Onsen...", "Kinosaki Onsen FAQ") and meta (148 chars).
  Keyword-heavy H2s were trimmed to three.
- [x] Every must-cover topic has a section: baths, pass, getting there, seasons, where to stay, food,
  yukata, nearby (Takeno, Izushi in "How long to stay").
- [x] Every teardown question answered (worth it, 1 or 2 nights, tattoos, mixed gender, pass price and
  where to buy, distance from Kyoto/Osaka/Tokyo, touristy/crowded, kid friendly, best ryokan, food,
  closing times, day trip).
- [x] Word count: about 3,400 with tables after the funnel pass (was 2,468 prose), against a target of 2,200 to 2,800.

## Facts (all read 2026-11-20 unless noted)
- [x] Sources:
  - **ryokansociety.com/kinosaki-onsen:** 43 ryokan taking bookings; $180–$720 for two, middle about
    $410; 6 with an open-air bath in some rooms; 23 with a private bath to book (counted from the inn
    cards); 20 within walking distance; pass valid to 13:00 on check-out day; Yumepa 1,500/750 yen;
    editors' picks.
  - **Our inn pages** (checked by the site Nov 17, read today): Nishimuraya Honkan, Onishiya Suishoen,
    Sensui, Tokitotoki, Koyado Enn, Hanakouji Saigetsu, Yuraku, Mikuniya, Kawaguchiya Honkan (card).
    They cover rooms, baths, ages, dinner, curfew, room-bath water and the association bus times.
  - **visitkinosaki.com:** 7 baths with their hours, closing days and fees (800/400 yen); Satono-yu
    closed since April 1, 2024; Kono-yu renovation May 11 to Oct 30, 2026; tattoos allowed; gender
    separation and nudity; the bath descriptions (Imperial Palace style, cave, oldest building, ceramic
    tubs, cypress, children's bath); about 1,300 years; 20-minute walk; crab November to March and the
    winter surge; seasons; shops closing about 17:00–20:00; Zentan bus; Tajima airport; JR Pass and JR
    West pass; all limited express seats reserved.
  - **Ekitan (current July 2026):** Kinosaki train about 2 h 30 min, several round trips; Kounotori
    about 2 h 40 min, more than ten round trips, some end at Fukuchiyama; all seats reserved; tickets on
    sale one month ahead.
  - **Tokyo, about 5 h:** Tokaido Shinkansen to Kyoto (about 2 h 15 min, general knowledge) plus 2 h 30
    min. This is the one figure not taken from a page today. The japan-guide figure (5 to 6 h) was not
    used.
- [x] No fact taken only from a competitor. Inside Kyoto's bath notes were each re-checked on the
  official bath pages. Japan-guide's Tokyo fare and its Hikari/Nozomi detail were dropped.
- [x] Counts phrased against the stated denominator. The site says "That is every ryokan in Kinosaki
  Onsen taking bookings", so "of the 43 ryokan we list" is supported.
- [x] All `[KAI]` items listed above.

## Links (funnel pass, 2026-11-20)
- [x] Funnel per linking-rules: at-a-glance table with 4 linked picks and CTA; a CTA closing the
  baths, pass, tattoo, private-bath, when-to-go and where-to-stay sections; one H3 per inn (8) with
  "See rooms and rates"; walkable inns in Getting there; second-night inns in How long; FAQ answers
  end on filtered links; comparison section (Arima, Hakone, Kusatsu, Kurokawa, near Kyoto); "Book
  your Kinosaki Onsen ryokan" H2 end with 4 filtered links.
- [x] 64 internal links: /kinosaki-onsen 21 times (with filters ?bath=room 6, ?bath=private 27,
  ?tattoos=private 29, ?children=welcome 15, counts read on the page today); every picked inn 4 to 6
  times except Yuraku (2) and Kawaguchiya Honkan (1, table only).
- [x] All 28 non-image URLs return HTTP 200 (license links now use the canonical trailing slash).
- [x] Hubs: /private-onsen, /how-we-choose. No OTA links.

## Author
- [x] Byline "By Kai, founder of Ryokan Society" with photo at the top; "About the author" before Photo
  credits; both link to /authors/kai (proposed page; see `_authors/kai/dev-notes.md`).

## Site preview
- [x] `blog_tools.py render kinosaki-onsen`; viewed at http://localhost:8787/kinosaki-onsen/preview.html.
- [x] Title = H1; no blockquotes; table, inn H3s and end section render with live CSS; images and
  captions show. Only panel warning: the 2 KAI notes.

## Photos
- [x] (2026-11-20 pass) Best gallery photo of each of the 8 recommended inns, picked from a contact
  sheet of all 40: under each inn's H3 (linked to the inn page) and as 360 px 3:2 thumbnails in the
  at-a-glance table. All 8 URLs return 200; the preview shows 17 of 17 images loaded.
- [x] All credits moved to "Photo credits" at the end, each naming the photo; captions now only
  describe. Opening no longer starts with "Yes,".
- [x] Five photos in photos.json, each with source, license page, license, attribution, alt text and
  placement. Each was viewed to confirm it shows what the caption says.
- [x] Licenses: CC0, CC BY 2.0/2.5 and CC BY-SA 4.0. No NC or ND. One candidate was rejected because its
  provenance was unclear.
- [x] Hero: 5280 px landscape night shot of the town's river and bridge.
- [x] Photo credits section uses `Author, License, via Wikimedia Commons` with license links.

## Writing
- [x] Answer-first opening with the unique numbers (43, $180–$720, 29 with a private bath), an at-a-glance
  table, 5 tables and an 8-question FAQ.
- [x] Two first-hand passages, both flagged for Kai.
- [x] None of the "Avoid" phrases and no em dashes (grep clean).
- [x] Nothing copied or closely paraphrased. The Inside Kyoto itinerary idea (arrive mid-afternoon,
  bathe before and after dinner) is common advice and is written in our own words.

## Scorecard against the top-3 articles
The top three articles are Inside Kyoto (#6), japan-guide (#7) and kitakinki (#9). The SERP's #1–#5
are the official homepage, Reddit, TripAdvisor, Wikipedia and Klook, none of them articles.

| Criterion | Ours | Inside Kyoto | japan-guide | kitakinki |
| --- | --- | --- | --- | --- |
| Answers the main question in the first screen | ✔ (worth it, numbers, box) | ✘ (intro, no verdict) | ✘ | ✘ |
| Covers the must-cover topics and the real questions | ✔ (all, plus FAQ) | Partial (no tattoos, nights, FAQ) | Partial | ✘ |
| Specific, current facts (prices, counts, times, dated) | ✔ (dated Nov 2026, current closures) | ✘ (Sato-no-yu, old fees, unreserved seats) | Partial | ✘ |
| Helps the reader choose where to stay | ✔ (8 inns, table, reasons) | Partial (4 inns, vague) | ✘ (sponsored blurbs) | ✘ |
| First-hand expertise | ✔ (pending Kai) | ✔ (strong, own photos) | Partial | ✘ |
| Photos and layout | ✔ (5 photos, 4 tables) | ✔ (many own photos, map) | Partial | Partial |

Result: we win 4 of 6 against Inside Kyoto (the two ties are expertise and photos), 6 of 6 against
japan-guide and 6 of 6 against kitakinki. **Pass.**
Inside Kyoto has a Google map and its own station photos. A later update could add a map of the seven
baths and the inns.
