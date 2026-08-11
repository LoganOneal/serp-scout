import { describe, expect, it } from 'vitest'
import { dueOutcomeChecks, hitRateByBand, isOrderingSound } from './calibration.js'
import type { OutcomeDayOffset, OutcomeRow, Verdict } from './types.js'

let nextId = 1
/** One build: a verdict frozen at save time plus a set of rank checks. */
function build(verdict: Verdict, checks: Array<[OutcomeDayOffset, number | null]>): OutcomeRow[] {
  const shortlistItemId = nextId++
  return checks.map(([dayOffset, position]) => ({
    shortlistItemId,
    dayOffset,
    checkedAt: '2026-08-01T00:00:00Z',
    position,
    verdictAtSave: verdict,
    difficultyAtSave: 20,
  }))
}

describe('calibration -- position NULL is a measurement', () => {
  it('counts a checked-and-nowhere build in the denominator', () => {
    // THE assertion. Three builds, one ranked. If `position: null` were treated
    // as missing data, the two failures would vanish from the denominator and
    // this band would report 100%.
    const rows = [
      ...build('likely_30d', [
        [7, null],
        [14, null],
        [30, 4],
      ]),
      ...build('likely_30d', [
        [7, null],
        [14, null],
        [30, null],
      ]),
      ...build('likely_30d', [
        [7, null],
        [30, null],
      ]),
    ]
    const stats = hitRateByBand(rows)
    const band = stats.find((s) => s.verdict === 'likely_30d')!
    expect(band.n).toBe(3)
    expect(band.hits).toBe(1)
    expect(band.rate).toBeCloseTo(1 / 3, 5)
  })

  it('reports n=0 and a null rate rather than 0% for a band with no builds', () => {
    const stats = hitRateByBand(build('likely_30d', [[7, 3]]))
    const empty = stats.find((s) => s.verdict === 'likely_6m')!
    expect(empty.n).toBe(0)
    // Not 0. An unmeasured rate is not a rate of zero -- rendering 0% would
    // read as "this band never works" when nothing has been tried.
    expect(empty.rate).toBeNull()
  })

  it('always exposes n so a rate can never be displayed bare', () => {
    const stats = hitRateByBand(build('likely_30d', [[30, 2]]))
    for (const s of stats) expect(typeof s.n).toBe('number')
    const band = stats.find((s) => s.verdict === 'likely_30d')!
    // "100%" off one build is not the same claim as "100%" off 300.
    expect(band.rate).toBe(1)
    expect(band.n).toBe(1)
  })

  it('honours each band deadline -- a 30-day claim is not saved by a day-90 rank', () => {
    const rows = build('likely_30d', [
      [7, null],
      [30, null],
      [90, 5], // ranked, but two months after the claim
    ])
    const band = hitRateByBand(rows).find((s) => s.verdict === 'likely_30d')!
    expect(band.hits).toBe(0)
    expect(band.n).toBe(1)
  })

  it('counts a rank outside the top 10 as a miss', () => {
    const band = hitRateByBand(build('likely_30d', [[30, 14]])).find(
      (s) => s.verdict === 'likely_30d',
    )!
    expect(band.hits).toBe(0)
  })
})

describe('calibration -- ordering soundness', () => {
  const bandsWith = (rates: Array<[Verdict, number, number]>) =>
    rates.flatMap(([v, hits, n]) =>
      Array.from({ length: n }, (_, i) => build(v, [[30, i < hits ? 3 : null]])).flat(),
    )

  it('is null, not true, before there is enough data to say anything', () => {
    const check = isOrderingSound(hitRateByBand(build('likely_30d', [[30, 2]])))
    expect(check.sound).toBeNull()
    expect(check.note).toMatch(/at least two bands/)
  })

  it('passes when better bands outperform worse ones', () => {
    const stats = hitRateByBand(
      bandsWith([
        ['likely_30d', 4, 5],
        ['likely_90d', 2, 5],
        ['likely_6m', 1, 5],
      ]),
    )
    const check = isOrderingSound(stats)
    expect(check.sound).toBe(true)
    expect(check.violations).toEqual([])
    expect(check.evaluated).toHaveLength(3)
  })

  it('reports a violation when a worse band outperforms a better one', () => {
    const stats = hitRateByBand(
      bandsWith([
        ['likely_30d', 1, 5],
        ['likely_90d', 4, 5],
      ]),
    )
    const check = isOrderingSound(stats)
    expect(check.sound).toBe(false)
    expect(check.violations).toHaveLength(1)
    expect(check.violations[0]!.better).toBe('likely_30d')
    expect(check.violations[0]!.worse).toBe('likely_90d')
    // A violation means the model cannot tell easy pages from hard ones -- a
    // different failure from "a constant needs nudging", and it must say so.
    expect(check.note).toMatch(/misreading SERPs, not mis-tuned/)
  })

  it('ignores bands with too few builds to be meaningful', () => {
    const stats = hitRateByBand(
      bandsWith([
        ['likely_30d', 3, 5],
        ['likely_90d', 2, 2], // n=2, below MIN_N_FOR_ORDERING
      ]),
    )
    const check = isOrderingSound(stats)
    expect(check.evaluated.map((e) => e.verdict)).toEqual(['likely_30d'])
    expect(check.sound).toBeNull()
  })
})

describe('calibration -- scheduling re-checks', () => {
  const started = new Date('2026-06-01T00:00:00Z')

  it('returns only checks that are due and not already done', () => {
    expect(
      dueOutcomeChecks({
        buildStartedAt: started,
        now: new Date('2026-06-20T00:00:00Z'),
        alreadyChecked: [7],
      }),
    ).toEqual([14])
  })

  it('returns nothing before the first checkpoint', () => {
    expect(
      dueOutcomeChecks({
        buildStartedAt: started,
        now: new Date('2026-06-03T00:00:00Z'),
        alreadyChecked: [],
      }),
    ).toEqual([])
  })

  it('backfills every missed checkpoint', () => {
    expect(
      dueOutcomeChecks({
        buildStartedAt: started,
        now: new Date('2026-09-15T00:00:00Z'),
        alreadyChecked: [],
      }),
    ).toEqual([7, 14, 30, 60, 90])
  })
})
