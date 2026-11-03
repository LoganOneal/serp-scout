import { describe, expect, it } from 'vitest'
import { chunkLeadRows, LEAD_CSV_COLUMNS, leadRowsToCsv, parseLeadCsv, sortLeadRows, type LeadRow } from './lead-csv.js'

const row = (domain: string, score: number, extra: Partial<LeadRow> = {}): LeadRow => ({
  domain,
  opportunityUrl: `https://${domain}/write-for-us`,
  allUrls: [`https://${domain}/write-for-us`, `https://${domain}/write-for-us`, `https://${domain}/contact`],
  sourceQuery: 'couples travel write for us',
  bucket: 'topic_wfu',
  leadType: 'guest_post',
  score,
  bestPosition: 4,
  queryHits: 2,
  batchId: 'b-01',
  ...extra,
})

describe('lead CSV contract', () => {
  it('writes the contract header and round-trips through the parser', () => {
    const csv = leadRowsToCsv([row('a.com', 81.234, { sourceQuery: 'travel, "guest" post' })])
    expect(csv.split('\n')[0]).toBe(LEAD_CSV_COLUMNS.join(','))
    const [parsed] = parseLeadCsv(csv)
    expect(parsed).toMatchObject({
      domain: 'a.com',
      source_query: 'travel, "guest" post',
      all_urls: 'https://a.com/write-for-us | https://a.com/contact',
      score: '81.2',
      lead_type: 'guest_post',
    })
  })

  it('sorts by score then domain and chunks into batches', () => {
    const sorted = sortLeadRows([row('b.com', 10), row('a.com', 10), row('c.com', 90)])
    expect(sorted.map((r) => r.domain)).toEqual(['c.com', 'a.com', 'b.com'])
    expect(chunkLeadRows(sorted, 2).map((chunk) => chunk.length)).toEqual([2, 1])
  })

  it('parses quoted multi-line cells and a BOM header', () => {
    const rows = parseLeadCsv('\uFEFFsite,notes\r\nx.com,"line one\nline two"\r\n\r\ny.com,ok\n')
    expect(rows).toEqual([
      { site: 'x.com', notes: 'line one\nline two' },
      { site: 'y.com', notes: 'ok' },
    ])
  })
})
