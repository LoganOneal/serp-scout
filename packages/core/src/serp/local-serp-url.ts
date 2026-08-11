/**
 * Build Google Search URLs that approximate what a person in a given locality
 * would see for a query — without VPN.
 *
 * Method (industry-standard for local SERP verification):
 *  - `q`     = exact keyword / service query
 *  - `hl`/`gl` = language + country (en / us)
 *  - `pws=0` = reduce signed-in personalization noise
 *  - `uule`  = Google's encoded location (canonical city name, AdWords geotarget form)
 *
 * UULE v1 (`w+CAIQICI…`) is a base64 protobuf with the geotarget canonical name
 * (e.g. "Phoenix,Arizona,United States"). See Valentin Pletzer's reverse-engineering
 * and Google Ads geotarget CSV naming.
 *
 * Limits (be honest in UI):
 *  - Desktop vs mobile SERPs still depend on User-Agent / viewport. A plain URL cannot
 *    force mobile layout on a desktop browser; open Mobile on a phone or use DevTools
 *    device mode. We still emit separate links + labels for that workflow.
 *  - Logged-in Google account, cookies, and experiments can still skew results vs our
 *    API snapshot. Use pws=0 and preferably a logged-out / private window.
 */

/** US state postal → full name (Google geotarget canonical form uses full names). */
const US_STATE_NAMES: Record<string, string> = {
  AL: 'Alabama',
  AK: 'Alaska',
  AZ: 'Arizona',
  AR: 'Arkansas',
  CA: 'California',
  CO: 'Colorado',
  CT: 'Connecticut',
  DE: 'Delaware',
  DC: 'District of Columbia',
  FL: 'Florida',
  GA: 'Georgia',
  HI: 'Hawaii',
  ID: 'Idaho',
  IL: 'Illinois',
  IN: 'Indiana',
  IA: 'Iowa',
  KS: 'Kansas',
  KY: 'Kentucky',
  LA: 'Louisiana',
  ME: 'Maine',
  MD: 'Maryland',
  MA: 'Massachusetts',
  MI: 'Michigan',
  MN: 'Minnesota',
  MS: 'Mississippi',
  MO: 'Missouri',
  MT: 'Montana',
  NE: 'Nebraska',
  NV: 'Nevada',
  NH: 'New Hampshire',
  NJ: 'New Jersey',
  NM: 'New Mexico',
  NY: 'New York',
  NC: 'North Carolina',
  ND: 'North Dakota',
  OH: 'Ohio',
  OK: 'Oklahoma',
  OR: 'Oregon',
  PA: 'Pennsylvania',
  RI: 'Rhode Island',
  SC: 'South Carolina',
  SD: 'South Dakota',
  TN: 'Tennessee',
  TX: 'Texas',
  UT: 'Utah',
  VT: 'Vermont',
  VA: 'Virginia',
  WA: 'Washington',
  WV: 'West Virginia',
  WI: 'Wisconsin',
  WY: 'Wyoming',
  PR: 'Puerto Rico',
}

/**
 * Canonical geotarget string: "City,State,United States" (no space after commas).
 * Matches Google Ads geotarget CSV / UULE examples.
 */
export function buildGeotargetCanonicalName(args: {
  city: string
  /** Full state name or 2-letter code. */
  state: string | null | undefined
  country?: string
}): string | null {
  const city = args.city?.trim()
  if (!city) return null
  let statePart = (args.state ?? '').trim()
  if (!statePart) return `${city},United States`
  if (statePart.length === 2) {
    const full = US_STATE_NAMES[statePart.toUpperCase()]
    if (full) statePart = full
  }
  const country = (args.country ?? 'United States').trim() || 'United States'
  // Strip trailing ", ST" from city if caller passed "Phoenix, AZ"
  const cityClean = city.replace(/,\s*[A-Za-z]{2}\s*$/, '').trim()
  return `${cityClean},${statePart},${country}`
}

/**
 * Encode UULE v1 (canonical name) — protobuf fields role=2, producer=32, name=string.
 * Output form: `w+` + base64(bytes). Matches public UULE generators.
 */
export function encodeUuleCanonical(canonicalName: string): string {
  const nameBytes = new TextEncoder().encode(canonicalName)
  if (nameBytes.length === 0 || nameBytes.length > 127) {
    // Keep varint simple; our city names are well under 127 bytes.
    throw new Error(`UULE canonical name length out of range: ${nameBytes.length}`)
  }
  const bytes = new Uint8Array(6 + nameBytes.length)
  bytes[0] = 0x08 // field 1, varint
  bytes[1] = 0x02 // = 2
  bytes[2] = 0x10 // field 2, varint
  bytes[3] = 0x20 // = 32
  bytes[4] = 0x22 // field 4, length-delimited
  bytes[5] = nameBytes.length
  bytes.set(nameBytes, 6)
  return `w+${bytesToBase64(bytes)}`
}

