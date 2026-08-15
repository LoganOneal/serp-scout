import { describe, expect, it } from 'vitest'
import {
  deriveFromObservation,
  resolveConversion,
  resolveEconomics,
  type EconomicsCatalog,
} from './resolve.js'

/** hotelhottubs: 7.5% flat by contract, $300 average booking. */
const HOTEL: EconomicsCatalog = {
  asOf: '2026-08-14',
  siteDefaultOrderValueMicros: 300_000_000n,
  commissionRates: [{ entitySlug: null, commissionRateBps: 750, effectiveFrom: '2026-01-01' }],
  vendorSlugs: [],
  entityOrderValueMicros: { 'las-vegas-nv': 450_000_000n },
}

/** borenhealth: commission varies per vendor. */
const PEPTIDES: EconomicsCatalog = {
  asOf: '2026-08-14',
  siteDefaultOrderValueMicros: 150_000_000n,
  commissionRates: [
    { entitySlug: null, commissionRateBps: 1000, effectiveFrom: '2026-01-01' },
    { entitySlug: 'peptide-sciences', commissionRateBps: 2000, effectiveFrom: '2026-01-01' },
    { entitySlug: 'swiss-chems', commissionRateBps: 1500, effectiveFrom: '2026-01-01' },
    { entitySlug: 'amino-asylum', commissionRateBps: 1200, effectiveFrom: '2026-01-01' },
  ],
  vendorSlugs: ['peptide-sciences', 'swiss-chems', 'amino-asylum'],
  entityOrderValueMicros: { 'bpc-157': 60_000_000n },
}

const peptideBindings = (entities: Record<string, string>) => ({
  entities,
  vendorDimension: 'vendor',
  orderValueDimensions: ['product'],
})

describe('commission — the hotel case is one number', () => {
  it('resolves from the site default', () => {
    const r = resolveEconomics(HOTEL, { entities: { locality: 'las-vegas-nv' }, orderValueDimensions: ['locality'] })
    expect(r.commissionRateBps.value).toBe(750)
    expect(r.commissionRateBps.resolvedFrom).toBe('site-default')
  })

  it('picks the rate in force, not the newest', () => {
    const withFuture: EconomicsCatalog = {
      ...HOTEL,
      commissionRates: [
        ...HOTEL.commissionRates,
        { entitySlug: null, commissionRateBps: 900, effectiveFrom: '2027-01-01' },
      ],
    }
    expect(resolveEconomics(withFuture, { entities: {} }).commissionRateBps.value).toBe(750)
  })

  it('uses a newer rate once it takes effect', () => {
    const later: EconomicsCatalog = {
      ...HOTEL,
      asOf: '2027-06-01',
      commissionRates: [
        ...HOTEL.commissionRates,
        { entitySlug: null, commissionRateBps: 900, effectiveFrom: '2027-01-01' },
      ],
    }
    expect(resolveEconomics(later, { entities: {} }).commissionRateBps.value).toBe(900)
  })
})

describe('commission — the peptide case varies per vendor', () => {
  it('takes the bound vendor’s own rate', () => {
    const r = resolveEconomics(PEPTIDES, peptideBindings({ vendor: 'peptide-sciences' }))
    expect(r.commissionRateBps.value).toBe(2000)
    expect(r.commissionRateBps.resolvedFrom).toBe('vendor:peptide-sciences')
  })

  /**
   * THE RULE THE PLAN SPECIFIES. A product-only keyword monetises through
   * whichever vendor the page routes to, and we do not measure that split. The
   * minimum is the conservative choice: a keyword clearing break-even at the
   * worst-paying vendor clears it everywhere.
   */
  it('falls back to the MINIMUM across vendors, not the average', () => {
    const r = resolveEconomics(PEPTIDES, peptideBindings({ product: 'bpc-157' }))
    expect(r.commissionRateBps.value).toBe(1200)
    expect(r.commissionRateBps.resolvedFrom).toBe('min-across-3-vendors')
    expect(r.commissionRateBps.inherited).toBe(true)
  })

  it('counts a vendor with no rate row as the site default, never skips it', () => {
    // Skipping would make the fallback MORE optimistic the less we know.
    const withUnknown: EconomicsCatalog = {
      ...PEPTIDES,
      vendorSlugs: [...PEPTIDES.vendorSlugs, 'core-peptides'],
    }
    const r = resolveEconomics(withUnknown, peptideBindings({ product: 'bpc-157' }))
    expect(r.commissionRateBps.value).toBe(1000) // the site default, not 1200
  })

  it('falls back to the site default for a vendor with no rate of its own', () => {
    const r = resolveEconomics(PEPTIDES, peptideBindings({ vendor: 'core-peptides' }))
    expect(r.commissionRateBps.value).toBe(1000)
    expect(r.commissionRateBps.inherited).toBe(true)
  })
})

