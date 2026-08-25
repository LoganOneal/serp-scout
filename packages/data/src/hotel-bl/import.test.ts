import { describe, expect, it } from 'vitest'
import { parseHotelBlInventoryCsv } from './import.js'

describe('Hotel Backlink Scout CSV parsing', () => {
  it('accepts common source headers, preserves raw values, and detects duplicate hotels', () => {
    const csv = `Property Name,City,State,HHT URL,Direct Link,Classification,Notes
"Cedar House",Austin,TX,https://hotelhottubs.com/cedar,http://www.cedarhouse.example/?utm_source=sheet,Direct,keep me
"Cedar House",Austin,TX,https://hotelhottubs.com/cedar,https://cedarhouse.example/new,Direct,duplicate source
"Lake Lodge",Denver,CO,,https://hilton.com/en/hotels/lake-lodge,Brand,raw note`
    const result = parseHotelBlInventoryCsv(csv)
    expect(result.rows).toHaveLength(2)
    expect(result.duplicateRows).toBe(1)
    expect(result.skippedRows).toBe(0)
    expect(result.rows[0]).toMatchObject({
      hotelName: 'Cedar House',
      city: 'Austin',
      state: 'TX',
      sourceUrl: 'https://cedarhouse.example/',
      sourceLinkType: 'Direct',
      rawSource: expect.objectContaining({ notes: 'keep me' }),
    })
  })

  it('skips rows without a recognizable hotel name instead of inventing one', () => {
    const result = parseHotelBlInventoryCsv('Hotel,City,Website\n,Seattle,https://example.com')
    expect(result.rows).toEqual([])
    expect(result.skippedRows).toBe(1)
  })

  it('recognizes the real inventory site_url header and keeps its remaining columns', () => {
    const csv = `slug,name,city,state,source,tub_type,rating,review_count,listing_url,site_url,host,link_type,confidence,method,serp_rank,http_status,final_url,flags
cedar-house,Cedar House,Austin,TX,inventory,private,4.7,125,https://hotelhottubs.com/hotels/cedar-house,https://www.cedarhouse.example/?utm_source=sheet,cedarhouse.example,direct,0.9,serp,1,200,https://cedarhouse.example/,verified`
    const result = parseHotelBlInventoryCsv(csv)

    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]).toMatchObject({
      hotelName: 'Cedar House',
      existingHhtUrl: 'https://hotelhottubs.com/hotels/cedar-house',
      sourceUrl: 'https://cedarhouse.example/',
      sourceLinkType: 'direct',
      rawSource: expect.objectContaining({
        slug: 'cedar-house',
        tub_type: 'private',
        confidence: '0.9',
        final_url: 'https://cedarhouse.example/',
      }),
    })
  })
})
