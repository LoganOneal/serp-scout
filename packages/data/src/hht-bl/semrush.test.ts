import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  applyHhtSemrushRequestFilters,
  classifySemrushError,
  HHT_SEMRUSH_FOLLOW_FILTER,
  nextSemrushPage,
  parseHhtSemrushEnvelope,
  parseSemrushRows,
  semrushBoolean,
  semrushRequestKey,
  semrushTimestamp,
} from './semrush.js'

const fixtures = JSON.parse(
  readFileSync(new URL('./__fixtures__/semrush-canaries.json', import.meta.url), 'utf8'),
) as Array<{ key: string; body: string; params: Record<string, unknown>; report: string }>

describe('Semrush MCP response contracts', () => {
  it('parses the observed backlink matrix without guessing dynamic target columns', () => {
    const fixture = fixtures.find((row) => row.key === 'backlink_matrix')!
    expect(parseSemrushRows(fixture.body)).toEqual([
      {
        domain: 'yahoo.com',
        domain_ascore: '100',
        domain_score: '100',
        matches_num: '2',
        hotelhottubs_com: '1',
        tubhotels_com: '93',
      },
    ])
  })

  it('preserves the observed follow flag and epoch timestamps', () => {
    const fixture = fixtures.find((row) => row.key === 'detailed_backlink')!
    const [row] = parseSemrushRows(fixture.body)
    expect(semrushBoolean(row?.['nofollow'])).toBe(false)
    expect(semrushTimestamp(row?.['first_seen'])?.getUTCFullYear()).toBeGreaterThanOrEqual(2026)
  })

  it('tolerates unescaped quotes observed in Semrush page titles', () => {
    expect(
      parseSemrushRows('source_url;source_title\nhttps://example.com;Rob+" Adventures'),
    ).toEqual([{ source_url: 'https://example.com', source_title: 'Rob+" Adventures' }])
  })

  it('builds idempotency keys independent of object key order', () => {
    expect(semrushRequestKey('backlinks', { target: 'x.com', display_limit: 10 })).toBe(
      semrushRequestKey('backlinks', { display_limit: 10, target: 'x.com' }),
    )
  })

  it('adds the provider follow filter to detailed backlink requests', () => {
    expect(
      applyHhtSemrushRequestFilters('backlinks', {
        target: 'x.com',
        display_filter: [
          { field: 'type', operation: '', sign: '+', value: 'nofollow' },
          { field: 'anchor', operation: 'contains', sign: '+', value: 'hotel' },
        ],
      }),
    ).toEqual({
      target: 'x.com',
      display_filter: [
        { field: 'anchor', operation: 'contains', sign: '+', value: 'hotel' },
        HHT_SEMRUSH_FOLLOW_FILTER,
      ],
    })
  })

  it('does not add backlink-only filters to other Semrush reports', () => {
    expect(applyHhtSemrushRequestFilters('backlinks_refdomains', { target: 'x.com' })).toEqual({
      target: 'x.com',
    })
  })

  it('rejects unsupported reports before durable import', () => {
    expect(() =>
      parseHhtSemrushEnvelope({ report: 'made_up_report', params: {}, body: 'x;y' }),
    ).toThrow(/unsupported report/)
    expect(() =>
      parseHhtSemrushEnvelope({ report: 'backlinks', params: [], body: 'x;y' }),
    ).toThrow(/params must be an object/)
  })

  it('distinguishes credential exhaustion from retryable failures', () => {
    expect(classifySemrushError(new Error('Insufficient credits remaining'))).toBe(
      'WAITING_FOR_CREDENTIALS',
    )
    expect(classifySemrushError(new Error('429 rate limit'))).toBe('RETRYABLE')
    expect(classifySemrushError(new Error('malformed response'))).toBe('FAILED')
  })

  it('advances pagination only after a full page', () => {
    expect(nextSemrushPage({ offset: 20, limit: 10, rowsReceived: 10 })).toEqual({
      complete: false,
      offset: 30,
    })
    expect(nextSemrushPage({ offset: 20, limit: 10, rowsReceived: 4 })).toEqual({ complete: true })
    expect(
      nextSemrushPage({
        offset: 20,
        limit: 10,
        rowsReceived: 10,
        totalRowsReceived: 40,
        maxRows: 50,
      }),
    ).toEqual({ complete: true })
  })
})
