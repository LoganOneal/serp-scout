# Plan: paid search for the affiliate sites — which keywords, and how we would know

| Field | Value |
|---|---|
| **Date** | 2026-08-13 |
| **Status** | ✅ **Built 2026-08-13. Nothing launched, $0 spent at Google.** Validate-only reached Google and it accepted the campaign without applying it — §10 |
| **Goal** | Pick keywords worth buying Google Ads on for `hotelhottubs.com`, and hold the launch machinery behind a gate |
| **Depends on** | [`plan-affiliate-directory-sites.md`](./plan-affiliate-directory-sites.md) — the keyword grid, organic positions and free volume it produces are this plan's inputs |
| **Bibliography** | §7 |

---

## 0. The reframing this plan turns on

The obvious framing is "predict which keywords will be profitable, then bid on
those". Twenty years of published field experiments say that framing produces
confident numbers that are wrong in a specific direction — **too optimistic** —
and that the error is largest exactly where an affiliate site wants to bid.

Three results, each from a large randomised experiment rather than a model:

> **Paid search returns are a fraction of what non-experimental estimates
> claim, and can be negative.** eBay ran large-scale field experiments turning
> ads off. Brand-keyword ads had **no measurable short-term benefit**.
> Non-brand ads did influence new and infrequent users — but frequent users,
> who would have bought anyway, accounted for most of the spend, so **average
> returns were negative**. (Blake, Nosko & Tadelis 2015, *Econometrica*)

> **The measurement is statistically expensive to the point of infeasibility.**
> Across 25 field experiments totalling $2.8m of spend, **the median confidence
> interval on ROI was over 100 percentage points wide.** Individual-level sales
> have a coefficient of variation around 10, so an informative experiment can
> require more than ten million person-weeks. (Lewis & Rao 2015, *QJE*)

> **Observational methods do not recover the experimental answer.** Across 15
> Facebook RCTs — 500m user-experiment observations, 1.6bn impressions — no
> observational approach reliably reproduced the experimental lift. (Gordon,
> Zettelmeyer, Bhargava & Chapsky 2019, *Marketing Science*)

**So this plan does not predict profit.** A profit prediction requires a
conversion rate we have never measured, and the literature says that even after
spending real money the estimate will have an interval wide enough to contain
both "excellent" and "ruinous".

What it does instead is §2: **invert the question**. We cannot say what a
keyword will earn. We can say exactly what it would have to earn to break even,
from data we already hold and did not pay for. That number is falsifiable, it is
computable today, and it sorts the list.

### 0.1 The one coefficient that makes this tractable

There is a directly usable published estimate for the hardest term, and it is
keyed on a column this tool already stores.

Google ran a meta-analysis of **390 Search Ads Pause studies** — accounts where
search ads were switched off — and measured what fraction of ad clicks were
*incremental* rather than cannibalised from the advertiser's own organic
listing. The answer depends almost entirely on **where the advertiser ranks
organically**:

| Our organic rank | Incremental share of ad clicks |
|---|---:|
| **1** | **50%** |
| **2–4** | **82%** |
| **5+** | **96%** |
| no organic result on page 1 | (81% of ad impressions and 66% of ad clicks occur here) |

*(Google Research, "Impact of Organic Ranking on Ad Click Incrementality",
meta-analysis of 390 Search Ads Pause studies.)*

**Read that as a cost multiplier and it becomes decision-relevant.** At organic
rank 1, half of every click we buy is a click we already had for free — so the
true cost per *incremental* click is **2× the CPC**, and a keyword needs twice
the conversion rate to break even. At rank 5+ the multiplier is ~1.04 and paid
search is almost purely additive.

> **This inverts the intuition that you should defend your best keywords.** The
> keywords where paid search is *least* wasteful are the ones we rank *worst*
> for — and those are exactly the ones the organic side has already classified
> `BUILD`.

The tool stores `site_keyword_targets.position`. The multiplier is a lookup, not
a guess, and §7 records the source so the constant can be argued with.

### 0.2 The honest counterweight

The same Search Ads Pause programme reports an average **89% incremental ad
clicks across verticals** (Chan, Yuan, Koehler & Kumar 2011), which sounds far
more favourable than the eBay result. Both are real and they are not in
conflict:

