import { describe, expect, it } from 'vitest'
import { partitionItems, validateItem } from './validate.js'

const good = {
  id: 'rm_1',
  supplierId: 'prop_1',
  supplierName: 'The Bellagio',
  title: 'King Suite with In-Room Jacuzzi',
  url: 'https://hotelhottubs.com/hotels/bellagio#rm_1',
  updatedAt: '2026-08-14T09:12:00Z',
}

describe('validateItem — reject, never repair', () => {
  it('accepts the minimum viable item', () => {
    const r = validateItem(good)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.item.id).toBe('rm_1')
  })

  it.each([
    ['id', 'missing id'],
    ['supplierId', 'missing supplierId'],
    ['supplierName', 'missing supplierName'],
    ['title', 'missing title'],
    ['url', 'missing url'],
    ['updatedAt', 'missing updatedAt'],
  ])('rejects an item with no %s', (field, problem) => {
    const r = validateItem({ ...good, [field]: undefined })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.problem).toBe(problem)
  })

  /**
   * A relative url is the repair that looks safest and is not: the consumer
   * would have to prepend a base it is guessing at, and a wrong guess is a 404
   * served to a searcher who clicked a ranked page.
   */
  it('rejects a relative url rather than resolving it against a guessed base', () => {
    const r = validateItem({ ...good, url: '/hotels/bellagio' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.problem).toMatch(/not absolute/)
  })

  /**
   * ==================== THE MOST EXPENSIVE POSSIBLE REPAIR ====================
   * `29.99` is a publisher who read "price" and not "micros". Multiplying by a
   * million would be the helpful thing to do and would be indistinguishable
   * from a real $0.00003 listing. It goes on to become a median order value,
   * which goes on to decide break-even, which goes on to authorise ad spend.
   * ==========================================================================
   */
  it('rejects a non-integer priceMicros instead of scaling it', () => {
    const r = validateItem({ ...good, priceMicros: 29.99, currency: 'USD' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.problem).toMatch(/not an integer/)
  })

  it('rejects a price with no currency', () => {
    const r = validateItem({ ...good, priceMicros: 40_000_000 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.problem).toMatch(/without a currency/)
  })

  it('accepts an integer price with a currency and upper-cases the currency', () => {
    const r = validateItem({ ...good, priceMicros: 40_000_000, currency: 'usd' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.item.priceMicros).toBe(40_000_000)
      expect(r.item.currency).toBe('USD')
    }
  })

  it('requires an ISO-3166 alpha-2 country', () => {
    const r = validateItem({ ...good, location: { city: 'Las Vegas', country: 'United States' } })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.problem).toMatch(/alpha-2/)
  })

  it('normalises a location and keeps the region', () => {
    const r = validateItem({
      ...good,
      location: { city: '  Las Vegas ', region: 'nv', country: 'us' },
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.item.location).toEqual({ city: 'Las Vegas', region: 'nv', country: 'US' })
  })

  /**
   * An out-of-range coordinate is decoration, not identity — resolution is by
   * name. Losing a whole listing over it would cost coverage for nothing.
   */
  it('drops an impossible coordinate but keeps the item', () => {
    const r = validateItem({
      ...good,
      location: { city: 'Las Vegas', country: 'US', lat: 999, lon: -115.17 },
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.item.location?.lat).toBeUndefined()
      expect(r.item.location?.lon).toBe(-115.17)
    }
  })

  it('keeps only scalar attributes', () => {
    const r = validateItem({
      ...good,
      attributes: { in_room_hot_tub: true, occupancy: 2, tag: 'suite', nested: { a: 1 } },
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.item.attributes).toEqual({ in_room_hot_tub: true, occupancy: 2, tag: 'suite' })
    }
  })

  it('normalises updatedAt to a canonical ISO string', () => {
    const r = validateItem({ ...good, updatedAt: '2026-08-14T09:12:00+00:00' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.item.updatedAt).toBe('2026-08-14T09:12:00.000Z')
  })

  it('rejects an unparseable updatedAt', () => {
    const r = validateItem({ ...good, updatedAt: 'last tuesday' })
    expect(r.ok).toBe(false)
  })
})

describe('partitionItems', () => {
  it('separates valid from invalid and keeps the reason for each drop', () => {
    const r = partitionItems([good, { ...good, id: 'rm_2', url: 'nope' }, null])
    expect(r.valid).toHaveLength(1)
    expect(r.invalid.map((i) => [i.id, i.problem])).toEqual([
      ['rm_2', 'url "nope" is not absolute http(s)'],
      ['(no id)', 'item is not an object'],
    ])
  })
})
