# Part A. Feasibility

## Process (run per domain, independently)

### Step 0. Region pre-screen (Indian and Pakistani sites are excluded)

Run this before anything else, on every domain, so no time is spent searching for a pitch route on a site that will be skipped. A site is excluded when it is based in, owned or operated from, or written primarily for India or Pakistan. Check, in this order, and stop at the first clear hit:

1. **Domain.** Country-code domains `.in`, `.co.in`, `.net.in`, `.org.in`, `.firm.in`, `.gen.in`, `.ind.in`, `.pk`, `.com.pk`, `.org.pk`, `.net.pk`, `.edu.pk`, `.gov.pk` are excluded outright.
2. **Site signals on .com, .org, .net, .travel and other domains.** Fetch the homepage, about page and contact page (and the footer) and look for: a business or postal address, city or state in India or Pakistan (for example Delhi, Mumbai, Bengaluru, Jaipur, Goa, Kerala, Karnataka, Lahore, Karachi, Islamabad); a phone number starting +91 or +92; prices in INR, Rs or ₹, or PKR; an About text saying the owner, team or company is based in India or Pakistan; a footer or legal page naming an Indian or Pakistani company (Pvt Ltd, LLP, "Private Limited") or registration; or an audience described as Indian or Pakistani readers or Indian or Pakistani travelers.
3. **Search results and the supplied URL.** If the search snippets or the discovery data (country column, language, hosting country) say India or Pakistan, check against the signals in point 2 before deciding.

A hit on point 1, or on a clear signal in point 2 (one is enough when it is unambiguous, such as an address or a company registration), gives the verdict SKIP_REGION_EXCLUDED. Quote the evidence (the TLD, or the exact wording and URL of the page showing the address, registration, phone or audience) in `evidence_quotes` and put a short reason in `notes`, for example "Excluded: .in domain" or "Excluded: contact page lists a Jaipur address". Fill `skip_code` and `fit_rationale` with the same, leave pitch fields empty, and do not run Steps 1 to 4 or Part B for it.

What does NOT trigger the exclusion:

- A site based elsewhere (the U.S., the U.K., Europe, Australia and so on) that merely writes about India or Pakistan travel. Excluded sites are those based in or run from India or Pakistan, not those covering them. Judge the others by the normal gates.
- A contributor or editor with an Indian or Pakistani name on an otherwise non-Indian, non-Pakistani site. A name alone is never evidence.
- Weak or ambiguous signals alone (a single Hindi or Urdu word, a hosting provider, an Indian payment option next to others). When the signals are mixed and nothing clearly shows the site is based in or run from India or Pakistan, do not exclude: continue with Step 1, record `region_check = unclear` and what was seen in `notes`, and let Kai decide at review.

Record `region_check` as `excluded`, `clear` or `unclear` for every domain. Domains checked and found clear need no further comment.

### Step 1. Find the real pitch route

Work through every step below before concluding that no route exists, and write each URL fetched and each search run into the `search_log`.

1. **Supplied URL as a hint.** Fetch it. Check for a soft 404 (a page that loads but is the homepage, an unrelated post or product page, an app shell, or only meta tags). A soft 404 counts as "not found", never as proof the route exists or does not exist.
2. **Homepage, nav and footer.** Read the header, the main nav, utility links and the footer for: write for us, contribute, contributors, submissions, guest post, guest blogger, become a writer, writers' guidelines, contributor guidelines, pitch, work with us, work with me, collaborate, partner, advertise, media kit, press, contact. Footers often hold the page the nav lacks.
3. **Read the contact, about, work-with-us and advertise pages in full.** Pitch rules often sit inside them as a sentence (for example "If you are a blogger, fill out the guest post form" or "This site does not accept guest posts"). Follow any link they give.
4. **Path variants.** Try, with and without www and with and without a trailing slash: /write-for-us, /guest-post, /guestpost, /guest-posts, /guest-blog, /contribute, /contributors, /submissions, /submit, /pitch, /writers, /writers-guidelines, /contributor-guidelines, /become-a-contributor, /work-with-us, /work-with-me, /collaborate, /advertise, /partner-with-us, /press, /contact.
5. **Sitemap.** Fetch /sitemap.xml, /sitemap_index.xml, /wp-sitemap.xml and /page-sitemap.xml and scan the URLs for the keywords above.
6. **Web search.** Run `site:<domain> write for us OR guest post OR contribute OR submissions` and a plain query such as `<domain> guest post guidelines`. If the `site:` operator does not seem to work (results come from other domains), say so in the log and rely on the plain query. Only count results that belong to the domain.
7. **Record every candidate page.** Pick the one that holds actual instructions or a form as `pitch_url`. If it differs from the supplied `opportunity_url`, set `url_corrected = true`.

