import { describe, expect, it } from 'vitest'
import {
  applyQueryModifier,
  buildGeotargetCanonicalName,
  buildLocalSerpLinks,
  encodeUuleCanonical,
  encodeUuleGps,
} from './local-serp-url.js'

describe('buildGeotargetCanonicalName', () => {
  it('uses full state name for US postal codes', () => {
    expect(buildGeotargetCanonicalName({ city: 'Phoenix', state: 'AZ' })).toBe(
      'Phoenix,Arizona,United States',
    )
  })

  it('strips trailing , ST from city', () => {
    expect(buildGeotargetCanonicalName({ city: 'Dallas, TX', state: 'TX' })).toBe(
      'Dallas,Texas,United States',
    )
  })
})

describe('encodeUuleCanonical', () => {
  it('matches known Austin UULE (doc example, with optional padding)', () => {
    const u = encodeUuleCanonical('Austin,Texas,United States')
    expect(u.startsWith('w+CAIQICI')).toBe(true)
    // Base payload matches public examples (padding = may differ).
    expect(u.replace(/=+$/, '')).toBe(
      'w+CAIQICIaQXVzdGluLFRleGFzLFVuaXRlZCBTdGF0ZXM'.replace(/=+$/, ''),
    )
  })

  it('matches West New York example', () => {
    const u = encodeUuleCanonical('West New York,New Jersey,United States')
    expect(u.replace(/=+$/, '')).toBe(
      'w+CAIQICImV2VzdCBOZXcgWW9yayxOZXcgSmVyc2V5LFVuaXRlZCBTdGF0ZXM'.replace(/=+$/, ''),
    )
  })
})

describe('buildLocalSerpLinks', () => {
  it('builds desktop and mobile URLs with uule + pws=0', () => {
    const links = buildLocalSerpLinks({
      query: 'roofing',
      city: 'Phoenix',
      state: 'AZ',
    })
    expect(links.canonicalLocation).toBe('Phoenix,Arizona,United States')
    expect(links.uule).toBeTruthy()
    expect(links.desktopUrl).toContain('google.com/search')
    expect(links.desktopUrl).toContain('q=roofing')
    expect(links.desktopUrl).toContain('pws=0')
    expect(links.desktopUrl).toContain('uule=')
    expect(links.desktopUrl).toContain('gl=us')
    expect(links.mobileUrl).toContain('client=ms-android-google')
    expect(links.desktopUrl).not.toContain('client=ms-android-google')
  })

  /**
   * The catalog's rank-1 market is "New York City"; Google's geotarget is
   * "New York". Reconstructing the name produced a UULE Google rejected, so the
   * verify link silently showed the OPERATOR's local SERP -- the failure that
   * makes a geo tool worse than useless, because it looks like it worked.
   */
  it('prefers the provider geotarget name over reconstructed city+state', () => {
    const links = buildLocalSerpLinks({
      query: 'roofing',
      city: 'New York City',
      state: 'NY',
      canonicalName: 'New York,New York,United States',
    })
    expect(links.canonicalLocation).toBe('New York,New York,United States')
    expect(links.uule).toBe(encodeUuleCanonical('New York,New York,United States'))
  })

  /**
   * Pinned against a known-good URL from valentin.app for "ac repair" in
   * Tucson, AZ — the one that demonstrably returns Tucson results rather than
   * the viewer's own city. Everything except the timestamp must match.
   */
  it('reproduces the reference GPS UULE payload for Tucson', () => {
    const uule = encodeUuleGps({ lat: 32.2226066, lon: -110.9747108, radiusMeters: 93_000 })
    expect(uule.startsWith('a+')).toBe(true)
    const decoded = Buffer.from(uule.slice(2), 'base64').toString('utf8')
    expect(decoded).toContain('role:1')
    expect(decoded).toContain('producer:12')
    expect(decoded).toContain('provenance:6')
    expect(decoded).toContain('latitude_e7:322226066')
    expect(decoded).toContain('longitude_e7:-1109747108')
    // Plain metres. The x620 multiplier produced radius:57660000 and a UULE
    // Google threw away, which is why the links showed the operator's location.
    expect(decoded).toContain('radius:93000')
  })

  it('prefers coordinates over the place name when both are available', () => {
    const links = buildLocalSerpLinks({
      query: 'ac repair',
      city: 'Tucson',
      state: 'AZ',
      canonicalName: 'Tucson,Arizona,United States',
      lat: 32.2226066,
      lon: -110.9747108,
    })
    expect(links.uule?.startsWith('a+')).toBe(true)
    expect(links.desktopUrl).toContain('uule=a%2B')
  })

  it('falls back to the place name when the market has no coordinates', () => {
    const links = buildLocalSerpLinks({
      query: 'ac repair',
      city: 'Tucson',
      state: 'AZ',
      lat: null,
      lon: null,
    })
    expect(links.uule?.startsWith('w+')).toBe(true)
  })

  it('falls back to city+state when no provider name is known', () => {
    const links = buildLocalSerpLinks({
      query: 'roofing',
      city: 'Phoenix',
      state: 'AZ',
      canonicalName: null,
    })
    expect(links.canonicalLocation).toBe('Phoenix,Arizona,United States')
  })
})

