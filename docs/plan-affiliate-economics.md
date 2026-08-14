# Plan: affiliate economics — commission per vendor, conversion from observations

| Field | Value |
|---|---|
| **Date** | 2026-08-13 |
| **Status** | 📋 **Draft for review.** Nothing built |
| **Goal** | Get real commission and conversion numbers into the model, so the paid-search verdicts stop reading `UNKNOWN` |
| **Depends on** | [`plan-paid-search.md`](./plan-paid-search.md) §2 (break-even), [`plan-affiliate-directory-sites.md`](./plan-affiliate-directory-sites.md) §4.1 (the value model that refuses to guess) |
| **Decided** | Hotel commission is **7.5% on booking, no clawback**. Conversion arrives by **manual entry** first. Peptide commission varies **per vendor only** |

---

## 0. The reframing this plan turns on

The request reads as one feature — "let me type in my numbers" — and it is three,
with three completely different epistemic statuses. Conflating them is how a
settings form ends up feeding a spending decision.

| Term | What it is | Where it comes from | Can it be typed in? |
|---|---|---|---|
| **Commission rate** | A **contract**. Exact, known, changes only when renegotiated | The affiliate agreement | **Yes.** It is a fact the operator holds |
| **Order value** | A **distribution**. A Las Vegas suite and a Wisconsin Dells room are not the same booking | Network reports, or an estimate | Yes, as an average — and the average is lossy |
| **Conversion rate** | A **measurement**. It is not knowable in advance and it has an interval | Observed clicks and orders | **No — see §0.1** |

`sites.affiliateCommissionRateBps` and `affiliateConversionRateBps` are both
plain integer columns today, which encodes the wrong idea: that these are the
same kind of number and differ only in value.

### 0.1 Enter the observation, not the rate

**A conversion rate typed in as a number loses the only thing that makes it
usable.** "3%" from 40 clicks and "3%" from 40,000 clicks are different facts,
and the paid-search model treats them differently or it is not doing its job —
`plan-paid-search.md` §0 is entirely about how wide these intervals are in
practice.

So the entry surface should not accept a rate. It should accept what the
operator actually reads off a dashboard:

```
    clicks: 412      orders: 11      commission earned: $247.50
```

From which every term falls out at once, and the sample size is
**non-optional by construction**:

```
    conversion rate   = 11 / 412            = 2.67%   (n = 412)
    average order     = ($247.50 / 0.075) / 11 = $300
    effective commission = 247.50 / 3300     = 7.5%
```

That last line is worth having even when the contract says 7.5%: **the effective
rate is what actually landed**, after adjustments, reversals and category mixes,
and where it diverges from the contract the contract is the wrong number to plan
with.

When an operator genuinely only knows "about 3%", they must still state the
sample it came from. If they cannot, they enter nothing and the model keeps
saying `UNKNOWN` — which is the correct output, and the one the current design
already produces.

### 0.2 Economics are a function of which entities a keyword binds

This is the complexity the request names, and it generalises cleanly.

```
bpc-157 peptide sciences review   binds product AND vendor
    commission  ← the VENDOR      (Peptide Sciences: 20%)
    order value ← the PRODUCT     (BPC-157: ~$60)

bpc-157 dosage                    binds product ONLY
    commission  ← ???             no vendor is bound

hotels with hot tubs las vegas    binds locality
    commission  ← the SITE        (7.5%, flat, by contract)
    order value ← the LOCALITY    (Las Vegas bookings ≠ Dells bookings)
```

**The middle case is the one that needs a decision written down.** A
product-only keyword monetises through whichever vendor the page routes the
click to, and we do not measure that split.

> **Default to the MINIMUM commission across active vendors, not the average.**
>
> Same reasoning as break-even using the *high* end of Google's bid range: when
> the true value is unknown within a range, assuming the favourable end is the
> optimistic error, and this number gates spending. A keyword that clears
> break-even at the worst vendor's rate clears it everywhere.

