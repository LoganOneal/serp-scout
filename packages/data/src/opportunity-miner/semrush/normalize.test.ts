import { describe, expect, it } from 'vitest'
import { normalizeRows, parseIntent, parseSemrushCsv } from './normalize.js'

describe('Semrush normalizer', () => {
  it('parses classic semicolon CSV and friendly MCP rows the same way', () => {
    const csv = parseSemrushCsv('Ph;Nq;Cp;Co;Kd\nroofing estimating software;2400;7.41;0.68;34')
    const mcp = normalizeRows([{ keyword: 'roofing estimating software', volume: 2400, cpc: 7.41, competitive_density: 0.68, keyword_difficulty: 34 }])
    expect(csv[0]?.keyword).toBe('roofing estimating software')
    expect(csv[0]?.volume).toBe(2400)
    expect(mcp[0]?.cpc).toBe(7.41)
    expect(parseIntent('commercial,transactional')).toBe('transactional')
  })

  it('returns empty on Semrush ERROR payloads instead of inventing rows', () => {
    expect(parseSemrushCsv('ERROR 50 :: NOTHING FOUND')).toEqual([])
  })
})