describe('query modifier makes the link local without relying on uule', () => {
  it('appends the locality to the measured keyword', () => {
    // The sweep measures city-free keywords, so without this the link carried
    // the location only in the uule and showed the operator their own city.
    const links = buildLocalSerpLinks({
      query: 'plumber',
      city: 'New York City',
      state: 'NY',
      queryModifier: 'new york city',
      lat: 40.662712,
      lon: -73.938677,
    })
    expect(links.query).toBe('plumber new york city')
    expect(decodeURIComponent(new URL(links.desktopUrl).searchParams.get('q')!)).toBe(
      'plumber new york city',
    )
    // The uule is still sent — it tightens the result when Google honours it.
    expect(links.uule?.startsWith('a+')).toBe(true)
  })

  it('leaves "near me" queries alone', () => {
    const links = buildLocalSerpLinks({
      query: 'plumber near me',
      city: 'New York City',
      state: 'NY',
      queryModifier: 'new york city',
    })
    expect(links.query).toBe('plumber near me')
  })

  it('does not repeat a locality the keyword already carries', () => {
    const links = buildLocalSerpLinks({
      query: 'plumber new york city',
      city: 'New York City',
      state: 'NY',
      queryModifier: 'new york city',
    })
    expect(links.query).toBe('plumber new york city')
  })

  it('is a no-op when no modifier is known', () => {
    const links = buildLocalSerpLinks({ query: 'plumber', city: 'Phoenix', state: 'AZ' })
    expect(links.query).toBe('plumber')
  })
})

describe('applyQueryModifier as the geo_explicit variant builder', () => {
  it('returns the keyword unchanged when there is nothing to add', () => {
    // The sweep compares against the input to decide whether to buy a second
    // SERP. Returning the same string is how it declines — a modifier-less
    // market must not queue a duplicate of the primary under another name.
    expect(applyQueryModifier('plumber', null)).toBe('plumber')
    expect(applyQueryModifier('plumber', '  ')).toBe('plumber')
    expect(applyQueryModifier('plumber near me', 'new york city')).toBe('plumber near me')
    expect(applyQueryModifier('plumber new york city', 'new york city')).toBe(
      'plumber new york city',
    )
  })

  it('is case-insensitive about a locality already present', () => {
    expect(applyQueryModifier('Plumber New York City', 'new york city')).toBe(
      'Plumber New York City',
    )
  })

  it('builds the variant when the keyword is genuinely city-free', () => {
    expect(applyQueryModifier('emergency ac repair', 'phoenix')).toBe(
      'emergency ac repair phoenix',
    )
  })
})

describe('UULE is stable across a server and client render', () => {
  it('produces the same string when called twice moments apart', () => {
    // The href is built by a client component that also server-renders. A raw
    // Date.now() gave the two passes different URLs and React logged a
    // hydration mismatch on every page carrying the grid.
    const a = encodeUuleGps({ lat: 40.662712, lon: -73.938677 })
    const b = encodeUuleGps({ lat: 40.662712, lon: -73.938677 })
    expect(a).toBe(b)
  })

  it('carries a timestamp quantised to the UTC day', () => {
    const decoded = Buffer.from(
      encodeUuleGps({ lat: 40.662712, lon: -73.938677 }).slice(2),
      'base64',
    ).toString('utf8')
    const micros = Number(decoded.match(/timestamp:(\d+)/)![1])
    expect(micros % 86_400_000_000).toBe(0)
    // Still current: within a day of now, not a frozen constant.
    expect(Date.now() * 1000 - micros).toBeLessThan(86_400_000_000)
  })

  it('lets a caller pin the timestamp outright', () => {
    const pinned = encodeUuleGps({ lat: 1, lon: 2, timestampMicros: 1_700_000_000_000_000 })
    expect(Buffer.from(pinned.slice(2), 'base64').toString('utf8')).toContain(
      'timestamp:1700000000000000',
    )
  })

  it('gives the whole link builder a stable url too', () => {
    const args = { query: 'plumber', city: 'New York City', state: 'NY', lat: 40.66, lon: -73.93 }
    expect(buildLocalSerpLinks(args).desktopUrl).toBe(buildLocalSerpLinks(args).desktopUrl)
  })
})
