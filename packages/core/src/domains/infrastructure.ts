/**
 * Hosts that are not a business at all, and locality-token matching that does
 * not fire on substrings.
 *
 * ==================== WHY THIS IS SEPARATE FROM NON_ACQUIRABLE_HOSTS ========
 * `NON_ACQUIRABLE_HOSTS` means "a real business is here, but it rents the page
 * and does not own the registrable domain" -- a Yelp profile, a Wix subdomain.
 * Those listings are EVIDENCE a business existed.
 *
 * These are different: a tag manager, a CDN, a tracking pixel, a manufacturer
 * whose products a contractor links to. They are not businesses in the market
 * and they are never evidence of one. Folding them into the same set would make
 * `skippedPlatform` mean two incompatible things at once.
 * ===========================================================================
 *
 * Every entry below was observed in an actual probe run, not imagined:
 * probe-wayback-directory reported FIFTEEN "business websites" on a BBB
 * category page, and all fifteen were in this set.
 */

/**
 * Matched as eTLD+1 or as a suffix, so `cdn.mouseflow.com` and
 * `bam.nr-data.net` both resolve.
 */
export const INFRASTRUCTURE_HOSTS: ReadonlySet<string> = new Set([
  // ---- Directory chrome and partners (seen on archived YellowPages pages) ----
  'ypcdn.com',
  'anywho.com',
  'ingenio.com',
  'keen.com',
  'taleo.net',
  'truste.com',
  'justanswer.com',
  'dexknows.com',
  'superpages.com',
  'yellowbook.com',
  'citysearch.com',
  'merchantcircle.com',
  'localeze.com',
  'infogroup.com',

  // ---- BBB's own affiliates (seen on archived BBB category pages) ----
  'bbbprograms.org',
  'bbbmarketplacetrust.org',
  'bbbnp.org',
  'bbbpromos.org',
  'give.org',
  'asrcreviews.org',

  // ---- Adtech, analytics, tag managers ----
  'doubleclick.net',
  'demdex.net',
  'omtrdc.net',
  'newrelic.com',
  'nr-data.net',
  'mouseflow.com',
  'google-analytics.com',
  'googletagmanager.com',
  'googleadservices.com',
  'googlesyndication.com',
  'scorecardresearch.com',
  'quantserve.com',
  'adsrvr.org',
  'criteo.com',
  'hotjar.com',
  'optimizely.com',
  'segment.com',
  'amplitude.com',
  'branch.io',
  'livechatinc.com',
  'e2ma.net',
  'addthis.com',
  'sharethis.com',

  // ---- CDNs, platform hosts, developer infrastructure ----
  'gstatic.com',
  'googleapis.com',
  'akamai.net',
  'akamaized.net',
  'cloudfront.net',
  'cloudflare.com',
  'jquery.com',
  'bootstrapcdn.com',
  'fontawesome.com',
  'typekit.net',
  'azurewebsites.net',
  'pages.dev',
  'workers.dev',
  'mozilla.org',
  'w3.org',
  'schema.org',
  'creativecommons.org',
  'archive.org',

  /**
   * ---- Manufacturers and national brands contractors link to ----
   * A plumber's site links to Kohler; Kohler is not an acquisition target.
   * `kohler.com` has already cost this project one false top-ranked candidate
   * (reported PARKED_DEAD at #2 on a timed-out probe), so the whole class is
   * excluded rather than left for triage to waste 20 seconds on.
   */
  'kohler.com',
  'carrier.com',
  'trane.com',
  'lennox.com',
  'rheem.com',
  'goodmanmfg.com',
  'bryant.com',
  'americanstandard.com',
  'moen.com',
  'delta.com',
  'deltafaucet.com',
  'navien.com',
  'rinnai.com',
  'bradfordwhite.com',
  'aosmith.com',
  'generac.com',
  'mitsubishicomfort.com',

  /**
   * ---- Found by the step-0 run, n=419 ----
   * These dominated the first outreach list by referring-domain count and none
   * is a local operator: ad networks, YellowPages' own corporate estate, and
   * national service brands that appear in every market's directory listing.
   */
  'networkadvertising.org',
  'openx.net',
  'citygridmedia.com',
  'dexyp.com',
  'dex-digital.com',
  'dexmedia.com',
  'vpweb.com',
  'liveonatt.com',
  'epri.com',
  'searspartsdirect.com',
  'searshomeservices.com',
  'searshomeimprovements.com',
  'sears.com',
  'roto-rooter.com',
  'mrhandyman.com',
  'aptiv.com',
])

/** True when the domain is infrastructure rather than a business. */
export function isInfrastructureHost(domain: string | null | undefined): boolean {
  if (!domain) return false
  const d = domain.trim().toLowerCase()
  if (!d) return false
  if (INFRASTRUCTURE_HOSTS.has(d)) return true
  for (const h of INFRASTRUCTURE_HOSTS) {
    if (d.endsWith(`.${h}`)) return true
  }
  return false
}

/**
 * Does this domain carry a locality or niche token as a WORD?
 *
 * ==================== WHY NOT `domain.includes(token)` ====================
 * The citation-hub probe used a bare substring test with the token `wi`, and
 * counted `wikitrans.net`, `wikiland.org`, `wikiwand.com` and an entire
 * wiki-spam network (`kilo-wiki.win`, `oscar-wiki.win`) as Kenosha-local. The
 * measured "locality share" was inflated by roughly the size of that network.
 *
 * A domain label has no spaces, so word boundaries have to come from the
 * separators that DO appear in one -- hyphens, dots, and the string ends -- plus
 * the observation that a short token is only credible at a boundary. Long
 * tokens (`kenosha`) are safe anywhere; short ones (`wi`) are only safe when
 * delimited.
 * =========================================================================
 */
export function hasLocalityToken(domain: string, token: string): boolean {
  const d = domain.trim().toLowerCase()
  const t = token.trim().toLowerCase()
  if (!d || !t) return false

  // Strip the TLD: `plumberwi.com` must not match token `com`, and the state
  // suffix in `example.wi.us` is a real match that the label test would miss.
  const labels = d.split('.')
  const stem = labels.slice(0, -1).join('.')

  /**
   * Tokens of 4+ characters are distinctive enough that a bare substring is
   * safe -- `kenosha` inside `godowntownkenosha` is a genuine match, and
   * requiring a delimiter there would lose most real hits.
   */
  if (t.length >= 4) return stem.includes(t)

  // Short tokens (state codes) only count when delimited or at an edge.
  const boundary = String.raw`(^|[^a-z0-9])`
  const after = String.raw`($|[^a-z0-9])`
  return new RegExp(`${boundary}${escapeRe(t)}${after}`).test(stem)
}

/** True when ANY of the tokens matches. */
export function hasAnyLocalityToken(domain: string, tokens: readonly string[]): boolean {
  return tokens.some((t) => hasLocalityToken(domain, t))
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
