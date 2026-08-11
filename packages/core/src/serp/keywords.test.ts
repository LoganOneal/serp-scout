import { describe, expect, it } from 'vitest'
import { KeywordImportError, parseKeywordCsv, splitCsvLine } from './keywords.js'

/**
 * The failure this file is written against is not "the parser throws" -- it is a PARTIAL
 * import that looks complete. Monitoring 40 of 300 keywords while believing you cover all
 * of them is the same class of bug as the client-side locality cap the README documents:
 * the symptom is missing data, and missing data reads as absence rather than as a bug.
 *
 * So every case here checks that skipped rows are REPORTED, not merely absent.
 */

describe('splitCsvLine', () => {
  it('keeps a comma inside a quoted keyword in one field', () => {
    // Without this, volume lands in difficulty and every later column shifts by one --
    // silently, because the row count is still right.
    expect(splitCsvLine('"hvac repair, tucson",3,1200', ',')).toEqual([
      'hvac repair, tucson',
      '3',
      '1200',
    ])
  })

  it('handles escaped quotes and empty fields', () => {
    expect(splitCsvLine('"say ""hi""",,7', ',')).toEqual(['say "hi"', '', '7'])
  })
})

describe('parseKeywordCsv', () => {
  it('reads a Semrush UI export (human headers)', () => {
    const csv = [
      'Keyword,Position,Search Volume,Keyword Difficulty,CPC,URL',
      'ac repair tucson,4,2400,38,12.50,https://example.com/ac',
      'hvac tucson az,11,880,45,9.10,https://example.com/',
    ].join('\n')

    const r = parseKeywordCsv(csv)
    expect(r.rows).toHaveLength(2)
    expect(r.skipped).toHaveLength(0)
    expect(r.rows[0]).toEqual({
      keyword: 'ac repair tucson',
      position: 4,
      volume: 2400,
      difficulty: 38,
      cpcMicros: 12_500_000n,
      url: 'https://example.com/ac',
    })
    expect(r.columnsFound).toContain('volume')
  })

  it('reads an API-style export (two-letter codes)', () => {
    const csv = ['Ph;Po;Nq;Kd;Cp;Ur', 'furnace repair tucson;7;590;41;8,00;https://x.com/f'].join('\n')
    const r = parseKeywordCsv(csv)
    // Semicolon delimiter sniffed, not assumed.
    expect(r.delimiter).toBe(';')
    expect(r.rows[0]!.keyword).toBe('furnace repair tucson')
    expect(r.rows[0]!.position).toBe(7)
    expect(r.rows[0]!.volume).toBe(590)
  })

  it('survives a BOM, which Excel adds and which breaks naive header matching', () => {
    const csv = '﻿Keyword,Search Volume\nac repair,100'
    const r = parseKeywordCsv(csv)
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0]!.volume).toBe(100)
  })

  it('accepts any column order and ignores extra columns, naming them', () => {
    const csv = [
      'Traffic,URL,Keyword,Intent,Search Volume',
      '90,https://x.com/a,ac repair,commercial,1000',
    ].join('\n')
    const r = parseKeywordCsv(csv)
    expect(r.rows[0]!.keyword).toBe('ac repair')
    expect(r.rows[0]!.volume).toBe(1000)
    expect(r.rows[0]!.url).toBe('https://x.com/a')
    // Surfaced rather than swallowed, so a column you expected to be read is visible.
    expect(r.columnsIgnored).toContain('traffic')
    expect(r.columnsIgnored).toContain('intent')
  })

  it('leaves absent metrics NULL, never 0', () => {
    // Volume 0 would mean "nobody searches this"; the truth is "the export omitted it".
    const r = parseKeywordCsv('Keyword\nac repair tucson')
    expect(r.rows[0]).toEqual({
      keyword: 'ac repair tucson',
      position: null,
      volume: null,
      difficulty: null,
      cpcMicros: null,
      url: null,
    })
  })

  it('treats "n/a" and blanks as unknown rather than zero', () => {
    const csv = 'Keyword,Search Volume,Keyword Difficulty,CPC\nac repair,n/a,,-'
    const r = parseKeywordCsv(csv)
    expect(r.rows[0]!.volume).toBeNull()
    expect(r.rows[0]!.difficulty).toBeNull()
    expect(r.rows[0]!.cpcMicros).toBeNull()
  })

  it('rejects out-of-range values instead of storing nonsense', () => {
    const csv = 'Keyword,Position,Keyword Difficulty\nac repair,0,140'
    const r = parseKeywordCsv(csv)
    // Position 0 does not exist; difficulty is 0-100.
    expect(r.rows[0]!.position).toBeNull()
    expect(r.rows[0]!.difficulty).toBeNull()
  })

  it('REPORTS every skipped row with a line number and reason', () => {
    const csv = [
      'Keyword,Search Volume',
      'ac repair,100',
      ',500', // no keyword
      '', // blank -- not an error, just skipped
      'AC Repair,700', // duplicate, different case
      'furnace repair,200',
    ].join('\n')

    const r = parseKeywordCsv(csv)
    expect(r.rows.map((x) => x.keyword)).toEqual(['ac repair', 'furnace repair'])
    expect(r.skipped).toHaveLength(2)

    // Line numbers must match the file as you see it in a spreadsheet.
    expect(r.skipped[0]).toMatchObject({ line: 3 })
    expect(r.skipped[0]!.reason).toContain('No keyword')
    expect(r.skipped[1]).toMatchObject({ line: 5 })
    expect(r.skipped[1]!.reason).toContain('Duplicate')
  })

  it('dedupes case-insensitively, because monitoring a keyword twice doubles its cost', () => {
    const r = parseKeywordCsv('Keyword\nAC Repair\nac repair\nAC REPAIR')
    expect(r.rows).toHaveLength(1)
    expect(r.skipped).toHaveLength(2)
  })

  it('throws only for a wrong file, not for bad rows', () => {
    // A missing keyword column is a "you exported the wrong report" problem. Reporting it
    // per row would bury it under 300 identical messages.
    expect(() => parseKeywordCsv('Traffic,URL\n90,https://x.com')).toThrow(KeywordImportError)
    expect(() => parseKeywordCsv('Traffic,URL\n90,https://x.com')).toThrow(/No keyword column/)
    expect(() => parseKeywordCsv('')).toThrow(/empty/)
  })

  it('names the headers it saw when it cannot find a keyword column', () => {
    // So the error is actionable rather than "invalid file".
    try {
      parseKeywordCsv('Foo,Bar\n1,2')
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as Error).message).toContain('foo')
      expect((e as Error).message).toContain('bar')
    }
  })

  it('handles CRLF line endings', () => {
    const r = parseKeywordCsv('Keyword,Search Volume\r\nac repair,100\r\nfurnace,50\r\n')
    expect(r.rows).toHaveLength(2)
    expect(r.rows[1]!.keyword).toBe('furnace')
  })

  it('keeps CPC in integer micros, never a float', () => {
    const r = parseKeywordCsv('Keyword,CPC\nac repair,$12.34')
    expect(r.rows[0]!.cpcMicros).toBe(12_340_000n)
    expect(typeof r.rows[0]!.cpcMicros).toBe('bigint')
  })
})