- Google's studies measure **clicks**, and mostly on accounts where the
  advertiser did *not* hold the top organic slot — 81% of ad impressions had no
  associated first-page organic result at all.
- eBay measured **purchases** for a dominant brand that ranked #1 organically
  for its own name — the 50% row above.

**They are the same finding read at two ends of the organic-rank axis**, which
is why this model is keyed on that axis rather than on a single global
incrementality constant. Simonov, Nosko & Rao (2018) land in between, measuring
a **1–4%** causal effect for brand ads on Bing when no competitor is bidding,
larger brands lower.

---

## 1. What already exists (do not rebuild any of this)

Paid search needs five inputs. **Four are already in the database and were free.**

| Input | Where | State |
|---|---|---|
| Keyword universe | `site_keyword_targets`, 975 for `hotelhottubs` | Built — grid expansion |
| Demand | `volume`, Google Ads, free | Built |
| **Our organic rank** — the §0.1 term | `position`, `position_source` | Built |
| Competition & bid range | `competition_index`; bid range **fetched and dropped** | ⚠️ §1.1 |
| Seasonality | `monthly_series`, 12 months, free | Built, unused |
| Difficulty / SERP shape | `difficulty`, `has_ai_overview` | Built |
| **Conversion rate** | — | **Missing, and unbuyable — §2** |
| **Forecast from Google itself** | — | **Missing — §3** |
| **Campaign creation** | — | **Missing — §5** |

### 1.1 The bid range is already bought and thrown away

`CachedVolume` carries `lowTopOfPageBidMicros` and `highTopOfPageBidMicros`,
returned free on every Google Ads volume call. `runVolumePass` stores `cpcMicros`
— which is **deliberately null on the Google Ads path**, because Google publishes
a bid *range*, not a CPC, and the existing code refuses to fabricate one from it:

> "Google publishes a top-of-page bid RANGE, not a CPC, and the two do not map:
> measured against cached DataForSEO rows, cpc/high ran 0.07x–1.16x and cpc/low
> 0.79x–2.59x. Any single derived number would be a fabricated figure in a
> column operators read as measured." — `keyword-volume-cache.ts`

That refusal is right, and the consequence is that **the paid-search model
currently has no cost term at all**. The fix is to carry the range as a range:
two columns, and a break-even computed at both ends. Migration 0023.

---

## 2. The model: what it must not claim, and what it can

### 2.1 Why not predict profit

Profit per click needs `orderValue × commission × conversionRate`. The first two
are operator inputs. **The third is unmeasured and cannot be bought.** Per §0,
even after spending money it will carry an interval wide enough to be useless
for a go/no-go.

The affiliate-value model already refuses this: `estimateAffiliateValue` returns
`null` when `conversionRateBps` is unset rather than defaulting to a plausible
2%. Paid search must inherit that refusal, not route around it.

### 2.2 Invert it: the break-even conversion rate

Everything except conversion is known or bounded. So solve for conversion.

Let `i` be incrementality (§0.1), `c` the CPC, `v` the order value, `m` the
commission rate. Buying `n` clicks:

```
profit = n · i · (v · m · r)  −  n · c
```

Only `i·n` clicks are new revenue; all `n` are paid for. Break-even is:

```
                    c
    r*  =  ─────────────────
             i  ·  v  ·  m
```

**`r*` is computable today for every keyword, from data we already hold.** It is
the whole product: a number with no unmeasured input, that ranks the list, and
that an operator can compare against a conversion rate they already know from
their affiliate dashboard.

Worked, at hotel economics — $300 booking, 4% commission, so $12 per booking:

| Organic rank | `i` | CPC | Cost per **incremental** click | Break-even conversion |
|---|---:|---:|---:|---:|
| none / 5+ | 0.96 | $1.20 | $1.25 | **10.4%** |
| 2–4 | 0.82 | $1.20 | $1.46 | **12.2%** |
| **1** | **0.50** | $1.20 | **$2.40** | **20.0%** |

A 20% click-to-booking conversion rate on a hotel affiliate link is not
plausible. **The rank-1 row is a refusal, derived rather than asserted** — and
it is the eBay result reproduced from first principles on our own numbers.

