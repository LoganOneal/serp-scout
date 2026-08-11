import { describe, expect, it } from 'vitest'
import { findCommentOrdinal } from '@rnr/core'
import {
  FIXTURE_COMMENT_ID,
  fixtureRedditThread,
  REDDIT_BLOCK_PAGE,
} from '../providers/fixtures/reddit.js'

/**
 * The parser against the fixture generator, shape by shape.
 *
 * Three of the four shapes MUST yield `unknown`. If the fixture only ever produced clean
 * threads the parser would look correct while every dangerous path went untested -- and
 * since Reddit 403s server IPs, the offline path is currently the only one that runs.
 *
 * Lives in `data`, not `core`: the parser is pure but the fixture is a PROVIDER fixture, and
 * `core` must not import from `data` -- that boundary is what makes "scoring is pure"
 * compiler-enforced rather than a convention.
 */
describe('findCommentOrdinal against the reddit fixture', () => {
  it('finds our comment in a complete thread', () => {
    const html = fixtureRedditThread('https://old.reddit.com/comments/abc/', 'complete')
    const r = findCommentOrdinal(html, FIXTURE_COMMENT_ID)
    expect(r.status).toBe('found')
    if (r.status === 'found') {
      expect(r.rank).toBe(3)
      expect(r.total).toBeGreaterThan(3)
    }
  })

  it('returns UNKNOWN for a truncated thread when our comment is missing', () => {
    const html = fixtureRedditThread('https://old.reddit.com/comments/abc/', 'truncated')
    // Present in this shape, so it is found...
    expect(findCommentOrdinal(html, FIXTURE_COMMENT_ID).status).toBe('found')
    // ...but a DIFFERENT id must be inconclusive, not absent.
    const other = findCommentOrdinal(html, 'notinthere')
    expect(other.status).toBe('unknown')
    if (other.status === 'unknown') expect(other.reason).toContain('inconclusive')
  })

  it('returns UNKNOWN for the real block page', () => {
    expect(findCommentOrdinal(REDDIT_BLOCK_PAGE, FIXTURE_COMMENT_ID).status).toBe('unknown')
    expect(findCommentOrdinal(fixtureRedditThread('x', 'blocked'), FIXTURE_COMMENT_ID).status).toBe(
      'unknown',
    )
  })

  it('returns ABSENT only for a complete thread without our comment', () => {
    const html = fixtureRedditThread('https://old.reddit.com/comments/abc/', 'removed')
    const r = findCommentOrdinal(html, FIXTURE_COMMENT_ID)
    expect(r.status).toBe('absent')
  })

  it('is deterministic for a given url', () => {
    const a = fixtureRedditThread('https://old.reddit.com/comments/same/')
    const b = fixtureRedditThread('https://old.reddit.com/comments/same/')
    expect(a).toBe(b)
  })

  it('produces all four shapes across urls, so no path is unreachable', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 60; i++) {
      const html = fixtureRedditThread(`https://old.reddit.com/comments/x${i}/`)
      const r = findCommentOrdinal(html, FIXTURE_COMMENT_ID)
      seen.add(r.status === 'unknown' ? `unknown:${r.reason.includes('block') ? 'blocked' : 'truncated'}` : r.status)
    }
    // found / absent / unknown-blocked must all occur. (truncated-with-comment reads as found.)
    expect(seen).toContain('found')
    expect(seen).toContain('absent')
    expect(seen).toContain('unknown:blocked')
  })
})