Traps to check before accepting a page as the pitch route:
- **Soft 404s**: the guessed URL renders the homepage or an unrelated article (seen on many sites).
- **Wording traps**: "contribute" can mean money (honeymoon gift lists), "work with us" can mean advertising, careers or affiliate programs, "collaborate" can mean brand sponsorship. Read the page before accepting it.
- **Unlinked pages**: a real guest-post page may not be in the nav or footer at all. The supplied URL, the sitemap, a sentence on the contact page or a search result may be the only way to find it.
- **Hidden emails**: addresses shown as "[email protected]" (a Cloudflare mask), "name (at) site (dot) com" or "name [at] site [dot] com" are a visible contact route. Record `email_obfuscated = true` and note that the address must be copied from the page in a browser. Never treat a masked address as "no contact route".
- **Tool limits**: robots.txt blocks, JavaScript-rendered pages (only meta tags returned), image-only responses and server errors are fetch failures, not evidence about the site. Do not bypass robots.txt, paywalls or 4xx errors by other means. Record the failure and the URL in the log, then try the other steps.

If the pitch page cannot be fetched after the retry, and no other route is found, the verdict is NEEDS_REVIEW with the error recorded. A failure to load the homepage or a feed alone is NOT a reason for review if the pitch page itself was read.

While reading the about and contact pages in Step 1, keep watching for Indian or Pakistani ownership or address signals that Step 0 could not see (for example a homepage that failed to load during the pre-screen). If a clear signal appears now, stop and give the verdict SKIP_REGION_EXCLUDED.

### Step 2. Apply hard gates in this order

Stop at the first gate that fails. Quote the exact wording that triggered it.

| Gate | Fails when | Verdict code |
|---|---|---|
| G0 Region allowed? | The site is based in, owned or operated from, or written primarily for India or Pakistan (Step 0). Applied first, before any pitch-route search. | SKIP_REGION_EXCLUDED |
| G1 Is it a publication? | Registry, gift list, forum index, store, or the guest-post URL just renders an unrelated app page. A company site that runs a real editorial blog passes this gate. | SKIP_NOT_PUBLICATION |
| G1b Invites guest posts? | After every step of Step 1, no page or explicit statement invites outside writers to submit guest posts or pitches. A contact page, advertise page, media kit or sponsored-post price list alone does not count. | SKIP_NO_INVITATION |
| G2 Open? | Page explicitly says closed, paused, not accepting, invite only, or check back later | SKIP_CLOSED |
| G3 One-off guest posts possible? | The route is explicitly a staff or team role, recruitment of paid team writers, assigned topics from an editorial calendar, or states "not for guest posts or sponsored posts". An open on-spec freelance pitch to an editor is a fence case, not a fail: lean PURSUE if an angle fits their stated sections and geography. | SKIP_STAFF_ROLE |
| G4 Companies allowed? | Page explicitly excludes businesses, brands, PR or SEO agencies and sends them elsewhere | SKIP_NO_COMPANIES, or PAID_ONLY if the redirect is a priced sponsored-post or advertising route |
| G5 Fundamental fit | See below | SKIP_MISALIGNED |
| G6 Site is dead | Domain parked, persistent errors, or no content | SKIP_DEAD |
| G6b Recently active? | No dated evidence of activity (a post, an owner reply to a comment, or a linked social post) in the 6 months before the triage date. Metadata dates do not count. | SKIP_INACTIVE |
| G7 Reachable? | The site invites guest posts but no form, email (including a masked or obfuscated one) or contact route for submitting was found after every step in Step 1 | NEEDS_REVIEW |

A page being silent about companies is NOT a failure. It passes G4 and is noted as `corporate_stance = unstated`. A page that only restricts commercial, promotional or sponsored links inside the article (without excluding businesses or sending them elsewhere) is not a G4 failure either: record it in `link_policy` and `restrictions`, and it goes into the reviewer note (see Part C), but it is not a skip reason and the pitch does not respond to it.

#### G5. Fundamental fit (subjective, but must be justified in writing)

Ask: could we write a piece that this site's actual readers would genuinely want, that also makes sense coming from Claire (a seasoned traveler and foodie who runs a U.S. hotel hot-tub guide)? Fail only when the answer is clearly no. Write 1 to 2 sentences saying who the readers are and why no workable piece exists. Typical clear failures:

- The readers are a different kind of traveler in a different market, and nothing we know serves them (for example hostel backpackers in Australia, New Zealand and Thailand).
- The site's scope excludes anything we can credibly cover and no angle bridges it.
- The subject is unrelated to travel or lodging (poetry, art, gambling, tech).
- The format cannot carry our content (for example forum-only, video-only, or personal-diary-only with a strict first-hand-trip rule that we cannot meet).