### 2.3 Two-sided, because the input is a range

Google gives a top-of-page bid *low* and *high*. Computing `r*` at both ends
gives an interval, and the interval is the answer:

- `r*(low)` — plausible if we win cheap positions
- `r*(high)` — what it costs to be reliably top-of-page

**A keyword only qualifies when `r*(high)` clears the bar**, not `r*(low)`.
Reporting the optimistic end is how a bid range becomes a fabricated CPC by
another route.

### 2.4 What the SERP shape does to the cost side

Two stored-and-unused columns move `r*` and both are free:

- **`has_ai_overview`** — an AI Overview pushes everything down and absorbs
  informational clicks. Volume unchanged, realisable clicks lower. Not a
  published coefficient; carried as a **flag that blocks qualification**, not as
  a silent multiplier.
- **`monthly_series`** — travel is violently seasonal. Aspen and Las Vegas peak
  six months apart. Annual average volume overstates a shoulder-season keyword
  and understates a peak one. Budget is allocated per month, not per year.

---

## 3. Ask Google for its own forecast — free, and better than our cost model

`KeywordPlanIdeaService.GenerateKeywordForecastMetrics` returns Google's own
predicted **impressions, clicks, cost, CTR and average CPC** for a proposed
campaign at a stated bid, without creating a keyword plan.

It runs on the **credentials already configured** for keyword volume, and it is
free. It is strictly better than anything we can derive from a bid range,
because it prices the actual auction we would be entering.

**It does not solve the problem, and the distinction matters.** Google forecasts
*clicks and cost*. It has no idea what a click is worth to us and no view on
incrementality — its forecast counts the cannibalised clicks identically to the
new ones. So the pipeline is:

```
Google forecast          →  clicks, cost              (measured, free, theirs)
§0.1 incrementality      →  incremental clicks        (published coefficient)
operator economics       →  value per conversion      (their input)
§2.2 inversion           →  break-even conversion     (ours)
```

---

## 4. Allocating a budget across keywords

Once keywords qualify, the question is where a fixed daily budget goes. Two
results shape it.

**Bid wider, not deeper.** Zhang, Yuan & Wang (2014) derive optimal
budget-constrained bidding and find the optimum is to *bid on more impressions
rather than concentrate on a small set of high-valued ones*, because lower-valued
inventory is more cost-effective per unit and easier to win. The naive
"concentrate the budget on the top-scoring keyword" is the wrong shape.

**Spend to learn, not only to earn.** Since `r*` orders keywords but no keyword
has a measured `r`, the first budget is an *experiment*, and allocation is an
explore/exploit problem. Thompson sampling (Chapelle & Li 2011) is the default:
trivial to implement, competitive with more complex bandits, and it naturally
allocates more budget to keywords whose conversion rate is uncertain rather than
to those merely estimated high.

**Shrink, do not trust, early rates.** Keyword-level conversion is a rare event
on tiny samples. Estimating each keyword independently produces a leaderboard of
noise — the keyword with 1 conversion in 3 clicks tops it. Agarwal et al. (2007,
2010) is the standard treatment: estimate at a coarse level where data is stable
(here: the **pattern**, e.g. `jacuzzi suites` across all destinations) and use it
as a prior to shrink the fine level. The grid gives us that hierarchy for free —
every keyword already carries `pattern_label` and `entities`.

---

## 5. The launch framework, and why nothing launches

Campaign, ad group, keyword and ad creation are built against the Google Ads
API. **Every mutate path is gated twice and dry-run by default.**

`LIVE_CALLS_ENABLED` is not sufficient here and reusing it would be a mistake.
It governs spending cents at data vendors; this governs an uncapped daily spend
at Google, in an account that bills a credit card. **A second, separate,
explicitly-named gate** (`GOOGLE_ADS_MUTATIONS_ENABLED`) plus a per-invocation
`--confirm` is the shape the repo already uses for telephony provisioning.

Additionally, and independent of any flag:

- Every plan is **persisted before it can be launched**, so what was launched is
  reconstructable from the row rather than the shell history.