The resolved value and *which rule produced it* are both recorded, so a
surprising verdict is explainable rather than merely surprising.

---

## 1. What already exists (do not rebuild any of this)

| Piece | Where | State |
|---|---|---|
| Site-level economics | `sites.affiliate_order_value_micros`, `_commission_rate_bps`, `_conversion_rate_bps` | Built — **wrong shape for two of the three, §0** |
| Per-entity extras | `research_entities.attributes` jsonb | **Built for exactly this.** Its comment already says "a $600 peptide and a $40 one are not worth the same click" |
| Value model that refuses to guess | `estimateAffiliateValue` | Built. Returns null on any unset input |
| Break-even inversion | `computeBreakEven` | Built. Consumes order value + commission |
| Paid verdict | `assessPaidKeyword` | Built. Consumes an *achieved* conversion rate |
| Plan-time freeze | `ads_plans.order_value_micros` etc. | Built — a plan already stores the economics it was computed against |
| What-if override | `buildAdsPlan({ economicsOverride })` | Built, and deliberately not written to the site |
| **Conversion observations** | — | **Missing — §2.3** |
| **Per-vendor commission** | — | **Missing — §2.1** |
| **Shrinkage** | — | **Missing — §3.** Deferred in `plan-paid-search.md` §4 as "nothing to shrink until a campaign has run". There is now something to shrink |

---

## 2. The model

### 2.1 Commission — a contract, so store it as one

Two levels, no more:

- **Site default.** `hotelhottubs.com` → **750 bps**, flat, by contract. This is
  the whole story for that site.
- **Per-vendor override.** An attribute on the vendor entity in
  `research_entities`, since commission varies per vendor only.

**Effective-dated, because a renegotiated rate must not retroactively rewrite
last month's plan.** A rate carries a `from` date; resolution picks the row in
force at plan time. `ads_plans` already freezes what it used, so the two
together mean a three-month-old plan still explains its own numbers.

Tiered volume-based rates are **not** built — the answer was per-vendor flat.
Noted in §7 so the omission is deliberate rather than forgotten.

### 2.2 Order value — a distribution flattened to a number, and say so

Hotels are the harder case and the request does not mention it, so it is worth
stating plainly:

> **Order value varies more across destinations than commission varies across
> vendors, and it is currently one number for the whole site.**

A Las Vegas suite, an Aspen ski-season booking and a Wisconsin Dells family room
are not the same booking value. Break-even is linear in order value, so a 3×
spread in booking price is a 3× spread in the conversion rate a keyword needs.

Same two levels as commission: a site default, overridable per entity — per
**locality** for hotels, per **product** for peptides. Unset entities inherit
the site number and are **flagged as inherited on screen**, because an inherited
average masquerading as a measurement is exactly the failure this repo's first
rule covers.

### 2.3 Conversion — an observation table, not a column

`sites.affiliate_conversion_rate_bps` becomes a *fallback*, not the source.

```
affiliate_observations
  id, site_id,
  scope_kind    'site' | 'entity' | 'pattern' | 'keyword'
  scope_ref     entity slug / pattern label / keyword_norm; null for site
  period_start, period_end          -- what window this covers
  clicks, orders                    -- REQUIRED. The sample size is the point
  sale_value_micros                 -- null when the report omits it
  commission_micros                 -- what actually landed
  source        'manual' | 'shareasale' | 'impact' | ...
  entered_by, note, created_at
```

**`clicks` and `orders` are NOT NULL.** There is no column for a bare rate,
which is what makes §0.1 structural rather than a convention someone can skip on
a busy afternoon.

Rates are **derived** from observations, never stored:

```
conversionRate      = Σ orders / Σ clicks
averageOrderValue   = Σ sale_value / Σ orders
effectiveCommission = Σ commission / Σ sale_value
```

Summing across rows rather than averaging rates, because averaging rates
weights a 40-click week equally with a 40,000-click one.

### 2.4 Resolution, and what gets recorded

For one keyword, in order, with the first hit winning:

