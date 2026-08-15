import { describe, expect, it } from 'vitest'
import {
  classifySupplyOpportunity,
  COVERAGE_STALE_AFTER_DAYS,
  orderValueFromSupply,
  supplyStatusFor,
  type SupplyCoverage,
} from './coverage.js'

const NOW = '2026-08-14T00:00:00.000Z'

const cov = (over: Partial<SupplyCoverage> = {}): SupplyCoverage => ({
  entityKind: 'locality',
  entitySlug: 'las-vegas-nv',
  supplierCount: 12,
  itemCount: 40,
  availableItemCount: 38,
  minPriceMicros: 120_000_000n,
  medianPriceMicros: 240_000_000n,
  lastSeenAt: NOW,
  ...over,
})

describe('supplyStatusFor — three states, never two', () => {
  /**
   * THE ONE THAT MATTERS. A missing coverage row means the feed is not
   * connected, the ingest has not run, OR the listing's location never resolved
   * to this slug. Reading any of those as "no hotels here" turns an importer bug
   * into a decision to stop building pages.
   */
  it('returns unknown for a missing row, never none', () => {
    for (const absent of [null, undefined]) {
      const r = supplyStatusFor(absent, { now: NOW })
      expect(r.status).toBe('unknown')
      expect(r.reason).toMatch(/[Nn]ot the same as having no listings/)
    }
  })

  it('returns have when at least one item is available', () => {
    expect(supplyStatusFor(cov(), { now: NOW }).status).toBe('have')
  })

  it('returns none for a measured zero', () => {
    const r = supplyStatusFor(cov({ itemCount: 0, availableItemCount: 0 }), { now: NOW })
    expect(r.status).toBe('none')
    expect(r.reason).toMatch(/Measured/)
  })

  /**
   * `available` omitted by the publisher means unknown, and the ingest does not
   * promote it. Counting unstated availability as bookable is how a sold-out
   * city keeps its BUILD verdict.
   */
  it('distinguishes "listed but unbookable" from "nothing listed", and calls both none', () => {
    const r = supplyStatusFor(cov({ availableItemCount: 0 }), { now: NOW })
    expect(r.status).toBe('none')
    expect(r.reason).toMatch(/exists and cannot currently be booked/)
  })

  it('flags coverage older than the staleness bar without changing the status', () => {
    const old = new Date(Date.parse(NOW) - (COVERAGE_STALE_AFTER_DAYS + 5) * 86_400_000).toISOString()
    const r = supplyStatusFor(cov({ lastSeenAt: old }), { now: NOW })
    expect(r.status).toBe('have')
    expect(r.stale).toBe(true)
    expect(r.reason).toMatch(/last confirmed 35 days ago/)
  })

  it('treats an unparseable lastSeenAt as maximally stale rather than as fresh', () => {
    expect(supplyStatusFor(cov({ lastSeenAt: 'never' }), { now: NOW }).stale).toBe(true)
  })
})

describe('classifySupplyOpportunity — the 2x2', () => {
  it('names each of the four cells', () => {
    expect(classifySupplyOpportunity('have', 'demand').cell).toBe('BUILD_FIRST')
    expect(classifySupplyOpportunity('have', 'no_demand').cell).toBe('KEYWORD_GAP')
    expect(classifySupplyOpportunity('none', 'demand').cell).toBe('SUPPLY_GAP')
    expect(classifySupplyOpportunity('none', 'no_demand').cell).toBe('IGNORE')
  })

  it('refuses to place a cell when either axis is unmeasured', () => {
    expect(classifySupplyOpportunity('unknown', 'demand').cell).toBe('UNKNOWN')
    expect(classifySupplyOpportunity('have', 'unknown').cell).toBe('UNKNOWN')
    expect(classifySupplyOpportunity('unknown', 'demand').action).toMatch(/supply was never measured/)
    expect(classifySupplyOpportunity('have', 'unknown').action).toMatch(/demand was never measured/)
  })

  /** The cell that costs money today, and the one nobody looks for. */
  it('tells you not to bid into a supply gap, and that a keyword gap is cheap', () => {
    expect(classifySupplyOpportunity('none', 'demand').action).toMatch(/Do not build and do not bid/)
    expect(classifySupplyOpportunity('have', 'no_demand').action).toMatch(/cheapest page/)
  })
})

describe('orderValueFromSupply', () => {
  it('returns the median flagged as an estimate, with its basis', () => {
    const v = orderValueFromSupply(cov())
    expect(v?.orderValueMicros).toBe(240_000_000n)
    expect(v?.estimated).toBe(true)
    expect(v?.basis).toMatch(/Not average booking value/)
  })

  /** Two rows produce a median that describes those two rows, not the market. */
  it('refuses a median computed from too few items', () => {
    expect(orderValueFromSupply(cov({ itemCount: 2 }))).toBeNull()
  })

  it('returns null rather than a fallback when there is no price data at all', () => {
    expect(orderValueFromSupply(cov({ medianPriceMicros: null }))).toBeNull()
    expect(orderValueFromSupply(null)).toBeNull()
  })

  it('refuses a zero median rather than treating free inventory as an order value', () => {
    expect(orderValueFromSupply(cov({ medianPriceMicros: 0n }))).toBeNull()
  })
})
