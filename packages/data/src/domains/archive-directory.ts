import 'server-only'
import {
  NON_ACQUIRABLE_HOSTS,
  isInfrastructureHost,
  registrableDomain,
} from '@rnr/core'

/**
 * Recover business domains from ARCHIVED directory category pages.
 *
 * ==================== WHY THE ARCHIVE AND NOT THE LIVE PAGE ================
 * Every present-tense source enumerates businesses that are visible NOW: a map
 * pack, an organic SERP. A business that closed in 2016 is in none of them. The
 * archive is the only source that still holds a record of it.
 *
 * Measured on ten domains recovered from 2011-2013 YellowPages snapshots: five
 * were not live businesses and four were outright AVAILABLE, against 16% and
 * 2.5% for the present-tense pipeline.
 *
 * bbb.org returns 403 to everything including DataForSEO, but web.archive.org
 * serves archived copies of it happily -- the archive is a way around a door
 * that is otherwise closed.
 * ==========================================================================
 */

const CDX = 'http://web.archive.org/cdx/search/cdx'

export interface ArchiveSnapshot {
  timestamp: string
  original: string
}

export interface RecoveredDomain {
  domain: string
  /** Which directory and snapshot produced it, for audit. */
  source: string
  snapshotYear: number
}

export interface DirectorySpec {
  name: string
  /**
   * Category-page path for a market + niche.
   *
   * Returns null when this directory has no URL shape for the input rather than
   * guessing one -- a fabricated path yields an empty CDX result, which reads
   * as "nothing was ever archived here" and is a different claim entirely.
   */
  path: (args: { citySlug: string; stateCode: string; nicheSlug: string }) => string | null
  /** True when the category page links straight to business websites. */
  oneHop: boolean
}

/**
 * The directories worth trying, and what is known about each.
 *
 * MEASURED 2026-08-13:
 *   YellowPages  one hop, archived 2011-2024, ~6-17 business domains per page
 *   BBB          TWO hops in both 2019 and 2025 -- category pages carry only
 *                bbb.org profile links, BBB affiliates and adtech
 */
export const DIRECTORIES: readonly DirectorySpec[] = [
  {
    name: 'yellowpages',
    path: ({ citySlug, stateCode, nicheSlug }) =>
      `yellowpages.com/${citySlug}-${stateCode.toLowerCase()}/${nicheSlug}`,
    oneHop: true,
  },
  {
    name: 'superpages',
    path: ({ citySlug, stateCode, nicheSlug }) =>
      `superpages.com/${citySlug}-${stateCode.toLowerCase()}/${nicheSlug}`,
    oneHop: true,
  },
  {
    name: 'merchantcircle',
    path: ({ citySlug, stateCode, nicheSlug }) =>
      `merchantcircle.com/${nicheSlug}-${citySlug}-${stateCode.toLowerCase()}`,
    oneHop: true,
  },
  {
    name: 'bbb',
    path: ({ citySlug, stateCode, nicheSlug }) =>
      `bbb.org/us/${stateCode.toLowerCase()}/${citySlug}/category/${nicheSlug}`,
    // Measured two-hop. Kept so the profile-crawl arm has a source.
    oneHop: false,
  },
]

/** `Pleasant Prairie` -> `pleasant-prairie`. */
export function citySlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

/**
 * List archived snapshots for a URL.
 *
 * ==================== TWO CDX TRAPS, BOTH MEASURED ====================
 * Neither returns an error. Both return HTTP 200 with an EMPTY BODY, which is
 * indistinguishable from "nothing was ever archived at this URL" -- and was
 * recorded as exactly that during the probes, twice.
 *
 *   1. `filter=statuscode:200` and `collapse=timestamp:6` empty the response.
 *      Filter in code instead.
 *   2. `encodeURIComponent` on the `url` param empties it too. Pass it raw.
 * ======================================================================
 */
