import { describe, expect, it } from 'vitest'
import { assessEmd, type EmdInput } from './emd.js'
import type { DifficultyResult } from '../types.js'

/** A SERP that passes every 30-day gate. Individual tests break one thing at a time. */
function softDifficulty(over: Partial<DifficultyResult> = {}): DifficultyResult {
  return {
    difficulty: 14,
    weightCovered: 0.85,
    components: {
      authorityWall: { value: 0.13, weight: 0.4, measured: true, note: null },
      slotDefence: { value: 0.17, weight: 0.3, measured: true, note: null },
      intentLock: { value: 0.19, weight: 0.15, measured: true, note: null },
      linkQuality: { value: null, weight: 0.15, measured: false, note: 'none' },
    },
    platformHeldSlots: 8,
    slotsOpen: 9,
    medianNonPlatformRefDomains: 5,
    minNonPlatformRefDomains: 3,
    pos1NonPlatformRefDomains: null,
    exactMatchHomepagesTop5: 0,
    localBusinessesTop5Dedicated: 0,
    hasLocalBusinessTop10: true,
    linkDataMeasured: true,
    ...over,
  }
}

function input(over: Partial<EmdInput> = {}): EmdInput {
  return {
    domain: 'kenoshatreeservice.com',
    difficulty: softDifficulty(),
    volume: 418,
    domainAvailable: true,
    hasLocalPack: true,
    emdAlreadyRanks: false,
    ...over,
  }
}

const codes = (r: ReturnType<typeof assessEmd>) => r.blockers.map((b) => b.code)

describe('EMD verdict -- baseline', () => {
  it('awards likely_30d only when every gate passes', () => {
    const r = assessEmd(input())
    expect(r.verdict).toBe('likely_30d')
    expect(r.blockers).toEqual([])
    expect(r.gates.every((g) => g.passed === true)).toBe(true)
  })

  it('always returns all seven gates, passed or not, for the audit view', () => {
    const r = assessEmd(input({ volume: 10 }))
    expect(r.gates).toHaveLength(7)
    expect(r.gates.filter((g) => g.passed !== true).map((g) => g.code)).toEqual(['volume'])
  })

  it('never emits a probability -- only a band', () => {
    const r = assessEmd(input())
    expect(Object.keys(r)).toEqual(['domain', 'verdict', 'blockers', 'gates'])
    expect(JSON.stringify(r)).not.toMatch(/probability|confidence|percent|chance/i)
  })
})

describe('EMD -- the asymmetry that protects money', () => {
  it('BLOCKS likely_30d when the domain could not be confirmed available', () => {
    // A rate-limited registry is not a yes. This is the gate that stops the tool
    // sending someone to buy a domain on the strength of a 429.
    const r = assessEmd(input({ domainAvailable: null }))
    expect(r.verdict).not.toBe('likely_30d')
    const gate = r.gates.find((g) => g.code === 'domain_available')!
    expect(gate.passed).toBe(false) // null availability -> FAILED, not skipped
    expect(gate.detail).toMatch(/Unconfirmed is not available/)
  })

  it('BLOCKS likely_30d when link data was never measured', () => {
    // Everywhere else, missing link data is dropped leniently and the weights
    // renormalise. Here it must block: a SERP we could not measure is not a
    // soft SERP.
    const r = assessEmd(
      input({
        difficulty: softDifficulty({ linkDataMeasured: false, medianNonPlatformRefDomains: null }),
      }),
    )
    expect(r.verdict).not.toBe('likely_30d')
    expect(r.gates.find((g) => g.code === 'link_data_measured')!.passed).toBe(false)
    expect(r.gates.find((g) => g.code === 'median_refdomains')!.passed).toBeNull()
  })

  it('treats an unevaluable gate as a failure, not a pass', () => {
    const r = assessEmd(input({ difficulty: softDifficulty({ difficulty: null }) }))
    expect(r.verdict).toBe('unknown')
  })

  it('refuses to place a band when too little was measured', () => {
    const r = assessEmd(input({ difficulty: softDifficulty({ weightCovered: 0.3 }) }))
    expect(r.verdict).toBe('unknown')
    expect(codes(r)).toContain('insufficient_coverage')
  })
})

