import { describe, expect, it } from 'vitest'
import { mcpPayloadError, serpRowsFromMcpPayload } from './mcp.js'

describe('serpRowsFromMcpPayload', () => {
  it('parses MCP phrase_organic CSV including Keywords SERP Features', () => {
    const csv = [
      'Domain;Url;Keywords SERP Features',
      'bontraveler.com;https://www.bontraveler.com/best-hotels-california;Related searches',
      'tripadvisor.com;https://www.tripadvisor.com/Hotels;Reviews',
    ].join('\n')
    const rows = serpRowsFromMcpPayload(csv)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      position: 1,
      domain: 'bontraveler.com',
      url: 'https://www.bontraveler.com/best-hotels-california',
      features: 'Related searches',
    })
  })

  it('keeps explicit position columns from export_columns', () => {
    const csv = [
      'Position;Domain;Url;Triggered SERP Features',
      '3;example.com;https://example.com/page;People also ask',
    ].join('\n')
    expect(serpRowsFromMcpPayload(csv)[0]).toMatchObject({
      position: 3,
      domain: 'example.com',
      features: 'People also ask',
    })
  })

  it('detects Semrush ERROR payloads instead of treating them as empty SERPs', () => {
    expect(mcpPayloadError('ERROR 122 :: WRONG FORMAT OR EMPTY KEY')).toMatch(/ERROR 122/)
    expect(mcpPayloadError('get phrase_organic: ERROR 50 :: NOTHING FOUND\nNo data found')).toMatch(/ERROR 50/)
    expect(mcpPayloadError('Domain;Url\nexample.com;https://example.com')).toBeNull()
  })
})
