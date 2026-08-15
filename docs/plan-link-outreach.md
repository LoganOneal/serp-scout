# Plan: link prospecting and guest-post outreach from competitor backlinks

| Field | Value |
|---|---|
| **Date** | 2026-08-14 |
| **Status** | ✅ **Built and run 2026-08-14.** §10 records what it found. Live spend **$0.18**. No email sent, none can be sent from this repo |
| **Goal** | Give one competitor domain (`tubhotels.com`), get a priced, contactable prospect list, and a gated outreach pipeline |
| **Depends on** | [`plan-affiliate-economics.md`](./plan-affiliate-economics.md) (what a conversion is worth), [`plan-paid-search.md`](./plan-paid-search.md) §2 (the break-even inversion this reuses) |
| **Reuses** | `fetchReferringDomains` (measured $0.0242/target), `fetchBulkBacklinks`, `fetchRankedKeywords` (measured $0.012 + $0.00012/row), `scoreDifficulty` |

---

## 0. The reframing this plan turns on

Mining a competitor's backlinks for outreach targets does not return "sites that
link to good content in our niche". It returns **sites that chose to link to a
commercial competitor**, and for a commercial niche that population is dominated
by one thing:

> **You are building a list of link sellers.**

That is simultaneously the feature and the risk, and both need saying.

**It is the feature** because a list of sites that already sell links to a hot-tub
hotel affiliate is a qualified buyer list. They take the money, they know the
format, and the conversion rate on outreach is far higher than cold-emailing
editorial sites that have never sold a placement.

**It is the risk** because everyone in the niche mines the same competitors and
buys from the same sellers. A site linking to six of the same commercial targets
is a footprint, and footprints are what devaluation systems are built to find.
§0.2 turns that into a computable signal rather than a worry.

### 0.1 Authority metrics are the wrong first filter

This repo has already run this experiment and it failed. The P2 citation-hub
probe pulled referring domains for two local hubs and got back
`seo-anomaly-top-34.xyz`, `kilo-wiki.win`, `m98ufa.com` — SEO spam, platform
hosts, and nothing usable
([`plan-defunct-domain-discovery.md`](./plan-defunct-domain-discovery.md) §1.5).

The reason those pass an authority filter is that **authority metrics are
manufacturable and traffic is not**. A private blog network buys expired domains
with real link profiles; its `rank` and `referring_domains` look fine. What it
cannot fake cheaply is ranking for anything a human searches for.

> **First filter: does this domain rank for real keywords and get real traffic?
> Only then look at authority.**

A domain with DFS rank 60 and zero ranked keywords is a link network, and no bid
price makes it worth buying.

**And a naming precision that matters here:** we do **not** have DA or AS.
"Domain Authority" is Moz's proprietary metric and "Authority Score" is
Semrush's; we hold neither. We have DataForSEO's `rank` (0–1000). They correlate
loosely and are not interchangeable, and every column, screen and email in this
feature will say `dfs_rank` rather than borrow a name we cannot compute.

### 0.2 The signal that separates an editorial link from a marketplace

Feed the pipeline **several** competitors rather than one, and a free signal
falls out: for each referring domain, count how many of our competitors it links
to.

| Competitors linked | Reading |
|---|---|
| 1 | Plausibly editorial. Somebody chose to link |
| 2–3 | A niche site that covers the space, or an early-stage seller |
| **4+** | **A marketplace.** It links to whoever pays |

This costs nothing — it is a `GROUP BY` over data the first stage already
bought. It is the single most decision-relevant field in the whole prospect
table, and it points in **both** directions at once: a 6-competitor site is the
easiest sale and the worst footprint. Which is why it is surfaced as a number
next to the bid rather than folded into a score that hides it.

### 0.3 The bid comes from a threshold we already compute, not from the seller's rate card

The seller will name a price. The question this feature has to answer is what
the link is worth **to us**, and there is already a model that produces the
input.

`scoreDifficulty` measures `medianNonPlatformRefDomains` — the referring-domain
wall on a SERP we want. `domain_authority` holds our own count. The gap is,
roughly, how many links stand between us and the top of that page.

```
    prize        = monthly revenue at target position − at current position
                   (from site_keyword_targets: volume, position, and the
                    economics resolved in plan-affiliate-economics.md)

    links needed = SERP authority wall − our referring domains

    value/link   = prize × P(campaign works) × decay ÷ links needed
```