/**
 * GPS UULE (v2, `a+…`) — coordinates, not a place name.
 *
 * ==================== THIS IS THE ONE GOOGLE HONOURS ====================
 * The v1 canonical-name form (`w+`) is matched against Google's geotarget list
 * and, in practice, now gets ignored on plain search URLs — the SERP silently
 * falls back to the viewer's IP, which looks exactly like a working link until
 * you notice the results are for wherever you are sitting.
 *
 * The coordinate form still works. Verified against a known-good URL from
 * valentin.app for Tucson, AZ, which decodes to precisely this payload:
 *
 *   role:1 / producer:12 / provenance:6 / timestamp:<micros>
 *   latlng{ latitude_e7 / longitude_e7 } / radius:93000
 *
 * `radius` is PLAIN METRES. This function used to multiply by 620 — a stray
 * conversion from the historical cookie format — producing radius:18600000 and
 * a UULE Google discarded.
 * =====================================================================
 */
export function encodeUuleGps(args: {
  lat: number
  lon: number
  /** Search radius in metres. City-scale default; the reference URL used 93km. */
  radiusMeters?: number
  /**
   * Microsecond timestamp. Defaults to the current UTC DAY, not the moment.
   *
   * ==================== A RAW Date.now() BREAKS HYDRATION ====================
   * This is rendered into an href by a client component that also server-
   * renders. `Date.now()` differs between the server pass and the hydration
   * pass milliseconds later, so React found two different URLs for the same
   * link and logged a hydration mismatch on every page carrying the grid.
   *
   * Quantising to the day makes the value identical across both passes while
   * keeping the timestamp current -- the only way to still mismatch is to
   * hydrate across UTC midnight, and the cost of that is one re-rendered link.
   * Google is given a timestamp that is at most a day old, which the reference
   * URLs suggest is well within tolerance.
   * ==========================================================================
   */
  timestampMicros?: number
}): string {
  const latE7 = Math.round(args.lat * 1e7)
  const lonE7 = Math.round(args.lon * 1e7)
  const radius = Math.round(args.radiusMeters ?? DEFAULT_UULE_RADIUS_METERS)
  const MICROS_PER_DAY = 86_400_000_000
  const timestamp =
    args.timestampMicros ?? Math.floor((Date.now() * 1000) / MICROS_PER_DAY) * MICROS_PER_DAY
  const text = [
    'role:1',
    'producer:12',
    'provenance:6',
    `timestamp:${timestamp}`,
    'latlng{',
    `latitude_e7:${latE7}`,
    `longitude_e7:${lonE7}`,
    '}',
    `radius:${radius}`,
  ].join('\n')
  return `a+${bytesToBase64(new TextEncoder().encode(text))}`
}

/**
 * Metro-scale default. The reference Tucson URL used 93km; too small and the
 * local pack tightens to a neighbourhood, too large and it stops being local.
 */
export const DEFAULT_UULE_RADIUS_METERS = 50_000

export type LocalSerpDevice = 'desktop' | 'mobile'

export interface LocalSerpLinks {
  /** Exact query shown to Google. */
  query: string
  /** Canonical location used for UULE (null if we could not build one). */
  canonicalLocation: string | null
  /** UULE value (without the `uule=` key). */
  uule: string | null
  /** Desktop browser verification URL. */
  desktopUrl: string
  /**
   * Mobile verification URL (same geo params). Open on a phone or in DevTools
   * device mode — UA/viewport drives mobile SERP layout, not a special query key.
   */
  mobileUrl: string
  /** Short how-to for operators. */
  howTo: string
}

/**
 * Build parameterized Google SERP URLs for a locality × service query.
 */