- Campaigns are created **PAUSED**. Enabling is a separate, deliberate act.
- A **daily budget cap is required**, not defaulted.
- The **validate-only** mode of the API is used first: Google itself checks the
  mutation and returns errors without applying it.

---

## 6. Measurement: designed before launch, not after

Per §0 the temptation after launch is to read last-click conversions and declare
a winner. Gordon et al. (2019) is the direct rebuttal.

### 6.1 The randomisation unit is already sitting in the data

Geo experiments (Vaver & Koehler 2011) randomise non-overlapping regions into
treatment and control and compare. The standard difficulty is finding enough
independent units.

**`hotelhottubs.com` has 195 of them, by construction.** Its keyword space is
`destination × pattern`, and destinations are naturally disjoint clusters — a
searcher looking for a Gatlinburg hotel is not substituting to the Las Vegas
listing. So:

- Randomise **destinations**, not searcher geography, into treatment/control.
- Run ads on treatment destinations' keywords only.
- Compare total (paid + organic) affiliate revenue per destination.

This is a cluster-randomised trial with ~195 clusters, it needs no geo-targeting
infrastructure, and it measures exactly the quantity §0.1 is about — total
revenue including the organic clicks the ads cannibalise.

### 6.2 Say how much data the answer needs, before spending

Lewis & Rao's finding is that the required sample is usually larger than anyone
expects. So the planner computes it up front: given the click volume a keyword
set can buy, what conversion-rate difference is detectable, and what would the
test cost?

**If the answer is "this test cannot resolve the question at this budget", that
is the output.** A test too small to conclude is worse than no test, because it
returns a number that gets acted on.

### 6.3 The direction of travel

Gordon, Moakler & Zettelmeyer (2023) — PIE — run a limited set of RCTs, learn a
mapping from campaign features to causal effects, then apply it to campaigns
never run as experiments. On 2,226 Meta experiments it reaches out-of-sample
**R² = 0.88** for incremental conversions per dollar, against **R² = 0.19** for
industry-standard 7-day last-click.

That is the shape this should grow into: a handful of honest destination-cluster
experiments become a model that prices the rest. **It is not buildable until the
first experiments have run** — recorded here so the incremental path is visible
rather than being re-derived later.

---

## 7. Bibliography

Every coefficient in the implementation cites one of these at its constant.