describe('order value', () => {
  it('prefers the entity’s own value', () => {
    const r = resolveEconomics(HOTEL, {
      entities: { locality: 'las-vegas-nv' },
      orderValueDimensions: ['locality'],
    })
    expect(r.orderValueMicros.value).toBe(450_000_000n)
    expect(r.orderValueMicros.inherited).toBe(false)
  })

  it('flags the site average as INHERITED when the entity has none', () => {
    const r = resolveEconomics(HOTEL, {
      entities: { locality: 'gatlinburg-tn' },
      orderValueDimensions: ['locality'],
    })
    expect(r.orderValueMicros.value).toBe(300_000_000n)
    expect(r.orderValueMicros.inherited).toBe(true)
  })

  it('multiplies out to value per conversion', () => {
    const r = resolveEconomics(HOTEL, {
      entities: { locality: 'las-vegas-nv' },
      orderValueDimensions: ['locality'],
    })
    // $450 × 7.5% = $33.75
    expect(r.valuePerConversionMicros).toBe(33_750_000n)
  })

  it('is null when either term is unset — never a partial answer', () => {
    const bare: EconomicsCatalog = { ...HOTEL, siteDefaultOrderValueMicros: null, entityOrderValueMicros: {} }
    expect(resolveEconomics(bare, { entities: {} }).valuePerConversionMicros).toBeNull()
  })
})

describe('resolveConversion — shrinkage down the hierarchy', () => {
  const site = { label: 'site', observation: { clicks: 50_000, orders: 1_500 } } // 3%

  it('a keyword with no data of its own inherits the site rate', () => {
    const r = resolveConversion({
      scopes: [{ label: 'keyword:x', observation: { clicks: 0, orders: 0 } }, site],
    })!
    expect(r.meanBps).toBeCloseTo(300, -1)
    expect(r.resolvedFrom).toBe('site')
  })

  it('a keyword with real data moves away from the site rate', () => {
    const r = resolveConversion({
      scopes: [{ label: 'keyword:x', observation: { clicks: 20_000, orders: 2_000 } }, site],
    })!
    expect(r.meanBps).toBeGreaterThan(900)
    expect(r.resolvedFrom).toBe('keyword:x')
  })

  it('shrinks through the pattern, not straight to the site', () => {
    const r = resolveConversion({
      scopes: [
        { label: 'keyword:x', observation: { clicks: 10, orders: 2 } },
        { label: 'pattern:suites', observation: { clicks: 10_000, orders: 800 } }, // 8%
        site,
      ],
    })!
    // The pattern (8%) dominates a 10-click keyword, not the site (3%).
    expect(r.meanBps).toBeGreaterThan(600)
    expect(r.chain.map((c) => c.label)).toEqual(['keyword:x', 'pattern:suites', 'site'])
  })

  it('returns null when nothing anywhere has been measured', () => {
    expect(
      resolveConversion({ scopes: [{ label: 'site', observation: { clicks: 0, orders: 0 } }] }),
    ).toBeNull()
  })

  it('carries the period, because stale data looks identical to fresh', () => {
    const r = resolveConversion({ scopes: [site], periodEnd: '2026-07-31' })!
    expect(r.periodEnd).toBe('2026-07-31')
  })
})

describe('deriveFromObservation — every term from one dashboard reading', () => {
  it('derives conversion, AOV and EFFECTIVE commission at once', () => {
    const d = deriveFromObservation({
      clicks: 412,
      orders: 11,
      saleValueMicros: 3_300_000_000n, // $3,300
      commissionMicros: 247_500_000n, // $247.50
    })
    expect(d.conversionBps).toBe(267) // 2.67%
    expect(d.averageOrderValueMicros).toBe(300_000_000n) // $300
    expect(d.effectiveCommissionBps).toBe(750) // 7.5%
  })

  it('leaves AOV and effective commission null when the report omits them', () => {
    const d = deriveFromObservation({ clicks: 412, orders: 11 })
    expect(d.conversionBps).toBe(267)
    expect(d.averageOrderValueMicros).toBeNull()
    expect(d.effectiveCommissionBps).toBeNull()
  })

  it('surfaces an effective rate that diverges from the contract', () => {
    // Contract says 7.5%; adjustments meant 6.1% actually landed.
    const d = deriveFromObservation({
      clicks: 400,
      orders: 10,
      saleValueMicros: 3_000_000_000n,
      commissionMicros: 183_000_000n,
    })
    expect(d.effectiveCommissionBps).toBe(610)
  })
})