These are NOT failures: a mismatch in tone (reframe the angle), a regional restriction with a plausible local angle, narrative-first sites (give them a first-person story), family or women-focused audiences (target the occasion), and commercial company blogs.

### Step 3. Record soft signals (never disqualify on these)

- Link policy: dofollow, nofollow, byline-only, none stated, links removed, or commercial or promotional links not accepted (quote the wording).
- Payment: unpaid, paid to the writer, or fee charged to the contributor (record the amount).
- Commercial site: a company, tour operator, OTA or hotel blog is fine. Record it.
- Requirements: word count, number of images, exclusivity, original-only, response time, pitch-first versus article-first and how the article is delivered (pasted in the email text, attached, linked, or form), "must have an active blog".
- Geographic or topical restrictions.
- Freshness: record the newest dated evidence of activity and its source (used by gate G6b). Mark `activity = active, quiet or dormant`.
- Audience and reach claims, with the source quoted.
- Evidence that outside contributors really publish there.
- Platforms and user-content sites (community networks): evaluate on whether the contributor route is open, not on post freshness.

### Step 4. Assign the verdict

- PURSUE: clearly invites guest posts (G1b, with the inviting page as `pitch_url` and its wording quoted), shows activity in the last 6 months (G6b), and passes all other gates, including fence cases. Include pitch_url, contact route and a one-line angle. Set `confidence` to high when guidelines are clear and current, medium when something is unclear, low when the verdict leans on a doubt (record the doubt).
- PAID_ONLY: the only route for companies is a priced sponsored or advertising option. Capture the price. A human decides.
- SKIP_*: failed a gate on an explicit statement or clear evidence. Give the code and the quote or rationale. For SKIP_NO_INVITATION, say what was found instead (for example "contact page only" or "advertise page with prices") and point to the search log. For SKIP_REGION_EXCLUDED, give the evidence for India or Pakistan (the TLD, or the quoted address, registration, phone or audience wording and its URL). Write the skip reason in the tracker's `notes` column so it is clear why the site was not pitched.
- NEEDS_REVIEW: use when (a) the site invites guest posts but no way to submit was found after every step in Step 1, or (b) a fetch failure (robots.txt block, JavaScript-only page, repeated errors) stopped the search. Always set `review_reason` to one of: NO_ROUTE_FOUND, FETCH_BLOCKED, JS_RENDERED, SOFT_404_ONLY, AMBIGUOUS_PAGE. State exactly what is missing, and fill in the `search_log` and `steps_completed`. Do not use NEEDS_REVIEW for unclear company policy: that is PURSUE with low confidence. Missing activity dates are SKIP_INACTIVE. A site that loaded fine but shows no invitation anywhere is SKIP_NO_INVITATION, not NEEDS_REVIEW. Unclear region signals are not NEEDS_REVIEW either (see Step 0).

## Part A output format

One row per domain, as CSV or JSON, with these fields:

`domain, verdict, skip_code, review_reason, region_check, supplied_urls, supplied_url_result, pitch_url, url_corrected, submission_mechanism, submission_stage, article_delivery, contact_route, email_obfuscated, payment, link_policy, corporate_stance, requirements_summary, last_post_date, activity, outside_contributors_seen, restrictions, fit_rationale, suggested_angle, evidence_quotes, evidence_urls, steps_completed, search_log, confidence, notes`

- `region_check`: `excluded` (verdict SKIP_REGION_EXCLUDED), `clear` or `unclear`, from Step 0.
- `submission_stage`: `pitch-first` when the site wants a pitch, query, topic ideas or an assignment request before any article, or `article-first` when the finished article is part of the first submission, however it is delivered. See Step B1.
- `article_delivery`: for article-first sites only, one of `in email text`, `attached document`, `linked document`, `form`, or a combination (for example `in email text or attached document`). Whatever the value, an article-first site is routed the same way (Part C, Step C2b).
- `steps_completed`: the Step 1 items done, for example "1,2,3,4,5,6". For SKIP_REGION_EXCLUDED rows write "0".
- `search_log`: every URL fetched with its result (ok, 404, soft_404, robots_blocked, js_only, error, redirect) and every search query run, with a note on whether results belonged to the domain.
- `supplied_url_result`: what the supplied URL returned (ok, 404, soft_404, wrong_page, blocked), and what kind of page it really was.

Rules for evidence:
- Quote exact wording and give the URL it came from. No quote, no claim.
- Separate what a page says from what you infer.
- Give confidence as high, medium or low.
- Check dates against today's date, and prefer dates on actual posts over "last modified" metadata.