| Term | Order |
|---|---|
| **Commission** | vendor entity bound → **min across active vendors** if none bound → site default |
| **Order value** | product/locality entity bound → site default *(flagged inherited)* |
| **Conversion** | keyword observations → pattern → entity → site, **shrunk, §3** |

The output carries `resolvedFrom` per term — `'vendor:peptide-sciences'`,
`'site-default'`, `'min-across-vendors'`. A verdict nobody can trace is a
verdict nobody can argue with, and the whole point of the break-even framing is
that an operator can argue with it.

---

## 3. Shrinkage, and the thing it lets us delete

### 3.1 Thin data is the normal case, not the edge case

Per-keyword conversion is a rare event on a small sample. Estimating each
keyword independently produces a leaderboard of noise: the keyword with 1 order
in 3 clicks tops it at 33%.

Agarwal et al. (2007, 2010) — already cited in `plan-paid-search.md` §4 — is the
standard treatment: estimate at a level where data is stable and use it as a
prior to shrink the finer level. **The grid supplies that hierarchy for free**,
since every keyword already carries `pattern_label`.

Beta-Binomial, with the parent scope as the prior:

```
    prior     Beta(p₀·m, (1−p₀)·m)      p₀ = parent rate, m = prior strength
    posterior Beta(p₀·m + k, (1−p₀)·m + n − k)
    shrunk    = (k + p₀·m) / (n + m)
```

`m` is "how many clicks of our own data before we stop trusting the parent". At
n ≪ m the estimate is the parent's; at n ≫ m it is the keyword's own. Estimated
by method of moments from the spread across siblings when there are ≥3 with
data; otherwise a **documented default of m = 200 clicks**, labelled as policy
rather than measurement.

### 3.2 It replaces the 2× buy margin, which is a blunter version of the same idea

`DEFAULT_BUY_MARGIN = 2` exists because — quoting its own comment — a margin
thinner than 2× "cannot be distinguished from zero by any test we can afford to
run". That is the right instinct implemented with a constant, and it has an
obvious flaw:

> **It demands the same 2× headroom from a keyword measured on 40,000 clicks as
> from one measured on 40.**

The principled version is to pass the model a **lower credible bound** of the
achieved rate rather than the point estimate, and let the bound carry the
uncertainty:

```
    achievedForDecision = 10th-percentile of Beta(p₀·m + k, (1−p₀)·m + n − k)
```

A well-measured keyword's bound sits close to its mean and needs little
headroom. A keyword with 40 clicks has a bound far below its mean and must clear
break-even by a lot — automatically, and in proportion to how little we know.

**Proposed:** keep `assessPaidKeyword`'s signature, feed it the bound, and
**lower `DEFAULT_BUY_MARGIN` to 1.0** — the margin becomes redundant once the
uncertainty is priced in properly. Both numbers reported side by side on the
first run so the change is visible rather than silent.

---

## 4. Schema

```sql
-- Observations. The only place conversion data enters.
CREATE TABLE affiliate_observations (
  id serial PRIMARY KEY,
  site_id integer NOT NULL REFERENCES sites(id) ON DELETE cascade,
  scope_kind text NOT NULL,          -- site | entity | pattern | keyword
  scope_ref  text,                   -- null only when scope_kind = 'site'
  period_start date NOT NULL,
  period_end   date NOT NULL,
  clicks  integer NOT NULL,          -- NOT NULL: the sample size IS the point
  orders  integer NOT NULL,
  sale_value_micros  bigint,
  commission_micros  bigint,
  source text NOT NULL DEFAULT 'manual',
  entered_by text,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON affiliate_observations (site_id, scope_kind, scope_ref);

-- Effective-dated commission. Site default lives on `sites`; this overrides it.
CREATE TABLE affiliate_commission_rates (
  id serial PRIMARY KEY,
  site_id integer NOT NULL REFERENCES sites(id) ON DELETE cascade,
  entity_slug text,                  -- null = the site default row
  commission_rate_bps integer NOT NULL,
  effective_from date NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ON affiliate_commission_rates (site_id, entity_slug, effective_from);
```

