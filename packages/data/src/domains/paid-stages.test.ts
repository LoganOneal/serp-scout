import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Architectural guard: every declared paid stage is actually read.
 *
 * ==================== WHY THIS TEST EXISTS ====================
 * `checkAuthority` sat in PaidOptions, fully typed and documented, and nothing
 * ever read it. `auditAuthorityLinks` was exported from the package index and
 * called from nowhere. The result was not a crash or a failing test -- it was
 * `authority_checked_at` NULL on every candidate ever produced, so every
 * directory link in the UI silently degraded to a name search, and operators
 * reported the links landing on nothing.
 *
 * A flag nobody reads is indistinguishable from a feature that is off, which
 * is exactly why it survived. This asserts the wiring instead of the intent.
 * =============================================================
 */

const RUN_ENRICH = readFileSync(fileURLToPath(new URL('./run-enrich.ts', import.meta.url)), 'utf8')

/** Every optional boolean on PaidOptions. Parsed, so a new one is caught too. */
function declaredPaidFlags(): string[] {
  const block = RUN_ENRICH.slice(
    RUN_ENRICH.indexOf('export interface PaidOptions {'),
    RUN_ENRICH.indexOf('export async function createEnrichRun'),
  )
  return [...block.matchAll(/^\s{2}(\w+)\?:\s*boolean/gm)].map((m) => m[1]!)
}

describe('paid enrich stages are wired, not just declared', () => {
  const flags = declaredPaidFlags()

  it('parses the flag list', () => {
    // Vacuous-pass guard: an empty list would make the check below meaningless.
    expect(flags.length).toBeGreaterThanOrEqual(3)
    expect(flags).toContain('checkAuthority')
  })

  it.each(flags)('%s is read by executeEnrichRun', (flag) => {
    // `paid.<flag>` is how the run reads it. Declaring it is not enough.
    expect(
      RUN_ENRICH.includes(`paid.${flag}`),
      `PaidOptions.${flag} is declared but executeEnrichRun never reads paid.${flag}. ` +
        'A flag nobody reads looks exactly like a feature that is switched off.',
    ).toBe(true)
  })

  it('persists an authority result when the stage runs', () => {
    // The stage running is not enough either -- the audit returns rows that
    // have to reach domain_candidates, or the UI still has nothing to link to.
    for (const field of ['authorityMatches', 'authorityCheckedAt', 'authorityScore']) {
      expect(RUN_ENRICH).toContain(field)
    }
  })

  it('stores the citation page URL, not just the referring host', () => {
    // The whole point: a host can only produce a search link.
    expect(RUN_ENRICH).toContain('urlFrom')
  })
})
