import { describe, expect, it } from 'vitest'
import { classifyLinkType, classifyOpportunityTypes, classifySeoRisk } from './classify.js'
import { classifyCorporateEligibility } from './eligibility.js'
import { extractPricing, extractRequirements, formatPrice } from './extract.js'
import { extractAuthors } from './authors.js'
import { brokenLinkRelevance, shouldCreateBrokenLinkOpportunity } from './broken.js'
import { intersectReferringDomains } from './competitors.js'
import {
  collapseClassifiedOpportunities,
  dedupeHitsByDomain,
  excludeDiscoveryDomain,
  fixtureHitsForQuery,
  planDiscoveryTargets,
  selectDiscoveryBatch,
} from './discovery.js'
import { isRefreshDue, proposeStrategyRecommendations, refreshIntervalDays } from './learning.js'
import { expandQueryTemplates } from './queries.js'
import { scoreFeasibility, scoreOverall, scoreSeoValue } from './scoring.js'
import { classifySpam } from './spam.js'
import { fallbackDraft } from './drafts.js'
import { DEFAULT_HHT_OPP_SCORE_WEIGHTS } from './types.js'

describe('opportunity classification', () => {
  it('classifies from the URL when the body is empty', () => {
    const found = classifyOpportunityTypes({
      url: 'https://example.com/write-for-us',
      title: null,
      text: '',
    })
    expect(found.some((row) => row.type === 'editorial_guest')).toBe(true)
  })

  it('classifies a write-for-us page as editorial guest', () => {
    const found = classifyOpportunityTypes({
      url: 'https://example.com/write-for-us',
      title: 'Write for Us',
      text: 'We welcome guest contributors. Pitch us before drafting. Brands welcome.',
    })
    const editorial = found.find((row) => row.type === 'editorial_guest')
    expect(editorial).toBeTruthy()
    expect(editorial?.evidence.sourceExcerpt).toMatch(/write for us|write-for-us|guest contributor|pitch us/i)
  })

  it('separates paid guest posts from editorial ones', () => {
    const found = classifyOpportunityTypes({
      url: 'https://example.com/sponsored',
      title: 'Sponsored posts',
      text: 'Paid guest post packages start here. We also offer link insertion into existing articles.',
    })
    const types = found.map((row) => row.type)
    expect(types).toContain('paid_guest_post')
    expect(types).toContain('paid_link_insertion')
  })
})

describe('corporate eligibility', () => {
  it('requires explicit business permission for PASS', () => {
    const silent = classifyCorporateEligibility('https://example.com/wfu', 'Write for us. 1,200 words. Original work only.')
    expect(silent.eligibility).toBe('REVIEW')
    expect(silent.reason).toMatch(/not clearly stated/i)

    const pass = classifyCorporateEligibility('https://example.com/wfu', 'Industry experts welcome. Brands welcome.')
    expect(pass.eligibility).toBe('PASS')
    expect(pass.evidence?.sourceExcerpt).toMatch(/welcome/i)

    const fail = classifyCorporateEligibility('https://example.com/wfu', 'Personal bloggers only. No commercial websites.')
    expect(fail.eligibility).toBe('FAIL')
  })
})

describe('pricing extraction', () => {
  it('never invents a price when only a quote is offered', () => {
    const price = extractPricing('https://example.com/advertise', 'Advertise with us. Contact us for pricing.')
    expect(price.amount).toBeNull()
    expect(price.status).toBe('QUOTE_REQUIRED')
    expect(formatPrice(price)).toBe('Price unknown — contact publisher')
  })

  it('captures an explicit dollar amount with evidence', () => {
    const price = extractPricing('https://example.com/sponsored', 'A sponsored article costs $250 one time.')
    expect(price.status).toBe('FIXED')
    expect(price.amount).toBe(250)
    expect(price.evidence?.sourceExcerpt).toMatch(/\$250/)
    expect(formatPrice(price)).toBe('$250')
  })
})

