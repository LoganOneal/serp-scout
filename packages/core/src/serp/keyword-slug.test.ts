import { describe, expect, it } from 'vitest'
import { keywordPathFor, keywordSlug, marketSlug, matchesKeywordPath } from './keyword-slug.js'

const c = (keyword: string, market: string | null, stateAbbr: string | null = null) => ({
  keyword,
  market,
  stateAbbr,
})

describe('keywordSlug', () => {
  it('makes a readable, path-safe slug', () => {
    expect(keywordSlug('best roofing san jose')).toBe('best-roofing-san-jose')
    expect(keywordSlug('  Roofing   Repair  ')).toBe('roofing-repair')
    expect(keywordSlug('24/7 plumber')).toBe('24-7-plumber')
  })

  it('folds diacritics rather than dropping the word', () => {
    // "café" and "cafe" must not become two different pages.
    expect(keywordSlug('café repair')).toBe('cafe-repair')
  })
})

describe('resolving a slug inside a run', () => {
  const runRows = [
    c('roofing', 'Houston', 'TX'),
    c('roofing', 'San Jose', 'CA'),
    c('best roofing san jose', 'San Jose', 'CA'),
  ]

  it('uses the short path when the keyword is unique in the run', () => {
    expect(keywordPathFor(runRows[2]!, runRows)).toBe('best-roofing-san-jose')
  })

  it('qualifies by market when the same keyword was measured twice', () => {
    // A catalog sweep measures one keyword across many markets, so the short
    // form genuinely cannot address a single measurement.
    expect(keywordPathFor(runRows[0]!, runRows)).toBe('houston-tx/roofing')
    expect(keywordPathFor(runRows[1]!, runRows)).toBe('san-jose-ca/roofing')
  })

  it('matches both the short and the market-qualified path', () => {
    expect(matchesKeywordPath(runRows[2]!, ['best-roofing-san-jose'])).toBe(true)
    expect(matchesKeywordPath(runRows[0]!, ['houston-tx', 'roofing'])).toBe(true)
    expect(matchesKeywordPath(runRows[1]!, ['houston-tx', 'roofing'])).toBe(false)
  })

  it('does not match a different keyword that merely starts the same', () => {
    expect(matchesKeywordPath(c('roofing', 'X'), ['roofing-repair'])).toBe(false)
  })

  it('returns false for an empty path rather than matching everything', () => {
    expect(matchesKeywordPath(runRows[0]!, [])).toBe(false)
  })

  it('marketSlug includes the state so two same-named cities differ', () => {
    expect(marketSlug('Springfield', 'IL')).toBe('springfield-il')
    expect(marketSlug('Springfield', 'MO')).toBe('springfield-mo')
  })
})
