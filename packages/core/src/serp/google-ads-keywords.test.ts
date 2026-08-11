import { describe, expect, it } from 'vitest'
import {
  decodeGoogleAdsExportText,
  parseGoogleAdsSavedKeywordsStats,
} from './google-ads-keywords.js'

describe('parseGoogleAdsSavedKeywordsStats', () => {
  it('skips meta lines and parses TSV volumes', () => {
    const text = [
      'Saved keywords report',
      'Jan 1, 2025 - Jan 31, 2025',
      'Keyword\tAvg. monthly searches\tCompetition\tIn account',
      'hvac\t450000\tHigh\tYes',
      'hvac near me\t2400.0\tMedium\tNo',
      '',
      'plumber\t12000\tLow\tYes',
    ].join('\n')

    const r = parseGoogleAdsSavedKeywordsStats(text)
    expect(r.rows).toHaveLength(3)
    expect(r.titleRaw).toContain('Saved keywords')
    expect(r.dateRangeRaw).toContain('2025')
    expect(r.rows[0]!.keyword).toBe('hvac')
    expect(r.rows[0]!.variant).toBe('primary')
    expect(r.rows[0]!.avgMonthlySearches).toBe(450000)
    expect(r.rows[1]!.variant).toBe('near_me')
    expect(r.rows[1]!.seedKey).toBe('hvac')
    expect(r.rows[2]!.keyword).toBe('plumber')
  })

  it('decodes UTF-16 LE with BOM', () => {
    const plain =
      'Keyword\tAvg. monthly searches\n' + 'ac repair\t5000\n'
    const bom = Buffer.from([0xff, 0xfe])
    const body = Buffer.from(plain, 'utf16le')
    const bytes = Buffer.concat([bom, body])
    const decoded = decodeGoogleAdsExportText(bytes)
    expect(decoded).toContain('Keyword')
    const r = parseGoogleAdsSavedKeywordsStats(bytes)
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0]!.keyword).toBe('ac repair')
    expect(r.rows[0]!.avgMonthlySearches).toBe(5000)
  })

  it('skips empty keyword rows', () => {
    const text = 'Keyword\tAvg. monthly searches\n\t100\nok\t1\n'
    const r = parseGoogleAdsSavedKeywordsStats(text)
    expect(r.rows.map((x) => x.keyword)).toEqual(['ok'])
    expect(r.skipped.length).toBeGreaterThanOrEqual(1)
  })
})