Order value per entity reuses `research_entities.attributes` — it exists for
this, and a fourth table for one number per row is not worth the join.

`sites.affiliate_conversion_rate_bps` **stays**, demoted to a documented
last-resort override with a comment saying observations supersede it.

---

## 5. Entry surfaces

Manual first, per the decision. Three commands, all free:

```
economics set hotelhottubs.com --commission-bps=750 --order-value=300
economics set-vendor borenhealth.com peptide-sciences --commission-bps=2000
economics observe hotelhottubs.com --clicks=412 --orders=11 \
                  --commission=247.50 --from=2026-07-01 --to=2026-07-31
economics observe borenhealth.com --scope=entity:peptide-sciences ...
economics show hotelhottubs.com
```

`observe` refuses a call without `--clicks` and `--orders`. There is no flag
that takes a bare rate.

`show` prints the resolved terms **with their provenance and sample size**, and
is the screen that answers "why does this keyword say it needs 12%".

A CSV importer per network lands later and writes the same table with a
different `source` — the shape is already right for it.

---

## 6. Order of work

| # | Item | Cost | Why here |
|---|---|---|---|
| **1** | `affiliate_commission_rates` + site defaults; **set `hotelhottubs` to 750 bps** | $0 | The one number the request names, and it unblocks half the model |
| **2** | Per-vendor rates on `borenhealth` + the **min-across-vendors** fallback (§0.2) | $0 | The stated complexity |
| **3** | `affiliate_observations` + `economics observe` (clicks and orders required) | $0 | The conversion input, shaped so it cannot lose its sample size |
| **4** | Resolution with `resolvedFrom` provenance (§2.4) — pure, tested | $0 | Everything downstream reads this |
| **5** | Wire into `buildAdsPlan` and the keyword board | $0 | The point: verdicts stop being `UNKNOWN` |
| **6** | Beta-Binomial shrinkage + lower credible bound (§3) | $0 | Makes thin data usable instead of dangerous |
| **7** | **Lower `DEFAULT_BUY_MARGIN` to 1.0**, reporting both for one run | $0 | Only after 6 — the margin is the crude stand-in for it |
| **8** | Per-entity order value for localities (§2.2) | $0 | Bigger lever than commission on the hotel site |
| **—** | Network CSV importers | — | Same table, different `source`. After manual proves the shape |
| **—** | Tiered volume-based commission | — | **Not built** — the answer was per-vendor flat |

**Items 1–5 are the request.** 6–7 are what stop the answer being confidently
wrong on small samples.

---

## 7. What this cannot do

- **A stated conversion rate is still a claim about the past.** Nothing here
  predicts next month's, and `plan-paid-search.md` §0 is about how wide that
  interval is even with real data.
- **Order value as one number per site loses the destination spread.** Item 8
  narrows it; it does not remove it, because a "Las Vegas average" is itself an
  average over a wide distribution.
- **The min-across-vendors rule is deliberately pessimistic** and will
  under-rate product keywords that in fact route mostly to a high-paying vendor.
  Fixing that needs click-routing data we do not collect.
- **No clawback modelling.** Confirmed unnecessary: 7.5% is paid on booking.
  **If that program term ever changes, every break-even number in the system
  becomes optimistic at once** — which is why the resolution output records the
  rate's `effective_from` rather than treating commission as timeless.
- **Effective commission can drift from the contract** through adjustments and
  category mixes. §0.1 derives both so the divergence is visible, but it cannot
  explain the cause.
- **Attribution windows are not modelled.** A hotel booking considered for three
  weeks and a peptide reorder bought in ninety seconds are the same "conversion"
  here, and network cookie windows differ.
- **Manual entry is a snapshot an operator remembered to take.** Stale
  observations look identical to fresh ones apart from `period_end`, so the
  resolution output must show the period and does.