**Incrementality and cannibalisation — the §0.1 term**
1. Google Research, [*Impact of Organic Ranking on Ad Click Incrementality*](https://research.google/blog/impact-of-organic-ranking-on-ad-click-incrementality/) — meta-analysis of 390 Search Ads Pause studies. **50% / 82% / 96% by organic rank.** The coefficient this model is keyed on.
2. Chan, D., Yuan, Y., Koehler, J. & Kumar, D. (2011). [*Incremental Clicks: The Impact of Search Advertising*](https://research.google/pubs/incremental-clicks-impact-of-search-advertising/). *Journal of Advertising Research* 51(4), 643–647. 89% average incremental ad clicks.
3. Blake, T., Nosko, C. & Tadelis, S. (2015). [*Consumer Heterogeneity and Paid Search Effectiveness: A Large-Scale Field Experiment*](https://onlinelibrary.wiley.com/doi/abs/10.3982/ECTA12423). *Econometrica* 83(1), 155–174. Brand ads: no measurable benefit. Non-brand: negative average returns.
4. Simonov, A., Nosko, C. & Rao, J. (2018). [*Competition and Crowd-Out for Brand Keywords in Sponsored Search*](https://pubsonline.informs.org/doi/10.1287/mksc.2017.1065). *Marketing Science* 37(2), 200–215. 1–4% causal effect absent competitors; smaller for larger brands.

**Why observational ROAS cannot be trusted**
5. Lewis, R. & Rao, J. (2015). [*The Unfavorable Economics of Measuring the Returns to Advertising*](https://academic.oup.com/qje/article-abstract/130/4/1941/1914592). *QJE* 130(4), 1941–1973. Median ROI CI > 100pp wide; CoV ≈ 10.
6. Gordon, B., Zettelmeyer, F., Bhargava, N. & Chapsky, D. (2019). [*A Comparison of Approaches to Advertising Measurement*](https://pubsonline.informs.org/doi/10.1287/mksc.2018.1135). *Marketing Science* 38(2), 193–225.

**Experimental design**
7. Vaver, J. & Koehler, J. (2011). [*Measuring Ad Effectiveness Using Geo Experiments*](https://research.google/pubs/measuring-ad-effectiveness-using-geo-experiments/). Google Inc.
8. Gordon, B., Moakler, R. & Zettelmeyer, F. (2023). [*Predicted Incrementality by Experimentation (PIE) for Ad Measurement*](https://arxiv.org/pdf/2304.06828). R² 0.88 vs 0.19 for last-click.

**Prediction, bidding and allocation**
9. McMahan, H.B. et al. (2013). [*Ad Click Prediction: a View from the Trenches*](https://research.google/pubs/ad-click-prediction-a-view-from-the-trenches/). KDD. FTRL-Proximal; the reference production CTR system.
10. Zhang, W., Yuan, S. & Wang, J. (2014). [*Optimal Real-Time Bidding for Display Advertising*](https://dl.acm.org/doi/abs/10.1145/2623330.2623633). KDD, 1077–1086. Bid wider, not deeper.
11. Chapelle, O. & Li, L. (2011). [*An Empirical Evaluation of Thompson Sampling*](https://proceedings.neurips.cc/paper/2011/hash/e53a0a2978c28872a4505bdb51db06dc-Abstract.html). NIPS 24.
12. Agarwal, D., Broder, A., Chakrabarti, D. et al. (2007). *Estimating Rates of Rare Events at Multiple Resolutions*. KDD, 16–25. — and Agarwal, D. et al. (2010), [*Estimating Rates of Rare Events with Multiple Hierarchies through Scalable Log-linear Models*](https://dl.acm.org/doi/10.1145/1835804.1835834). KDD.

---

## 8. Order of work

| # | Item | Cost | Why here |
|---|---|---|---|
| **1** | Carry the bid RANGE onto keyword rows (§1.1) — migration 0023 | $0 | The model has no cost term without it. Data already bought |
| **2** | Incrementality by organic rank (§0.1) — pure, tested, cited | $0 | The one published coefficient; everything is keyed on it |
| **3** | Break-even conversion rate at both bid ends (§2.2, §2.3) | $0 | The whole product. No unmeasured input |
| **4** | Paid verdict + AI-Overview and seasonality gates (§2.4) | $0 | Two stored, unused, free signals |
| **5** | Google forecast provider (§3) | **$0** | Prices the real auction; free on existing credentials |
| **6** | Budget allocation + Thompson exploration (§4) | $0 | Bid wider, not deeper; spend to learn |
| **7** | Plan persistence + launch framework, **gated, paused, validate-only** (§5) | $0 | Built and not fired |
| **8** | Destination-cluster experiment designer + power calc (§6) | $0 | Designed before launch, per §0 |
| **—** | Hierarchical shrinkage of measured rates (§4) | — | **Nothing to shrink until a campaign has run** |
| **—** | PIE-style incrementality model (§6.3) | — | **Needs the experiments first** |

---

## 9. What this cannot do

- **It cannot tell you a keyword will be profitable.** It tells you the
  conversion rate required. Whether we clear it is unmeasured until we run.
- **The incrementality coefficients are three bands from someone else's
  advertisers.** 50/82/96 is a published meta-analysis, not our measurement, and
  a hotel-affiliate SERP is not the average of 390 accounts. It is the best
  available prior and it is labelled as one.
- **A bid range is not a CPC**, and the actual clearing price depends on Quality
  Score, competitors and time of day. Both ends are carried for that reason.
- **Google's forecast is Google's.** It prices clicks in the auction it operates,
  and it has no view on whether those clicks are incremental to us.
- **Last-click affiliate conversions will overstate paid search**, and they are
  the only conversion data an affiliate network gives. That is precisely the gap
  §6 exists to close, and it does not close by looking harder at the dashboard.
- **Nothing here models competitor response.** Simonov et al. show the return to
  brand ads depends on who else is bidding, which moves week to week.
- **The AI Overview effect is a flag, not a coefficient.** We know it depresses
  clicks; we have no defensible number for by how much on these SERPs.

---

## 10. Results — 2026-08-13

Built and run end to end. **$0 spent at Google.** The whole pipeline —
`plan` → `board` → `validate` — is free; only `launch` can spend, and it did not
run.

### 10.1 Validate-only earned its place immediately

The first validate run against Google **failed**, with two defects that would
otherwise have surfaced on a real launch:

| Error | What was wrong |
|---|---|
| `fieldError: REQUIRED` on `contains_eu_political_advertising` | Required on campaign create since the EU Political Ads Regulation, and absent from the docs' own examples |
| `currencyError: VALUE_NOT_MULTIPLE_OF_BILLABLE_UNIT` | **Every derived bid was malformed.** 80% of a $25.11 top-of-page high is $20.088 — 20,088,000 micros, a multiple of 1,000 and *not* of 10,000 |

Both fixed; both pinned in tests. Rounding is **down**, never to nearest — a
bid rounded up outspends the break-even that produced it.

The second run: **`ok=true`, 7 operations, campaign validated, nothing applied.**

> **This is the argument for validate-only in one line.** A free external check
> caught a systematically wrong bid on every keyword. Our own validator was
> happy; Google was not.

### 10.2 What the model says about the real keywords

`hotelhottubs.com` is blocked on the Google Ads volume quota (975 keywords, 0
measurements — reported as unmeasured, never as zero). So the model ran on
`borenhealth.com`, which has 131 measured keywords, organic positions from a
complete Labs pull, and difficulty on five.

At **no** stored economics, every keyword is `UNKNOWN` with the cause named —
the correct output, not a bug. At a what-if of $150 order value and 15%
commission ($22.50 per conversion):

| Verdict | n |
|---|---:|
| BUY | 0 |
| MARGINAL | 0 |
| SKIP | 55 |
| BLOCKED | 5 |
| UNKNOWN | 71 |

**Several required conversion rates come out above 100%:**

| Keyword | Volume | Max CPC | Required conversion |
|---|---:|---:|---:|
| `semaglutide` | 368,000 | $28.49 | **164.9%** |
| `semaglutide vs tirzepatide` | 60,500 | $20.15 | **116.6%** |
| `tirzepatide` | 1,000,000 | $20.09 | **116.3%** |
| `nad+ side effects` | 4,400 | $2.12 | 12.3% |

**A required rate above 100% is a proof of impossibility, not a close call** —
it needs more than one purchase per click. The mechanism is visible in the CPCs:
GLP-1 keywords are priced by telehealth advertisers monetising a recurring
subscription, and a one-off affiliate commission cannot compete in that auction
at any conversion rate.

**That is the model doing the job §0 set it.** It did not produce an optimistic
ROAS; it produced a refusal with the arithmetic attached.

### 10.3 The framework, exercised

Raising the what-if to a $1,000 order at 20% produced `BUY 1 / MARGINAL 5`,
allocated $30.91/day across 3 keywords, and built a campaign Google accepted.
That path confirms the machinery; **it is not a recommendation** — no site
carries those economics.

### 10.4 What is still blocked

| Blocker | Effect |
|---|---|
| **Google Ads volume quota** | `hotelhottubs.com` — the site this plan is for — has no measured demand yet, so it has no plan |
| **No achieved conversion rate** | The only input that cannot be derived. Every verdict is `UNKNOWN` without it, by design |
| **Only 5 SERPs bought for `borenhealth`** | `has_ai_overview` is unmeasured on the rest, so `BLOCKED` is under-counted |
| **Destination clusters need ≥10** | `borenhealth` has none — its keywords are products, not places. The cluster-randomised design in §6 is `hotelhottubs`-specific |

### 10.5 The finding that reorders the keyword list

Worth restating because it is counterintuitive and it fell out of §0.1 rather
than being assumed:

> **The keywords worth buying ads on are the ones we rank *worst* for.**

At organic rank 1 half of every paid click is cannibalised, so break-even
doubles. At rank 5+ paid is ~96% additive. The organic `BUILD` bucket and the
paid `BUY` bucket therefore point at **the same keywords**, and the organic
`DEFEND` bucket is the set to keep *out* of a campaign — the opposite of
"defend your best keywords".
