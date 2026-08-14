import 'dotenv/config'

/**
 * P3 — do ARCHIVED directory category pages carry business WEBSITE links?
 *
 * ==================== WHY THIS QUESTION DECIDES A BUILD ====================
 * `bbb.org` returns 403 even through DataForSEO -- established, do not retry.
 * But `web.archive.org` does not block, so the archive is the one open door to
 * the best directory of local operators there is.
 *
 * The open question is the SHAPE of the crawl, and it is worth an order of
 * magnitude:
 *
 *   one hop  -- the category page lists each business WITH its website
 *   two hops -- it links only to BBB profile pages, and each profile must then
 *               be fetched to reach a website
 *
 * Free: Wayback is fetched over plain HTTP, no DataForSEO involved.
 * ==========================================================================
 */

const CDX = 'http://web.archive.org/cdx/search/cdx'

/**
 * Category pages known to be archived, established by probe-cdx-shapes.
 *
 * Kenosha is deliberately kept for YellowPages (archived back to 2013) and
 * Chicago used for BBB, because BBB has no archived category page for a market
 * that small -- which is itself a finding about which markets this route can
 * serve.
 */
const TARGETS = [
  { name: 'YellowPages · Kenosha WI', url: 'yellowpages.com/kenosha-wi/plumbers' },
  { name: 'BBB · Chicago IL', url: 'bbb.org/us/il/chicago/category/plumber' },
]

interface Snapshot {
  timestamp: string
  original: string
  status: string
}

/**
 * ============ THE FIRST VERSION OF THIS RETURNED ZERO FOR EVERYTHING ========
 * It sent `&filter=statuscode:200&collapse=timestamp:6`, and CDX answered HTTP
 * 200 with an empty body for every target -- indistinguishable from "nothing is
 * archived here", which is what it was briefly recorded as.
 *
 * Plain queries return rows fine (verified: probe-cdx-shapes). Status filtering
 * is done here in code instead, where an empty result cannot be confused with a
 * malformed request.
 * ===========================================================================
 */
async function snapshots(url: string): Promise<Snapshot[]> {
  // NOT encodeURIComponent: percent-encoding the slashes makes CDX return an
  // empty body rather than an error, which cost one false "nothing archived"
  // reading on YellowPages already.
  const q = `${CDX}?url=${url}&output=json&limit=60`
  const res = await fetch(q, { signal: AbortSignal.timeout(90_000) })
  if (!res.ok) return []
  const text = await res.text()
  if (!text.trim()) return []
  const rows = JSON.parse(text) as string[][]
  // Row 0 is the header.
  return rows
    .slice(1)
    .map((r) => ({ timestamp: r[1] ?? '', original: r[2] ?? '', status: r[4] ?? '' }))
    .filter((s) => s.status === '200')
}

/**
 * Outbound links on an archived page, split into the two categories that
 * decide the crawl shape.
 *
 * Wayback rewrites every link to `/web/<timestamp>/<original-url>`, so the
 * real destination has to be recovered from inside the archive URL before any
 * of it means anything.
 */
function classifyLinks(html: string, directoryHost: string) {
  const hrefs = [...html.matchAll(/href="([^"]+)"/gi)].map((m) => m[1] ?? '')
  const external = new Set<string>()
  const internal = new Set<string>()

  for (const href of hrefs) {
    // Unwrap the archive prefix: /web/20180101000000/http://example.com/
    const unwrapped = href.match(/\/web\/\d+(?:[a-z_]+)?\/(https?:\/\/.+)$/i)?.[1] ?? href
    if (!/^https?:\/\//i.test(unwrapped)) continue

    let host: string
    try {
      host = new URL(unwrapped).hostname.replace(/^www\./, '').toLowerCase()
    } catch {
      continue
    }
    if (!host) continue

    if (host.endsWith(directoryHost) || host.endsWith('archive.org')) internal.add(unwrapped)
    else external.add(host)
  }
  return { external: [...external], internal: [...internal] }
}

/**
 * Hosts that are never a local business: the archive's own furniture, plus the
 * social and platform links every directory page carries in its chrome.
 */
const CHROME =
  /^(facebook|twitter|x|instagram|linkedin|youtube|pinterest|apple|google|googleapis|gstatic|cloudflare|adobe|microsoft|bing|doubleclick|jquery|fonts|schema|w3|creativecommons|archive|wikipedia|amazon|itunes|play\.google)\./

for (const target of TARGETS) {
  console.log(`\n${'='.repeat(72)}\n${target.name} — ${target.url}\n${'='.repeat(72)}`)

  let snaps: Snapshot[] = []
  try {
    snaps = await snapshots(target.url)
  } catch (e) {
    console.log(`  CDX failed: ${(e as Error).message}`)
    continue
  }

  console.log(`  snapshots with HTTP 200: ${snaps.length}`)
  if (snaps.length === 0) {
    console.log('  → nothing archived at this URL. Try a different path shape.')
    continue
  }

  const years = [...new Set(snaps.map((s) => s.timestamp.slice(0, 4)))]
  console.log(`  years covered: ${years.join(', ')}`)

  /**
   * OLDEST and NEWEST, not the middle.
   *
   * The 2025 BBB page carried no business links at all -- it is a modern
   * client-rendered listing. Whether a 2013-2019 snapshot of the same directory
   * is server-rendered with real outbound links is a completely different
   * question, and it is the one that decides the build.
   */
  const picks = [
    ['oldest', snaps[0]],
    ['newest', snaps[snaps.length - 1]],
  ] as const

  for (const [which, pick] of picks) {
    if (!pick) continue
    const archiveUrl = `http://web.archive.org/web/${pick.timestamp}/${pick.original}`
    console.log(`\n  [${which} · ${pick.timestamp.slice(0, 4)}] ${archiveUrl.slice(0, 100)}`)

    try {
      const res = await fetch(archiveUrl, { signal: AbortSignal.timeout(90_000) })
      const html = await res.text()
      const host = target.url.split('/')[0]!.replace(/^www\./, '')
      const { external, internal } = classifyLinks(html, host)
      const business = external.filter((h) => !CHROME.test(h))

      console.log(
        `    HTTP ${res.status} · ${html.length.toLocaleString()} bytes · internal ${internal.length} · external ${external.length} · business ${business.length}`,
      )

      if (business.length > 0) {
        console.log(`    ── ONE HOP: category page carries business websites ──`)
        for (const h of business.slice(0, 20)) console.log(`        ${h}`)
      } else {
        console.log(`    ── TWO HOPS: no business websites on the category page ──`)
        const profiles = internal.filter((u) => /\/profile\/|\/mip\/|\/biz\//i.test(u))
        console.log(`       profile links: ${profiles.length}`)
        for (const u of profiles.slice(0, 5)) console.log(`        ${u.slice(0, 105)}`)
      }
    } catch (e) {
      console.log(`    fetch failed: ${(e as Error).message}`)
    }
  }
}
