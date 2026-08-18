import { describe, expect, it } from 'vitest'
import {
  aggregateCluster,
  clusterUsesSupply,
  inferClusterKind,
  supplyShortfall,
  type ClusterMember,
} from './cluster.js'

const m = (
  keywordNorm: string,
  volume: number | null,
  semrushKd: number | null = null,
  position: number | null = null,
  positionMeasured = false,
): ClusterMember => ({ keywordNorm, volume, semrushKd, position, positionMeasured })

describe('inferClusterKind', () => {
  it('reads the type prefix the researcher wrote', () => {
    expect(inferClusterKind('city_houston')).toBe('locality')
    expect(inferClusterKind('state_nj')).toBe('locality')
    expect(inferClusterKind('region_north_jersey')).toBe('locality')
    expect(inferClusterKind('chain_hilton')).toBe('brand')
    expect(inferClusterKind('head')).toBe('head')
    expect(inferClusterKind('head_near_me')).toBe('head')
    expect(inferClusterKind('vocab_bath')).toBe('vocab')
    expect(inferClusterKind('suites')).toBe('property_type')
    expect(inferClusterKind('romantic')).toBe('modifier')
  })

  /**
   * `data_anomaly` arrives as a cluster label in the real export. Imported as a
   * content cluster it would get a verdict and a place in the work queue.
   */
  it('quarantines data_anomaly rather than treating it as a page', () => {
    expect(inferClusterKind('data_anomaly')).toBe('quarantine')
  })

  it('falls back to the least-privileged kind, which claims no entity or supply', () => {
    expect(inferClusterKind('something_new')).toBe('modifier')
    expect(inferClusterKind('')).toBe('modifier')
    expect(clusterUsesSupply(inferClusterKind('something_new'))).toBe(false)
  })

  it('applies supply only to locality clusters', () => {
    expect(clusterUsesSupply('locality')).toBe(true)
    for (const k of ['brand', 'head', 'modifier', 'property_type', 'vocab', 'quarantine'] as const) {
      expect(clusterUsesSupply(k)).toBe(false)
    }
  })
})

describe('aggregateCluster — the volume bound', () => {
  /**
   * ==================== THE REGRESSION THIS FILE EXISTS FOR ====================
   * Four real keywords from the source export, all reporting 590 because Google
   * groups near-identical queries. Summed they claim 2,360 for ~590 of real
   * demand. `max` must be the ranking number.
   * ============================================================================
   */
  it('reports max as the lower bound and sum as the inflated upper bound', () => {
    const a = aggregateCluster([
      m('hot tub hotel rooms', 590),
      m('hot tub hotel rooms near me', 590),
      m('hotels near me with hot tubs', 590),
      m('hotels near me with hot tubs in room', 590),
    ])
    expect(a.volume.max).toBe(590)
    expect(a.volume.sum).toBe(2360)
    expect(a.volume.measuredMembers).toBe(4)
  })

  it('keeps both null when nothing was measured, rather than reporting zero', () => {
    const a = aggregateCluster([m('a', null), m('b', null)])
    expect(a.volume.max).toBeNull()
    expect(a.volume.sum).toBeNull()
    expect(a.volume.measuredMembers).toBe(0)
    expect(a.memberCount).toBe(2)
  })

  it('counts only measured members toward the bound', () => {
    const a = aggregateCluster([m('a', 100), m('b', null), m('c', 300)])
    expect(a.volume.max).toBe(300)
    expect(a.volume.sum).toBe(400)
    expect(a.volume.measuredMembers).toBe(2)
  })
})

describe('aggregateCluster — primary keyword', () => {
  /**
   * The shortest string looks like the head term and often is not: "hotels with
   * jacuzzi in room in" is longer than "hotels with jacuzzi in room" and reports
   * the identical volume.
   */
  it('picks the highest-volume member, not the shortest', () => {
    const a = aggregateCluster([
      m('a very long tail phrasing with many words', 5000),
      m('short one', 100),
    ])
    expect(a.primaryKeywordNorm).toBe('a very long tail phrasing with many words')
  })

  it('breaks a volume tie on the shorter string', () => {
    const a = aggregateCluster([
      m('hotels with jacuzzi in room in', 18100),
      m('hotels with jacuzzi in room', 18100),
    ])
    expect(a.primaryKeywordNorm).toBe('hotels with jacuzzi in room')
  })

  it('still names a primary when no member has a volume', () => {
    expect(aggregateCluster([m('only', null)]).primaryKeywordNorm).toBe('only')
  })
})

describe('aggregateCluster — difficulty and position', () => {
  it('reports kd min as the way in and median as the honest picture', () => {
    const a = aggregateCluster([
      m('a', 10, 13),
      m('b', 10, 20),
      m('c', 10, 44),
      m('d', 10, 60),
    ])
    expect(a.kdMin).toBe(13)
    expect(a.kdMedian).toBe(32)
  })

  it('takes the odd-count median exactly', () => {
    expect(aggregateCluster([m('a', 1, 9), m('b', 1, 23), m('c', 1, 40)]).kdMedian).toBe(23)
  })

  /** If any member ranks, the page ranks. */
  it('takes the best member position', () => {
    const a = aggregateCluster([m('a', 1, null, 14, true), m('b', 1, null, 4, true)])
    expect(a.bestPosition).toBe(4)
    expect(a.positionMeasured).toBe(true)
  })

  /**
   * All members checked and none ranked is MEASURED and absent — the state that
   * turns UNKNOWN into BUILD. It must not read as unmeasured.
   */
  it('is measured when members were checked and none ranked', () => {
    const a = aggregateCluster([m('a', 1, null, null, true), m('b', 1, null, null, true)])
    expect(a.bestPosition).toBeNull()
    expect(a.positionMeasured).toBe(true)
  })

  it('is unmeasured when nobody looked', () => {
    const a = aggregateCluster([m('a', 1, null, null, false)])
    expect(a.positionMeasured).toBe(false)
  })
})

describe('supplyShortfall', () => {
  /** Turns "supply gap" into "one more listing and this unlocks". */
  it('reports how many more listings a locality needs', () => {
    expect(supplyShortfall(7)).toEqual({ have: 7, needed: 0, credible: true })
    expect(supplyShortfall(4)).toEqual({ have: 4, needed: 1, credible: false })
    expect(supplyShortfall(0)).toEqual({ have: 0, needed: 5, credible: false })
  })

  it('never reports a negative shortfall', () => {
    expect(supplyShortfall(40).needed).toBe(0)
  })
})
