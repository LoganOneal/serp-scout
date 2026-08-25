import { describe, expect, it } from 'vitest'
import { extractHotelBlValidationIdentity } from './validation.js'

describe('Hotel Backlink Scout URL validation evidence', () => {
  it('extracts prominent names and the matching lodging address from JSON-LD', () => {
    const identity = extractHotelBlValidationIdentity(`
      <html><head><title>Mokara Hotel &amp; Spa | San Antonio</title></head><body>
        <h1>Mokara Hotel &amp; Spa</h1>
        <script type="application/ld+json">{
          "@type": "Hotel",
          "name": "Mokara Hotel & Spa",
          "address": {
            "@type": "PostalAddress",
            "streetAddress": "212 W Crockett St",
            "addressLocality": "San Antonio",
            "addressRegion": "TX"
          }
        }</script>
      </body></html>
    `, 'Mokara Hotel Spa San Antonio')

    expect(identity).toMatchObject({
      title: 'Mokara Hotel & Spa | San Antonio',
      headings: ['Mokara Hotel & Spa'],
      lodgingNames: ['Mokara Hotel & Spa'],
      matchedAddress: '212 W Crockett St, San Antonio, TX',
    })
  })

  it('keeps tourism organizations separate from lodging schema', () => {
    const identity = extractHotelBlValidationIdentity(`
      <html><head><title>Visit Ventura | Official Visitor Guide</title></head><body>
        <h1>Plan your trip to Ventura</h1>
        <script type="application/ld+json">{"@type":"TouristInformationCenter","name":"Visit Ventura"}</script>
      </body></html>
    `, 'Viking Motel')

    expect(identity.organizationNames).toEqual(['Visit Ventura'])
    expect(identity.lodgingNames).toEqual([])
  })
})
