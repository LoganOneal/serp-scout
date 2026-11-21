# Photo rules

Use only photos we are allowed to use commercially on a website. Record every photo in
`photos.json` with: `file` or `image` URL, `source`, `page` (where the license is shown),
`license`, `attribution` (the exact credit line), `alt`, `placement`.

## Allowed sources, in priority order
1. **Ryokan Society's own destination photos.** `site-index.json` → `site_photos` per
   destination, with the page's `photo_credits`. Most are Wikimedia Commons photos the site
   already credits; reuse the same credit line. Prefer these: they're already vetted.
   The page gives one combined credit line, not one per photo, and some photos (no credit
   needed) may have no entry. To credit a single photo, find its Commons file (search Commons
   for the alt text with `blog_tools.py photos`) and use that file's own credit; if you can't
   match it, use a different photo.
2. **Inn photos from our own inn pages** (`static.cupid.travel`, the gallery at the top of
   each inn page). Kai approved them for blog use on 2026-11-20. Every inn the post
   recommends gets one: the best of the five gallery photos (download them, compare on a
   contact sheet, pick the one that shows the reason it's picked: the bath for a bath pick,
   the dinner for a food pick, otherwise the best exterior or garden). Place it directly under
   the inn's H3, wrapped in a link to the inn page, and as a 360 px thumbnail (3:2 crop, about two-thirds of the cell; Kai found 160 px too small)
   (`![alt](url){w=360}`) beside the inn in the at-a-glance table. Use the original
   `static.cupid.travel/hotels/<id>.jpg` URL; the site's `/_next/image` resizer refuses
   outside requests.
3. **Wikimedia Commons** via `blog_tools.py photos`. Only CC0, public domain, CC BY and
   CC BY-SA (the script filters out everything else). CC BY and CC BY-SA need the credit line;
   CC BY-SA stays fine as long as we don't edit the image beyond a crop or resize.
4. **Openverse** (Flickr and other CC sources) via the same command, with the same licenses.
   Check the photo's own page once: Flickr licenses can be changed by the uploader, so the
   license shown on the page today is the one that counts.
5. **Unsplash or Pexels**: free for commercial use without credit under their own licenses,
   but there is no API key here. Use them only if Kai picks photos and gives the links.

## Never
Google Images, competitor sites, Instagram, Pinterest, Reddit, TripAdvisor, OTA listing photos
(Booking, Agoda), photos of a different inn presented as the one recommended, any photo marked
NC (non-commercial) or ND (no derivatives), and AI-generated photos presented as real places.

## Choosing photos
- **Hero:** landscape, at least 1600 px wide, of the place itself (the town, the bath, the
  inn), not a station or signage.
- One image every 300 to 400 words, each next to the section it shows.
- Prefer people-free or small-figure scenes; avoid identifiable faces of private people as the
  subject.
- Check that the photo shows what the caption says (read the Commons description).

## Alt text
Describe what's in the picture in plain words, with the place name where it's true: "Willow-
lined canal in Kinosaki Onsen at dusk". No keyword lists.

## Credits: always at the bottom
Kai's rule (2026-11-20): **every photo credit goes in the "Photo credits" section at the end
of the post, never under or beside the photo**, unless a license strictly requires the credit
next to the image (CC BY and CC BY-SA do not: a credits section is a reasonable manner of
attribution). A caption under a photo may describe it ("Goshono-yu, one of the seven public
bathhouses.") but never carries the credit. List each credited photo as
`<what it shows>: Author, License, via Wikimedia Commons`, with the license name linking to the
license URL, and end with "Ryokan photos: courtesy of each ryokan, as shown on its Ryokan
Society page" when inn photos are used.
