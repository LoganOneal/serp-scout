import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Architectural guard: every flag that changes the JOB COUNT must reach the
 * enqueue, not just the estimate.
 *
 * ==================== WHY THIS TEST EXISTS ====================
 * `includeGeoExplicit` was wired into `variantsPerKw`, which is what the dry
 * run reports, but was left off the `enqueueDiscoveryRun` call in the bulk
 * path. The preview promised 4 SERPs, the run built 2, and the run row said
 * the feature was off. Nothing failed: no exception, no warning, and the only
 * way to notice was to start a real sweep and count the jobs.
 *
 * That is the shape of the bug worth asserting -- the estimate and the
 * fan-out are computed in different places from the same flags, and they
 * drift silently. `includeNearMe` is checked alongside it because it is the
 * same kind of flag and would fail the same way.
 * =============================================================
 */

const FILE = fileURLToPath(new URL('./catalog-research.ts', import.meta.url))

/** Flags that multiply `variantsPerKw` and therefore the bill. */
const COUNT_CHANGING_FLAGS = ['includeNearMe', 'includeGeoExplicit']

/**
 * Argument object of each `enqueueDiscoveryRun(db, { ... })` call, matched by
 * brace depth so a nested object cannot end the slice early.
 */
function enqueueCallArgs(src: string): string[] {
  const out: string[] = []
  const needle = 'enqueueDiscoveryRun(db, {'
  let from = 0
  for (;;) {
    const start = src.indexOf(needle, from)
    if (start === -1) break
    let depth = 0
    let i = start + needle.length - 1
    for (; i < src.length; i++) {
      if (src[i] === '{') depth += 1
      else if (src[i] === '}') {
        depth -= 1
        if (depth === 0) break
      }
    }
    out.push(src.slice(start, i + 1))
    from = i + 1
  }
  return out
}

describe('enqueue receives every count-changing flag', () => {
  const src = readFileSync(FILE, 'utf8')
  const calls = enqueueCallArgs(src)

  it('finds the enqueue call sites at all', () => {
    // If this drops to zero the test below passes vacuously, which would be
    // worse than the bug it guards.
    expect(calls.length).toBeGreaterThanOrEqual(2)
  })

  for (const flag of COUNT_CHANGING_FLAGS) {
    it(`passes ${flag} at every enqueueDiscoveryRun call site`, () => {
      const missing = calls
        .map((c, i) => ({ i, has: new RegExp(`\\b${flag}\\b`).test(c) }))
        .filter((r) => !r.has)
        .map((r) => r.i)

      expect(
        missing,
        `enqueueDiscoveryRun call #${missing.join(', #')} in catalog-research.ts does not pass ` +
          `${flag}. The dry run counts it, so the preview will promise SERPs the run never buys.`,
      ).toEqual([])
    })
  }

  it('keeps the variant multiplier in step with the flag list', () => {
    // variantsPerKw is the estimate side of the same pair. If a flag is added
    // to the enqueue but not here, the preview undercounts instead.
    for (const flag of COUNT_CHANGING_FLAGS) {
      expect(src).toMatch(new RegExp(`variantsPerKw = [^\\n]*${flag}`))
    }
  })
})
