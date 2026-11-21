# Don't compete with our booking pages

Kai's rule (2026-11-21). Destination, hub and inn pages are the money pages: on our own data
they convert partner clicks at about 25%, blog posts at 4 to 12%. Two blog posts were already
301'd to their city pages because they competed with them (see the site's `editorial-gate.ts`).
A blog post exists to win **travel** searches our booking pages can't, then hand readers to
those pages. It must never target a search the booking page should win.

## Booking-intent phrases belong to the booking page
These are reserved for the page that lists the inns. A post never uses them as its target, a
secondary keyword, its title, H1 or an H2:

| Phrase shape | Belongs to |
| --- | --- |
| `<place> ryokan`, `ryokan <place>`, `<place> onsen ryokan`, `ryokan in <place>` | `/<place>` |
| `<place> hotels`, `<place> inns`, `<place> accommodation`, `where to stay in <place>` | `/<place>` |
| `best ryokan in <place>`, `luxury ryokan <place>`, `<place> ryokan with private onsen` | `/<place>` |
| `private onsen ryokan`, `ryokan with private onsen`, `private onsen` | `/private-onsen` |
| `onsen hotels`, `best/luxury ryokan (in japan)`, `onsen ryokan` | `/onsen-hotels`, `/ryokans` |
| `<inn name>` | the inn page |

Informational phrases that only contain "ryokan" are fine: `what is a ryokan`, `ryokan etiquette`,
`ryokan dinner`, `ryokan vs hotel`, `tattoo friendly onsen`.

## What a town guide targets instead
The town name alone is fine when its search results are travel results (official tourism site,
Wikipedia, Reddit, TripAdvisor, guides). Check `serp.json`: if the top 10 is mostly booking
sites and inn lists, the town name is booking intent too, so retarget the post at a travel
question and leave the town name to `/<place>`. Secondaries are travel questions: `is <place>
worth it`, `<place> 1 or 2 nights`, `<place> from kyoto`, `<place> bath pass`, `things to do in
<place>`, `<place> in winter`.

## When the calendar target itself is booking intent
Don't write the post. Tell Kai the topic belongs on the booking page, and propose either
(a) improving that page (an intro, FAQ, the decision help the post would have had), or (b) a
travel-intent post on the same town (`things to do in hakone`, `hakone day trip from tokyo`).
`blog_tools.py cannibal --calendar` lists every such calendar entry.

## Writing the post
- The "Where to stay" H2 says "Where to stay in <place>: our picks for each kind of trip", never
  "the best <place> ryokan".
- Inn sections stay short: the reason, the Baths / Ages / Known for line, the rates link. Room
  types, plans and prices belong on the inn and destination pages.
- The destination page gets the strongest anchor in that section ("all 43 Kinosaki Onsen ryokan"),
  and the funnel links in linking-rules.md.

## Check and monitor
- `blog_tools.py cannibal <slug>` before QA (also shown in the preview panel). It must report nothing.
- After launch, in Search Console: if the post and its destination page both show impressions for
  the same booking query and swap positions, cut the post's overlap further. If that fails,
  301 the post into the destination page.
