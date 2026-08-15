import type { SupplyItem, SupplyLocation } from './types.js'

/**
 * Validation, and the rule it follows: REJECT, NEVER REPAIR.
 *
 * An item missing a `url` could be given one by convention. An item with a
 * `priceMicros` of `29.99` could be multiplied by a million. Both repairs
 * produce a row that looks correct downstream and is wrong — a 404 for a
 * searcher, a $0.00003 median for the economics model — and neither announces
 * itself. So a malformed item is excluded and COUNTED, and the count is served
 * in the manifest where the publisher can see it.
 *
 * This mirrors `cleanEmail` in the consumer, which returns null rather than
 * patching a broken address into a plausible one: a repaired-but-wrong value is
 * worse than no value, because only one of the two stops anybody.
 */

export interface ValidationOk {
  ok: true
  item: SupplyItem
}
export interface ValidationFail {
  ok: false
  /** Best-effort id for the report. `(no id)` when even that is missing. */
  id: string
  problem: string
}
export type ValidationResult = ValidationOk | ValidationFail

const ISO_8601 = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0

function validateLocation(raw: unknown): { ok: true; value: SupplyLocation } | { ok: false; problem: string } {
  if (typeof raw !== 'object' || raw === null) return { ok: false, problem: 'location is not an object' }
  const l = raw as Record<string, unknown>
  if (!isNonEmptyString(l['city'])) return { ok: false, problem: 'location.city is required' }
  if (!isNonEmptyString(l['country'])) return { ok: false, problem: 'location.country is required' }
  const country = (l['country'] as string).trim().toUpperCase()
  if (country.length !== 2) {
    return { ok: false, problem: `location.country "${country}" is not an ISO-3166 alpha-2 code` }
  }

  const value: SupplyLocation = { city: (l['city'] as string).trim(), country }
  if (isNonEmptyString(l['region'])) value.region = (l['region'] as string).trim()

  /**
   * Coordinates are dropped rather than rejected when out of range.
   *
   * They are decoration here — resolution is by name, not by point — so a bad
   * lat/lon must not cost the consumer an otherwise-usable listing.
   */
  const lat = l['lat']
  const lon = l['lon']
  if (typeof lat === 'number' && Number.isFinite(lat) && Math.abs(lat) <= 90) value.lat = lat
  if (typeof lon === 'number' && Number.isFinite(lon) && Math.abs(lon) <= 180) value.lon = lon

  return { ok: true, value }
}

export function validateItem(raw: unknown): ValidationResult {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, id: '(no id)', problem: 'item is not an object' }
  }
  const r = raw as Record<string, unknown>
  const id = isNonEmptyString(r['id']) ? (r['id'] as string).trim() : '(no id)'

  const fail = (problem: string): ValidationFail => ({ ok: false, id, problem })

  if (id === '(no id)') return fail('missing id')
  if (!isNonEmptyString(r['supplierId'])) return fail('missing supplierId')
  if (!isNonEmptyString(r['supplierName'])) return fail('missing supplierName')
  if (!isNonEmptyString(r['title'])) return fail('missing title')
  if (!isNonEmptyString(r['url'])) return fail('missing url')
  if (!isNonEmptyString(r['updatedAt'])) return fail('missing updatedAt')

  const url = (r['url'] as string).trim()
  if (!/^https?:\/\//i.test(url)) return fail(`url "${url}" is not absolute http(s)`)

  const updatedAt = (r['updatedAt'] as string).trim()
  if (!ISO_8601.test(updatedAt) || Number.isNaN(Date.parse(updatedAt))) {
    return fail(`updatedAt "${updatedAt}" is not ISO 8601`)
  }

  const item: SupplyItem = {
    id,
    supplierId: (r['supplierId'] as string).trim(),
    supplierName: (r['supplierName'] as string).trim(),
    title: (r['title'] as string).trim(),
    url,
    updatedAt: new Date(updatedAt).toISOString(),
  }

  if (isNonEmptyString(r['affiliateUrl'])) {
    const a = (r['affiliateUrl'] as string).trim()
    if (!/^https?:\/\//i.test(a)) return fail(`affiliateUrl "${a}" is not absolute http(s)`)
    item.affiliateUrl = a
  }

  if (r['location'] !== undefined && r['location'] !== null) {
    const loc = validateLocation(r['location'])
    if (!loc.ok) return fail(loc.problem)
    item.location = loc.value
  }

  /**
   * Price and currency travel together or not at all.
   *
   * A price with no currency is a number the consumer would have to guess a unit
   * for, and it would guess USD. That is right today and wrong the first time a
   * European property is listed — silently, in the direction of a plausible
   * number.
   */
  if (r['priceMicros'] !== undefined && r['priceMicros'] !== null) {
    const p = r['priceMicros']
    if (typeof p !== 'number' || !Number.isFinite(p)) return fail('priceMicros is not a number')
    if (!Number.isInteger(p)) {
      return fail(`priceMicros ${p} is not an integer — micros are integers, 1_000_000 = $1.00`)
    }
    if (p < 0) return fail(`priceMicros ${p} is negative`)
    if (!isNonEmptyString(r['currency'])) return fail('priceMicros was given without a currency')
    item.priceMicros = p
    item.currency = (r['currency'] as string).trim().toUpperCase()
  } else if (isNonEmptyString(r['currency'])) {
    item.currency = (r['currency'] as string).trim().toUpperCase()
  }

  if (typeof r['available'] === 'boolean') item.available = r['available']

  if (r['attributes'] !== undefined && r['attributes'] !== null) {
    if (typeof r['attributes'] !== 'object' || Array.isArray(r['attributes'])) {
      return fail('attributes is not an object')
    }
    const attrs: Record<string, string | number | boolean> = {}
    for (const [k, v] of Object.entries(r['attributes'] as Record<string, unknown>)) {
      // Scalars only. A nested object here is a schema someone is inventing
      // without saying so, and it would arrive at the consumer as `[object Object]`.
      if (typeof v === 'string' || typeof v === 'boolean') attrs[k] = v
      else if (typeof v === 'number' && Number.isFinite(v)) attrs[k] = v
    }
    if (Object.keys(attrs).length > 0) item.attributes = attrs
  }

  if (Array.isArray(r['images'])) {
    const images = (r['images'] as unknown[]).filter(
      (i): i is string => isNonEmptyString(i) && /^https?:\/\//i.test(i.trim()),
    )
    if (images.length > 0) item.images = images.map((i) => i.trim())
  }

  return { ok: true, item }
}

export interface PartitionResult {
  valid: SupplyItem[]
  invalid: ValidationFail[]
}

export function partitionItems(raw: unknown[]): PartitionResult {
  const valid: SupplyItem[] = []
  const invalid: ValidationFail[] = []
  for (const r of raw) {
    const result = validateItem(r)
    if (result.ok) valid.push(result.item)
    else invalid.push(result)
  }
  return { valid, invalid }
}
