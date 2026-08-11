import { describe, expect, it } from 'vitest'
import {
  buildKeywordPlannerVerify,
  parseGeoCriteriaId,
  KEYWORD_PLANNER_HOME,
} from './keyword-planner-link.js'

describe('parseGeoCriteriaId', () => {
  it('parses geoTargetConstants labels', () => {
    expect(parseGeoCriteriaId('geoTargetConstants/1013462')).toBe(1013462)
    expect(parseGeoCriteriaId('geoTargetConstants/2840 (US national)')).toBe(2840)
  })
  it('returns null for empty', () => {
    expect(parseGeoCriteriaId(null)).toBeNull()
    expect(parseGeoCriteriaId('')).toBeNull()
  })
})

describe('buildKeywordPlannerVerify', () => {
  it('includes keyword and geo in href for our notes (Google may ignore)', () => {
    const v = buildKeywordPlannerVerify({
      keyword: 'hvac repair',
      volumeGeoTarget: 'geoTargetConstants/1013462',
    })
    expect(v.href.startsWith(KEYWORD_PLANNER_HOME)).toBe(true)
    expect(v.href).toContain('rnr_kw=hvac')
    expect(v.href).toContain('rnr_geo=1013462')
    expect(v.geoCriteriaId).toBe(1013462)
    expect(v.keyword).toBe('hvac repair')
    expect(v.howTo).toMatch(/Get search volume/)
  })
})
