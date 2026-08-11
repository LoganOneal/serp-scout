# Backlog: Domain search & market sweep

| Field | Value |
|---|---|
| **Date** | 2026-08-07 |
| **Status** | Backlog — nothing here is built |
| **Scope** | Follow-on work for ENRICH MODE (domain search), the authority-citation audit, and the market sweep |

Everything below came out of building and then stress-testing those features
against live data. Each item records what is actually true today, so the next
person does not re-derive it.

> **Coverage work has its own plan:** see
> [`plan-domain-search-coverage.md`](./plan-domain-search-coverage.md) for how
> to widen discovery (509 already-paid-for domains are sitting untriaged) and
> the quality gates that must land before any new source is added.

---

## 1. Scheduled expiry re-check *(highest value)*

**Problem.** A run is a snapshot. Nothing re-probes, so nothing ever learns
whether a domain actually lapsed — which is the only moment that matters.

**Evidence.** At the time of writing, across all runs:

| Days to expiry | Domains |
|---|---|
| 0–90 | 14 |
| 92–167 | 10 |
| 183–270 | 16 |
| 290–364 | 24 |

The 10 domains at 92–167 days will enter the 90-day window within weeks and
nothing will notice. Of the 14 already inside it, 13 are `LIVE` — the watchlist
shows them, but no process is watching.

**Shape.** A daily Trigger.dev scheduled task re-probing every domain with
`days_to_expiry <= 90`, plus anything whose expiry has since passed. Free —
DNS, HTTP and RDAP only. Record transitions rather than overwriting, so
"renewed" and "lapsed" are both visible; a lapse is the strongest acquisition
signal the system can produce.

**Watch out.** The `LIVE`/`UNKNOWN` boundary is genuinely noisy — measured:
`ramarplumbing.com` read `EXPIRING_SOON` on one pass and `LIVE` on the next
minutes later; `imhandymen.com` flipped too. A re-check that treats one bad
read as a state change will generate false lapse alerts. Require two
consecutive agreeing probes before recording a transition.

---

## 2. Expiry is not availability

Not a feature — a correction the UI should eventually make for the operator,
because the current "Expiring ≤90d" tab implies more than it delivers.

After the expiry date: ~30–45 days registrar auto-renew grace → ~30 days
redemption (owner can restore, roughly $80–200) → 5 days `pendingDelete` →
drop. A domain expiring in 6 days is realistically obtainable in ~75+ days,
and only if the owner does nothing.

Anything with real age or links is taken by drop-catchers (DropCatch,
SnapNames, NameJet) within seconds of dropping. For the good ones the action is
**place a backorder**, not "buy at a registrar". The UI currently offers no
such distinction and should.

---

## 3. Wire the authority audit to the market page

The engine works and persists (`auditRunAuthorityLinks`), but it only runs from
`probe-authority-audit.mts`. Needs a button on
`/markets/[locality]/[niche]` alongside the domain-search panel, and the
authority columns surfaced in the results table.

**Cost model is already settled and measured:** `/backlinks/referring_domains/live`
is **$0.025 per target** (balance delta, not a rate card). A whole market is
$2.96, so the audit pre-filters on the cheap bulk endpoints and only buys the
list for established candidates with a real profile — roughly $0.35/market.
`LIVE`, `BROKEN` and `UNKNOWN` never earn a paid lookup.

---

## 4. Defunct-business discovery

**The known coverage gap.** Stage 1 enumerates from Google Maps, so businesses
that have already dropped off Maps never enter the pipeline — and those are
often the best targets, because the business is definitively gone.

**BBB cannot be crawled.** Verified: `bbb.org` category pages return **403 even
through DataForSEO**, which crawls for a living. `dallaschamber.org` returns 200
but yields no markup. Do not spend time retrying this.

**The one viable route is Wayback.** `web.archive.org` does not block, and
archived BBB/chamber category pages from 2014–2019 list businesses that no
longer exist. Feed the recovered domains into the existing triage unchanged.

**Unproven, check first:** whether archived BBB category pages carry business
*website* links or only links to BBB profile pages. If the latter, it is a
two-hop crawl and the yield may not justify it.

---

## 5. Reddit commentability is broken

`fetchPageHtml` had an accessor bug (fixed in `9988f1c`) — it reached for
`body.tasks[0].result[0].items[0]` while `client.post` already unwraps to
`tasks[0].result`, so it always returned empty HTML while still billing.

**Fixing the accessor did not fix the feature.** `on_page/instant_pages`
returns page metadata and **no `raw_html` key at all**, `store_raw_html: true`
notwithstanding — verified against `example.com`. Raw markup requires the
task-based On-Page flow (`task_post` → `/on_page/raw_html`).

