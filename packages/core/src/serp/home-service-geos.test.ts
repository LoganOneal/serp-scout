import { describe, expect, it } from 'vitest'
import { parseHomeServiceGeographiesCsv } from './home-service-geos.js'

describe('parseHomeServiceGeographiesCsv', () => {
  it('parses pre-resolved location codes and ranks', () => {
    const text = [
      'market,state_abbr,population_2025,selected_rank,dataforseo_location_code,dataforseo_location_name',
      'Nashville,TN,700000,1,1020571,"Nashville,Tennessee,United States"',
      'Austin,TX,1000000,2,1020572,"Austin,Texas,United States"',
    ].join('\n')

    const r = parseHomeServiceGeographiesCsv(text)
    expect(r.rows).toHaveLength(2)
    expect(r.rows[0]!.market).toBe('Nashville')
    expect(r.rows[0]!.stateAbbr).toBe('TN')
    expect(r.rows[0]!.dataforseoLocationCode).toBe(1020571)
    expect(r.rows[0]!.selectedRank).toBe(1)
    expect(r.rows[1]!.market).toBe('Austin')
  })

  it('requires market and state or code', () => {
    const text = 'market,state_abbr\n,TN\nSolo,,\n'
    const r = parseHomeServiceGeographiesCsv(text)
    // empty market skipped; Solo without state or code skipped
    expect(r.rows).toHaveLength(0)
    expect(r.skipped.length).toBeGreaterThanOrEqual(1)
  })
})