**Same inversion as paid search.** We do not predict that a link will move us
three places. We compute what a link would have to be worth for the price to
make sense, and compare it to what is being asked. §3 makes this concrete, and
**predicts the answer will often be below market**, exactly as the GLP-1 CPC
result was.

---

## 1. What already exists (do not rebuild any of this)

Most of the expensive plumbing is built and measured.

| Piece | Where | State |
|---|---|---|
| Referring-domain list with `url_from` | `authority-links.ts` `fetchReferringDomains` | **Built.** Measured **$0.0242** per target at limit 100 |
| Bulk metrics: rank, refdomains, spam | `backlinks.ts` `fetchBulkBacklinks` | **Built.** $0.024/request + $0.000036/row, 3 endpoints merged on `target`, cached 90 days |
| Ranked-keyword count (the §0.1 filter) | `quality-gates.ts`, `labs.ts` | **Built.** Measured **$0.012 + $0.00012/row** |
| Authority cache | `readAuthorityCache` / `writeAuthorityCache` | Built, 90-day TTL |
| The SERP authority wall | `scoreDifficulty` → `medianNonPlatformRefDomains` | Built. The §0.3 denominator |
| Keyword value | `site_keyword_targets` + `resolveKeywordEconomics` | Built last session |
| Spend ledger + budget guard | `spend_ledger`, `BudgetGuard` | Built, and mandatory here |
| Non-acquirable / infrastructure host sets | `NON_ACQUIRABLE_HOSTS`, `INFRASTRUCTURE_HOSTS` | **Built, and directly reusable** as prospect exclusions |
| Page fetching | `instant-pages.ts` | ⚠️ **Returns no `raw_html`** — see §4.1 |
| **Prospect table + qualification** | — | **Missing — §2** |
| **Bid model** | — | **Missing — §3** |
| **Contact discovery** | — | **Missing — §4** |
| **Outreach + compliance** | — | **Missing — §5** |

**Already-connected tools worth not duplicating.** The account has MCP
connectors for **lemlist**, **Apollo.io**, **Clay**, **Attio** and **Gmail**
(all currently unauthenticated). lemlist already solves sending, warmup,
deliverability, reply detection and unsubscribe handling — which is most of §5
and the part with the most ways to go wrong. **The recommendation is to build
prospecting and qualification here and hand sending to lemlist**, rather than
writing an email sender. §5 assumes that split and says what changes if not.

---

## 2. The pipeline

One command, one competitor (or several), five stages. Every stage is priced and
capped; every stage writes what it dropped.

```
  competitors: tubhotels.com, jacuzzisuites.com, romantichotels.com
        │
   ①  referring domains        $0.0242 × competitors      ~200-1000 domains
        │
   ②  exclude the obvious      $0                         free, and removes most of it
        │
   ③  bulk metrics             $0.024/req + $0.000036/row  rank, refdomains, spam
        │
   ④  TRAFFIC FILTER           see §2.4                    the §0.1 gate
        │
   ⑤  qualify + bid            $0                          verdict, max bid
        │
   ⑥  contact discovery        ~$0.005/site                only for qualified
```

**Cost falls at every stage on purpose.** The two paid stages that scale per
prospect (④ and ⑥) run **only on survivors**, which is the same economic
ordering the affiliate pipeline uses: free filtering first, paid measurement
last.

### 2.1 Stage ① — referring domains

`fetchReferringDomains` per competitor, `mode: one_per_domain`, so we get one row
per referring domain plus the page the link sits on. `REFERRING_DOMAIN_LIMIT` is
currently 100; this needs it raised and paginated, and **the cost scales with
rows** — the backlog measured $0.0416 for 490 rows, so a deep pull on three
competitors is dollars, not cents. Cap it and price it in the confirmation.

### 2.2 Stage ② — exclusions, free

`NON_ACQUIRABLE_HOSTS` and `INFRASTRUCTURE_HOSTS` already exist and already
encode what this repo learned the hard way — that a hand-rolled filter reported
fifteen "business websites" that were all adtech. Add a prospect-specific set:

- Social, video, and platform hosts (nobody is guest-posting on `facebook.com`)
- Our own portfolio domains and the competitors themselves
- Anything already in `outreach_suppressions`
- Domains we already have a link from

### 2.3 Stage ③ — bulk metrics

