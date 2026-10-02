# HHT engine configuration

`engine.yml` is the runtime source of truth. Values marked **PLACEHOLDER DEFAULT** must be reviewed before launch.

- Seeds — **PLACEHOLDER DEFAULT**: `hotels with hot tubs`, `romantic hotels with hot tubs`, `hotels with jacuzzi rooms`.
- Competitors: `tubhotels.com`, `cozycozy.com`. These domains are excluded as competitor directories and used for Semrush keyword expansion.
- OTAs: Booking.com, Expedia, Hotels.com, Tripadvisor, Kayak, and Agoda.
- Other excluded site rules: Marriott, Hilton, Hyatt, IHG; Reddit, Pinterest, Facebook, Quora, X/Twitter; Amazon/eBay; Google/Bing/DuckDuckGo.
- Blocked keyword categories: jobs/careers, hot-tub sales and repair, parts, spa-brand-only terms, adult terms, and destinations outside the current US target (`uk`, `london`, `toronto`, `sydney`).
- Relevance thresholds — **PLACEHOLDER DEFAULT**: reject below `0.35`, local-embedding accept at or above `0.72`; near-duplicate threshold `0.92`.
- SERP depth — **PLACEHOLDER DEFAULT**: maximum 100; band 2 (21–50) requires 1 new domain from band 1; band 3 (51–100) requires 1 new domain from band 2; two consecutive low-yield bands saturate a keyword.
- Cooldowns: contact 90 days; decline 180 days; ranking re-verification 14 days.
- Google Ads: United States geo target `2840`, English language `1000`; **PLACEHOLDER DEFAULT** runtime cap 100 calls.
- Semrush cap: `null`, so the account balance is the only production cap. Low-credit threshold: 500 units.
- Batch limits: 20 minutes; at most 100 exported LLM tasks; daily keyword cap 200; expansion depth 4.
- Guest-post personalization: 3 topic ideas by default; topic titles max 120 characters, fit line max 240, generated subject max 120. Guideline-requested topic counts override the default.
- Explore share: 20%.
- CRM: disabled. CRM-ready payloads are upserted into `hht_engine.crm_outbox`.
