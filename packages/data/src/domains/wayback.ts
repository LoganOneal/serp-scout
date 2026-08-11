/**
 * Stage 5b — archive history.
 *
 * Free, unauthenticated, and the only enrichment that speaks to whether a
 * domain ever carried a real business rather than just old links. A domain with
 * eleven unbroken years of HTML and a domain registered in 2009 that has only
 * ever served a parking page look identical in RDAP and very different here.
 */

const CDX_URL = 'https://web.archive.org/cdx/search/cdx'

export interface WaybackHistory {
  firstSnapshotAt: Date | null
  /** Most recent snapshot that actually returned HTML with a 200. */
  lastContentSnapshotAt: Date | null
  totalSnapshots: number
  /** Distinct calendar years with at least one content snapshot. */
  contentYears: number
  /** Longest run of CONSECUTIVE years carrying content. */
  yearsOfContinuousContent: number
  /** False when the CDX request failed — distinguishes "no history" from "no answer". */
  ok: boolean
  detail: string
}

const EMPTY = (detail: string, ok: boolean): WaybackHistory => ({
  firstSnapshotAt: null,
  lastContentSnapshotAt: null,
  totalSnapshots: 0,
  contentYears: 0,
  yearsOfContinuousContent: 0,
  ok,
  detail,
})

/** CDX timestamps are `yyyyMMddHHmmss` in UTC. */
function parseCdxTimestamp(ts: string): Date | null {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?$/.exec(ts)
  if (!m) return null
  const d = new Date(
    Date.UTC(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      Number(m[4] ?? '0'),
      Number(m[5] ?? '0'),
      Number(m[6] ?? '0'),
    ),
  )
  return Number.isNaN(d.getTime()) ? null : d
}

function longestConsecutiveRun(years: number[]): number {
  if (years.length === 0) return 0
  const sorted = [...new Set(years)].sort((a, b) => a - b)
  let best = 1
  let run = 1
  for (let i = 1; i < sorted.length; i += 1) {
    run = sorted[i]! === sorted[i - 1]! + 1 ? run + 1 : 1
    if (run > best) best = run
  }
  return best
}

export interface WaybackOptions {
  fetchImpl?: typeof fetch
  timeoutMs?: number
  /** Cap on rows returned; a busy domain can have hundreds of thousands. */
  limit?: number
}

/**
 * Snapshot history for a domain.
 *
 * `collapse=timestamp:6` asks the CDX index for one row per month, which is
 * ample for "did this carry content in year N" and keeps the response small on
 * domains with a decade of daily crawls.
 *
 * ====================== WHAT "CONTENT" MEANS HERE ======================
 * A content snapshot is HTTP 200 with an HTML mime type. That is a proxy, not
 * a guarantee: a parking page also returns 200 text/html, so a long content
 * history can include parked years. Distinguishing them would mean fetching and
 * classifying each snapshot body, which is a different order of cost, so the
 * limitation is stated rather than hidden behind a confident number.
 * =======================================================================
 */
export async function fetchWaybackHistory(
  domain: string,
  opts: WaybackOptions = {},
): Promise<WaybackHistory> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const controller = new AbortController()
  // Archive's CDX index is genuinely slow — a healthy exact query measured
  // ~10s — so a tight timeout would report "no history" for domains that have
  // plenty of it, which is the one failure this stage must not produce.
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000)

  const params = new URLSearchParams({
    url: domain,
    // ============ matchType=exact IS NOT A SIMPLIFICATION ============
    // The obvious query is `url=domain/*`, every path ever archived. Measured
    // against the live CDX index it returns HTTP 504 after 60s — the prefix
    // scan is too expensive for Archive to serve. `matchType=exact` answers the
    // homepage in ~10s, and the homepage is the signal we actually want: "was
    // a site being served here, in which years". Whether /about was archived
    // adds nothing to that and costs an endpoint that will not answer.
    // =================================================================
    matchType: 'exact',
    output: 'json',
    fl: 'timestamp,statuscode,mimetype',
    collapse: 'timestamp:6',
    limit: String(opts.limit ?? 2_000),
  })

  try {
    const res = await fetchImpl(`${CDX_URL}?${params.toString()}`, { signal: controller.signal })
    if (!res.ok) return EMPTY(`Wayback CDX returned HTTP ${res.status}.`, false)

    const body = (await res.json()) as unknown
    if (!Array.isArray(body) || body.length === 0) {
      return EMPTY('No snapshots recorded for this domain.', true)
    }

    // First row is the header when `output=json`.
    const rows = (body as string[][]).slice(1).filter((r) => Array.isArray(r) && r.length >= 1)
    if (rows.length === 0) return EMPTY('No snapshots recorded for this domain.', true)

    let firstSnapshotAt: Date | null = null
    let lastContentSnapshotAt: Date | null = null
    const contentYears: number[] = []

    for (const row of rows) {
      const at = parseCdxTimestamp(row[0] ?? '')
      if (!at) continue
      if (!firstSnapshotAt || at < firstSnapshotAt) firstSnapshotAt = at

      const statusCode = row[1] ?? ''
      const mime = row[2] ?? ''
      const isContent = statusCode === '200' && mime.includes('html')
      if (isContent) {
        if (!lastContentSnapshotAt || at > lastContentSnapshotAt) lastContentSnapshotAt = at
        contentYears.push(at.getUTCFullYear())
      }
    }

    return {
      firstSnapshotAt,
      lastContentSnapshotAt,
      totalSnapshots: rows.length,
      contentYears: new Set(contentYears).size,
      yearsOfContinuousContent: longestConsecutiveRun(contentYears),
      ok: true,
      detail: `${rows.length} monthly snapshot row(s) indexed.`,
    }
  } catch (e) {
    return EMPTY(`Wayback CDX request failed (${(e as Error).name}: ${(e as Error).message}).`, false)
  } finally {
    clearTimeout(timer)
  }
}
