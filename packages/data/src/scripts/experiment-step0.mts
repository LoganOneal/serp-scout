import 'dotenv/config'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import {
  assessAcquisition,
  hasAnyLocalityToken,
  isInfrastructureHost,
  registrableDomain,
  NON_ACQUIRABLE_HOSTS,
  type AcquisitionVerdict,
} from '@rnr/core'
import { db } from '../db.js'
import { spendLedger } from '../schema.js'
import { harvestFromArchives, DIRECTORIES } from '../domains/archive-directory.js'
import { triageDomain } from '../domains/enrich-pipeline.js'
import { fetchWaybackHistory } from '../domains/wayback.js'
import { runQualityGates } from '../domains/quality-gates.js'
import { DataForSeoClient, fetchAccountStatus } from '../providers/dataforseo/client.js'

/**
 * STEP 0 — at what rate does each discovery angle produce a domain worth buying?
 *
 * ==================== THIS IS AN EXPERIMENT, NOT A FEATURE ====================
 * The probes proved discovery works and then undercut it: of ten domains
 * recovered from a 2013 archive, exactly one had surviving equity, and it
 * carried spam 46. n = 10, one market.
 *
 * The decision rules are in docs/plan-step0-experiment.md §4 and were written
 * BEFORE this ran, because a 6% hit rate is otherwise argued into "promising"
 * after the fact.
 *
 *   BUY >= 5%                      -> build the buy list
 *   BUY < 5% and OUTREACH >= 15%   -> ship an outreach list instead
 *   both below                     -> stop; record the negative result
 *
 * With n ~ 300 a 5% rate carries roughly +/-2.5pp, so 2.5-7.5% is NOT a
 * decision -- it is a request for a bigger sample.
 * ============================================================================
 *
 * Spend is ledgered (`note = experiment=step0`) and hard-capped. The probes
 * moved $1.34 off the books; this does not.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Hard cap. The run STOPS rather than exceeding it. */
const BUDGET_USD = Number(process.env['STEP0_BUDGET_USD'] ?? 1.0)

/** Markets spanning sizes — archive coverage is known to vary with market size. */
const MARKETS = [
  { city: 'Kenosha', stateCode: 'WI', tokens: ['kenosha'] },
  { city: 'Milwaukee', stateCode: 'WI', tokens: ['milwaukee'] },
  { city: 'Tucson', stateCode: 'AZ', tokens: ['tucson'] },
  { city: 'Chattanooga', stateCode: 'TN', tokens: ['chattanooga'] },
  { city: 'Chicago', stateCode: 'IL', tokens: ['chicago'] },
]

const NICHES = [
  { slug: 'plumbers', token: 'plumb' },
  { slug: 'air-conditioning-contractors-systems', token: 'hvac' },
  { slug: 'electricians', token: 'electric' },
]

const ARMS = ['B_archive_onehop', 'C_archive_twohop', 'D_whois', 'E_other_dirs'] as const
type Arm = (typeof ARMS)[number]

const argv = process.argv.slice(2)
const only = argv.filter((a) => !a.startsWith('--'))
const armWanted = (a: Arm): boolean => only.length === 0 || only.includes(a)

/**
 * Measurements are cached to disk so the ASSESSMENT can be re-run for free.
 *
 * The first run cost 9 minutes of wall clock and $0.117 of backlink data, and
 * then showed that the assessor needed two fixes. Re-buying the same
 * measurements to re-apply a pure function is pure waste -- and worse, it
 * changes the sample between runs, so the before/after is no longer a
 * comparison of the fix.
 */
const CACHE = process.env['STEP0_CACHE'] ?? '.cache/step0-measurements.json'
const useCache = argv.includes('--cache')
const reassessOnly = argv.includes('--reassess')

interface CachedRow {
  domain: string
  arms: Arm[]
  sources: string[]
  status: string
  years: number | null
  refdom: number | null
  spam: number | null
}

// ---------------------------------------------------------------------------
// Spend control
// ---------------------------------------------------------------------------

const login = process.env['DATAFORSEO_LOGIN']?.trim()
const password = process.env['DATAFORSEO_PASSWORD']?.trim()
if (!login || !password) {
  console.error('DATAFORSEO_LOGIN / PASSWORD missing')
  process.exit(1)
}
const client = new DataForSeoClient({ credentials: { login, password }, timeoutMs: 120_000 })
const database = db()

