import { describe, expect, it } from 'vitest'
import { hashReviewSnapshot } from './review.js'

describe('hashReviewSnapshot', () => {
  it('is stable when object key order changes', () => {
    const left = { outreach: { subject: 'Hello', body: 'Pitch' }, domain: 'example.com' }
    const right = { domain: 'example.com', outreach: { body: 'Pitch', subject: 'Hello' } }
    expect(hashReviewSnapshot(left)).toBe(hashReviewSnapshot(right))
  })

  it('changes when approved copy changes', () => {
    const approved = { outreach: { subject: 'Hello', body: 'Pitch', sequence: [] } }
    const edited = { outreach: { subject: 'Hello', body: 'Updated pitch', sequence: [] } }
    expect(hashReviewSnapshot(approved)).not.toBe(hashReviewSnapshot(edited))
  })

  it('changes when research or contact data changes', () => {
    const approved = {
      hht: { targetHhtUrl: 'https://www.hotelhottubs.com/chicago/' },
      contact: { email: 'editor@example.com' },
    }
    const changed = {
      hht: { targetHhtUrl: 'https://www.hotelhottubs.com/illinois/' },
      contact: { email: 'editor@example.com' },
    }
    expect(hashReviewSnapshot(approved)).not.toBe(hashReviewSnapshot(changed))
  })
})
