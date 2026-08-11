import { describe, expect, it } from 'vitest'
import { assessAcquiredDomain, assessEmd } from './emd.js'
import type { DifficultyResult } from '../types.js'

/**
 * A SERP that passes every 30-day gate: three platform slots, weak defenders,
 * no exact-match homepage, low difficulty, link data measured.
 */
const WINNABLE: DifficultyResult = {
  difficulty: 22,
  weightCovered: 1,
  components: {
    authorityWall: { value: 0.2, weight: 0.4, measured: true, note: null },
    slotDefence: { value: 0.2, weight: 0.3, measured: true, note: null },
    intentLock: { value: 0.1, weight: 0.15, measured: true, note: null },
    linkQuality: { value: 0.3, weight: 0.15, measured: true, note: null },
  },
  platformHeldSlots: 4,
  slotsOpen: 7,
  medianNonPlatformRefDomains: 6,
  minNonPlatformRefDomains: 2,
  pos1NonPlatformRefDomains: 4,
  exactMatchHomepagesTop5: 0,
  localBusinessesTop5Dedicated: 1,
  hasLocalBusinessTop10: true,
  linkDataMeasured: true,
}

const base = { difficulty: WINNABLE, volume: 900, hasLocalPack: true }

describe('assessAcquiredDomain', () => {
  it('reaches likely_30d where the EMD path is blocked ONLY by availability', () => {
    // The whole reason two verdicts exist: the SERP is winnable, and the only
    // thing stopping a fresh registration is that the string is taken.
    const fresh = assessEmd({
      ...base,
      domain: 'houstonhvac.com',
      domainAvailable: false,
      emdAlreadyRanks: false,
    })
    const acquired = assessAcquiredDomain(base)

    expect(fresh.verdict).not.toBe('likely_30d')
    expect(acquired.verdict).toBe('likely_30d')
  })

  it('agrees with the EMD path when the domain IS available', () => {
    const fresh = assessEmd({
      ...base,
      domain: 'houstonhvac.com',
      domainAvailable: true,
      emdAlreadyRanks: false,
    })
    expect(assessAcquiredDomain(base).verdict).toBe(fresh.verdict)
  })

  it('is still blocked by committed local operators', () => {
    const contested = assessAcquiredDomain({
      ...base,
      difficulty: { ...WINNABLE, localBusinessesTop5Dedicated: 4 },
    })
    expect(contested.verdict).toBe('not_winnable')
    expect(contested.blockers.map((b) => b.code)).toContain('committed_operators_top5')
  })

  it('is still blocked by an authority wall', () => {
    const walled = assessAcquiredDomain({
      ...base,
      difficulty: { ...WINNABLE, minNonPlatformRefDomains: 900 },
    })
    expect(walled.verdict).toBe('not_winnable')
    expect(walled.blockers.map((b) => b.code)).toContain('min_refdomains_too_high')
  })

  it('is still blocked when the query is not actually local', () => {
    // The most valuable blocker: these SERPs score wide-open and guarantee a
    // wasted build. Buying a domain does not make the query local.
    const notLocal = assessAcquiredDomain({
      ...base,
      hasLocalPack: false,
      difficulty: { ...WINNABLE, hasLocalBusinessTop10: false },
    })
    expect(notLocal.verdict).toBe('not_winnable')
    expect(notLocal.blockers.map((b) => b.code)).toContain('not_a_local_query')
  })

  it('drops out of likely_30d when volume was never measured', () => {
    // The sweep only buys volume when asked. A missing figure must fail the
    // gate visibly rather than be assumed adequate.
    const noVolume = assessAcquiredDomain({ ...base, volume: 0 })
    expect(noVolume.verdict).not.toBe('likely_30d')
    expect(noVolume.gates.find((g) => g.code === 'volume')?.passed).toBe(false)
  })

  it('never reports a real domain name, so nobody reads it as measured', () => {
    expect(assessAcquiredDomain(base).domain).toBe('(acquired domain)')
  })
})
