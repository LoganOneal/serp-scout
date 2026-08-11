import { describe, expect, it } from 'vitest'
import { buildMatchContext, classifyResult } from './classify.js'
import { scoreDifficulty } from './difficulty.js'
import { assessEmd } from './emd.js'
import { estimateDemand } from './demand.js'
import {
  ALL_ARCHETYPES,
  ARCHETYPE_BRUTAL,
  ARCHETYPE_MIXED,
  ARCHETYPE_SOFT,
  KENOSHA,
  TREE_SERVICE,
  type Archetype,
} from './__fixtures__/archetypes.js'
import type { DomainAuthority } from '../types.js'

const ctx = buildMatchContext({
  localityName: KENOSHA.name,
  nicheEmdToken: TREE_SERVICE.emdToken,
  nicheDomainStems: TREE_SERVICE.domainStems,
})

function score(a: Archetype, opts?: { stripAuthority?: boolean }) {
  const results = a.items.map((item) =>
    classifyResult(
      item,
      ctx,
      opts?.stripAuthority ? null : (a.authorities[item.domain] ?? null),
    ),
  )
  return scoreDifficulty({ results, hasLocalPack: a.hasLocalPack })
}

function verdictFor(a: Archetype, opts?: { available?: boolean | null }) {
  const difficulty = score(a)
  const demand = estimateDemand({ population: KENOSHA.population, niche: TREE_SERVICE })!
  return assessEmd({
    domain: 'kenoshatreeservice.com',
    difficulty,
    volume: demand.monthlySearches,
    domainAvailable: opts?.available ?? true,
    hasLocalPack: a.hasLocalPack,
    // Archetypes B and C literally contain the candidate EMD, but this flag
    // models "we are considering buying it", so the caller states it. The
    // emd_already_ranks blocker is exercised in emd.test.ts.
    emdAlreadyRanks: false,
  })
}

describe('difficulty -- the three archetypes', () => {
  it('orders the three archetypes strictly easiest to hardest', () => {
    // THE hard assertion. Magnitudes are priors; ordering is the claim that the
    // model can tell an easy local SERP from a hard one at all. A violation here
    // means the model is misreading pages, not that a constant needs nudging.
    const scores = ALL_ARCHETYPES.map((a) => score(a).difficulty!)
    expect(scores).toHaveLength(3)
    const [soft, mixed, brutal] = scores as [number, number, number]
    expect(soft).toBeLessThan(mixed)
    expect(mixed).toBeLessThan(brutal)
  })

  it('soft: 8 directories + 2 thin locals reads as very easy', () => {
    const d = score(ARCHETYPE_SOFT)
    expect(d.difficulty).toBeLessThanOrEqual(25)
    expect(d.platformHeldSlots).toBe(8)
    // Both thin locals are displaceable, so 9 of 10 slots are takeable. Only
    // kenoshalawnandsnow.com clears the committed-operator dedication bar.
    expect(d.slotsOpen).toBe(9)
    expect(d.exactMatchHomepagesTop5).toBe(0)
    expect(d.localBusinessesTop5Dedicated).toBe(0)
  })

  it('mixed: 2 committed operators below directories reads as moderate', () => {
    const d = score(ARCHETYPE_MIXED)
    expect(d.difficulty).toBeGreaterThan(25)
    expect(d.difficulty).toBeLessThanOrEqual(45)
    expect(d.localBusinessesTop5Dedicated).toBe(2)
  })

  it('brutal: 5 exact-match operators reads as unwinnable', () => {
    const d = score(ARCHETYPE_BRUTAL)
    expect(d.difficulty).toBeGreaterThanOrEqual(70)
    expect(d.exactMatchHomepagesTop5).toBe(5)
    expect(d.localBusinessesTop5Dedicated).toBe(5)
    expect(d.minNonPlatformRefDomains).toBe(150)
    expect(d.pos1NonPlatformRefDomains).toBe(420)
  })

  it('assigns the expected verdict band to each archetype', () => {
    expect(verdictFor(ARCHETYPE_SOFT).verdict).toBe('likely_30d')
    expect(verdictFor(ARCHETYPE_MIXED).verdict).toBe('likely_6m')
    expect(verdictFor(ARCHETYPE_BRUTAL).verdict).toBe('not_winnable')
  })

  it('names a blocker for every non-30-day band', () => {
    expect(verdictFor(ARCHETYPE_SOFT).blockers).toEqual([])
    for (const a of [ARCHETYPE_MIXED, ARCHETYPE_BRUTAL]) {
      const v = verdictFor(a)
      expect(v.blockers.length).toBeGreaterThan(0)
      // Every blocker must be explainable to the operator, not an opaque code.
      for (const b of v.blockers) {
        expect(b.code).toBeTruthy()
        expect(b.message.length).toBeGreaterThan(20)
      }
    }
  })
})

