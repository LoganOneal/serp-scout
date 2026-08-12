import { describe, expect, it } from 'vitest'
import {
  PRICE,
  centsToMicros,
  costMicros,
  estimateDiscoveryCostMicros,
  formatMicrosUsd,
  sumMicros,
  usdToMicros,
} from './money.js'

describe('money', () => {
  it('prices are exact integers in micros', () => {
    expect(PRICE.serpOrganicLive).toBe(usdToMicros(0.002))
    expect(PRICE.serpMapsLive).toBe(usdToMicros(0.002))
    expect(PRICE.serpOrganicTask).toBe(usdToMicros(0.0006))
    expect(PRICE.backlinksBulkRequest).toBe(usdToMicros(0.024))
    expect(PRICE.backlinksBulkRow).toBe(usdToMicros(0.000036))
  })

  it('locations and user_data are free', () => {
    expect(costMicros('locations')).toBe(0n)
    expect(costMicros('userData')).toBe(0n)
  })

  it('bulk backlinks charges per request plus per row', () => {
    // $0.024 + 250 * $0.000036 = $0.033
    expect(costMicros('backlinksBulkRequest', 250)).toBe(33_000n)
    // All three endpoints for 250 domains: ~$0.099. The brief's ~$0.09.
    expect(costMicros('backlinksBulkRequest', 250) * 3n).toBe(99_000n)
  })

  it('per-niche link lookups cost ~10x batched, which is why the pipeline has a barrier', () => {
    const domains = 250
    const niches = 40
    const batched = costMicros('backlinksBulkRequest', domains) * 3n
    // Same rows, but the $0.024 request fee is paid 40 times per endpoint.
    const perNiche =
      (PRICE.backlinksBulkRequest * BigInt(niches) +
        PRICE.backlinksBulkRow * BigInt(domains)) *
      3n
    expect(perNiche).toBeGreaterThan(batched * 9n)
  })

  it('accumulates sub-cent charges exactly, where a float32 total drifts', () => {
    // The regression the bigint choice exists for, part 1: DRIFT.
    // Ten thousand single-row charges of $0.000036 on top of $100.
    let total = usdToMicros(100)
    for (let i = 0; i < 10_000; i++) total += PRICE.backlinksBulkRow
    expect(total).toBe(100_360_000n) // exact, to the micro

    // Postgres `real` is float32. Same arithmetic, wrong answer -- and wrong
    // in the direction of over-reporting, so a budget cap trips early here.
    const f32 = new Float32Array([100])
    for (let i = 0; i < 10_000; i++) f32[0] = f32[0]! + 0.000036
    expect(f32[0]).not.toBe(100.36)
    expect(Math.abs(f32[0]! - 100.36)).toBeGreaterThan(0.02)
  })

  it('keeps accumulating past the total where a float32 stops entirely', () => {
    // Part 2: the actual PLATEAU. Once a row charge falls below half an ulp of
    // the total, round-to-nearest makes the addition a literal no-op and the
    // running total freezes while real money keeps leaving the account.
    // For x in [1024, 2048), float32 ulp is 2^-13 = 1.22e-4; half of that is
    // 6.1e-5, which exceeds the $0.000036 charge. So $1,024 is the cliff.
    const f32 = new Float32Array([2048])
    for (let i = 0; i < 10_000; i++) f32[0] = f32[0]! + 0.000036
    expect(f32[0]).toBe(2048) // frozen: 10,000 real charges recorded as zero

    let total = usdToMicros(2048)
    for (let i = 0; i < 10_000; i++) total += PRICE.backlinksBulkRow
    expect(total).toBe(2_048_360_000n)
  })

  it('sums an empty list to a bigint zero, not a number zero', () => {
    const zero = sumMicros([])
    expect(zero).toBe(0n)
    expect(typeof zero).toBe('bigint')
  })

  it('converts cents to micros without float drift', () => {
    expect(centsToMicros(200)).toBe(2_000_000n) // $2.00 budget cap
    expect(centsToMicros(1)).toBe(10_000n)
  })

  it('formats for display', () => {
    expect(formatMicrosUsd(2_000n)).toBe('$0.0020')
    expect(formatMicrosUsd(240_000n)).toBe('$0.2400')
    expect(formatMicrosUsd(2_000_000n, { precision: 2 })).toBe('$2.00')
    expect(formatMicrosUsd(0n, { precision: 2 })).toBe('$0.00')
  })
})

describe('estimateDiscoveryCostMicros', () => {
  it('uses the queued task rate when that delivery method is selected', () => {
    const c = estimateDiscoveryCostMicros({
      jobCount: 1_400,
      serpUnitMicros: PRICE.serpOrganicTask,
      volumeRequests: 0,
    })
    expect(formatMicrosUsd(c.serpMicros, { precision: 2 })).toBe('$0.84')
  })

  /**
   * The bug this pins: a 3,200-job deep dive quoted $6.40 (SERP only) while
   * keyword volume alone was ~$144, because volume was fetched once per
   * keyword x location at $0.09 a request and never counted.
   */
  it('counts volume, not just SERP — unbatched 10 niches x 8 kw x 20 markets x 2 devices', () => {
    const cells = 10 * 8 * 20 // keyword x location pairs; devices share one call
    const c = estimateDiscoveryCostMicros({
      jobCount: cells * 2,
      volumeRequests: cells,
      mapsRequests: 10 * 20,
    })
    expect(formatMicrosUsd(c.serpMicros, { precision: 2 })).toBe('$6.40')
    expect(formatMicrosUsd(c.volumeMicros, { precision: 2 })).toBe('$144.00')
    expect(c.totalMicros).toBeGreaterThan(c.serpMicros * 20n)
  })

  it('batching volume by location is what makes a run affordable', () => {
    const cells = 10 * 8 * 20
    const unbatched = estimateDiscoveryCostMicros({ jobCount: cells * 2, volumeRequests: cells })
    const batched = estimateDiscoveryCostMicros({ jobCount: cells * 2, volumeRequests: 20 })
    expect(formatMicrosUsd(batched.volumeMicros, { precision: 2 })).toBe('$1.80')
    expect(unbatched.totalMicros / batched.totalMicros).toBeGreaterThan(15n)
  })

  it('is per request, so keyword count inside a request is free', () => {
    const one = estimateDiscoveryCostMicros({ jobCount: 0, volumeRequests: 1 })
    expect(formatMicrosUsd(one.totalMicros, { precision: 2 })).toBe('$0.09')
  })
})
