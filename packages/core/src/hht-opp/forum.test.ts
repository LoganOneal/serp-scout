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

  it('classifies a forum thread URL as forum_ugc', () => {
    const found = classifyOpportunityTypes({
      url: 'https://talk.example/forums/hotels-with-hot-tubs',
      title: 'Hotels with hot tubs',
      text: 'Post a reply. Start a new thread about jacuzzi suites.',
    })
    expect(found.some((row) => row.type === 'forum_ugc')).toBe(true)
  })

  it('fails forums that ban commercial posts and does not PASS from registration alone', () => {
    const silent = classifyForumUgcEligibility(
      'https://talk.example/forums',
      'Register to post. Post a reply. Community guidelines.',
    )
    expect(silent.eligibility).toBe('REVIEW')

    const banned = classifyForumUgcEligibility(
      'https://talk.example/forums',
      'No advertising. Promotional posts are not allowed.',
    )
    expect(banned.eligibility).toBe('FAIL')
  })
})