describe('requirements', () => {
  it('extracts word count and pitch-first rules with provenance', () => {
    const rows = extractRequirements(
      'https://example.com/write-for-us',
      'Minimum 1200 words. Pitch us before you draft. Original photography preferred. No promotional copy.',
    )
    expect(rows.some((r) => r.label === 'Word count' && /1200/.test(r.requirementText))).toBe(true)
    expect(rows.some((r) => r.label === 'Pitch first')).toBe(true)
    expect(rows.every((r) => r.sourceUrl && r.sourceExcerpt && r.dateChecked)).toBe(true)
  })
})

describe('link type and SEO risk', () => {
  it('reads dofollow contextual language', () => {
    expect(classifyLinkType('One contextual dofollow link is allowed in the article body.').linkType).toBe(
      'contextual_dofollow',
    )
  })

  it('marks open SEO-link sales as high risk without auto-rejecting paid placement', () => {
    const risk = classifySeoRisk({
      text: 'Buy cheap dofollow SEO links. Casino and crypto welcome.',
      title: 'Sponsored posts',
    })
    expect(risk.risk).toBe('HIGH')
  })
})

describe('scoring', () => {
  it('scores PASS + contact route higher than FAIL', () => {
    const pass = scoreFeasibility({
      eligibility: 'PASS',
      hasSubmissionRoute: true,
      linkType: 'contextual_dofollow',
      topicalFit: 70,
      pitchClarity: 60,
      evidenceConfidence: 80,
      freshnessDays: 1,
    })
    const fail = scoreFeasibility({
      eligibility: 'FAIL',
      hasSubmissionRoute: false,
      linkType: 'unknown',
      topicalFit: 20,
      pitchClarity: 10,
      evidenceConfidence: 20,
      freshnessDays: 200,
    })
    expect(pass).toBeGreaterThan(fail)
    expect(pass).toBeGreaterThan(60)
  })

  it('does not treat missing Semrush metrics as zero authority', () => {
    const unevaluated = scoreSeoValue({
      authorityScore: null,
      referringDomains: null,
      organicTraffic: null,
      topicalRelevance: 80,
      usTrafficShare: null,
      linkType: 'unknown',
      avgExternalLinks: null,
      seoRisk: 'LOW',
      quality: 'OK',
    })
    expect(unevaluated).toBeGreaterThan(0)
    expect(unevaluated).toBeLessThan(50)
  })

  it('applies editable weights', () => {
    const highSeo = scoreOverall({
      seoValue: 90,
      feasibility: 10,
      topicalRelevance: 10,
      editorialQuality: 10,
      costEfficiency: 10,
      freshness: 10,
      weights: { ...DEFAULT_HHT_OPP_SCORE_WEIGHTS, seoValue: 1, feasibility: 0, topicalRelevance: 0, editorialQuality: 0, costEfficiency: 0, freshness: 0 },
    })
    expect(highSeo).toBeCloseTo(90, 5)
  })
})

describe('spam classifier', () => {
  it('flags possible link farms without deleting them', () => {
    const verdict = classifySpam({
      title: 'Buy cheap dofollow SEO links',
      text: 'Permanent dofollow guest post for sale. Casino crypto CBD.',
      avgExternalLinks: 30,
      uniqueExternalDomains: 50,
      organicTraffic: 0,
      authorityScore: 55,
      hasAuthor: false,
      paidLinkLanguageCount: 9,
    })
    expect(verdict.quality).toBe('POSSIBLE_LINK_FARM')
  })
})

describe('query expansion', () => {
  it('expands to at least 200 parameterized templates', () => {
    const templates = expandQueryTemplates()
    expect(templates.length).toBeGreaterThanOrEqual(200)
    expect(templates.some((t) => t.query.includes('contribute a story'))).toBe(true)
    expect(templates.some((t) => t.strategy === 'unlinked_mentions')).toBe(true)
  })
})