describe('the platform authority discount', () => {
  it('does not let a 4M-refdomain directory wall off a soft SERP', () => {
    // THE critical correction. Give every platform on the soft SERP its real
    // link profile and the difficulty must not move, because platform results
    // are routed to the fixed constant instead.
    const monster = (target: string): DomainAuthority => ({
      target,
      rank: 1000,
      referringDomains: 4_000_000,
      referringDomainsNofollow: 400_000,
      referringMainDomains: 3_800_000,
      spamScore: 1,
      sources: ['ranks', 'refdomains', 'spam'],
    })

    const withRealPlatformProfiles = ARCHETYPE_SOFT.items.map((item) =>
      classifyResult(
        item,
        ctx,
        ARCHETYPE_SOFT.authorities[item.domain] ?? monster(item.domain),
      ),
    )
    const inflated = scoreDifficulty({
      results: withRealPlatformProfiles,
      hasLocalPack: true,
    })
    const baseline = score(ARCHETYPE_SOFT)

    expect(inflated.difficulty).toBe(baseline.difficulty)
    // And it is still the best kind of market this tool can find.
    expect(inflated.difficulty!).toBeLessThanOrEqual(25)
  })
})

describe('measurement honesty', () => {
  it('omits unmeasured components and renormalises rather than scoring them zero', () => {
    // Strip ALL link data from the brutal SERP. authorityWall and linkQuality
    // become unmeasurable. If they were defaulted to 0, this page -- five
    // exact-match operators with hundreds of refdomains -- would read as easy.
    const stripped = score(ARCHETYPE_BRUTAL, { stripAuthority: true })

    expect(stripped.components.authorityWall.measured).toBe(false)
    expect(stripped.components.authorityWall.value).toBeNull()
    expect(stripped.components.linkQuality.measured).toBe(false)
    expect(stripped.components.linkQuality.value).toBeNull()

    // Only slotDefence (0.30) and intentLock (0.15) survive.
    expect(stripped.weightCovered).toBeCloseTo(0.45, 5)

    // Renormalised over the measured 0.45, it still reads as hard -- because the
    // structural signals alone say so.
    expect(stripped.difficulty).toBeGreaterThanOrEqual(70)

    // The zero-default failure mode, made explicit: had the two missing
    // components scored 0, difficulty would have collapsed to roughly this.
    const ifZeroed = Math.round(
      100 *
        (0.3 * stripped.components.slotDefence.value! +
          0.15 * stripped.components.intentLock.value!),
    )
    expect(ifZeroed).toBeLessThan(45)
    expect(stripped.difficulty!).toBeGreaterThan(ifZeroed + 25)
  })

  it('reports null difficulty, never 0, when nothing at all can be measured', () => {
    const empty = scoreDifficulty({ results: [], hasLocalPack: false })
    expect(empty.difficulty).toBeNull()
    expect(empty.weightCovered).toBe(0)
    // A 0 here would sort to the top of an easiest-first table and read as the
    // single best opportunity in the locality.
    expect(empty.difficulty).not.toBe(0)
  })

  it('flags partial link coverage in the component note', () => {
    const partial = ARCHETYPE_BRUTAL.items.map((item) =>
      classifyResult(
        item,
        ctx,
        // Only position 1 has link data; the other four operators do not.
        item.position === 1 ? (ARCHETYPE_BRUTAL.authorities[item.domain] ?? null) : null,
      ),
    )
    const d = scoreDifficulty({ results: partial, hasLocalPack: true })
    // Position 1 (0.276 CTR) plus the five platforms (0.135) clears the 50%
    // click-weight bar, so this IS measured -- but it says how much it covered.
    expect(d.components.authorityWall.measured).toBe(true)
    expect(d.components.authorityWall.note).toMatch(/omitted, not counted as zero/)
    expect(d.components.authorityWall.note).toMatch(/click weight/)
  })

  it('marks authorityWall unmeasured when only platforms were evaluable', () => {
    // The regression this guards: platforms always contribute a constant, so
    // "some weight was used" does not mean the real defenders were measured.
    const onlyPlatformsMeasured = ARCHETYPE_BRUTAL.items.map((i) =>
      classifyResult(i, ctx, null),
    )
    const d = scoreDifficulty({ results: onlyPlatformsMeasured, hasLocalPack: true })
    expect(d.components.authorityWall.measured).toBe(false)
    expect(d.components.authorityWall.note).toMatch(/click weight/)
    expect(d.linkDataMeasured).toBe(false)
  })

  it('never scores a domain with zero measured refdomains the same as an unmeasured one', () => {
    const zeroed: DomainAuthority = {
      target: 'newsite.com',
      rank: 0,
      referringDomains: 0,
      referringDomainsNofollow: 0,
      referringMainDomains: 0,
      spamScore: 0,
      sources: ['ranks', 'refdomains', 'spam'],
    }
    const items = ARCHETYPE_BRUTAL.items
    const measuredZero = scoreDifficulty({
      results: items.map((i) => classifyResult(i, ctx, i.isHomepage ? zeroed : null)),
      hasLocalPack: true,
    })
    const unmeasured = scoreDifficulty({
      results: items.map((i) => classifyResult(i, ctx, null)),
      hasLocalPack: true,
    })
    // Measured-as-zero is real evidence of weakness and must score EASIER.
    // Unmeasured must not borrow that benefit.
    expect(measuredZero.difficulty!).toBeLessThan(unmeasured.difficulty!)
    expect(measuredZero.components.authorityWall.measured).toBe(true)
    expect(unmeasured.components.authorityWall.measured).toBe(false)
  })
})
