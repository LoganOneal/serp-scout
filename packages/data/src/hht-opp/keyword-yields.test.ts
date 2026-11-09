import { describe, expect, it } from 'vitest'
import { buildKeywordYields, type KeywordRow } from './keyword-yields.js'

const kw = (id: number, keyword: string, status = 'FETCHED', fetched = true): KeywordRow => ({
  id, keyword, normalizedKeyword: keyword, status, bucket: null, resultsSeen: 90, newDomains: 10,
  fetchedAt: fetched ? new Date('2026-11-08T00:00:00Z') : null,
})

describe('buildKeywordYields', () => {
  it('counts PURSUE per source query and marks it final once leads are evaluated', () => {
    const rows = buildKeywordYields({
      keywords: [kw(1, 'things to do in reno')],
      tracker: [
        { domain: 'a.com', verdict: 'PURSUE', sourceQuery: 'things to do in reno', draftId: 'e1' },
        { domain: 'b.com', verdict: 'SKIP', sourceQuery: 'things to do in reno', draftId: '' },
      ],
      handoff: [
        { domain: 'a.com', sourceQuery: 'things to do in reno', leadType: 'guest_post' },
        { domain: 'b.com', sourceQuery: 'things to do in reno', leadType: 'guest_post' },
      ],
    })
    expect(rows[0]).toMatchObject({ pitchable_opportunities: 1, drafts_created: 1, evaluated_domains: 2, skipped: 1 })
    expect(String(rows[0]!.evaluation_coverage)).toMatch(/^final/)
  })

  it('stays unknown while most exported leads are unevaluated, and falls back to the export query', () => {
    const rows = buildKeywordYields({
      keywords: [kw(2, 'reno itinerary')],
      tracker: [{ domain: 'a.com', verdict: 'PURSUE', sourceQuery: '', draftId: '' }],
      handoff: ['a.com', 'b.com', 'c.com'].map((domain) => ({ domain, sourceQuery: 'reno itinerary', leadType: 'guest_post' })),
    })
    expect(rows[0]!.pitchable_opportunities).toBe(1)
    expect(String(rows[0]!.evaluation_coverage)).toMatch(/^unknown: 1 of 3/)
  })

  it('treats NO_DATA as a final zero, carries forward old finals, ignores link insertion', () => {
    const rows = buildKeywordYields({
      keywords: [kw(3, 'zero kw', 'NO_DATA'), kw(4, 'old kw'), kw(5, 'pending kw')],
      tracker: [],
      handoff: [{ domain: 'x.com', sourceQuery: 'pending kw', leadType: 'link_insertion' }],
      previous: new Map([[4, { pitchable_opportunities: '3', evaluation_coverage: 'Final tracker evaluations recorded' }]]),
    })
    const byId = new Map(rows.map((row) => [row.keyword_id, row]))
    expect(String(byId.get(3)!.evaluation_coverage)).toMatch(/^final: fetch found no new domains/)
    expect(byId.get(4)).toMatchObject({ pitchable_opportunities: 3 })
    expect(String(byId.get(5)!.evaluation_coverage)).toMatch(/^unknown/)
  })
})
