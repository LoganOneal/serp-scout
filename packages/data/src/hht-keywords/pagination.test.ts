import { describe, expect, it } from 'vitest'
import { HHT_GLOBAL_KEYWORD_PAGE_SIZE, resolveHhtKeywordPage } from './pagination.js'

describe('resolveHhtKeywordPage', () => {
  it('defaults to the first 100 globally ranked keywords', () => {
    expect(resolveHhtKeywordPage(undefined, 4_461)).toEqual({
      page: 1,
      pageSize: HHT_GLOBAL_KEYWORD_PAGE_SIZE,
      totalPages: 45,
      totalRows: 4_461,
      offset: 0,
    })
  })

  it('clamps invalid and out-of-range pages', () => {
    expect(resolveHhtKeywordPage(-4, 600)).toMatchObject({ page: 1, offset: 0 })
    expect(resolveHhtKeywordPage(99, 600)).toMatchObject({ page: 6, offset: 500 })
    expect(resolveHhtKeywordPage(Number.NaN, 0)).toMatchObject({
      page: 1,
      totalPages: 1,
      totalRows: 0,
    })
  })
})
