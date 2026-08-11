import { describe, expect, it } from 'vitest'
import { extractRedditHitsFromDfsResult } from './discovery.js'
import { countForumElements, extractSerpLayoutMetrics } from './serp-layout.js'

/**
 * Verbatim shape from `discovery_jobs.raw_items` for job 3329 — "plumber" at
 * location_code 1023191 (New York City), measured 2026-08-06. That row reported
 * reddit_hit_count = 0 with this Reddit thread sitting in the payload, which is
 * the bug these tests exist to hold shut.
 */
const PERSPECTIVES_PACK = {
  type: 'perspectives',
  rank_group: 1,
  rank_absolute: 11,
  items: [
    {
      type: 'perspectives_element',
      url: 'https://www.facebook.com/groups/hellospringfieldmo/posts/1376879203964390/',
      title: 'Looking for a plumber to do a rough in on a kitchen sink',
      domain: 'www.facebook.com',
      source: 'Springfield, MO',
    },
    {
      type: 'perspectives_element',
      url: 'https://www.instagram.com/reel/Dbrs26HjXFo/',
      title: 'Smart Plumber Trick To Join 3 PVC Pipe',
      domain: 'www.instagram.com',
      source: 'kamal_farid96',
    },
    {
      type: 'perspectives_element',
      url: 'https://www.reddit.com/r/AusRenovation/comments/1vgyz7q/look_what_my_plumber_did/',
      title: 'Look what my plumber did',
      domain: 'www.reddit.com',
      source: 'r/AusRenovation',
    },
  ],
}

const ORGANIC = {
  type: 'organic',
  rank_group: 1,
  rank_absolute: 12,
  url: 'https://www.craigslist.org/',
  domain: 'www.craigslist.org',
}

describe('perspectives module is the discussions pack', () => {
  it('extracts a Reddit thread Google now files under "perspectives"', () => {
    const hits = extractRedditHitsFromDfsResult({ items: [ORGANIC, PERSPECTIVES_PACK] })

    expect(hits).toHaveLength(1)
    expect(hits[0]?.postId).toBe('1vgyz7q')
    expect(hits[0]?.subreddit).toBe('AusRenovation')
    // Same surface as the old module, so the same source kind — scoring already
    // knows how to weigh a pack placement against an organic one.
    expect(hits[0]?.sourceKind).toBe('discussions_and_forums')
    expect(hits[0]?.packPosition).toBe(1)
  })

  it('numbers pack position by Reddit ordinal, not by element index', () => {
    // Facebook and Instagram sit above the Reddit thread in this payload. Pack
    // position counts Reddit threads, so a caller reading position 1 is not
    // told this thread outranks results the parser never returned.
    const hits = extractRedditHitsFromDfsResult({ items: [PERSPECTIVES_PACK] })
    expect(hits[0]?.packPosition).toBe(1)
  })

  it('still reads the legacy discussions_and_forums name', () => {
    const legacy = {
      ...PERSPECTIVES_PACK,
      type: 'discussions_and_forums',
      items: PERSPECTIVES_PACK.items.map((i) => ({
        ...i,
        type: 'discussions_and_forums_element',
      })),
    }
    const hits = extractRedditHitsFromDfsResult({ items: [legacy] })
    expect(hits.map((h) => h.postId)).toEqual(['1vgyz7q'])
  })

  it('counts every perspectives element as a forum thread, not just Reddit ones', () => {
    // forumsCount measures how much of page 1 the discussion surface occupies,
    // which is a layout fact independent of who posted.
    expect(countForumElements(PERSPECTIVES_PACK)).toBe(3)
  })

  it('reports the pack as present in layout metrics', () => {
    const layout = extractSerpLayoutMetrics([ORGANIC, PERSPECTIVES_PACK])
    expect(layout.discussionsPackPresent).toBe(true)
    expect(layout.forumsCount).toBe(3)
    expect(layout.forumsRankAbsolute).toBe(11)
  })

  it('does not treat an unrelated module as a discussion surface', () => {
    // product_considerations also cites Reddit, but it is a shopping widget, not
    // a thread listing — counting it as a forum would overstate the surface.
    const shopping = {
      type: 'product_considerations',
      rank_absolute: 4,
      items: [
        {
          type: 'product_considerations_element',
          url: 'https://www.reddit.com/r/Plumbing/comments/abc123/what_to_look_for/',
          domain: 'www.reddit.com',
        },
      ],
    }
    expect(countForumElements(shopping)).toBe(0)
    expect(extractSerpLayoutMetrics([shopping]).discussionsPackPresent).toBe(false)
  })
})