`fetchBulkBacklinks`, batched 1000, cached 90 days. Gives `rank`,
`referring_main_domains`, `spam_score`. Cheap and already written.

### 2.4 Stage ④ — the traffic filter, and its open cost question

This is the §0.1 gate and it decides whether the whole list is real.

`fetchRankedKeywords(target, limit: 1)` returns `total_count` — the number of
keywords a domain ranks for — for a **measured** $0.01212. On 500 prospects that
is **$6.06**, which is affordable but is the largest line in the run.

> **Unproven and worth one probe:** `/dataforseo_labs/google/bulk_traffic_estimation/live`
> takes up to 1,000 targets in a request. If it is priced per request like the
> bulk backlinks endpoints, it replaces $6.06 with cents. **Measure it by balance
> delta before building stage ④ around the per-domain call** — the same probe
> that found `ranked_keywords` was billed per row.

Reject on: zero ranked keywords, or ranked keywords wildly out of proportion to
`rank` (the link-network signature).

### 2.5 Stage ⑤ — qualification

A verdict per prospect, in the same vocabulary as everything else here:

| Verdict | Meaning |
|---|---|
| **PURSUE** | Real traffic, clean profile, bid clears the likely ask |
| **MARGINAL** | Qualifies, but the bid is thin — batch it, do not chase it |
| **REJECT** | Named reason: no traffic, spam score, marketplace footprint, irrelevant |
| **UNKNOWN** | A required signal was never measured. **Never folded into REJECT** |

---

## 3. What a link is worth

### 3.1 The model

Per §0.3, and every term below already exists in the database:

```
  prize          Σ over target keywords of
                   (revenue at target position − revenue at current position)
                 using volume, ctrAtPosition, and resolveKeywordEconomics

  wall           median non-platform referring domains on those SERPs
                   (scoreDifficulty.medianNonPlatformRefDomains)

  ours           our own referring domains (domain_authority)

  linksNeeded    max(1, wall − ours)

  pSuccess       P(the campaign actually moves us)      ← MODELLED, and stated
  decay          fraction of link value still present at 12 months  ← MODELLED

  valuePerLink   prize × pSuccess × decay ÷ linksNeeded
```

`pSuccess` and `decay` are **modelled inputs with no measurement behind them**,
and they are the two terms that most move the answer. They are required options
rather than buried constants, they are labelled on every screen, and the first
thing this feature should produce after a campaign is a measurement that
replaces them.

### 3.2 The bid is per-prospect, not per-link

`valuePerLink` is the average. What we will pay for *this* placement scales with
what it plausibly delivers:

```
  maxBid = valuePerLink × qualityMultiplier(prospect) × (1 / safetyMargin)
```

`qualityMultiplier` rises with relevance (does it rank for anything in our
keyword space?) and traffic, and **falls sharply with the §0.2 competitor
count** — a marketplace link is worth less than an editorial one at identical
authority, because so does everyone else's.

### 3.3 The prediction to write down before it runs

Guest-post placements in travel and health niches are commonly quoted at
**$100–$500**, and link-building campaigns typically need dozens of links.

> **The model will frequently return a `maxBid` below the market rate**, for the
> same structural reason the GLP-1 keywords returned break-even conversion rates
> above 100%: an affiliate commission on a $300 booking has to fund a fixed cost
> that a subscription business or a lead-gen business can amortise far better.
>
> Recording this now so a low number is read as a result rather than a bug.

If it does come out low, the honest responses are: target lower-competition
keywords where the wall is shorter, negotiate, or accept that link buying is not
the right channel for these sites — not to raise `pSuccess` until the answer
looks better.

---

## 4. Contact discovery

For each qualified prospect: find who handles editorial and partnership requests.

### 4.1 Fetching the page has a known trap

`on_page/instant_pages` **returns no `raw_html`**, verified in this repo against
`example.com` and recorded in `domain-search-backlog.md` §5. `store_raw_html:
true` does not change it. So contact discovery needs one of:

| Route | Cost | Note |
|---|---|---|
| Plain HTTP fetch | **$0** | Works for most small sites; blocked by Cloudflare on some |
| `on_page/content_parsing` | list price, unmeasured | **Probe it** |
| `on_page` browser render | **$0.0051** measured | The fallback for JS-rendered contact pages |

Start with the free fetch and escalate only on failure — the same cost ordering
as everywhere else here.