let openingBalance = 0
let spentUsd = 0

async function balance(): Promise<number> {
  return (await fetchAccountStatus(client)).balanceUsd
}

/**
 * Record a purchase and refuse to continue past the cap.
 *
 * Written at the moment of purchase, exactly like recordEnrichSpend: a run that
 * fails after spending must still show the spend.
 */
async function ledger(endpoint: string, costUsd: number, rows: number): Promise<void> {
  spentUsd += costUsd
  if (costUsd <= 0) return
  await database.insert(spendLedger).values({
    endpoint,
    costMicros: BigInt(Math.round(costUsd * 1_000_000)),
    rows,
    note: 'experiment=step0',
  })
}

function assertBudget(nextCostUsd: number, what: string): void {
  if (spentUsd + nextCostUsd > BUDGET_USD) {
    throw new Error(
      `BUDGET CAP: ${what} would take spend to $${(spentUsd + nextCostUsd).toFixed(4)}, ` +
        `over the $${BUDGET_USD.toFixed(2)} cap. Stopping.`,
    )
  }
}

// ---------------------------------------------------------------------------
// Harvest
// ---------------------------------------------------------------------------

interface Harvested {
  domain: string
  arms: Set<Arm>
  sources: Set<string>
}

const harvested = new Map<string, Harvested>()

function record(domain: string, arm: Arm, source: string): void {
  const existing = harvested.get(domain)
  if (existing) {
    existing.arms.add(arm)
    existing.sources.add(source)
    return
  }
  harvested.set(domain, { domain, arms: new Set([arm]), sources: new Set([source]) })
}

const YP_ONLY = DIRECTORIES.filter((d) => d.name === 'yellowpages')
const OTHER_DIRS = DIRECTORIES.filter((d) => d.name !== 'yellowpages' && d.oneHop)

async function runArchiveArms(): Promise<void> {
  for (const market of MARKETS) {
    for (const niche of NICHES) {
      console.log(`\n  ${market.city}, ${market.stateCode} · ${niche.slug}`)

      if (armWanted('B_archive_onehop')) {
        const r = await harvestFromArchives({
          city: market.city,
          stateCode: market.stateCode,
          nicheSlug: niche.slug,
          directories: YP_ONLY,
          snapshotsPerDirectory: 3,
          onProgress: (m) => console.log(m),
        })
        for (const d of r.domains) record(d.domain, 'B_archive_onehop', d.source)
        console.log(`      B one-hop: +${r.domains.length} domains`)
      }

      if (armWanted('E_other_dirs')) {
        const r = await harvestFromArchives({
          city: market.city,
          stateCode: market.stateCode,
          nicheSlug: niche.slug,
          directories: OTHER_DIRS,
          snapshotsPerDirectory: 2,
          onProgress: (m) => console.log(m),
        })
        for (const d of r.domains) record(d.domain, 'E_other_dirs', d.source)
        console.log(`      E other dirs: +${r.domains.length} domains`)
      }
    }
  }

  /**
   * Two-hop runs on ONE market only. At up to 60 profile fetches per snapshot it
   * is the single thing here that can run for hours, and one market answers
   * "does the profile crawl multiply the yield" perfectly well.
   */
  if (armWanted('C_archive_twohop')) {
    const m = MARKETS[0]!
    console.log(`\n  TWO-HOP (${m.city} only, capped): plumbers`)
    const r = await harvestFromArchives({
      city: m.city,
      stateCode: m.stateCode,
      nicheSlug: 'plumbers',
      directories: YP_ONLY,
      snapshotsPerDirectory: 1,
      twoHop: true,
      maxProfilesPerSnapshot: 40,
      onProgress: (msg) => console.log(msg),
    })
    for (const d of r.domains) record(d.domain, 'C_archive_twohop', d.source)
    console.log(
      `      C two-hop: +${r.domains.length} domains · ${r.stats.profilesFetched} profiles fetched, ${r.stats.profilesSkipped} skipped by cap`,
    )
  }
}

// ---------------------------------------------------------------------------
// Arm D — WHOIS name-token queries
// ---------------------------------------------------------------------------

const WHOIS = '/domain_analytics/whois/overview/live'
const WHOIS_COST = 0.1269

