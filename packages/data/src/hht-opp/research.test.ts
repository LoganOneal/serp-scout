import { describe, expect, it } from 'vitest'
import { classifyCorporateEligibility } from '@rnr/core'
import { extractPricing, extractRequirements, formatPrice } from '@rnr/core'
import { classifyOpportunityTypes } from '@rnr/core'

const PAGE = `
Write for Us. Industry experts welcome. Brands welcome.
Pitch us before you draft. Minimum 1200 words. No promotional copy.
Original photography preferred. One contextual dofollow link is allowed.
Paid guest post packages start at $150. Advertise with us for other packages.
`

describe('seed research extractors on a publisher-like page', () => {
  it('produces a PASS editorial opportunity with evidence and a public price', () => {
    const types = classifyOpportunityTypes({
      url: 'https://travel.example/write-for-us',
      title: 'Write for Us',
      text: PAGE,
    })
    expect(types.map((row) => row.type)).toEqual(expect.arrayContaining(['editorial_guest', 'paid_guest_post']))

    const eligibility = classifyCorporateEligibility('https://travel.example/write-for-us', PAGE)
    expect(eligibility.eligibility).toBe('PASS')
    expect(eligibility.evidence?.sourceExcerpt).toMatch(/welcome/i)

    const requirements = extractRequirements('https://travel.example/write-for-us', PAGE)
    expect(requirements.some((row) => row.label === 'Word count')).toBe(true)
    expect(requirements.some((row) => row.label === 'Pitch first')).toBe(true)

    const price = extractPricing('https://travel.example/write-for-us', PAGE)
    expect(price.status).toBe('FIXED')
    expect(price.amount).toBe(150)
    expect(formatPrice(price)).toBe('$150')
  })
})