Also measured: `old.reddit.com` returns **403** through DataForSEO, so the
premise in that module's header comment no longer holds either. Whatever
replaces this needs a different source, not a different accessor.

---

## 6. Credential-blocked adapters

Interfaced and inert. Each activates when a key appears; none is stubbed with
fake data, and the score reports them in `missing` rather than scoring a domain
down for their absence.

| Adapter | Stage | Blocker |
|---|---|---|
| Majestic | 5a — Trust Flow, Citation Flow, referring subnets, Topical Trust Flow | No subscription |
| Registrar availability (Namecheap / Dynadot) | 3e | No API key |
| Google Places Details | 1 — `businessStatus` | No key |

**On Places specifically:** the Maps source gives 100 businesses for $0.002 but
carries **no `business_status`** (measured 0/100 on a live result), so
`CLOSED_PERMANENTLY` — the spec's highest-value rows — is unreachable. Every
row already stores its `place_id` (100/100 coverage) precisely so a Places
Details call can supply it later. Places Text Search + Details would price 200
businesses near $3.70 versus $0.002, so this is a deliberate trade, not an
oversight.

---

## 7. Queued SERP would cut sweep cost ~70%

`serp/task_post` is **$0.0006** with a free `task_get`, against **$0.002** for
`serp/live/advanced`. A 50 keyword × 50 market sweep is **$5.00** live and
would be **$1.50** queued.

Costs a polling loop and a results table; Trigger.dev already provides the
long-running worker that makes this practical.

---

## 8. Calibrate the ranking weights

`scoreDomain` is a transparent additive heuristic for **sorting**, not an
appraisal. The weights encode the spec's stated priorities (age primary,
referring subnets over raw referring domains) and have **never been checked
against a realised acquisition**, because no outcome data exists yet.

Once a few domains have actually been acquired, the components to revisit
first are `acquirability` (currently worth only 2 points for `PARKED_DEAD`,
which is why zeroing it barely moved `kohler.com`) and the age ramp.

---

## 9. Smaller known gaps

- **CPC column reads `—` on the Google Ads path.** Google publishes a
  top-of-page bid *range*, not a CPC, and the two do not map — measured,
  `cpc/high` ran 0.07×–1.16× and `cpc/low` 0.79×–2.59×. Any single derived
  number would be fabricated in a column operators read as measured. Displaying
  the range instead is the honest fix.
- **`gbp_leaders` read 0 in every sampled row.** Flagged during the cost work,
  never investigated. May simply not be populating.
- **`providers/dataforseo/contracts.test.ts` fails**, and did so on a clean
  checkout of `d4ae21e` — pre-existing, unrelated to any of this work.
- **No git remote.** Every commit in this line of work exists only on one
  machine. `gh` is authenticated with `repo` scope.
- **Rotate the two Trigger.dev keys** that were pasted into a chat transcript.

---

## Appendix: what the triage learned the hard way

Four corrections, each found by an operator spot-checking a result. All four
had the same shape — **the probe was accurate and the label overreached** —
and the fix each time was to stop collapsing an ambiguous network result into
"dead".

| Domain | Reported as | Actually | Cause |
|---|---|---|---|
| `kohler.com` | `PARKED_DEAD`, ranked #2 | Live manufacturer | A 10s timeout was classified `dead` |
| `quixservice.com` | Top authority find | Live, unreadable | Same, and one `AbortController` covered the retry so the HTTP fallback never ran |
| `247manhattanplumbingnyc.com` | `PARKED_DEAD` | Broken WordPress (HTTP 500) | 5xx lumped in with 404 and connection-refused |
| `borismechanical.com` | `PARKED_DEAD`, ranked #1 in two runs | Broken WordPress (HTTP 500) | Same |

**27 of 64 domains labelled `PARKED_DEAD` were not dead.**

The structural fixes were three honest statuses — `PARKED_DEAD`, `BROKEN`
(5xx: a server is running and being paid for), `UNKNOWN` (triage never
concluded) — plus `conclusive` on the classification so an unproven row cannot
outrank a confirmed one.

The mirror-image risk was then closed too: `LIVE` used to short-circuit before
RDAP, so a domain parked on a broker with a convincing splash page was dropped
without the registry ever being consulted. Registry-expired states
(`redemptionPeriod`, `pendingDelete`, unregistered) now outrank any page
content, and a redirect to a known marketplace reads as *for sale* rather than
*already acquired*.

**The general lesson for anything added here:** a single probe is a snapshot of
a noisy channel. Prefer three honest buckets over two confident ones, and make
the absence of evidence visible rather than defaulting it to a verdict.