async function runWhoisArm(): Promise<void> {
  if (!armWanted('D_whois')) return

  for (const market of MARKETS) {
    assertBudget(WHOIS_COST, `WHOIS query for ${market.city}`)
    const token = market.tokens[0]!

    /**
     * Locality token + a real link profile. Deliberately NOT filtered on
     * expiration_datetime: that field is a stale snapshot (it returns
     * freepik.com as expired), so it belongs in triage, not in the query.
     */
    const payload = {
      limit: 100,
      filters: [
        ['domain', 'like', `%${token}%`],
        'and',
        ['backlinks_info.referring_domains', '>', 3],
      ],
      order_by: ['backlinks_info.referring_domains,desc'],
    }

    try {
      const res = await client.post<Array<{ items?: Array<{ domain?: string }> }>>(WHOIS, [payload])
      const items = res?.[0]?.items ?? []
      await ledger(WHOIS, WHOIS_COST, items.length)

      let kept = 0
      for (const it of items) {
        const n = registrableDomain(it.domain ?? null)
        if (!n || n.nonAcquirable) continue
        if (NON_ACQUIRABLE_HOSTS.has(n.domain) || isInfrastructureHost(n.domain)) continue
        // Boundary-safe: a bare substring test counted every wiki* domain as
        // local during the citation-hub probe.
        if (!hasAnyLocalityToken(n.domain, market.tokens)) continue
        record(n.domain, 'D_whois', `whois:${token}`)
        kept += 1
      }
      console.log(`  WHOIS ${market.city}: ${items.length} rows -> ${kept} kept`)
    } catch (e) {
      console.log(`  WHOIS ${market.city}: FAILED ${(e as Error).message.slice(0, 90)}`)
    }
  }
}

// ---------------------------------------------------------------------------
// Triage + value
// ---------------------------------------------------------------------------

interface Assessed {
  domain: string
  arms: Arm[]
  status: string
  years: number | null
  refdom: number | null
  spam: number | null
  verdict: AcquisitionVerdict
  reason: string
}

/**
 * Persist the harvest before triage begins.
 *
 * The first full run was killed by a wall-clock limit at 350 of 752 domains and
 * lost EVERYTHING -- including 500 domains that had cost $0.635 of WHOIS
 * queries. Harvest is slow but free; triage is slower. Neither should have to
 * be repeated because the other timed out.
 */
const HARVEST_CACHE = process.env['STEP0_HARVEST'] ?? '.cache/step0-harvest.json'

function saveHarvest(): void {
  const rows = [...harvested.values()].map((h) => ({
    domain: h.domain,
    arms: [...h.arms],
    sources: [...h.sources],
  }))
  const prior: typeof rows = existsSync(HARVEST_CACHE)
    ? (JSON.parse(readFileSync(HARVEST_CACHE, 'utf8')) as typeof rows)
    : []
  const merged = new Map(prior.map((r) => [r.domain, r]))
  for (const r of rows) {
    const e = merged.get(r.domain)
    merged.set(r.domain, e ? { ...r, arms: [...new Set([...e.arms, ...r.arms])] } : r)
  }
  writeFileSync(HARVEST_CACHE, JSON.stringify([...merged.values()], null, 2))
  console.log(`  harvest cached: ${merged.size} domains → ${HARVEST_CACHE}`)
}

function loadHarvest(): void {
  if (!existsSync(HARVEST_CACHE)) return
  const rows = JSON.parse(readFileSync(HARVEST_CACHE, 'utf8')) as Array<{
    domain: string
    arms: Arm[]
    sources: string[]
  }>
  for (const r of rows) {
    harvested.set(r.domain, {
      domain: r.domain,
      arms: new Set(r.arms),
      sources: new Set(r.sources),
    })
  }
  console.log(`Loaded ${rows.length} domains from harvest cache`)
}

