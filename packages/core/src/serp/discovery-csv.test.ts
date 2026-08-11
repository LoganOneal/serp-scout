import { describe, expect, it } from 'vitest'
import {
  DiscoveryCsvError,
  parseDiscoveryGeoCsv,
  parseDiscoveryNicheCsv,
} from './discovery-csv.js'

describe('parseDiscoveryNicheCsv', () => {
  it('parses primary + near-me columns', () => {
    const csv = `Niche,Keyword Primary,Keyword Near Me
Electrician,electrician,electrician near me
HVAC,hvac repair,hvac repair near me
`
    const r = parseDiscoveryNicheCsv(csv)
    expect(r.rows).toHaveLength(2)
    expect(r.rows[0]).toEqual({
      label: 'Electrician',
      slug: null,
      keywordPrimary: 'electrician',
      keywordNearMe: 'electrician near me',
      nearMeSynthesised: false,
    })
    expect(r.skipped).toEqual([])
  })

  it('synthesises near-me when only one keyword column', () => {
    const csv = `label,keyword
Plumber,plumber
`
    const r = parseDiscoveryNicheCsv(csv)
    expect(r.rows[0]).toMatchObject({
      keywordPrimary: 'plumber',
      keywordNearMe: 'plumber near me',
      nearMeSynthesised: true,
      label: 'Plumber',
    })
  })

  it('skips duplicates and empty keywords with line numbers', () => {
    const csv = `keyword
electrician

electrician
`
    const r = parseDiscoveryNicheCsv(csv)
    expect(r.rows).toHaveLength(1)
    expect(r.skipped.some((s) => s.reason.includes('Duplicate'))).toBe(true)
  })

  it('throws when there is no keyword column', () => {
    expect(() => parseDiscoveryNicheCsv('foo,bar\n1,2')).toThrow(DiscoveryCsvError)
  })
})

describe('parseDiscoveryGeoCsv', () => {
  it('parses name, state, population, kind', () => {
    const csv = `City,State,Population,Kind
Austin,TX,978908,city
Cook County,IL,5275541,county
`
    const r = parseDiscoveryGeoCsv(csv)
    expect(r.rows).toEqual([
      { name: 'Austin', state: 'TX', population: 978908, kind: 'city' },
      { name: 'Cook County', state: 'IL', population: 5275541, kind: 'county' },
    ])
  })

  it('requires state and never guesses', () => {
    const csv = `name,state
Dallas,TX
Houston,
`
    const r = parseDiscoveryGeoCsv(csv)
    expect(r.rows).toHaveLength(1)
    expect(r.skipped[0]?.reason).toMatch(/Missing state/)
    expect(r.skipped[0]?.line).toBe(3)
  })

  it('maps metro aliases and rejects unknown kind', () => {
    const csv = `name,state,kind
Chicago,IL,MSA
Nowhere,ZZ,planet
`
    const r = parseDiscoveryGeoCsv(csv)
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0]?.kind).toBe('metro')
    expect(r.skipped[0]?.reason).toMatch(/Unknown kind/)
  })

  it('throws without name or state columns', () => {
    expect(() => parseDiscoveryGeoCsv('foo\nbar')).toThrow(DiscoveryCsvError)
    expect(() => parseDiscoveryGeoCsv('city\nAustin')).toThrow(DiscoveryCsvError)
  })

  it('tolerates BOM and semicolon delimiter', () => {
    const csv = '\uFEFFname;state;pop\nPhoenix;AZ;1608139\n'
    const r = parseDiscoveryGeoCsv(csv)
    expect(r.delimiter).toBe(';')
    expect(r.rows[0]).toMatchObject({ name: 'Phoenix', state: 'AZ', population: 1608139 })
  })
})
