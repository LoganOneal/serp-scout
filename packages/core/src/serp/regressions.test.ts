import { describe, expect, it } from 'vitest'
import {
  detectRegressions,
  measurementCoverage,
  SLIP_THRESHOLD,
  type SerpCheckPoint,
} from './regressions.js'

const point = (over: Partial<SerpCheckPoint> = {}): SerpCheckPoint => ({
  checkedAt: '2026-08-04T00:00:00Z',
  serpPosition: 5,
  serpPackPosition: null,
  serpSourceKind: 'organic',
  serpMeasured: true,
  commentRank: 2,
  commentPresent: true,
  ourDomainPosition: 12,
  ...over,
})

/**
 * This module decides whether the operator gets woken up, so most of these tests assert
 * SILENCE. An alerting feature that cries wolf gets ignored, and then it costs you the one
 * real alert it existed for.
 */

describe('detectRegressions — the two things you asked for', () => {
  it('alerts when the thread stops ranking', () => {
    const r = detectRegressions({
      keyword: 'ac repair tucson',
      previous: point({ serpPosition: 4 }),
      latest: point({ serpPosition: null, serpPackPosition: null, serpSourceKind: null }),
    })
    const d = r.find((x) => x.kind === 'thread_deindexed')
    expect(d).toBeDefined()
    expect(d!.severity).toBe('high')
    expect(d!.message).toContain('#4')
    expect(d!.message).toContain('nowhere')
  })

  it('does NOT de-index when organic is gone but pack still has the thread', () => {
    const r = detectRegressions({
      keyword: 'ac repair tucson',
      previous: point({ serpPosition: 4, serpPackPosition: 2, serpSourceKind: 'both' }),
      latest: point({
        serpPosition: null,
        serpPackPosition: 1,
        serpSourceKind: 'discussions_and_forums',
      }),
    })
    expect(r.map((x) => x.kind)).not.toContain('thread_deindexed')
  })

  it('alerts when pack-only thread disappears from both surfaces', () => {
    const r = detectRegressions({
      keyword: 'electrician near me',
      previous: point({
        serpPosition: null,
        serpPackPosition: 2,
        serpSourceKind: 'discussions_and_forums',
      }),
      latest: point({ serpPosition: null, serpPackPosition: null, serpSourceKind: null }),
    })
    const d = r.find((x) => x.kind === 'thread_deindexed')
    expect(d).toBeDefined()
    expect(d!.message).toContain('Discussions #2')
  })

  it('alerts when our comment loses ordering', () => {
    const r = detectRegressions({
      keyword: 'ac repair tucson',
      previous: point({ commentRank: 2 }),
      latest: point({ commentRank: 6 }),
    })
    const d = r.find((x) => x.kind === 'comment_slipped')
    expect(d).toBeDefined()
    expect(d!.from).toBe(2)
    expect(d!.to).toBe(6)
  })

  it('alerts when our comment is confirmed gone', () => {
    const r = detectRegressions({
      keyword: 'k',
      previous: point({ commentPresent: true, commentRank: 3 }),
      latest: point({ commentPresent: false, commentRank: null }),
    })
    expect(r.map((x) => x.kind)).toContain('comment_removed')
    expect(r.find((x) => x.kind === 'comment_removed')!.severity).toBe('high')
  })
})

describe('detectRegressions — silence when we do not know', () => {
  it('does NOT alert when the comment check could not be measured', () => {
    // THE most important test here. commentPresent null = blocked or truncated. Alerting
    // would tell the operator their comment was deleted because Reddit rate-limited us.
    const r = detectRegressions({
      keyword: 'k',
      previous: point({ commentPresent: true, commentRank: 2 }),
      latest: point({ commentPresent: null, commentRank: null }),
    })
    expect(r.map((x) => x.kind)).not.toContain('comment_removed')
    expect(r.map((x) => x.kind)).not.toContain('comment_slipped')
  })

  it('does NOT alert when the previous comment state was unmeasured either', () => {
    const r = detectRegressions({
      keyword: 'k',
      previous: point({ commentPresent: null, commentRank: null }),
      latest: point({ commentPresent: false, commentRank: null }),
    })
    // Going from "unknown" to "absent" is not a transition we can attribute to anything.
    expect(r.map((x) => x.kind)).not.toContain('comment_removed')
  })

  it('does NOT read an unmeasured SERP as a de-index', () => {
    // serpMeasured false means the call never happened (budget cap, provider error).
    // serpPosition null then carries no information at all.
    const r = detectRegressions({
      keyword: 'k',
      previous: point({ serpPosition: 4, serpMeasured: true }),
      latest: point({ serpPosition: null, serpMeasured: false }),
    })
    expect(r.map((x) => x.kind)).not.toContain('thread_deindexed')
  })

  it('never alerts on a target with no history', () => {
    // Otherwise every newly added target alerts the instant it is created.
    expect(detectRegressions({ keyword: 'k', previous: null, latest: point() })).toEqual([])
    expect(
      detectRegressions({ keyword: 'k', previous: null, latest: point({ serpPosition: null }) }),
    ).toEqual([])
  })

  it('ignores SERP churn below the threshold', () => {
    const r = detectRegressions({
      keyword: 'k',
      previous: point({ serpPosition: 5 }),
      latest: point({ serpPosition: 5 + SLIP_THRESHOLD - 1 }),
    })
    expect(r.map((x) => x.kind)).not.toContain('thread_slipped')
  })

  it('alerts at exactly the threshold', () => {
    const r = detectRegressions({
      keyword: 'k',
      previous: point({ serpPosition: 5 }),
      latest: point({ serpPosition: 5 + SLIP_THRESHOLD }),
    })
    expect(r.map((x) => x.kind)).toContain('thread_slipped')
  })

  it('says nothing about improvements', () => {
    const r = detectRegressions({
      keyword: 'k',
      previous: point({ serpPosition: 20, commentRank: 8, ourDomainPosition: null }),
      latest: point({ serpPosition: 2, commentRank: 1, ourDomainPosition: 3 }),
    })
    expect(r).toEqual([])
  })

  it('alerts when our own site drops out, which is free from the same call', () => {
    const r = detectRegressions({
      keyword: 'k',
      previous: point({ ourDomainPosition: 8 }),
      latest: point({ ourDomainPosition: null }),
    })
    expect(r.map((x) => x.kind)).toContain('our_domain_lost')
  })

  it('can report several regressions from one check', () => {
    const r = detectRegressions({
      keyword: 'k',
      previous: point({ serpPosition: 3, commentRank: 1, commentPresent: true, ourDomainPosition: 9 }),
      latest: point({ serpPosition: null, commentRank: null, commentPresent: false, ourDomainPosition: null }),
    })
    expect(r.map((x) => x.kind).sort()).toEqual([
      'comment_removed',
      'our_domain_lost',
      'thread_deindexed',
    ])
  })
})

describe('measurementCoverage', () => {
  it('exposes how much of the history is actually measured', () => {
    // "rank 4" from a target whose last six checks were all blocked is a stale number
    // wearing a confident face -- same argument as weightCovered beside difficulty.
    const checks = [
      point({ commentPresent: true }),
      point({ commentPresent: null }),
      point({ commentPresent: null, serpMeasured: false }),
      point({ commentPresent: true }),
    ]
    const c = measurementCoverage(checks)
    expect(c.total).toBe(4)
    expect(c.commentMeasured).toBe(2)
    expect(c.serpMeasured).toBe(3)
    expect(c.commentCoverage).toBe(0.5)
  })

  it('is null, not zero, with no checks', () => {
    expect(measurementCoverage([]).commentCoverage).toBeNull()
  })
})