export async function listSnapshots(
  url: string,
  opts: { limit?: number; timeoutMs?: number } = {},
): Promise<ArchiveSnapshot[]> {
  const q = `${CDX}?url=${url}&output=json&limit=${opts.limit ?? 60}`
  const res = await fetch(q, { signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000) })
  if (!res.ok) return []
  const text = await res.text()
  if (!text.trim()) return []

  let rows: string[][]
  try {
    rows = JSON.parse(text) as string[][]
  } catch {
    return []
  }
  return rows
    .slice(1) // row 0 is the header
    .filter((r) => r[4] === '200')
    .map((r) => ({ timestamp: r[1] ?? '', original: r[2] ?? '' }))
    .filter((s) => s.timestamp && s.original)
}

/**
 * Pick the snapshots worth fetching.
 *
 * Oldest first, then spread across distinct years. Recent snapshots are worth
 * far less: the 2025 BBB page is client-rendered and carried no business links
 * at all, while the 2013 YellowPages page carried seventeen. Old pages are both
 * server-rendered AND more likely to list businesses that have since died.
 */
export function pickSnapshots(snaps: ArchiveSnapshot[], count: number): ArchiveSnapshot[] {
  if (snaps.length === 0) return []
  const byYear = new Map<string, ArchiveSnapshot>()
  for (const s of snaps) {
    const year = s.timestamp.slice(0, 4)
    if (!byYear.has(year)) byYear.set(year, s)
  }
  return [...byYear.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(0, count)
    .map(([, s]) => s)
}

/**
 * Business domains linked from one archived page.
 *
 * Uses the real normaliser plus the infrastructure set. A hand-rolled regex did
 * this job during the probes and reported fifteen adtech hosts as businesses.
 */
export function extractBusinessDomains(html: string): string[] {
  const found = new Set<string>()

  for (const m of html.matchAll(/href="([^"]+)"/gi)) {
    const href = m[1] ?? ''
    // Wayback rewrites every link to /web/<timestamp>/<original>. Anything that
    // does not carry that wrapper is site chrome, not an outbound link.
    const unwrapped = href.match(/\/web\/\d+(?:[a-z_]+)?\/(https?:\/\/.+)$/i)?.[1]
    if (!unwrapped) continue

    const n = registrableDomain(unwrapped)
    if (!n || n.nonAcquirable) continue
    if (NON_ACQUIRABLE_HOSTS.has(n.domain)) continue
    if (isInfrastructureHost(n.domain)) continue
    found.add(n.domain)
  }
  return [...found]
}

/**
 * Profile-page links, for the two-hop arm.
 *
 * ==================== THE FIRST VERSION FOUND ZERO ====================
 * It required the full Wayback wrapper AND an absolute `http://` immediately
 * after the timestamp:
 *
 *   /web/\d+/(https?:\/\/[^"]*\/mip\/[^"]+)
 *
 * The archived 2013 YellowPages page carries **307** `/mip/` links and that
 * pattern matched none of them, because Wayback does not rewrite every link to
 * an absolute form -- plenty stay relative (`/mip/joes-plumbing-123`). The arm
 * reported "+0 domains, 0 profiles fetched", which reads exactly like "profile
 * pages carry nothing" and is a completely different claim.
 *
 * So: match any href containing the profile marker, then normalise to an
 * absolute original URL, whichever form it arrived in.
 * =====================================================================
 */
export function extractProfileLinks(html: string, directory: string): string[] {
  const marker = directory === 'bbb' ? '/profile/' : '/mip/'
  const host = directory === 'bbb' ? 'https://www.bbb.org' : 'http://www.yellowpages.com'

  const out = new Set<string>()
  for (const m of html.matchAll(/href="([^"]+)"/gi)) {
    const href = m[1] ?? ''
    if (!href.toLowerCase().includes(marker)) continue

    // Form 1: wrapped and absolute — /web/<ts>/http://host/mip/...
    const wrapped = href.match(/\/web\/\d+(?:[a-z_]+)?\/(https?:\/\/.+)$/i)?.[1]
    if (wrapped) {
      out.add(wrapped)
      continue
    }
    // Form 2: already absolute.
    if (/^https?:\/\//i.test(href)) {
      out.add(href)
      continue
    }
    // Form 3: relative to the directory's own host — the case that was missed.
    if (href.startsWith('/')) out.add(`${host}${href}`)
  }
  return [...out]
}