async function assessAll(): Promise<Assessed[]> {
  const all = [...harvested.values()]
  console.log(`\nTriaging ${all.length} unique domains (free stages)…`)

  const triaged = new Map<string, { status: string; years: number | null }>()
  let cursor = 0
  let done = 0

  const worker = async (): Promise<void> => {
    for (;;) {
      const item = all[cursor++]
      if (!item) return
      try {
        const c = await triageDomain(item.domain, [
          { name: item.domain, website: `https://${item.domain}` },
        ])
        // triageDomain skips Wayback on domains that look live, so archive
        // depth is fetched explicitly rather than left null and counted as
        // "never measured".
        const w = c.wayback ?? (await fetchWaybackHistory(item.domain))
        triaged.set(item.domain, {
          status: c.classification.status,
          years: w.ok ? w.yearsOfContinuousContent : null,
        })
      } catch {
        // A domain that will not resolve is dropped, not guessed at.
      }
      done += 1
      if (done % 25 === 0) console.log(`  …${done}/${all.length}`)
    }
  }
  await Promise.all(Array.from({ length: Math.min(10, all.length) }, worker))

  // ---- One bulk request for spam + referring domains across everything ----
  const targets = [...triaged.keys()]
  const bulkCost = 0.024 + targets.length * 3 * 0.000036
  assertBudget(bulkCost, `bulk backlinks for ${targets.length} domains`)

  console.log(`\nBuying spam + link profile for ${targets.length} domains…`)
  const quality = await runQualityGates(targets, { checkSpam: true })
  const actual = Number(quality.costMicros) / 1_000_000
  await ledger('backlinks/bulk_* (step0)', actual, quality.rows.length)
  console.log(`  cost $${actual.toFixed(4)}`)

  const byDomain = new Map(quality.rows.map((r) => [r.domain, r]))

  const measured: CachedRow[] = []
  for (const item of all) {
    const t = triaged.get(item.domain)
    if (!t) continue
    const q = byDomain.get(item.domain)
    measured.push({
      domain: item.domain,
      arms: [...item.arms],
      sources: [...item.sources],
      status: t.status,
      years: t.years,
      refdom: q?.referringDomains ?? null,
      spam: q?.spamScore ?? null,
    })
  }

  // Merge with any prior cache so arms run on different days still combine.
  const prior: CachedRow[] = existsSync(CACHE)
    ? (JSON.parse(readFileSync(CACHE, 'utf8')) as CachedRow[])
    : []
  const merged = new Map(prior.map((r) => [r.domain, r]))
  for (const r of measured) {
    const existing = merged.get(r.domain)
    merged.set(
      r.domain,
      existing ? { ...r, arms: [...new Set([...existing.arms, ...r.arms])] } : r,
    )
  }
  writeFileSync(CACHE, JSON.stringify([...merged.values()], null, 2))
  console.log(`  cached ${merged.size} measured domains → ${CACHE}`)

  return assessCached([...merged.values()])
}

