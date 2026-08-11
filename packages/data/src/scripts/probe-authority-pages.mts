/**
 * Are the high-authority citation sources actually fetchable, and do their
 * pages carry business domains we can extract?
 *
 * BBB and chamber sites sit behind bot protection that refuses datacenter IPs,
 * which is why this goes through DataForSEO's instant_pages rather than fetch().
 * Costs ~$0.00015 per page.
 *
 *   pnpm exec tsx packages/data/src/scripts/probe-authority-pages.mts [url...]
 */
import 'dotenv/config'
import { registrableDomain } from '@rnr/core'
import { createDfsClientFromEnv } from '../providers/dataforseo/keyword-volume.js'
import { fetchPageHtml } from '../providers/dataforseo/instant-pages.js'

const URLS =
  process.argv.slice(2).length > 0
    ? process.argv.slice(2)
    : [
        'https://www.bbb.org/us/tx/dallas/category/air-conditioning-repair',
        'https://www.bbb.org/us/tx/dallas/category/air-conditioning-heating-contractors-commercial/accredited',
        'https://www.dallaschamber.org',
      ]

const client = createDfsClientFromEnv()
if (!client) throw new Error('DataForSEO credentials are not configured.')

/** Every href on the page, as a registrable domain, with counts. */
function outboundDomains(html: string, sourceUrl: string) {
  const source = registrableDomain(sourceUrl)?.domain ?? ''
  const counts = new Map<string, number>()
  const hrefs = html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)
  let total = 0
  for (const m of hrefs) {
    const raw = m[1]!
    if (!/^https?:\/\//i.test(raw)) continue
    total += 1
    const d = registrableDomain(raw)?.domain
    if (!d || d === source) continue
    counts.set(d, (counts.get(d) ?? 0) + 1)
  }
  return { counts, total }
}

/** BBB category pages link to PROFILE pages, not business sites — count those. */
function bbbProfileLinks(html: string): string[] {
  const out = new Set<string>()
  for (const m of html.matchAll(/href\s*=\s*["'](\/us\/[a-z]{2}\/[^"'?#]+\/profile\/[^"'?#]+)["']/gi)) {
    out.add(`https://www.bbb.org${m[1]!}`)
  }
  return [...out]
}

for (const url of URLS) {
  console.log(`\n=== ${url}`)
  try {
    const r = await fetchPageHtml(client, url)
    console.log(`  status ${r.statusCode ?? '—'} · ${r.html.length} bytes html`)
    if (r.html.length === 0) {
      console.log('  EMPTY BODY — blocked or unrenderable without JS')
      continue
    }

    const blocked = /captcha|are you a human|access denied|request blocked|cf-browser-verification/i.test(
      r.html.slice(0, 20000),
    )
    if (blocked) console.log('  LOOKS BLOCKED (challenge markers in the first 20KB)')

    const { counts, total } = outboundDomains(r.html, url)
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1])
    console.log(`  ${total} absolute href(s) · ${sorted.length} distinct off-site domain(s)`)
    for (const [d, n] of sorted.slice(0, 15)) console.log(`     ${String(n).padStart(3)}  ${d}`)

    const profiles = bbbProfileLinks(r.html)
    if (profiles.length > 0) {
      console.log(`  ${profiles.length} BBB profile link(s), e.g.:`)
      for (const p of profiles.slice(0, 3)) console.log(`     ${p}`)
    }
  } catch (e) {
    console.log(`  FAILED: ${(e as Error).message}`)
  }
}
process.exit(0)
