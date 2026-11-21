# Dev handoff: author credit on ryokansociety.com (proposed, not built)

The blog post body (content.html) already carries the byline and the "About the author" section, so
it works in the current template. Three site changes make it complete:

1. **Author page route** `/authors/kai-sulkin`: use `content.html` here (same container and title classes
   as the blog). Until it exists, the byline and "More about Kai" links 404.
2. **Upload the headshot** `kai.jpg` (800x800) so it serves at `https://ryokansociety.com/authors/kai-sulkin.jpg`
   (or change `photo_url` in `author.md` to wherever it's hosted and re-render).
3. **Schema** (`packages/travel-web-core/src/lib/blog-schema.ts`): BlogPosting already emits a Person
   author when the article has `author: { name, jobTitle, bio }`. Set it to Kai Sulkin / Founder,
   Ryokan Society on each post, and extend `articleAuthorSchema` with `url` (/authors/kai-sulkin),
   `image` and `sameAs` once those exist. Put `person-schema.json` on the author page. In
   `blog/[slug]/page.tsx` the Next metadata still says `authors: [{ name: SITE.name }]`; use the
   post's author there too.
4. **Hero image:** set `hero_image_url` on every post (the Kinosaki hero is the Otani River photo).
   BlogPosting `image`, `primaryImageOfPage` and og:image all come from it; without it the post has
   no image in schema and shares with the generic site image. Host it on our domain at 1200 px+.

Optional: the blog column is `max-w-3xl` (768 px) while the site shell is 77rem.

## Blog dates: authored date always, "Last updated" only when changed later (Kai, 2026-11-20)

Today `blog/[slug]/page.tsx` (lines ~139-144) shows "Published on X. Last updated Y" whenever both
dates exist, even on the same day, and shows **no date at all** if either is missing. Proposed:

```tsx
{publishedOn ? (
  <p className="mt-4 text-sm text-gray-500">
    <time dateTime={publishedOn}>Published on {publicationLabel(publishedOn)}.</time>
    {lastUpdated && lastUpdated > publishedOn ? (
      <>
        {" "}
        <time dateTime={lastUpdated}>Last updated {publicationLabel(lastUpdated)}.</time>
      </>
    ) : null}
  </p>
) : null}
```

`publicationDay` returns YYYY-MM-DD, so the string comparison is by day. Keep `modifiedTime`
in the metadata as is. Caveat: the CMS `updated_at` can move on edits that aren't content
changes; if that shows "Last updated" too eagerly, drive it from a deliberate revision date
(the way `CONTENT_REVISED_AT` already does for Hotel Hot Tubs in `article-updates.ts`).
