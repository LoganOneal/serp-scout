import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Architectural guard: volume is bought in exactly one place.
 *
 * ==================== WHY THIS TEST EXISTS ====================
 * `keywords_data/google_ads/search_volume/live` costs $0.09 PER REQUEST.
 * `ensureKeywordVolumes` tries Google Ads first (free), serves a 30-day cache,
 * and records anything it does spend on the ledger.
 *
 * Three call sites had drifted around it -- the grid backfill, the discovery
 * backfill, and promote -- so they paid DataForSEO for data Google gives away
 * and the spend never reached the books. Each one was individually reasonable
 * and collectively they were the same bug that made a 50x50 run cost $225.
 *
 * A reviewer cannot be relied on to notice the fourth one, so this asserts it.
 * =============================================================
 */

const SRC = fileURLToPath(new URL('../', import.meta.url))

/** The one module allowed to buy volume directly — it *is* the fallback. */
const SANCTIONED = ['serp/keyword-volume-cache.ts', 'providers/dataforseo/keyword-volume.ts']

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === '__fixtures__') continue
      walk(full, out)
    } else if (entry.endsWith('.ts') || entry.endsWith('.mts')) {
      out.push(full)
    }
  }
  return out
}

const rel = (p: string): string => p.slice(SRC.length).replace(/\\/g, '/')

describe('volume purchasing is centralised', () => {
  const files = walk(SRC)

  it('finds source files to check', () => {
    expect(files.length).toBeGreaterThan(20)
  })

  it('no module outside the cache calls the paid DataForSEO volume endpoint', () => {
    const offenders = files.filter((file) => {
      const path = rel(file)
      if (SANCTIONED.includes(path)) return false
      // Scripts are hand-run probes, not production paths.
      if (path.startsWith('scripts/')) return false
      if (path.endsWith('.test.ts')) return false

      const body = readFileSync(file, 'utf8')
      return /fetchDfsKeywordVolumesFromEnv\s*\(/.test(body)
    })

    expect(
      offenders.map(rel),
      'Keyword volume must come from Google Ads (free) or be null. DataForSEO ' +
        'search_volume costs $0.09 PER REQUEST and is removed by policy — ' +
        'use ensureKeywordVolumesFromEnv, which returns nulls when Google Ads ' +
        'cannot resolve a geo.',
    ).toEqual([])
  })

  it('no module outside the provider references the paid endpoint constant', () => {
    const offenders = files.filter((file) => {
      const path = rel(file)
      if (SANCTIONED.includes(path)) return false
      if (path === 'providers/dataforseo/endpoints.ts') return false
      if (path.startsWith('scripts/') || path.endsWith('.test.ts')) return false
      return /KEYWORDS_GOOGLE_ADS_SEARCH_VOLUME/.test(readFileSync(file, 'utf8'))
    })
    expect(offenders.map(rel)).toEqual([])
  })
})

/**
 * A failed lookup is not a measurement.
 *
 * ==================== WHAT CACHING A MISS COST ====================
 * The cache wrote `no_data` rows alongside real figures, with the same 30-day
 * TTL, on the reasoning that the next job should not re-ask. That was sound
 * when a re-ask meant $0.09 to DataForSEO. Volume now comes from Google Ads --
 * free -- or it does not come at all, so persisting a failure bought nothing.
 *
 * Run 38 asked while Google Ads was returning nothing and pinned all 16 of its
 * keywords to null until September. With no volume there is no Reddit-visits
 * estimate, so a run holding 10 genuine Reddit threads displayed an entirely
 * empty Reddit column and read as "no Reddit on any SERP". 445 cache rows were
 * poisoned before it was caught; purging them restored volume on 13 of 16
 * immediately, from the same free API that had "failed".
 * =================================================================
 */
describe('a missed volume lookup is never cached', () => {
  const SRC = readFileSync(
    fileURLToPath(new URL('./keyword-volume-cache.ts', import.meta.url)),
    'utf8',
  )

  it('returns before writeVolumes when the source is no_data', () => {
    const fn = SRC.slice(SRC.indexOf('export async function ensureKeywordVolumes'))
    const guard = fn.indexOf("vol.source === 'no_data'")
    const write = fn.indexOf('await writeVolumes(')
    expect(guard, 'ensureKeywordVolumes must special-case a no_data result').toBeGreaterThan(-1)
    expect(
      guard,
      'The no_data guard must come BEFORE writeVolumes, or a failed lookup is ' +
        'persisted for 30 days and the keyword reads as zero-volume until it expires.',
    ).toBeLessThan(write)
  })

  it('still serves the miss to the caller, so the row is not silently dropped', () => {
    // The caller needs a row per requested keyword; it just must not be cached.
    const fn = SRC.slice(SRC.indexOf("vol.source === 'no_data'"))
    expect(fn.slice(0, 600)).toContain('volumes.set(')
  })
})
