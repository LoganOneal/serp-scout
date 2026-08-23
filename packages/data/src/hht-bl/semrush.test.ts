import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  applyHhtSemrushRequestFilters,
  classifySemrushError,
  HHT_SEMRUSH_FOLLOW_FILTER,
  hhtSemrushRequestParams,
  isHhtSemrushPaginatedReport,
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

  it('recovers malformed triple quotes observed in Semrush anchor text', () => {
    const [row] = parseSemrushRows(
      'source_url;anchor;nofollow\nhttps://example.com;""" "dropped-pin" => """ Visit website;false',
    )
    expect(row).toEqual({
      source_url: 'https://example.com',
      anchor: '””” ”dropped-pin” => ””” Visit website',
      nofollow: 'false',
    })
  })

  it('repairs raw semicolons in detailed backlink anchors from the fixed trailing fields', () => {
    const [row] = parseSemrushRows(
      'page_ascore;page_score;response_code;source_url;source_title;target_url;target_title;anchor;first_seen;last_seen;nofollow;sitewide;newlink;lostlink\n' +
        '22;22;200;https://source.example/;Source;https://target.example/;;target.example ; Opens a new tab;1700000000;1700000001;false;false;false;false',
    )
    expect(row?.['anchor']).toBe('target.example ; Opens a new tab')
    expect(row?.['first_seen']).toBe('1700000000')
    expect(row?.['nofollow']).toBe('false')
  })

  it('treats the provider no-data sentinel as a valid empty report', () => {
    expect(
      parseSemrushRows(
        'get backlinks_competitors: ERROR 50 :: NOTHING FOUND\nNo data found for this request.\nnot found',
      ),
    ).toEqual([])
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

  it('omits pagination fields from the batched backlink comparison contract', () => {
    const params = {
      targets: ['one.example', 'two.example'],
      target_types: ['root_domain', 'root_domain'],
      export_columns: ['target', 'authority_score'],
    }
    expect(hhtSemrushRequestParams('backlinks_comparison', params, { offset: 0, limit: 2 })).toEqual(
      params,
    )
    expect(isHhtSemrushPaginatedReport('backlinks_comparison')).toBe(false)
  })

  it('adds the saved page checkpoint to paginated backlink requests', () => {
    expect(
      hhtSemrushRequestParams('backlinks', { target: 'x.com' }, { offset: 50, limit: 25 }),
    ).toMatchObject({
      target: 'x.com',
      display_offset: 50,
      display_limit: 25,
      display_filter: [HHT_SEMRUSH_FOLLOW_FILTER],
    })
    expect(isHhtSemrushPaginatedReport('backlinks')).toBe(true)
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
    expect(
      classifySemrushError(
        new Error('The user does not have enough API units to complete this request.'),
      ),
    ).toBe('WAITING_FOR_CREDENTIALS')
    expect(classifySemrushError(new Error('ERROR 132: API units balance is zero'))).toBe(
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
