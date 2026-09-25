import { describe, expect, it } from 'vitest'
import { classifyOpportunityTypes } from './classify.js'
import {
  classifyForumUgcEligibility,
  detectForumSignals,
  isDofollowRel,
  summarizeUgcLinkPolicy,
} from './forum.js'

describe('forum and UGC link policy', () => {
  it('does not treat comments-welcome copy as dofollow', () => {
    const signals = detectForumSignals({
      url: 'https://forum.example/community',
      title: 'Travel community',
      text: 'Leave a comment. Join the discussion. Comments welcome.',
    })
    expect(signals.isForum).toBe(true)
    expect(signals.allowsUgc).toBe(true)
    expect(summarizeUgcLinkPolicy([]).linkType).toBe('unknown')
  })

  it('classifies dofollow only from measured rel attributes', () => {
    expect(isDofollowRel('')).toBe(true)
    expect(isDofollowRel(undefined)).toBe(true)
    expect(isDofollowRel('noopener')).toBe(true)
    expect(isDofollowRel('nofollow')).toBe(false)
    expect(isDofollowRel('ugc')).toBe(false)
    expect(isDofollowRel('nofollow ugc')).toBe(false)
    expect(isDofollowRel('sponsored')).toBe(false)

    const dofollow = summarizeUgcLinkPolicy([
      { url: 'https://hotels.example/guide', rel: '', dofollow: true },
      { url: 'https://maps.example/', rel: 'noopener', dofollow: true },
      { url: 'https://ads.example/', rel: 'nofollow', dofollow: false },
    ])
    expect(dofollow.linkType).toBe('ugc_dofollow')
    expect(dofollow.dofollowCount).toBe(2)
    expect(dofollow.confidence).toBe('HIGH')

    const nofollow = summarizeUgcLinkPolicy([
      { url: 'https://hotels.example/guide', rel: 'nofollow ugc', dofollow: false },
    ])
    expect(nofollow.linkType).toBe('ugc_nofollow')
  })

  it('treats official tourism community hosts as forums', () => {
    const signals = detectForumSignals({
      url: 'https://community.ireland.com/31830/hot-tubs-in-ireland',
      title: 'Ireland.com Community',
      text: 'Reply. Login / Register. Post Quoted Reply.',
    })
    expect(signals.isForum).toBe(true)
    expect(signals.allowsUgc).toBe(true)
    expect(detectForumSignals({
      url: 'https://boards.cruisecritic.com/',
      title: 'Cruise Critic Message Boards',
      text: 'Start a new thread.',
    }).isForum).toBe(true)
    expect(detectForumSignals({
      url: 'https://www.mumsnet.com/talk',
      title: 'Mumsnet Talk',
      text: 'Join the discussion.',
    }).isForum).toBe(true)
    expect(detectForumSignals({
      url: 'https://www.ukcampsite.co.uk/chatter/',
      title: 'Campsite chatter',
      text: 'Post a reply.',
    }).isForum).toBe(true)
  })

  it('classifies a forum thread URL as forum_ugc', () => {
    const found = classifyOpportunityTypes({
      url: 'https://talk.example/forums/hotels-with-hot-tubs',
      title: 'Hotels with hot tubs',
      text: 'Post a reply. Start a new thread about jacuzzi suites.',
    })
    expect(found.some((row) => row.type === 'forum_ugc')).toBe(true)
    expect(found.find((row) => row.type === 'forum_ugc')?.inventedType?.name).toMatch(/^Forum/)
  })

  it('keeps open-comment boards in REVIEW even when rules ban advertising', () => {
    const silent = classifyForumUgcEligibility(
      'https://talk.example/forums',
      'Register to post. Post a reply. Community guidelines.',
    )
    expect(silent.eligibility).toBe('REVIEW')

    const banned = classifyForumUgcEligibility(
      'https://talk.example/forums',
      'No advertising. Promotional posts are not allowed. Leave a comment.',
    )
    expect(banned.eligibility).toBe('REVIEW')
  })

  it('tags tour-operator pages with an open comment form as UGC', () => {
    const found = classifyOpportunityTypes({
      url: 'https://tours.example/uzbekistan-itinerary',
      title: 'Uzbekistan itinerary',
      text: 'Leave a comment. Comments are welcome.',
    })
    expect(found.some((row) => row.type === 'forum_ugc')).toBe(true)
  })
})
