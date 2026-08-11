import type { ProviderLocation } from '@rnr/core'
import { downloadZipEntry, lines, splitCsv } from './download.js'

/**
 * Google Ads geo target constants -- a free, keyless, complete location corpus.
 *
 * ==================== WHY THIS EXISTS ====================
 * DataForSEO's /serp/google/locations is free but sits behind the account's IP
 * whitelist, so an unwhitelisted machine cannot build a location index at all --
 * and without one, every locality in the corpus fails to resolve and the tool has
 * nothing to scan. That is how "Tucson, AZ has no provider location code" happens
 * with a perfectly good ingest.
 *
 * Google publishes the same class of data publicly: 16,407 active US cities plus
 * 3,098 counties, no auth, no key.
 *
 * ===================== AND WHY IT IS NOT AUTHORITATIVE =====================
 * DataForSEO documents its `location_code` as the Google Ads criterion ID, and
 * the structure agrees -- US cities in the 10xxxxx range, states in 21xxx,
 * counties in 90xxxxx, and the canonical-name forms match exactly, including the
 * two odd ones the brief flagged:
 *
 *   Orange,Orange,California,United States              <- county, no word "County"
 *   Brentwood,Contra Costa County,California,United States  <- county with the word
 *   McKinney,Texas,United States                        <- no county at all
 *
 * But that equivalence is UNVERIFIED against the live API. If it were wrong, a
 * scan would run against a well-formed SERP for the wrong city and nothing
 * downstream could tell -- the exact failure this project is organised against.
 *
 * So localities resolved from here are tagged `location_source =
 * 'google_geotargets'`, and runScan REFUSES to spend money on one. Verification
 * is free (the DataForSEO locations endpoint costs nothing), so the fix is to
 * re-run `ingest:geo` once the IP is whitelisted -- not to trust this.
 * ==========================================================================
 */

/**
 * Vintage pinned deliberately. Google does not publish a "latest" alias, and
 * silently drifting to a new vintage would silently change location codes under
 * saved shortlist items and outcome history.
 */
export const GEOTARGETS_URL =
  'https://developers.google.com/google-ads/api/data/geo/geotargets-2023-05-03.csv.zip'
export const GEOTARGETS_VINTAGE = '2023-05-03'

/**
 * Target types worth keeping. Deliberately EXCLUDES Postal Code (33,352 rows),
 * Neighborhood, Airport, University, National Park and Congressional District --
 * none is a locality this tool scans, and Postal Code alone would triple the
 * index for nothing.
 *
 * NOTE there is no `DMA Region` in this dataset. Metros therefore resolve to
 * their anchor City, which ACCEPT_TYPES.metro already permits.
 */
const KEPT_TYPES = new Set(['City', 'County', 'State', 'Municipality', 'Borough'])

export async function fetchGeotargetLocations(): Promise<ProviderLocation[]> {
  const text = await downloadZipEntry(GEOTARGETS_URL, /geotargets-.*\.csv$/i, 'geotargets.csv')
  return parseGeotargets(text)
}

/** Columns: Criteria ID, Name, Canonical Name, Parent ID, Country Code, Target Type, Status */
export function parseGeotargets(text: string): ProviderLocation[] {
  const rows = lines(text)
  const header = splitCsv(rows[0] ?? '').map((h) => h.trim().replace(/^"|"$/g, '').toUpperCase())
  const idx = (name: string) => header.indexOf(name)
  const iId = idx('CRITERIA ID')
  const iCanonical = idx('CANONICAL NAME')
  const iCountry = idx('COUNTRY CODE')
  const iType = idx('TARGET TYPE')
  const iStatus = idx('STATUS')

  if (iId < 0 || iCanonical < 0 || iType < 0) {
    throw new Error(
      `Geotargets CSV missing expected columns. Header was: ${header.join(', ')}. ` +
        'Refusing to return an empty list, which would silently resolve zero localities.',
    )
  }

  const unquote = (s: string | undefined) => (s ?? '').trim().replace(/^"|"$/g, '')
  const out: ProviderLocation[] = []

  for (let i = 1; i < rows.length; i++) {
    const f = splitCsv(rows[i]!)
    if (unquote(f[iCountry]) !== 'US') continue
    // Removed/deprecated targets must not be offered: a scan against a retired
    // criterion ID is a scan against nothing.
    if (unquote(f[iStatus]) !== 'Active') continue
    const type = unquote(f[iType])
    if (!KEPT_TYPES.has(type)) continue

    const code = Number(unquote(f[iId]))
    const canonical = unquote(f[iCanonical])
    if (!Number.isFinite(code) || !canonical) continue

    out.push({
      locationCode: code,
      locationName: canonical,
      locationType: type,
      countryIsoCode: 'US',
    })
  }

  if (out.length < 10_000) {
    // A healthy parse yields ~20k US rows across the kept types. Far fewer means
    // the format moved, and an under-populated index resolves a fraction of the
    // corpus while looking like it worked.
    throw new Error(
      `Geotargets parse produced only ${out.length} US locations, expected >10,000. The CSV format has probably changed.`,
    )
  }
  return out
}