/** Apply the (pure) verdict to already-measured rows. Free, repeatable. */
function assessCached(rows: CachedRow[]): Assessed[] {
  return rows.map((r) => {
    const a = assessAcquisition({
      status: r.status as never,
      yearsOfContent: r.years,
      referringDomains: r.refdom,
      spamScore: r.spam,
    })
    return { ...r, verdict: a.verdict, reason: a.reason }
  })
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function report(rows: Assessed[]): void {
  const line = '='.repeat(78)
  console.log(`\n${line}\nRESULTS\n${line}`)

  const pct = (n: number, d: number) => (d === 0 ? '—' : `${((n / d) * 100).toFixed(1)}%`)

  console.log(`\nPER ARM (a domain found by two arms counts in both):\n`)
  console.log(
    'arm'.padEnd(20) + 'n'.padStart(5) + 'BUY'.padStart(7) + 'OUTREACH'.padStart(10) +
      'NEITHER'.padStart(9) + 'UNKNOWN'.padStart(9) + '   BUY%   OUTREACH%',
  )
  for (const arm of ARMS) {
    const sub = rows.filter((r) => r.arms.includes(arm))
    if (sub.length === 0) continue
    const c = (v: AcquisitionVerdict) => sub.filter((r) => r.verdict === v).length
    console.log(
      arm.padEnd(20) +
        String(sub.length).padStart(5) +
        String(c('BUY')).padStart(7) +
        String(c('OUTREACH')).padStart(10) +
        String(c('NEITHER')).padStart(9) +
        String(c('UNKNOWN_VALUE')).padStart(9) +
        pct(c('BUY'), sub.length).padStart(8) +
        pct(c('OUTREACH'), sub.length).padStart(11),
    )
  }

  const n = rows.length
  const buy = rows.filter((r) => r.verdict === 'BUY')
  const outreach = rows.filter((r) => r.verdict === 'OUTREACH')

  console.log(`\nOVERALL: n=${n}  BUY ${buy.length} (${pct(buy.length, n)})  ` +
    `OUTREACH ${outreach.length} (${pct(outreach.length, n)})`)

  console.log(`\nSTATUS MIX:`)
  const statuses = new Map<string, number>()
  for (const r of rows) statuses.set(r.status, (statuses.get(r.status) ?? 0) + 1)
  for (const [s, c] of [...statuses.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${s.padEnd(16)} ${String(c).padStart(4)}  ${pct(c, n)}`)
  }

  if (buy.length > 0) {
    console.log(`\nBUY LIST:`)
    for (const r of buy.sort((a, b) => (b.refdom ?? 0) - (a.refdom ?? 0))) {
      console.log(
        `  ${r.domain.padEnd(38)} ${r.status.padEnd(14)} ${String(r.years ?? '—').padStart(3)}y ` +
          `refdom ${String(r.refdom ?? '—').padStart(4)} spam ${String(r.spam ?? '—').padStart(3)} [${r.arms.join(',')}]`,
      )
    }
  }

  if (outreach.length > 0) {
    console.log(`\nOUTREACH LIST (top 25 by referring domains):`)
    for (const r of outreach.sort((a, b) => (b.refdom ?? 0) - (a.refdom ?? 0)).slice(0, 25)) {
      console.log(
        `  ${r.domain.padEnd(38)} ${r.status.padEnd(14)} ${String(r.years ?? '—').padStart(3)}y ` +
          `refdom ${String(r.refdom ?? '—').padStart(4)} spam ${String(r.spam ?? '—').padStart(3)} [${r.arms.join(',')}]`,
      )
    }
  }

  // ---- The pre-registered decision ----
  const buyPct = n === 0 ? 0 : (buy.length / n) * 100
  const outPct = n === 0 ? 0 : (outreach.length / n) * 100
  console.log(`\n${line}\nDECISION (rules fixed before the run)\n${line}`)
  if (n < 100) {
    console.log(`INCONCLUSIVE — n=${n} is too small to decide on. Widen the harvest.`)
  } else if (buyPct >= 7.5) {
    console.log(`BUY LIST VIABLE — ${buyPct.toFixed(1)}% clears 5% with the interval.`)
  } else if (buyPct >= 2.5) {
    console.log(
      `INSIDE THE CONFIDENCE BAND — ${buyPct.toFixed(1)}% is within +/-2.5pp of the 5% line.\n` +
        `Not a decision. Needs a bigger sample.`,
    )
  } else if (outPct >= 15) {
    console.log(
      `OUTREACH ONLY — BUY ${buyPct.toFixed(1)}% is below the line, OUTREACH ${outPct.toFixed(1)}% clears 15%.\n` +
        `Ship an outreach list; the buy list is a labelled sub-tab.`,
    )
  } else {
    console.log(
      `NOT WORTH BUILDING — BUY ${buyPct.toFixed(1)}%, OUTREACH ${outPct.toFixed(1)}%.\n` +
        `Record the negative result and keep the present-tense pipeline.`,
    )
  }
}

// ---------------------------------------------------------------------------

const started = Date.now()
openingBalance = await balance()
console.log(`Budget cap: $${BUDGET_USD.toFixed(2)}   ·   opening balance $${openingBalance.toFixed(4)}`)
console.log(`Arms: ${only.length === 0 ? ARMS.join(', ') : only.join(', ')}`)

try {
  if (reassessOnly) {
    // Re-apply the verdict to cached measurements. No network, no spend.
    const rows = JSON.parse(readFileSync(CACHE, 'utf8')) as CachedRow[]
    console.log(`\nRe-assessing ${rows.length} cached domains (no spend)…`)
    report(assessCached(rows))
  } else {
    console.log(`\n${'='.repeat(78)}\nHARVEST\n${'='.repeat(78)}`)
    if (useCache) loadHarvest()
    await runArchiveArms()
    await runWhoisArm()
    saveHarvest()

    console.log(`\nUnique domains harvested: ${harvested.size}`)
    if (harvested.size === 0) {
      console.log('Nothing harvested — no rates to compute.')
    } else {
      report(await assessAll())
    }
  }
} catch (e) {
  console.error(`\nSTOPPED: ${(e as Error).message}`)
} finally {
  const closing = await balance()
  console.log(
    `\nSpend: $${(openingBalance - closing).toFixed(4)} (ledgered as experiment=step0) · ` +
      `elapsed ${Math.round((Date.now() - started) / 1000)}s`,
  )
  await database.$client.end?.()
  process.exit(0)
}