describe('EMD -- hard blockers', () => {
  it('4 of 5 committed local operators kills it', () => {
    const r = assessEmd(
      input({ difficulty: softDifficulty({ localBusinessesTop5Dedicated: 4 }) }),
    )
    expect(r.verdict).toBe('not_winnable')
    expect(codes(r)).toContain('committed_operators_top5')
  })

  it('a weakest defender at 250 refdomains kills it', () => {
    const r = assessEmd(
      input({ difficulty: softDifficulty({ minNonPlatformRefDomains: 250 }) }),
    )
    expect(r.verdict).toBe('not_winnable')
    expect(codes(r)).toContain('min_refdomains_too_high')
  })

  it('a position-1 fortress at 1000 refdomains kills it', () => {
    const r = assessEmd(
      input({ difficulty: softDifficulty({ pos1NonPlatformRefDomains: 1000 }) }),
    )
    expect(r.verdict).toBe('not_winnable')
    expect(codes(r)).toContain('pos1_fortress')
  })

  it('the target EMD already ranking kills it', () => {
    const r = assessEmd(input({ emdAlreadyRanks: true }))
    expect(r.verdict).toBe('not_winnable')
    expect(codes(r)).toContain('emd_already_ranks')
  })

  it('kills a structurally wide-open SERP that is not actually a local query', () => {
    // The most valuable blocker in the model. No local pack and no local
    // business in the top 10 means every structural signal reads "easy" --
    // difficulty 14, 8 open slots -- and a build here can never rank, because
    // Google does not treat the query as local in this place.
    const r = assessEmd(
      input({
        hasLocalPack: false,
        difficulty: softDifficulty({ hasLocalBusinessTop10: false, difficulty: 9 }),
      }),
    )
    expect(r.verdict).toBe('not_winnable')
    expect(codes(r)).toContain('not_a_local_query')
    expect(r.blockers.find((b) => b.code === 'not_a_local_query')!.message).toMatch(
      /guaranteed wasted build/,
    )
  })

  it('does not fire the local-query blocker when a local pack exists', () => {
    const r = assessEmd(
      input({ hasLocalPack: true, difficulty: softDifficulty({ hasLocalBusinessTop10: false }) }),
    )
    expect(codes(r)).not.toContain('not_a_local_query')
  })
})

describe('EMD -- band assignment', () => {
  it('downgrades to likely_90d on difficulty alone', () => {
    const r = assessEmd(input({ difficulty: softDifficulty({ difficulty: 40 }) }))
    expect(r.verdict).toBe('likely_90d')
    expect(codes(r)).toContain('gate_difficulty')
  })

  it('caps at likely_6m when committed operators hold top-5 slots', () => {
    // Even at a low aggregate difficulty: you have to displace them
    // individually, not beat the page average.
    const r = assessEmd(
      input({ difficulty: softDifficulty({ difficulty: 32, localBusinessesTop5Dedicated: 2 }) }),
    )
    expect(r.verdict).toBe('likely_6m')
    expect(codes(r)).toContain('committed_operators_present')
  })

  it('falls to not_winnable above the 6-month difficulty ceiling', () => {
    const r = assessEmd(input({ difficulty: softDifficulty({ difficulty: 80 }) }))
    expect(r.verdict).toBe('not_winnable')
    expect(codes(r)).toContain('difficulty_above_ceiling')
  })

  it('reports a registered domain as such rather than as unknown', () => {
    const r = assessEmd(input({ domainAvailable: false }))
    expect(r.verdict).not.toBe('likely_30d')
    expect(r.gates.find((g) => g.code === 'domain_available')!.detail).toMatch(
      /already registered/,
    )
  })
})