### 4.2 What the agent does

Candidate URLs, in order: `/write-for-us`, `/contribute`, `/guest-post`,
`/contact`, `/about`, `/team`, `/editorial`, plus whatever the homepage links to
with matching anchor text. Stop at the first page carrying a usable contact.

Then an LLM pass over the parsed text, extracting:

- Email address, **verbatim**, including obfuscated forms (`name [at] site.com`)
- Name and role, **only when stated on the page**
- Whether the page states guest-post terms, and any price mentioned
- A one-line evidence quote for each field

**The rule that matters most:**

> **The agent never invents a name, a role, or an email.** If the page does not
> say who handles this, the field is null and the prospect is flagged
> `contact_unknown` — it does not become "Hi there" or a guessed
> `editor@domain.com`.
>
> A guessed address bounces, and bounces are what destroy a sending domain. A
> guessed name is worse: it lands, it is wrong, and it tells the recipient
> exactly what this is.

Pattern-guessed addresses (`editor@`, `info@`) are allowed but stored with
`confidence: 'pattern'` and are **excluded from the first send** by default,
because a bounce costs more than the placement is worth.

### 4.3 Verification

Bounces are the whole game. Options in cost order: MX record check (free,
catches dead domains), SMTP probe (free, unreliable and rate-limited), a paid
verifier (Hunter/NeverBounce, ~$0.003–0.01/email). **Apollo and Clay are already
connected** and do this. Recommend routing verification there rather than
building it.

---

## 5. Outreach

### 5.1 Send through lemlist, not through code we write

Deliverability is a specialist problem — warmup, sending-domain separation,
throttling, reply detection, bounce handling, unsubscribe processing. lemlist is
already connected and does all of it.

**So the split is:** this repo owns prospects, qualification, bids, contacts and
message drafting. lemlist owns sending and reply state. We push a campaign and
poll status back onto `outreach_messages`.

If sending is built here instead, everything in §5.2 becomes our problem and the
build roughly doubles.

### 5.2 Compliance is a build requirement, not a footnote

Cold commercial email in the US is governed by **CAN-SPAM**, which requires
accurate headers and sender identity, a non-deceptive subject line, a valid
physical postal address, a working opt-out, and honouring opt-outs within 10
business days. EU recipients bring **GDPR** into it; B2B outreach is usually
run under legitimate interest, which requires a real assessment and an easy
objection route.

Concretely, and non-negotiable regardless of who sends:

- `outreach_suppressions` is checked **before every send**, keyed on email *and*
  domain, and a reply saying "no" writes to it automatically
- A real postal address and a working unsubscribe in every message
- Never a fake `Re:` or a fabricated prior relationship
- Per-domain send caps and a global daily cap
- One contact per prospect domain per campaign

### 5.3 Message drafting

An LLM draft per prospect, using only facts the pipeline actually holds: the
site's name, the topic it ranks for, a real recent article title, and our
proposed topic. Merge fields are **verified before send** — a message containing
an unresolved `{{name}}` or a fact we could not source is blocked, not sent.

**Drafts are reviewed before the first send.** The gate shape is the one the ads
launcher already uses: built, validate-first, and a separate explicit confirm.

---

## 6. Schema

```sql
link_prospect_runs        -- one run: which competitors, what it cost, what it dropped
link_prospects            -- domain, dfs_rank, refdomains, spam, ranked_keywords,
                          -- competitor_link_count (§0.2), verdict, reason,
                          -- max_bid_micros, quality_multiplier
link_prospect_sources     -- (prospect, competitor, url_from) — the §0.2 GROUP BY
link_contacts             -- prospect, email, name, role, source, confidence,
                          -- evidence_quote, verified_at, bounce_state
outreach_campaigns        -- site being built for, target keywords, budget, status
outreach_messages         -- contact, subject, body, status, external_id (lemlist),
                          -- sent_at, replied_at, outcome
outreach_suppressions     -- email OR domain, reason, added_at   (checked before every send)
```

`link_prospects.verdict` and `.reason` follow the same convention as every other
verdict in this codebase: `UNKNOWN` is a distinct state from `REJECT`, and the
reason is a sentence somebody can argue with.

---

## 7. Order of work

