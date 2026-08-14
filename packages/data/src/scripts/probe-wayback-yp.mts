import { registrableDomain, NON_ACQUIRABLE_HOSTS } from '@rnr/core'

/**
 * P3, focused: does an ARCHIVED YellowPages category page carry business
 * websites, or only YP profile links?
 *
 * BBB answered "two hops" in both 2019 and 2025 -- its category pages link to
 * bbb.org profiles and to nothing else except BBB's own affiliates and adtech.
 * YellowPages is the better bet and is archived back to 2013, which is old
 * enough that a good share of the businesses on the page are now gone.
 *
 * Uses the REAL normaliser rather than a hand-rolled host filter: the previous
 * pass reported 15 "business" links on a BBB page that were all analytics and
 * BBB affiliates, because an ad-hoc regex was doing the classifying.
 */

const CDX = 'http://web.archive.org/cdx/search/cdx'

/** Trackers, tag managers and CDNs. Never a local business, never acquirable. */
const INFRA =
  /(doubleclick|demdex|omtrdc|newrelic|nr-data|mouseflow|google-analytics|googletagmanager|googleadservices|googlesyndication|gstatic|googleapis|facebook|fbcdn|scorecardresearch|quantserve|adsrvr|criteo|bing|yahoo|akamai|cloudfront|cloudflare|jquery|bootstrapcdn|typekit|fontawesome|addthis|sharethis|hotjar|optimizely|segment|amplitude|branch\.io|livechatinc|e2ma|yellowpages|yp\.com|dexknows|superpages|bbb)/i

async function cdx(url: string): Promise<Array<{ ts: string; original: string }>> {
  const res = await fetch(`${CDX}?url=${url}&output=json&limit=40`, {
    signal: AbortSignal.timeout(90_000),
  })
  const text = await res.text()
  console.log(`  CDX HTTP ${res.status} · body ${text.length} bytes`)
  if (!text.trim()) return []
  const rows = JSON.parse(text) as string[][]
  return rows
    .slice(1)
    .filter((r) => r[4] === '200')
    .map((r) => ({ ts: r[1] ?? '', original: r[2] ?? '' }))
}

const TARGETS = [
  'yellowpages.com/kenosha-wi/plumbers',
  'yellowpages.com/milwaukee-wi/plumbers',
]

for (const target of TARGETS) {
  console.log(`\n${'='.repeat(72)}\n${target}\n${'='.repeat(72)}`)

  let snaps: Array<{ ts: string; original: string }> = []
  try {
    snaps = await cdx(target)
  } catch (e) {
    console.log(`  CDX failed: ${(e as Error).message}`)
    continue
  }
  console.log(`  snapshots (200): ${snaps.length}`)
  if (snaps.length === 0) continue
  console.log(`  years: ${[...new Set(snaps.map((s) => s.ts.slice(0, 4)))].join(', ')}`)

  const pick = snaps[0]!
  const url = `http://web.archive.org/web/${pick.ts}/${pick.original}`
  console.log(`  fetching oldest (${pick.ts.slice(0, 4)}): ${url.slice(0, 100)}`)

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(90_000) })
    const html = await res.text()
    console.log(`  HTTP ${res.status} · ${html.length.toLocaleString()} bytes`)

    const found = new Map<string, number>()
    let profileLinks = 0

    for (const m of html.matchAll(/href="([^"]+)"/gi)) {
      const href = m[1] ?? ''
      if (/\/mip\//i.test(href)) profileLinks += 1
      const unwrapped = href.match(/\/web\/\d+(?:[a-z_]+)?\/(https?:\/\/.+)$/i)?.[1]
      if (!unwrapped) continue

      const n = registrableDomain(unwrapped)
      if (!n || n.nonAcquirable) continue
      if (NON_ACQUIRABLE_HOSTS.has(n.domain)) continue
      if (INFRA.test(n.domain)) continue
      found.set(n.domain, (found.get(n.domain) ?? 0) + 1)
    }

    console.log(`  YP profile links (/mip/): ${profileLinks}`)
    console.log(`  candidate business domains: ${found.size}`)
    if (found.size > 0) {
      console.log(`  ── ONE HOP CONFIRMED ──`)
      for (const [d, n] of [...found.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)) {
        console.log(`      ${d}  (${n}x)`)
      }
    } else {
      console.log(`  ── TWO HOPS: profile links only ──`)
    }
  } catch (e) {
    console.log(`  fetch failed: ${(e as Error).message}`)
  }
}
