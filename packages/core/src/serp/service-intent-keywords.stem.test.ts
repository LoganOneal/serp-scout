import { describe, expect, it } from 'vitest'
import { expandServiceIntentKeywords } from './service-intent-keywords.js'

describe('service-intent expansion never emits a bare stem', () => {
  const cases = [
    { slug: 'foundation-repair', keywordNoun: 'foundation repair', stem: 'foundation' },
    { slug: 'concrete-contractor', keywordNoun: 'concrete contractor', stem: 'concrete' },
    { slug: 'tree-service', keywordNoun: 'tree service', stem: 'tree' },
    { slug: 'carpet-cleaning', keywordNoun: 'carpet cleaning', stem: 'carpet' },
    { slug: 'pest-control', keywordNoun: 'pest control', stem: 'pest' },
    { slug: 'solar-installation', keywordNoun: 'solar installers', stem: 'solar' },
  ]

  for (const c of cases) {
    it(`"${c.keywordNoun}" does not expand to "${c.stem}"`, () => {
      // "foundation" is makeup and nonprofits. It carried 2,900 searches/mo in
      // Seattle and 73% of that niche's apparent local demand.
      const out = expandServiceIntentKeywords({ slug: c.slug, label: c.slug, keywordNoun: c.keywordNoun })
      expect(out).not.toContain(c.stem)
    })
  }

  it('still keeps the stem-derived phrasings that carry intent', () => {
    const out = expandServiceIntentKeywords({
      slug: 'foundation-repair',
      label: 'foundation-repair',
      keywordNoun: 'foundation repair',
    })
    expect(out).toContain('foundation repair')
    expect(out.some((k) => k.startsWith('foundation ') && k !== 'foundation')).toBe(true)
  })

  it('leaves a noun that is ALREADY the query alone', () => {
    // "plumber" is not repairish, so nothing is stripped and the bare noun is
    // exactly what a searcher types.
    const out = expandServiceIntentKeywords({ slug: 'plumber', label: 'plumber', keywordNoun: 'plumber' })
    expect(out).toContain('plumber')
  })
})
