import { describe, expect, it } from 'vitest'
import { writeGuestPitch } from './guest-pitch.js'

describe('guest pitch', () => {
  it('writes a family list when the guidelines are for parents', () => {
    const pitch = writeGuestPitch({
      domain: 'familyroad.com',
      publicationName: 'Family Road',
      pitchUrl: 'https://familyroad.com/write-for-us',
      guidelineText: 'Family travel for parents traveling with kids. Write for us. 800-1200 words. Original only.',
    })
    expect(pitch.angle).toContain('Family Road')
    expect(pitch.angle).toContain('family weekend')
    expect(pitch.angle).toContain('800–1,200-word')
    expect(pitch.body).toContain('Original work')
    expect(pitch.body).toContain('Word count: 800-1200 words')
    expect(pitch.body).not.toMatch(/I (?:stayed|visited|slept) at/i)
  })

  it('complements a company blog and names a restricted place', () => {
    const pitch = writeGuestPitch({
      domain: 'chaacreek.com',
      publicationName: 'Chaa Creek',
      pitchUrl: 'https://belize-travel-blog.chaacreek.com/write-for-us',
      guidelineText: 'Our lodge offers stays in the jungle. We only publish articles about Belize. Guest posts welcome.',
    })
    expect(pitch.angle).toContain('complements')
    expect(pitch.angle).toContain('Belize')
    expect(pitch.angle).toContain('U.S.')
    expect(pitch.subject).toContain('Belize')
  })

  it('uses a first-person data finding for a narrative blog without claiming a stay', () => {
    const pitch = writeGuestPitch({
      domain: 'paulinaontheroad.com',
      publicationName: 'Paulina on the Road',
      pitchUrl: 'https://paulinaontheroad.com/guest-posts',
      guidelineText: 'Please send first-person stories. Submit your guest post.',
    })
    expect(pitch.angle).toContain('first-person')
    expect(pitch.angle).toContain('dataset')
    expect(pitch.body).not.toMatch(/I (?:stayed|visited|slept) at/i)
  })

  it('slices a U.S. state when the call is limited to that state', () => {
    const pitch = writeGuestPitch({
      domain: 'smalltownwashington.com',
      publicationName: 'Small Town Washington',
      pitchUrl: 'https://smalltownwashington.com/write-for-us',
      guidelineText: 'We only accept posts about Washington. Write for us.',
    })
    expect(pitch.angle).toContain('Washington slice')
    expect(pitch.angle).not.toContain('inventory we can actually verify')
  })

  it('keeps two publications from sharing the same pitch', () => {
    const a = writeGuestPitch({
      domain: 'bootsnall.com',
      publicationName: 'BootsnAll',
      pitchUrl: 'https://bootsnall.com/writers',
      guidelineText: 'How to pitch and submit an article. 900 words.',
    })
    const b = writeGuestPitch({
      domain: 'etravel.com',
      publicationName: 'eTravel',
      pitchUrl: 'https://etravel.com/write-for-us',
      guidelineText: 'Write for us. 1500 words.',
    })
    expect(a.angle).not.toBe(b.angle)
    expect(a.subject).toContain('BootsnAll')
    expect(b.angle).toContain('1,500-word')
  })

  it('ignores a scraped word count of zero', () => {
    const pitch = writeGuestPitch({
      domain: 'practicalwanderlust.com',
      publicationName: 'Practical Wanderlust',
      pitchUrl: 'https://practicalwanderlust.com/write-for-us',
      guidelineText: 'Family travel for parents. Write for us. Word count: 000 words.',
    })
    expect(pitch.angle).not.toContain('0-word')
    expect(pitch.body).not.toContain('000 words')
  })
})