describe('discovery batching and filters', () => {
  it('selects a small mixed batch instead of the full template list', () => {
    const batch = selectDiscoveryBatch({ limit: 6 })
    expect(batch).toHaveLength(6)
    expect(new Set(batch.map((row) => row.strategy)).size).toBeGreaterThanOrEqual(4)
    expect(expandQueryTemplates().length).toBeGreaterThan(200)
  })

  it('excludes OTAs, platforms, and HotelHotTubs itself', () => {
    expect(excludeDiscoveryDomain('https://www.booking.com/hotel/us/x').excluded).toBe(true)
    expect(excludeDiscoveryDomain('tripadvisor.com').excluded).toBe(true)
    expect(excludeDiscoveryDomain('https://hotelhottubs.com/vermont').excluded).toBe(true)
    expect(excludeDiscoveryDomain('https://kayak.com/hotels').excluded).toBe(true)
    expect(excludeDiscoveryDomain('https://expertvagabond.com/write-for-us/').excluded).toBe(false)
  })

  it('keeps one hit per domain and prefers an opportunity path', () => {
    const hits = dedupeHitsByDomain([
      { url: 'https://example.com/best-hotels', title: 'Best hotels', snippet: null, domain: 'example.com' },
      { url: 'https://example.com/write-for-us', title: 'Write for us', snippet: null, domain: 'www.example.com' },
      { url: 'https://booking.com/hotel', title: 'Booking', snippet: null, domain: 'booking.com' },
    ])
    expect(hits.map((hit) => hit.domain)).toEqual(['example.com', 'booking.com'])
    expect(hits[0]?.url).toBe('https://example.com/write-for-us')
  })

  it('plans research only for new, non-excluded domains up to the cap', () => {
    const plan = planDiscoveryTargets(
      [
        { url: 'https://afar.com/write-for-us', title: 'AFAR', snippet: null, domain: 'afar.com' },
        { url: 'https://booking.com/hotel', title: 'Booking', snippet: null, domain: 'booking.com' },
        { url: 'https://fresh-travel.example/advertise', title: 'Fresh', snippet: null, domain: 'fresh-travel.example' },
        { url: 'https://another.example/media-kit', title: 'Another', snippet: null, domain: 'another.example' },
      ],
      ['afar.com'],
      1,
    )
    expect(plan.uniqueDomains).toBe(3)
    expect(plan.newDomains).toBe(2)
    expect(plan.toResearch.map((row) => row.domain)).toEqual(['fresh-travel.example'])
    expect(plan.deferredNew.map((row) => row.domain)).toEqual(['another.example'])
    expect(plan.excluded.some((row) => row.domain === 'booking.com')).toBe(true)
  })

  it('collapses path-variant editorial rows on the same domain', () => {
    const collapsed = collapseClassifiedOpportunities(
      [
        { type: 'editorial_guest' as const, url: 'https://example.com/contribute' },
        { type: 'editorial_guest' as const, url: 'https://example.com/write-for-us' },
        { type: 'existing_article' as const, url: 'https://example.com/a' },
        { type: 'existing_article' as const, url: 'https://example.com/b' },
      ],
      { seedUrl: 'https://example.com/write-for-us' },
    )
    expect(collapsed.filter((row) => row.type === 'editorial_guest')).toHaveLength(1)
    expect(collapsed.find((row) => row.type === 'editorial_guest')?.url).toBe('https://example.com/write-for-us')
    expect(collapsed.filter((row) => row.type === 'existing_article')).toHaveLength(2)
  })

  it('maps fixture queries to labeled publishers, not local-service SERPs', () => {
    const hits = fixtureHitsForQuery('"travel" "write for us"')
    expect(hits.some((hit) => hit.domain === 'expertvagabond.com')).toBe(true)
    expect(hits.every((hit) => !/yelp|angi|thumbtack/i.test(hit.domain ?? ''))).toBe(true)
  })
})