| # | Item | Cost | Why here |
|---|---|---|---|
| **0** | **Probe `bulk_traffic_estimation` pricing** (§2.4) | ~$0.05 | Decides whether stage ④ costs cents or $6/run. One balance-delta measurement |
| **1** | `link_prospect_runs` / `link_prospects` / `link_prospect_sources` + stages ①–③ | ~$0.10/competitor | The list, and the §0.2 signal that makes it readable |
| **2** | Traffic filter (§2.4) + exclusions (§2.2) | per probe | **The filter that decides if any of it is real** |
| **3** | Qualification verdicts + `UNKNOWN` handling | $0 | Pure, tested |
| **4** | Bid model (§3), with `pSuccess`/`decay` as required labelled options | $0 | Reuses the difficulty wall and the economics already built |
| **5** | Contact discovery: free fetch → parse → LLM extract, never invent (§4) | ~$0.005/site | Only on qualified prospects |
| **6** | `outreach_suppressions` + the pre-send check | $0 | **Before any drafting.** Cheaper to build first than to retrofit |
| **7** | Message drafting + merge-field verification | LLM | Drafts only |
| **8** | lemlist push + status poll-back | $0 | Sending stays where deliverability is somebody's job |
| **—** | Our own email sender | — | **Not recommended** — see §5.1 |
| **—** | `pSuccess` / `decay` measured from a real campaign | — | Nothing to measure until one has run. The first campaign is the experiment |

**Items 0–4 are the request's first half** and produce a priced prospect list
with no email involved at all. That is a useful deliverable on its own, and it
is worth confirming the numbers look sane before building outreach on top.

---

## 8. What this cannot do

- **It cannot tell you a link will work.** `pSuccess` and `decay` are modelled
  with nothing behind them. The bid is what a link would have to be worth, not a
  prediction that it will be.
- **Competitor backlinks are a biased sample.** You find the links they *bought*,
  not the links that *worked*. Editorial links earned by good content are
  systematically under-represented, because those sites link once and are hard to
  find by this method.
- **`dfs_rank` is not DA and not AS.** We do not hold Moz's or Semrush's metric
  and the columns will not pretend otherwise.
- **The traffic filter can be gamed**, just more expensively than authority can.
  A network that buys real traffic will pass it.
- **Email discovery fails on Cloudflare-protected and JS-rendered sites**, and
  on sites that use a contact form and publish no address. Those are `UNKNOWN`,
  not "use info@".
- **Reply rate is not measured anywhere yet.** Until a campaign runs, any claim
  about outreach conversion is invention.
- **Nothing here models the seller's price.** We compute a maximum bid; what
  they ask is a negotiation the tool does not observe.

---

## 9. The risk this feature buys, stated once

Paying for links that pass PageRank is a violation of **Google's link spam
policy**. The documented remedy is that the links are devalued, and the
documented worst case is a manual action against the receiving site. Guest
posting *as such* is fine; **payment for a followed link is the part that is
against policy**, and the policy asks for `rel="sponsored"` or `rel="nofollow"`
on paid placements — which removes the ranking benefit that is the entire point.

This matters to the model, not just to the conscience:

> **A penalised site is not worth zero, it is worth negative** — it takes the
> existing organic revenue with it. `pSuccess` in §3.1 is therefore not "did the
> rankings move", it is "did the rankings move *and* nothing got penalised", and
> the expected value of a campaign has to carry that downside.

The practical exposures the §0.2 signal is measuring: a marketplace linking to
six competitors is a pattern already visible to anyone looking, and buying into
it puts our sites in the same cluster. That is the strongest argument for
weighting `qualityMultiplier` **against** high competitor counts rather than
toward them, even though those are the easiest placements to buy.

**This is your call to make and the plan implements what you asked for.** It is
recorded here because it changes the arithmetic in §3, and a bid model that
ignored it would be overstating what these links are worth.

---

## 10. Results — 2026-08-14

Built and run end to end. **$0.18 of live spend. No email was sent, and none can
be sent from this repo.** 854 tests pass, typecheck clean.

### 10.1 Item 0 measured, and it reshaped stage ④

`bulk_traffic_estimation` by balance delta:

| targets | Δ balance |
|---:|---:|
| 3 | $0.012360 |
| 15 | $0.013800 |

**$0.012 per request + $0.00012 per target** — the same per-row rate as
`ranked_keywords`, but it takes **1,000 targets in one request**. So the traffic
gate on 500 prospects costs **$0.072** instead of **$6.06**.

