# Internal linking rules

The blog exists to send readers to pages where they can book. Every post routes readers to
the most specific page that answers "where should I stay?".

## Which page to link
| The post mentions | Link to | Anchor text |
| --- | --- | --- |
| A destination or onsen town | Its destination page, e.g. `/kinosaki-onsen` (find with `blog_tools.py links <town>`) | Descriptive: "Kinosaki Onsen ryokan", "all 43 ryokan in Kinosaki" |
| A specific inn | Its inn page, e.g. `/kinosaki-onsen/nishimuraya-honkan` | The inn's name |
| A region (Hokkaido, Kyushu, near Tokyo) | The region page (`/hokkaido`, `/near-tokyo`) | "ryokan in Hokkaido", "onsen ryokan near Tokyo" |
| Private baths | `/private-onsen` | "ryokan with a private onsen" |
| Onsen hotels | `/onsen-hotels` | "onsen hotels" |
| How we pick and check inns | `/how-we-choose`, `/how-we-verify` | Natural phrasing |
| Another blog post on the subject | That post (once published) | Its target keyword |

## Funnel: every section ends on a page you can book
Kai's rule (2026-11-20): the blog's job is to send readers to destination and inn pages. Our
own data shows blog posts convert partner clicks at roughly half the rate of city pages, so a
post earns its place only by handing readers on. A well-written post that doesn't is a miss.

- **At a glance table** right under the opening (not a blockquote): verdict, how long, best
  for, then one row per pick ("Splurge", "Value", "Private baths", "Adults only"), each a linked
  inn. Follow it with a bold CTA line: **[See all <n> <town> ryokan, with prices for your dates →](/<town>)**.
- **Filtered destination links.** The destination page takes view filters; link the one that
  matches the section, with the count from the page read today:
  `?bath=room` (bath in the room), `?bath=private` (private bath to book),
  `?tattoos=private` (bathe privately with tattoos), `?children=welcome`, plus `type`,
  `onsen` and `dinner` where the page offers them. Check each filtered URL in the browser and
  quote its count; never guess one.
- **A CTA at the end of each major section** (baths, tattoos, private baths, when to go,
  where to stay): one bold line, phrased as the next step for that reader.
- **Where to stay = one H3 per inn**, a reason from its page, and a closing bold line
  **[See rooms and rates at <Inn> →](/<town>/<inn>)**. End with "Compare all <n> …".
- **Practical sections point at inns too:** getting there names the inns a short walk from
  the station; how-long-to-stay suggests an inn for the second night; FAQ answers end with the
  matching filtered link.
- **A comparison section** ("<Town> or another onsen town?") linking 3 to 5 other destination
  pages with our counts and price ranges. It catches "X vs Y" searches and keeps readers who
  decide against this town on our site.
- **End with a plain H2** "Book your <town> ryokan": one sentence, a list of filtered links,
  then the bold all-ryokan CTA. Never a blockquote (it renders gray italic on the live site).
- Rough target for a town guide: 40+ internal links, the destination page (any filter) in at
  least 8 places, every inn page at least twice.

## How many
- The destination page: in the first 150 words, the at-a-glance CTA, every section CTA, "Where
  to stay" and the end box (see Funnel above).
- Inn pages: every inn named gets a link on first mention. A town guide names 5 to 10.
- Hubs: one or two, where they fit.
- Other posts: two to four once they exist. Update older posts to link to new ones.

## Choosing which inns to name
Pick inns that answer the reader's situation, from what our inn pages say (not from
competitors' lists): best overall, private bath in the room, best value, family-friendly,
tattoo-friendly, best food. Give each one a reason in one line, from its inn page. Prefer
inns we can book.

## External links
Only where they help the reader and nothing on our site covers it: the official tourism site,
JR or bus timetables, an event's official page. Never link OTAs (Booking, Agoda, Klook,
TripAdvisor, Jalan, Rakuten).
