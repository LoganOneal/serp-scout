import { describe, expect, it } from 'vitest'
import { assessKeyword } from '../spaces/keyword-verdict.js'
import { assessPaidKeyword } from '../ads/paid-verdict.js'
import { supplyStatusFor, type SupplyCoverage } from './coverage.js'
import { gateKeywordVerdict, gatePaidVerdict } from './gate.js'

const NOW = '2026-08-14T00:00:00.000Z'

const coverage = (over: Partial<SupplyCoverage>): SupplyCoverage => ({
  entityKind: 'locality',
  entitySlug: 'boise-id',
  supplierCount: 0,
  itemCount: 0,
  availableItemCount: 0,
  minPriceMicros: null,
  medianPriceMicros: null,
  lastSeenAt: NOW,
  ...over,
})

const HAVE = supplyStatusFor(coverage({ supplierCount: 12, itemCount: 40, availableItemCount: 38 }), { now: NOW })
const NONE = supplyStatusFor(coverage({}), { now: NOW })
const UNKNOWN = supplyStatusFor(null, { now: NOW })

const buildable = () =>
  assessKeyword({ position: null, positionMeasured: true, volume: 2400, difficulty: 30, volumeFloor: 50 })

describe('gateKeywordVerdict', () => {
  it('leaves BUILD alone when supply exists', () => {
    const r = gateKeywordVerdict(buildable(), HAVE)
    expect(r.verdict).toBe('BUILD')
    expect(r.gated).toBe(false)
    expect(r.supplyStatus).toBe('have')
  })

  it('turns BUILD into IGNORE on measured zero supply, and says so', () => {
    const r = gateKeywordVerdict(buildable(), NONE)
    expect(r.verdict).toBe('IGNORE')
    expect(r.gated).toBe(true)
    expect(r.demandVerdict).toBe('BUILD')
    expect(r.reason).toMatch(/No supply/)
    expect(r.reason).toMatch(/empty result set/)
  })

  /**
   * ==================== THE REGRESSION THIS FILE EXISTS FOR ====================
   * Supply-blindness must not be replaced by supply-certainty. An unresolved
   * locality is not a locality with no hotels, and if 'unknown' downgraded
   * anything, one importer bug would stop the portfolio building pages.
   * ============================================================================
   */
  it('changes NOTHING when supply is unknown', () => {
    const before = buildable()
    const r = gateKeywordVerdict(before, UNKNOWN)
    expect(r.verdict).toBe(before.verdict)
    expect(r.reason).toBe(before.reason)
    expect(r.missing).toEqual(before.missing)
    expect(r.gated).toBe(false)
    expect(r.supplyStatus).toBe('unknown')
  })

  /**
   * A page that already ranks is a live asset. Telling the operator to abandon
   * it over an inventory count inverts the cheap fix, which is to list supply.
   */
  it('warns on DEFEND and IMPROVE rather than blocking them', () => {
    const defend = assessKeyword({
      position: 2, positionMeasured: true, volume: 2400, difficulty: 30, volumeFloor: 50,
    })
    const r = gateKeywordVerdict(defend, NONE)
    expect(r.verdict).toBe('DEFEND')
    expect(r.gated).toBe(false)
    expect(r.supplyWarnings.join(' ')).toMatch(/ranking is earning nothing/)
  })

  it('surfaces stale coverage as a warning without touching the verdict', () => {
    const old = new Date(Date.parse(NOW) - 60 * 86_400_000).toISOString()
    const stale = supplyStatusFor(
      coverage({ supplierCount: 12, itemCount: 40, availableItemCount: 38, lastSeenAt: old }),
      { now: NOW },
    )
    const r = gateKeywordVerdict(buildable(), stale)
    expect(r.verdict).toBe('BUILD')
    expect(r.supplyWarnings.join(' ')).toMatch(/claim about the past/)
  })
})

const paid = () =>
  assessPaidKeyword({
    keywordNorm: 'hotels with hot tubs in room boise',
    volume: 2400,
    organicPosition: null,
    positionMeasured: true,
    // $0.25-$0.50 against a $30 margin ($400 booking x 7.5%) at 96% incrementality:
    // break-even is 1.74%, we convert at 4.00% — 2.3x the bar, so BUY.
    bidLowMicros: 250_000n,
    bidHighMicros: 500_000n,
    hasAiOverview: false,
    economics: { orderValueMicros: 400_000_000n, commissionRateBps: 750 },
    achievedConversionBps: 400,
  })

describe('gatePaidVerdict', () => {
  it('leaves a BUY alone when supply exists', () => {
    const before = paid()
    expect(before.verdict).toBe('BUY')
    const r = gatePaidVerdict(before, HAVE)
    expect(r.verdict).toBe('BUY')
    expect(r.gated).toBe(false)
  })

  /**
   * BLOCKED, not SKIP. SKIP means the arithmetic was run and does not work; this
   * one never reached the arithmetic. Same treatment as an AI Overview — a
   * structural fact no favourable margin should override.
   */
  it('BLOCKS on measured zero supply even when the arithmetic says BUY', () => {
    const r = gatePaidVerdict(paid(), NONE)
    expect(r.verdict).toBe('BLOCKED')
    expect(r.demandVerdict).toBe('BUY')
    expect(r.gated).toBe(true)
    expect(r.marginRatio).toBeNull()
    expect(r.reason).toMatch(/nothing that survives the click/)
  })

  it('changes nothing when supply is unknown', () => {
    const before = paid()
    const r = gatePaidVerdict(before, UNKNOWN)
    expect(r.verdict).toBe(before.verdict)
    expect(r.reason).toBe(before.reason)
    expect(r.gated).toBe(false)
  })

  it('warns rather than blocks when a BUY rests on stale coverage', () => {
    const old = new Date(Date.parse(NOW) - 60 * 86_400_000).toISOString()
    const stale = supplyStatusFor(
      coverage({ supplierCount: 12, itemCount: 40, availableItemCount: 38, lastSeenAt: old }),
      { now: NOW },
    )
    const r = gatePaidVerdict(paid(), stale)
    expect(r.verdict).toBe('BUY')
    expect(r.warnings.join(' ')).toMatch(/nobody has refreshed/)
  })
})
