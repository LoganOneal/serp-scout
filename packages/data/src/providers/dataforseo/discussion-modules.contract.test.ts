import { extractRedditHitsFromDfsResult, extractSerpLayoutMetrics } from '@rnr/core'
import { describe, expect, it } from 'vitest'
import { loadContract, resultOf } from './contracts.js'

/**
 * The discussion surface, against REAL captured payloads.
 *
 * ==================== WHY BOTH NAMES ARE IN THE CONTRACT ====================
 * The parser was written for `discussions_and_forums` only and went blind when
 * Google renamed the module to Perspectives. The obvious conclusion -- "the old
 * name is gone, match the new one" -- is WRONG, and these two fixtures are the
 * evidence. They come from the same sweep, the same market, minutes apart:
 *
 *   job 4492  "plumber"               desktop  -> perspectives
 *   job 4495  "plumber new york city" mobile   -> discussions_and_forums
 *
 * Both names are live simultaneously and which one arrives depends on the query
 * and device. Anything that handles one and not the other silently reports zero
 * Reddit on half the SERPs it sees, which is exactly the bug that prompted this.
 * ===========================================================================
 *
 * These payloads were bought once by a real run; the tests cost nothing to run
 * and nothing to keep. My earlier tests for this used a hand-written module,
 * which could only ever confirm the shape I already believed.
 */

function itemsOf(name: string): Array<Record<string, unknown>> {
  const result = resultOf<Array<{ items?: Array<Record<string, unknown>> }>>(
    loadContract(name).payload,
  )
  return result?.[0]?.items ?? []
}

const CASES = [
  { fixture: 'serp_perspectives_module', moduleType: 'perspectives' },
  { fixture: 'serp_discussions_and_forums_module', moduleType: 'discussions_and_forums' },
] as const

describe.each(CASES)('$moduleType (captured)', ({ fixture, moduleType }) => {
  const items = itemsOf(fixture)

  it('the capture really contains this module', () => {
    // Guards the rest of the block from passing vacuously if a re-capture
    // returns a SERP that happens to have no discussion surface at all.
    expect(items.some((i) => i['type'] === moduleType)).toBe(true)
  })

  it('is recognised as a discussion pack by the layout metrics', () => {
    const layout = extractSerpLayoutMetrics(items)
    expect(layout.discussionsPackPresent).toBe(true)
    expect(layout.forumsCount).toBeGreaterThan(0)
  })

  it('yields Reddit threads with a pack position and a parseable post id', () => {
    const hits = extractRedditHitsFromDfsResult({ items })
    const packHits = hits.filter((h) => h.sourceKind === 'discussions_and_forums')
    expect(packHits.length).toBeGreaterThan(0)

    for (const h of packHits) {
      expect(h.postId, `${h.url} produced an empty post id`).toMatch(/^[a-z0-9]+$/i)
      expect(h.domain).toMatch(/reddit\.com$/)
      expect(h.packPosition).toBeGreaterThanOrEqual(1)
      // Pack hits carry no organic rank -- the organic CTR curve must not be
      // applied to them as though they did.
      expect(h.organicPosition).toBeNull()
    }
  })

  it('counts pack positions consecutively from 1', () => {
    const packHits = extractRedditHitsFromDfsResult({ items })
      .filter((h) => h.sourceKind === 'discussions_and_forums')
      .map((h) => h.packPosition)
    expect(packHits).toEqual(packHits.map((_, i) => i + 1))
  })

  it('does not mistake the module for organic results', () => {
    const hits = extractRedditHitsFromDfsResult({ items })
    const organicRedditUrls = items
      .filter((i) => i['type'] === 'organic' && /reddit\.com/.test(String(i['url'] ?? '')))
      .length
    expect(hits.filter((h) => h.sourceKind === 'organic')).toHaveLength(organicRedditUrls)
  })
})

describe('the two module names are genuinely interchangeable to the parser', () => {
  it('finds Reddit under whichever name the SERP used', () => {
    for (const { fixture } of CASES) {
      const hits = extractRedditHitsFromDfsResult({ items: itemsOf(fixture) })
      expect(hits.length, `${fixture} yielded no hits`).toBeGreaterThan(0)
    }
  })

  it('reports the same source kind for both, so scoring cannot diverge', () => {
    // A second source kind would need its own weight in opportunity-score and
    // its own branch in the Reddit-volume estimate. They are the same surface.
    const kinds = new Set(
      CASES.flatMap(({ fixture }) =>
        extractRedditHitsFromDfsResult({ items: itemsOf(fixture) })
          .filter((h) => h.packPosition != null)
          .map((h) => h.sourceKind),
      ),
    )
    expect([...kinds]).toEqual(['discussions_and_forums'])
  })
})
