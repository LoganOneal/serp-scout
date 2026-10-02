import { describe, expect, it } from 'vitest'
import { bandForDepth, phraseOrganicParams, SERP_BANDS } from './bands.js'
import { DEFAULT_ENGINE_CONFIG } from './config.js'
import { decideFilter } from './filters.js'
import { nextKeywordStatus, normalizeFrontierKeyword, volumeMidpoint } from './keywords.js'
import { matchHhtTarget } from './matching.js'
import { bundleInsertionPages, guestPostKey, insertionLeadStatus, releaseHeldInsertions } from './opportunities.js'
import { priorityScore } from './priority.js'
import { classifySemrushFailure, semrushReplacementNotice } from './semrush-access.js'
import type { HhtInventoryPage } from './types.js'

const pages: HhtInventoryPage[] = [
  { url: 'https://www.hotelhottubs.com/', pageType: 'homepage', city: null, state: null, collection: null, verifiedStayCount: 0, title: 'Hotel Hot Tubs' },
  { url: 'https://www.hotelhottubs.com/california/san-francisco', pageType: 'city', city: 'San Francisco', state: 'California', collection: null, verifiedStayCount: 40, title: 'San Francisco' },
  { url: 'https://www.hotelhottubs.com/california', pageType: 'state', city: null, state: 'California', collection: null, verifiedStayCount: 100, title: 'California' },
  { url: 'https://www.hotelhottubs.com/romantic', pageType: 'collection', city: null, state: null, collection: 'romantic', verifiedStayCount: 0, title: 'Romantic' },
  { url: 'https://www.hotelhottubs.com/editors-choice', pageType: 'editors_choice', city: null, state: null, collection: null, verifiedStayCount: 0, title: "Editor's Choice" },
]

describe('keyword frontier', () => {
  it('normalizes modifiers and plurals', () => {
    expect(normalizeFrontierKeyword('Best hotels with hot tubs')).toBe('hotel with hot tub')
  })

  it('scores a volume range from its midpoint', () => {
    expect(volumeMidpoint({ avgMonthlySearches: null, volumeLow: 100, volumeHigh: 1000, volumeIsRange: true })).toBe(550)
  })

  it('does not saturate on a single thin band', () => {
    const once = nextKeywordStatus({
      status: 'ACTIVE',
      consecutiveLowYieldBands: 0,
      band: { newQualifiedDomains: 0, reachedMaxDepth: false },
      lowYieldThreshold: 1,
    })
    expect(once.status).toBe('LOW_YIELD_AT_CURRENT_DEPTH')
    const twice = nextKeywordStatus({
      status: once.status,
      consecutiveLowYieldBands: once.consecutiveLowYieldBands,
      band: { newQualifiedDomains: 0, reachedMaxDepth: false },
      lowYieldThreshold: 1,
    })
    expect(twice.status).toBe('SATURATED')
  })

  it('lets cluster yield outrank search volume', () => {
    const richCluster = priorityScore({
      clusterYield: 5,
      relevanceScore: 0.8,
      verifiedStayCount: 10,
      sourceYield: 1,
      novel: false,
      estimatedUnits: 200,
      avgMonthlySearches: 50,
      volumeLow: null,
      volumeHigh: null,
      volumeIsRange: false,
      explore: false,
    })
    const fatVolume = priorityScore({
      clusterYield: 0,
      relevanceScore: 0.8,
      verifiedStayCount: 10,
      sourceYield: 1,
      novel: false,
      estimatedUnits: 200,
      avgMonthlySearches: 500_000,
      volumeLow: null,
      volumeHigh: null,
      volumeIsRange: false,
      explore: false,
    })
    expect(richCluster).toBeGreaterThan(fatVolume)
    expect(DEFAULT_ENGINE_CONFIG.priorityWeights.volume).toBeLessThan(DEFAULT_ENGINE_CONFIG.priorityWeights.clusterYield)
  })
})

describe('serp bands', () => {
  it('fetches band 2 with an offset so positions 1-20 are not repurchased', () => {
    const band = bandForDepth(20)
    expect(band).toEqual(SERP_BANDS[1])
    expect(phraseOrganicParams('hotels with hot tubs', band!).display_offset).toBe(20)
    expect(phraseOrganicParams('hotels with hot tubs', band!).display_limit).toBe(30)
  })
})

describe('targets and opportunities', () => {
  it('prefers the city page and keeps a collection as secondary', () => {
    const match = matchHhtTarget('romantic hotels with hot tubs in San Francisco', pages)
    expect(match.targetHhtUrl).toContain('san-francisco')
    expect(match.secondaryHhtUrl).toContain('romantic')
    expect(match.matchRule).toBe('city')
    expect(match.weakTargetMatch).toBe(false)
  })

  it('holds insertions while a guest post is the primary thread', () => {
    expect(insertionLeadStatus('ACCEPTS')).toBe('HELD')
    expect(insertionLeadStatus('UNKNOWN')).toBe('QUALIFIED')
    expect(releaseHeldInsertions('NO_RESPONSE')).toBe(true)
    expect(releaseHeldInsertions('CONTACTED')).toBe(false)
    expect(guestPostKey('Example.com')).toBe('example.com+guest_post')
    expect(bundleInsertionPages([
      { canonicalUrl: 'https://a.test/b', bestPosition: 8 },
      { canonicalUrl: 'https://a.test/a', bestPosition: 2 },
    ])[0]?.bestPosition).toBe(2)
  })
})

describe('filters and semrush notices', () => {
  it('excludes a link farm only when two signals fire', () => {
    const base = {
      rootDomain: 'travel.example',
      siteType: 'editorial_blog' as const,
      onCompetitorList: false,
      editorial: true,
      linksToHht: false,
      blocked: false,
      contactedWithinCooldown: false,
      declinedWithinCooldown: false,
      sellsPlacements: true,
      highOutboundLinks: false,
      highSponsoredShare: false,
      unrelatedTopicSpread: false,
      trafficDownHard: false,
      parasitePage: false,
      hasContact: true,
      contextualFit: true,
    }
    expect(decideFilter(base).status).toBe('REVIEW')
    expect(decideFilter({ ...base, highOutboundLinks: true }).status).toBe('EXCLUDED')
  })

  it('tells Kai to replace the connector account and leave the Mac unlocked', () => {
    const notice = semrushReplacementNotice({
      reason: 'credits exhausted',
      pausedAt: '2026-09-29T18:00:00Z',
      unitsUsed: 10,
      queuedJobs: 4,
    })
    expect(notice).toContain('Cursor MCP connector')
    expect(notice).toContain('Mac logged in and unlocked')
    expect(classifySemrushFailure('ERROR 132 :: NOT ENOUGH API UNITS')).toBe('exhausted')
  })
})