That 84× is what makes §0.1 affordable to run on *every* prospect rather than a
sample — and a sampled quality filter tells you nothing about the rows it
skipped.

### 10.2 §0.1 confirmed: 83% of the list is not a website

One run, three competitors, 100 referring domains each:

| | |
|---|---:|
| Referring domains found | **136** |
| Excluded (§2.2, free) | 5 |
| **REJECT** | **121** |
| PURSUE | 10 |
| Spend | **$0.1794** |

Of the 121 rejects, **113 failed on traffic alone** and 8 on spam. A sample of
what the gate caught:

```
buzzshrink.website        ranked 0    etv 0
screenshots.wiki          ranked 3    etv 0
quero.party               ranked 1    etv 0
ggmap.us.com              ranked 0    etv 0
bye.fyi                   ranked 5    etv 1
```

**This is the P2 citation-hub result reproduced exactly** — same shape, same
worthlessness. Every one of these carries a link profile good enough to pass an
authority filter. **An authority-first pipeline ships all 113 of them.**

### 10.3 And what survived is real

```
verdict        kw       etv  rank  spam  comp  domain
PURSUE      16945   567,036   244    17     1  magnificentworld.com
PURSUE      14269   184,993   261    22     1  beautifulworld.com
PURSUE      11220   132,573   314    23     1  johnnyafrica.com
PURSUE      17056    89,166   273     4     1  girlwiththepassport.com
PURSUE      11445    34,568   339    23     1  mantripping.com
```

Real travel blogs at 11–17k ranked keywords. **`comp` is 1 across the board** —
no marketplace detected. That is a genuine reading of these three competitors,
and it is also a warning about them: obscure competitors have little referring-
domain overlap, so the §0.2 signal has little to work with. Mining larger
competitors is what would make that column earn its place.

### 10.4 The free half of contact discovery works

Page fetching costs nothing and found addresses without a single model token:

```
mantripping.com          ok   /contact-us, /about        james@mantripping.com
minitravellers.co.uk     ok   /guest-post, /contact      karen@minitravellers.co.uk
girlwiththepassport.com  ok   /write-for-us, /contribute (no address in text)
johnnyafrica.com         ok   /contact, /about
```

`minitravellers.co.uk` publishing a `/guest-post` page **and** a named editor is
the ideal shape. `girlwiththepassport.com` has `/write-for-us` and `/contribute`
but no address in the text — the `form_only` case, which stays `form_only` and
never becomes a guessed `editor@`.

### 10.5 A silent failure, found by running it

Contact extraction reported **"0 found"** with no cause. The credential check
relied on `new Anthropic()` throwing when nothing resolves — **it does not**; it
constructs fine and fails at request time. So 4 extractions failed one at a time
inside a per-row `catch` that swallowed them.

"These sites publish no contacts" and "nothing was ever asked" had become the
same output. Now checked once, up front, and reported as a blocker — plus a
`failed` counter, so a thrown extraction is never counted as a measured
negative.

### 10.6 The `now()` helper bit three times

`const now = () => timestamp('created_at', …)` hardcodes the column name.
`startedAt: now()` declares a column called **`created_at`** — the TypeScript
field name is the lie, the SQL name is the truth, and nothing surfaces until an
INSERT fails at runtime.

It cost three separate debugging rounds (`started_at`, `first_seen_at`,
`added_at`). Added `timestampCol(name)` beside it so the trap is unreachable for
the next table.

### 10.7 Suppression verified before anything can draft

```
suppressed domain, known address  : true
suppressed domain, OTHER address  : true   <- domain-level is the point
unrelated site                    : false
```

Someone who asks to be left alone speaks for the site, not the inbox the mail
reached. Address-only suppression would leave the next contact discovered at
that domain fair game.

### 10.8 Still blocked

| Blocker | Effect |
|---|---|
| **No Anthropic credentials** | Contact extraction and drafting cannot run. `ANTHROPIC_API_KEY` or `ant auth login`. The free fetch half already works |
| **No lemlist auth** | Sending has no home. Deliberately so — §5.1 |
| **No `--prize/--wall/--ours`** | Prospects are qualified but **unpriced**. The bid needs the SERP authority wall and our own referring-domain count |
| **`comp` is uninformative here** | Three obscure competitors share almost no referring domains. Mine larger ones |