export function buildLocalSerpLinks(args: {
  /** Exact SERP query (e.g. "roofing", "ac repair phoenix"). */
  query: string
  city: string
  state?: string | null
  country?: string
  language?: string
  /** Prefer 'us'. */
  countryCode?: string
  /**
   * The geotarget name Google itself uses, when we know it — i.e. the
   * `location_name` DataForSEO measured against.
   *
   * ==================== PASS THIS WHENEVER YOU HAVE IT ====================
   * Google matches UULE against its geotarget list EXACTLY, and silently
   * ignores a name that is not on it -- falling back to the viewer's IP. So a
   * near-miss does not degrade to "roughly the right city", it degrades to
   * "wherever the operator is sitting", which looks like the feature works
   * while showing entirely the wrong SERP.
   *
   * "City,State,United States" is right for most markets but not all: our own
   * catalog has "New York City" (Google: "New York") and "Stockton" (Google:
   * "Stockton,San Joaquin County,California"). Reconstructing the string
   * guesses; this uses the answer.
   * =====================================================================
   */
  canonicalName?: string | null
  /**
   * Market coordinates. When present these WIN — see encodeUuleGps: the
   * coordinate UULE is the form Google still honours, and the canonical-name
   * form silently degrades to the viewer's own location.
   */
  lat?: number | null
  lon?: number | null
  /**
   * How a person in this market types the location — "new york city".
   *
   * ==================== UULE ALONE IS NOT ENOUGH ====================
   * The sweep measures city-free keywords and passes geo as `location_code`, so
   * the verification link for that cell was `q=plumber` with the location
   * carried ONLY by the uule parameter. When Google declines to honour it --
   * which it does silently, and which operators reported here -- there is
   * nothing else in the request saying New York, so the page returned is
   * plumbers wherever the operator happens to be sitting. The link looked like
   * it worked and showed the wrong city.
   *
   * Putting the locality in the query text removes that single point of
   * failure: "plumber new york city" is local because of what was typed, not
   * because of a parameter Google may ignore. The uule is still sent, so when
   * it IS honoured the result is tightened to the market rather than the metro.
   *
   * The cost of this is honest and worth stating in the UI: the link now
   * searches a slightly different string than the one measured.
   * =================================================================
   */
  queryModifier?: string | null
  /** Force the canonical-name form even when coordinates are available. */
  useGps?: boolean
  radiusMeters?: number
}): LocalSerpLinks {
  const baseQuery = args.query.trim()
  const query = applyQueryModifier(baseQuery, args.queryModifier)
  const language = args.language ?? 'en'
  const gl = (args.countryCode ?? 'us').toLowerCase()

  let canonicalLocation =
    args.canonicalName?.trim() ||
    buildGeotargetCanonicalName({
      city: args.city,
      state: args.state,
      country: args.country,
    })
  let uule: string | null = null

  const hasCoords =
    args.lat != null &&
    args.lon != null &&
    Number.isFinite(args.lat) &&
    Number.isFinite(args.lon)

  // Coordinates by default, not by request. Name-based UULE is the fallback for
  // markets we have no lat/lon for, and it is the weaker of the two.
  if (hasCoords && args.useGps !== false) {
    uule = encodeUuleGps({
      lat: args.lat as number,
      lon: args.lon as number,
      ...(args.radiusMeters === undefined ? {} : { radiusMeters: args.radiusMeters }),
    })
    canonicalLocation = canonicalLocation ?? `${args.lat}, ${args.lon}`
  } else if (canonicalLocation) {
    try {
      uule = encodeUuleCanonical(canonicalLocation)
    } catch {
      uule = null
    }
  }

  const desktopUrl = buildGoogleSearchUrl({
    query,
    language,
    gl,
    uule,
    device: 'desktop',
  })
  const mobileUrl = buildGoogleSearchUrl({
    query,
    language,
    gl,
    uule,
    device: 'mobile',
  })

  const locLabel = canonicalLocation ?? args.city
  const howTo =
    `Opens Google as if searching from ${locLabel}. ` +
    `Use a private/logged-out window (pws=0). ` +
    `Mobile: open on a phone or Chrome DevTools device mode — layout follows User-Agent.`

  return {
    query,
    canonicalLocation,
    uule,
    desktopUrl,
    mobileUrl,
    howTo,
  }
}

/**
 * Append the locality to a keyword, unless it is already in there.
 *
 * "plumber near me" keeps its own intent rather than becoming the nonsense
 * "plumber near me new york city", and a keyword an operator already typed with
 * a city is not given it twice.
 */
export function applyQueryModifier(
  query: string,
  modifier: string | null | undefined,
): string {
  const base = query.trim()
  const mod = modifier?.trim()
  if (!base || !mod) return base
  const lowerBase = base.toLowerCase()
  if (lowerBase.includes(mod.toLowerCase())) return base
  // "near me" is a location statement already; stacking a city onto it asks
  // Google a question nobody types.
  if (/\bnear me\b/.test(lowerBase)) return base
  return `${base} ${mod}`
}

export function buildGoogleSearchUrl(args: {
  query: string
  language: string
  gl: string
  uule: string | null
  device: LocalSerpDevice
}): string {
  const params = new URLSearchParams()
  params.set('q', args.query)
  params.set('hl', args.language)
  params.set('gl', args.gl)
  // Match the known-good reference URL: explicit charset params.
  params.set('ie', 'utf-8')
  params.set('oe', 'utf-8')
  // Disable personalized results when possible.
  params.set('pws', '0')
  if (args.uule) params.set('uule', args.uule)
  // Soft signal only; Google primarily uses UA for mobile SERPs.
  if (args.device === 'mobile') {
    params.set('client', 'ms-android-google')
  }
  // Trailing notes for operators who copy the URL.
  params.set('nfpr', '1') // no auto-correct to different query when possible

  return `https://www.google.com/search?${params.toString()}`
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64')
  }
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
  return btoa(binary)
}
