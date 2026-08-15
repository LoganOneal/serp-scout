import { describe, expect, it } from 'vitest'
import {
  MARKETPLACE_COMPETITOR_COUNT,
  MIN_RANKED_KEYWORDS,
  assessProspect,
  computeMaxBid,
  estimateLinkValue,
  qualityMultiplier,
  type ProspectSignals,
} from './prospect.js'
import { isExcludedProspect } from './exclusions.js'

const real: ProspectSignals = {
  domain: 'jacuzzitravelblog.com',
  dfsRank: 320,
  referringDomains: 180,
  spamScore: 8,
  rankedKeywords: 4_200,
  organicEtv: 12_000,
  competitorLinkCount: 1,
  alreadyLinked: false,
}

describe('the traffic gate — authority is manufacturable, traffic is not', () => {
  it('accepts a domain that ranks for real keywords', () => {
    expect(assessProspect(real).verdict).toBe('PURSUE')
  })

  /**
   * The P2 probe's actual output: SEO spam with a bought link profile. High
   * dfsRank, high referring domains, ranks for nothing.
   */
  it('rejects a link network however good its authority metrics look', () => {
    const network: ProspectSignals = {
      ...real,
      domain: 'seo-anomaly-top-34.xyz',
      dfsRank: 610,
      referringDomains: 4_400,
      rankedKeywords: 3,
    }
    const r = assessProspect(network)
    expect(r.verdict).toBe('REJECT')
    expect(r.reason).toMatch(/Authority metrics are manufacturable/)
  })

  it('checks traffic BEFORE spam, so a dead domain reads as dead not spammy', () => {
    const r = assessProspect({ ...real, rankedKeywords: 2, spamScore: 90 })
    expect(r.reason).toMatch(/below the 50 floor/)
  })

  it('rejects on the spam ceiling once traffic passes', () => {
    expect(assessProspect({ ...real, spamScore: 44 }).verdict).toBe('REJECT')
  })

  it('rejects a domain we already have a link from', () => {
    expect(assessProspect({ ...real, alreadyLinked: true }).verdict).toBe('REJECT')
  })
})

describe('missing signals are never treated as good ones', () => {
  it('an unmeasured ranked-keyword count is UNKNOWN, not REJECT', () => {
    const r = assessProspect({ ...real, rankedKeywords: null })
    expect(r.verdict).toBe('UNKNOWN')
    expect(r.missing).toContain('rankedKeywords')
  })

  it('a measured ZERO is REJECT — the distinction that matters', () => {
    expect(assessProspect({ ...real, rankedKeywords: 0 }).verdict).toBe('REJECT')
  })

  it('an unmeasured spam score warns rather than silently passing', () => {
    const r = assessProspect({ ...real, spamScore: null })
    expect(r.verdict).toBe('PURSUE')
    expect(r.warnings.join(' ')).toMatch(/never measured/)
  })
})

describe('the marketplace signal points both ways', () => {
  it('warns at the marketplace threshold without vetoing', () => {
    const r = assessProspect({ ...real, competitorLinkCount: MARKETPLACE_COMPETITOR_COUNT })
    expect(r.verdict).toBe('PURSUE')
    expect(r.warnings.join(' ')).toMatch(/Easiest sale, worst footprint/)
  })

  it('survives onto a REJECTED row, so the reject list is still informative', () => {
    const r = assessProspect({ ...real, rankedKeywords: 1, competitorLinkCount: 6 })
    expect(r.verdict).toBe('REJECT')
    expect(r.warnings.join(' ')).toMatch(/marketplace/)
  })

  it('is priced into the bid: more competitors, lower multiplier', () => {
    const editorial = qualityMultiplier({ ...real, competitorLinkCount: 1 })
    const marketplace = qualityMultiplier({ ...real, competitorLinkCount: 6 })
    expect(marketplace).toBeLessThan(editorial * 0.6)
  })
})

describe('link value', () => {
  const base = {
    prizeMicrosPerMonth: 500_000_000n, // $500/mo of upside
    serpAuthorityWall: 120,
    ourReferringDomains: 20,
    pSuccess: 0.4,
    decay: 0.7,
    horizonMonths: 12,
  }

  it('divides the prize across the links the wall implies', () => {
    const r = estimateLinkValue(base)
    expect(r.linksNeeded).toBe(100)
    // $500 x 12 x 0.4 x 0.7 / 100 = $16.80
    expect(r.valuePerLinkMicros).toBe(16_800_000n)
  })

  it('never divides by zero when we are already at the wall', () => {
    const r = estimateLinkValue({ ...base, ourReferringDomains: 500 })
    expect(r.linksNeeded).toBe(1)
    expect(Number(r.valuePerLinkMicros)).toBeGreaterThan(0)
  })

  it('is null when any input is unmeasured', () => {
    expect(estimateLinkValue({ ...base, serpAuthorityWall: null }).valuePerLinkMicros).toBeNull()
  })

  it('labels pSuccess and decay as modelled', () => {
    expect(estimateLinkValue(base).modelled).toEqual(['pSuccess', 'decay'])
  })

  /**
   * The pre-registered prediction: guest posts are commonly $100-$500, and an
   * affiliate commission on a $300 booking funds a fixed cost far worse than a
   * subscription business can. A low number is a result, not a bug.
   */
  it('produces a bid well below typical market rates at affiliate economics', () => {
    const value = estimateLinkValue(base)
    const bid = computeMaxBid({ value, signals: real })
    expect(Number(bid.maxBidMicros)).toBeLessThan(100_000_000) // under $100
  })
})

describe('exclusions', () => {
  it('excludes our own sites and the competitors we mined', () => {
    const opts = { ownDomains: ['hotelhottubs.com'], competitorDomains: ['tubhotels.com'] }
    expect(isExcludedProspect('hotelhottubs.com', opts).reason).toMatch(/our own/)
    expect(isExcludedProspect('tubhotels.com', opts).reason).toMatch(/competitor/)
  })

  it('excludes platforms nobody guest-posts on', () => {
    for (const d of ['en.wikipedia.org', 'reddit.com', 'booking.com', 'facebook.com']) {
      expect(isExcludedProspect(d).excluded).toBe(true)
    }
  })

  it('excludes the adtech that a hand-rolled filter mistook for businesses', () => {
    // The exact class probe-wayback-directory got wrong: 15 of 15 were these.
    expect(isExcludedProspect('doubleclick.net').excluded).toBe(true)
    expect(isExcludedProspect('newrelic.com').excluded).toBe(true)
  })

  it('excludes government and academic domains by shape, not by name', () => {
    expect(isExcludedProspect('cityofaspen.gov').excluded).toBe(true)
    expect(isExcludedProspect('ox.ac.uk').excluded).toBe(true)
    expect(isExcludedProspect('mit.edu').excluded).toBe(true)
  })

  it('matches subdomains via the registrable domain', () => {
    expect(isExcludedProspect('m.reddit.com').excluded).toBe(true)
  })

  it('lets a real niche blog through', () => {
    expect(isExcludedProspect('jacuzzitravelblog.com').excluded).toBe(false)
  })
})

describe('the floor is generous on purpose', () => {
  it('a small genuine blog clears it', () => {
    expect(assessProspect({ ...real, rankedKeywords: MIN_RANKED_KEYWORDS }).verdict).toBe('PURSUE')
  })
})