/** Fetch one archived page. Returns null rather than throwing on any failure. */
export async function fetchSnapshot(
  snap: ArchiveSnapshot,
  timeoutMs = 60_000,
): Promise<string | null> {
  const url = `http://web.archive.org/web/${snap.timestamp}/${snap.original}`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return null
    return await res.text()
  } catch {
    return null
  }
}

export interface HarvestArgs {
  city: string
  stateCode: string
  nicheSlug: string
  directories?: readonly DirectorySpec[]
  /** Snapshots per directory. */
  snapshotsPerDirectory?: number
  /** Hard cap on two-hop profile fetches per snapshot. */
  maxProfilesPerSnapshot?: number
  twoHop?: boolean
  onProgress?: (msg: string) => void
}

export interface HarvestResult {
  domains: RecoveredDomain[]
  stats: {
    directoriesTried: number
    directoriesWithSnapshots: number
    snapshotsFetched: number
    profilesFetched: number
    /** Profile links seen but not fetched because of the cap. */
    profilesSkipped: number
  }
}

/**
 * Harvest one market + niche across the archived directories.
 *
 * Free: web.archive.org only. No DataForSEO, no spend.
 */
export async function harvestFromArchives(args: HarvestArgs): Promise<HarvestResult> {
  const dirs = args.directories ?? DIRECTORIES
  const slug = citySlug(args.city)
  const perDir = args.snapshotsPerDirectory ?? 2
  const maxProfiles = args.maxProfilesPerSnapshot ?? 60

  const byDomain = new Map<string, RecoveredDomain>()
  const stats = {
    directoriesTried: 0,
    directoriesWithSnapshots: 0,
    snapshotsFetched: 0,
    profilesFetched: 0,
    profilesSkipped: 0,
  }

  for (const dir of dirs) {
    const path = dir.path({ citySlug: slug, stateCode: args.stateCode, nicheSlug: args.nicheSlug })
    if (!path) continue
    stats.directoriesTried += 1

    let snaps: ArchiveSnapshot[]
    try {
      snaps = await listSnapshots(path)
    } catch {
      continue
    }
    if (snaps.length === 0) {
      args.onProgress?.(`    ${dir.name}: no snapshots`)
      continue
    }
    stats.directoriesWithSnapshots += 1

    const picked = pickSnapshots(snaps, perDir)
    args.onProgress?.(
      `    ${dir.name}: ${snaps.length} snapshots, fetching ${picked.length} (${picked
        .map((p) => p.timestamp.slice(0, 4))
        .join(', ')})`,
    )

    for (const snap of picked) {
      const html = await fetchSnapshot(snap)
      if (!html) continue
      stats.snapshotsFetched += 1
      const year = Number(snap.timestamp.slice(0, 4))

      for (const d of extractBusinessDomains(html)) {
        if (!byDomain.has(d)) {
          byDomain.set(d, { domain: d, source: `${dir.name}:${year}`, snapshotYear: year })
        }
      }

      // ---- Two-hop: the profile pages, where most of the yield is ----
      if (args.twoHop) {
        const profiles = extractProfileLinks(html, dir.name)
        const take = profiles.slice(0, maxProfiles)
        stats.profilesSkipped += Math.max(0, profiles.length - take.length)

        for (const profileUrl of take) {
          const phtml = await fetchSnapshot(
            { timestamp: snap.timestamp, original: profileUrl },
            30_000,
          )
          stats.profilesFetched += 1
          if (!phtml) continue
          for (const d of extractBusinessDomains(phtml)) {
            if (!byDomain.has(d)) {
              byDomain.set(d, {
                domain: d,
                source: `${dir.name}:${year}:profile`,
                snapshotYear: year,
              })
            }
          }
        }
      }
    }
  }

  return { domains: [...byDomain.values()], stats }
}
