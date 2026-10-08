import { describe, expect, it } from 'vitest'
import { judgePitchPages, pitchCallPresentation } from './pitch-call.js'

function page(url: string, text: string, hasContact = true) {
  return { url, status: 200, text, hasContact }
}

describe('judgePitchPages', () => {
  it('pursues an open write-for-us page', () => {
    const result = judgePitchPages('etravel.com', [
      page('https://www.etravel.com/explore/submit-a-travel-guest-post/', 'Submit a Travel Guest Post. Email the editor to pitch your story.'),
    ])
    expect(result.verdict).toBe('PURSUE')
  })

  it('skips a page that is closed to new writers', () => {
    const result = judgePitchPages('shebuystravel.com', [
      page('https://shebuystravel.com/about-us/work-with-us/', 'Write For SheBuysTravel We are currently closed to new writer applications. Please check back in fall 2026.'),
    ])
    expect(result.verdict).toBe('SKIP_CLOSED')
    expect(result.quote).toMatch(/currently closed/i)
  })

  it('does not treat a content ban list as a closed program', () => {
    const result = judgePitchPages('travelazz.com', [
      page('https://travelazz.com/write-for-us/', 'Submit Your Travel Story. We are not currently accepting: thin promotional content, casino, or crypto. Email editor@travelazz.com.'),
    ])
    expect(result.verdict).toBe('PURSUE')
  })

  it('skips a site that refuses guest posts', () => {
    const result = judgePitchPages('travelbabbo.com', [
      page('https://travelbabbo.com/guest-posts/', 'I do not accept guest posts or any outside content at all. Contact me another way.'),
    ])
    expect(result.verdict).toBe('SKIP_CLOSED')
  })

  it('skips a permanent contributor hire', () => {
    const result = judgePitchPages('worldofwanderlust.com', [
      page('https://www.worldofwanderlust.com/submissions/', 'We are committed to finding writers who can join our team of permanent contributors.'),
    ])
    expect(result.verdict).toBe('SKIP_STAFF_ROLE')
  })

  it('skips a hotel that has no guest-post page', () => {
    const result = judgePitchPages('leatherwoodmountains.com', [
      page('https://leatherwoodmountains.com/', 'Book your stay in our cabins. Check availability for nightly rates and view rooms.'),
    ])
    expect(result.verdict).toBe('SKIP_NOT_PUBLICATION')
  })

  it('does not pass a magazine that never invites a pitch', () => {
    const result = judgePitchPages('afar.com', [
      page('https://afar.com/', 'AFAR is a travel magazine. Latest stories from our editors. Contact the newsroom for press.'),
    ])
    expect(result.verdict).toBe('NEEDS_REVIEW')
  })

  it('skips a brand site with no contributor page', () => {
    const result = judgePitchPages('jacuzzi.com', [
      page('https://jacuzzi.com/', 'Jacuzzi hot tubs. Contact us to find a local dealer.'),
    ])
    expect(result.verdict).toBe('SKIP_NOT_PUBLICATION')
  })

  it('asks for review when the pitch page cannot be read', () => {
    const result = judgePitchPages('artoftravel.tips', [
      { url: 'https://artoftravel.tips/write-for-us', status: 202, text: '', hasContact: false },
    ])
    expect(result.verdict).toBe('NEEDS_REVIEW')
  })
})

describe('pitchCallPresentation', () => {
  it('labels a pass as Pursue and a skip as Dont pitch', () => {
    expect(pitchCallPresentation('PURSUE').label).toBe('Pursue')
    expect(pitchCallPresentation('PURSUE').tone).toBe('go')
    expect(pitchCallPresentation('SKIP_CLOSED').label).toBe("Don't pitch")
    expect(pitchCallPresentation('SKIP_CLOSED').tone).toBe('stop')
  })
})