describe('phase 3–5 helpers', () => {
  it('keeps domains that link to two competitors and not HHT', () => {
    const rows = intersectReferringDomains(
      {
        'tubhotels.com': [{ domain: 'afar.com', authorityScore: 60, backlinks: 2 }],
        'jacuzzisuites.com': [{ domain: 'afar.com', authorityScore: 60, backlinks: 1 }, { domain: 'booking.com', authorityScore: 90, backlinks: 4 }],
      },
      ['lonelyplanet.com'],
      2,
    )
    expect(rows.map((row) => row.domain)).toEqual(['afar.com'])
    expect(rows[0]?.competitorCount).toBe(2)
  })

  it('extracts a byline author and ignores staff labels', () => {
    const authors = extractAuthors(
      '<meta name="author" content="Jordan Blake"><span class="byline">Jordan Blake</span>',
      'Written by Jordan Blake on a romantic hotels list.',
    )
    expect(authors.some((row) => row.name === 'Jordan Blake')).toBe(true)
    expect(extractAuthors(null, 'By Staff Writer').length).toBe(0)
  })

  it('creates a broken-link opportunity only when HHT is a real substitute', () => {
    expect(shouldCreateBrokenLinkOpportunity(brokenLinkRelevance('Best romantic hotels with private hot tubs', 'https://old-guide.example/jacuzzi-suites', 'jacuzzi suites'))).toBe(true)
    expect(shouldCreateBrokenLinkOpportunity(brokenLinkRelevance('Home', 'https://doubleclick.net/ad', 'ad'))).toBe(false)
  })

  it('recommends shifting allocation without dropping other strategies', () => {
    const recs = proposeStrategyRecommendations({
      yields: [
        { strategy: 'competitor_backlinks', queries: 8, domainsFound: 20, pass: 8, yieldPct: 40 },
        { strategy: 'direct_keyword_search', queries: 20, domainsFound: 40, pass: 2, yieldPct: 5 },
      ],
      outcomesByType: [{ key: 'unlinked_mention', sent: 5, replies: 3, acquired: 2, avgCost: null }],
      outcomesByStrategy: [],
    })
    expect(recs.some((row) => /Increase discovery allocation/.test(row.summary))).toBe(true)
    expect(recs.every((row) => !/remove|drop|disable/i.test(row.rationale) || /Do not drop/.test(row.rationale))).toBe(true)
  })

  it('uses 14-day refresh for PASS and 90 for FAIL', () => {
    expect(refreshIntervalDays({ status: 'PASS', eligibility: 'PASS', priceStatus: 'FREE', overallScore: 80 })).toBe(14)
    expect(refreshIntervalDays({ status: 'FAIL', eligibility: 'FAIL', priceStatus: 'UNKNOWN', overallScore: 10 })).toBe(90)
    expect(isRefreshDue(new Date(Date.now() - 15 * 86_400_000), 14)).toBe(true)
  })
})

describe('draft fallback', () => {
  it('identifies HotelHotTubs as a commercial site and does not invent a price', () => {
    const draft = fallbackDraft({
      publicationName: 'Example Travel',
      domain: 'example.com',
      opportunityType: 'editorial_guest',
      requirementsSummary: ['Pitch first: Pitch us before you draft'],
      eligibility: 'REVIEW',
      eligibilityReason: 'Not clearly stated',
      recentArticles: [],
      submissionMethod: 'form',
      linkType: 'unknown',
      priceLabel: 'Price unknown — contact publisher',
      contact: null,
      opportunityUrl: 'https://example.com/write-for-us',
      hhtAssets: ['https://hotelhottubs.com/vermont'],
      pitchAngle: 'Room-level amenity verification',
    })
    expect(draft.body).toMatch(/commercial website/)
    expect(draft.body).not.toMatch(/\$\d+/)
    expect(draft.body).toMatch(/image rights require review|will not claim firsthand/i)
  })
})
