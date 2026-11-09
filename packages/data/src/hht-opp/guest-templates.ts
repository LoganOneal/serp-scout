import 'server-only'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  GUEST_TEMPLATES,
  GUEST_TOURISM_REGIONS,
  guestMetroEntities,
  guestStateEntities,
  guestTemplateStats,
  guestYieldBaseline,
  matchGuestTemplate,
  normalizeFrontierKeyword,
  parseLeadCsv,
  rankGuestTemplateCandidates,
  type FetchedGuestKeyword,
  type GuestBucketId,
  type GuestEntity,
  type GuestTemplateCandidate,
  type GuestTemplateHistoryRow,
  type GuestTemplateRanking,
  type GuestTemplateStats,
  type GuestYieldBaseline,
  type Neighborhood,
} from '@rnr/core'
import { and, asc, eq, inArray } from 'drizzle-orm'
import type { Database } from '../db.js'
import { STATE_NAMES } from '../ingest/census-sources.js'
import { ensureKeywordVolumesFromEnv } from '../serp/keyword-volume-cache.js'
import { hhtOppGuestKeywords, localities } from '../schema.js'

/** Queue rows created here carry this source type. */
export const GUEST_TEMPLATE_SOURCE = 'guest_template'
const VOLUME_BATCH = 200
const FETCHED_STATUSES = ['FETCHED', 'SATURATED', 'EXHAUSTED', 'NO_DATA']

export interface GuestTemplateContext {
  entities: GuestEntity[]
  stats: Map<string, GuestTemplateStats>
  baseline: GuestYieldBaseline
  known: string[]
  fetched: FetchedGuestKeyword[]
  yieldsFile: string | null
}

export interface GuestTemplateOptions {
  limit?: number
  buckets?: GuestBucketId[]
  perTemplate?: number
  metros?: number
  /** Tracker export with per-keyword pitchable counts. Defaults to the newest keyword-yields-*.csv. */
  yieldsPath?: string | null
  log?: (message: string) => void
}

export interface GuestTemplatePreview {
  yieldsFile: string | null
  baseline: GuestYieldBaseline
  entities: { cities: number; states: number; regions: number }
  templates: GuestTemplateStats[]
  skipped: GuestTemplateRanking['skipped']
  candidates: GuestTemplateCandidate[]
}

/** Rank template × entity keywords against the current queue. No API calls, no writes. */
export async function previewGuestTemplates(db: Database, options: GuestTemplateOptions = {}): Promise<GuestTemplatePreview> {
  const context = await loadGuestTemplateContext(db, options)
  const ranking = rank(context, options, options.limit ?? 25)
  return {
    yieldsFile: context.yieldsFile,
    baseline: context.baseline,
    entities: {
      cities: context.entities.filter((row) => row.kind === 'city').length,
      states: context.entities.filter((row) => row.kind === 'state').length,
      regions: context.entities.filter((row) => row.kind === 'region').length,
    },
    templates: [...context.stats.values()].sort((a, b) => b.prior - a.prior),
    skipped: ranking.skipped,
    candidates: ranking.candidates,
  }
}

export interface GuestTemplateEnqueueResult {
  retiredTemplates: string[]
  retiredPending: number
  checked: number
  zeroVolume: string[]
  /** Google Ads gave no answer; not queued and not recorded. */
  unchecked: string[]
  queued: Array<{ keyword: string; templateId: string; score: number; volume: number | null }>
  error: string | null
}

/**
 * Volume-check the top candidates and add the survivors to hht_opp_guest_keywords
 * as NEW rows (no priority), in rank order, so `guest-frontier` takes them next and
 * still applies its similarity skip. Zero-volume phrases are stored as SKIPPED so
 * they are never proposed again. Only Google Ads is called; never Semrush.
 */
export async function enqueueGuestTemplates(db: Database, options: GuestTemplateOptions = {}): Promise<GuestTemplateEnqueueResult> {
  const log = options.log ?? ((message: string) => console.log(message))
  const limit = options.limit ?? 25
  const context = await loadGuestTemplateContext(db, options)
  const retired = await retireGuestTemplateKeywords(db, context.stats)
  const result: GuestTemplateEnqueueResult = {
    retiredTemplates: retired.templates,
    retiredPending: retired.rows,
    checked: 0,
    zeroVolume: [],
    unchecked: [],
    queued: [],
    error: null,
  }
  if (retired.rows > 0) log(`Retired ${retired.rows} queued keywords from templates below the yield floor.`)

  // Over-fetch: some candidates will fail the volume gate.
  const ranking = rank(context, options, limit * 3)
  const pending = [...ranking.candidates]
  while (result.queued.length < limit && pending.length > 0) {
    const batch = pending.splice(0, Math.min(VOLUME_BATCH, Math.max(limit - result.queued.length, 1) * 2))
    let volumes: Map<string, number | null>
    try {
      volumes = await lookupVolumes(db, batch.map((row) => row.keyword), log)
    } catch (error) {
      result.error = error instanceof Error ? error.message : 'Google Ads volume lookup failed'
      log(`Volume check failed, nothing more queued: ${result.error}`)
      break
    }
    result.checked += batch.length
    if (batch.every((candidate) => volumes.get(candidate.keyword.toLowerCase()) == null)) {
      result.unchecked.push(...batch.map((candidate) => candidate.keyword))
      log('Google Ads gave no volume for this batch; stopping rather than queueing unchecked keywords.')
      break
    }
    for (const candidate of batch) {
      const volume = volumes.get(candidate.keyword.toLowerCase()) ?? null
      if (volume == null) {
        // Google Ads did not answer. Leave it out of the queue, unrecorded, and ask again next run.
        result.unchecked.push(candidate.keyword)
        continue
      }
      if (volume <= 0) {
        result.zeroVolume.push(candidate.keyword)
        await insertTemplateKeyword(db, candidate, 'SKIPPED', 'zero_volume')
        continue
      }
      if (result.queued.length >= limit) break
      if (await insertTemplateKeyword(db, candidate, 'NEW', null)) {
        result.queued.push({ keyword: candidate.keyword, templateId: candidate.templateId, score: candidate.score, volume })
      }
    }
  }
  if (result.unchecked.length > 0 && result.queued.length === 0) {
    result.error ??= 'Google Ads returned no volume data; nothing queued. Check LIVE_CALLS_ENABLED and the Google Ads credentials.'
  }
  log(`Queued ${result.queued.length} template keywords; ${result.zeroVolume.length} zero-volume, ${result.unchecked.length} without a Google Ads answer.`)
  return result
}

/**
 * Mark still-queued keywords of retired templates RETIRED. Called by
 * `guest-frontier` before each run so a template that falls below the floor
 * stops spending Semrush units straight away.
 */
export async function retireGuestTemplateKeywords(
  db: Database,
  stats?: ReadonlyMap<string, GuestTemplateStats>,
): Promise<{ templates: string[]; rows: number }> {
  const current = stats ?? (await loadGuestTemplateContext(db, {})).stats
  const templates = [...current.values()].filter((row) => row.retired).map((row) => row.templateId)
  if (templates.length === 0) return { templates, rows: 0 }
  const retiredSet = new Set(templates)
  const pending = await db.select({ id: hhtOppGuestKeywords.id, keyword: hhtOppGuestKeywords.keyword })
    .from(hhtOppGuestKeywords)
    .where(and(eq(hhtOppGuestKeywords.status, 'NEW'), eq(hhtOppGuestKeywords.sourceType, GUEST_TEMPLATE_SOURCE)))
  const ids = pending.filter((row) => {
    const match = matchGuestTemplate(row.keyword)
    return match != null && retiredSet.has(match.template.id)
  }).map((row) => row.id)
  if (ids.length > 0) {
    await db.update(hhtOppGuestKeywords)
      .set({ status: 'RETIRED', skipReason: 'template_retired' })
      .where(inArray(hhtOppGuestKeywords.id, ids))
  }
  return { templates, rows: ids.length }
}

function rank(context: GuestTemplateContext, options: GuestTemplateOptions, limit: number): GuestTemplateRanking {
  return rankGuestTemplateCandidates({
    entities: context.entities,
    stats: context.stats,
    known: context.known,
    fetched: context.fetched,
    limit,
    buckets: options.buckets,
    perTemplate: options.perTemplate,
  })
}

async function loadGuestTemplateContext(
  db: Database,
  options: GuestTemplateOptions,
): Promise<GuestTemplateContext> {
  const yieldsFile = options.yieldsPath === null ? null : resolveYieldsFile(options.yieldsPath)
  const pitchable = yieldsFile ? readTrackerYields(yieldsFile) : new Map<number, number | null>()
  const rows = await db.select({
    id: hhtOppGuestKeywords.id,
    keyword: hhtOppGuestKeywords.keyword,
    normalizedKeyword: hhtOppGuestKeywords.normalizedKeyword,
    status: hhtOppGuestKeywords.status,
    neighborhood: hhtOppGuestKeywords.neighborhood,
    newDomains: hhtOppGuestKeywords.newDomains,
    fetchedAt: hhtOppGuestKeywords.fetchedAt,
  }).from(hhtOppGuestKeywords).orderBy(asc(hhtOppGuestKeywords.id))

  const history: GuestTemplateHistoryRow[] = rows.map((row) => ({
    keyword: row.keyword,
    fetched: row.fetchedAt != null || FETCHED_STATUSES.includes(row.status),
    newDomains: row.newDomains,
    pitchable: pitchable.has(row.id) ? pitchable.get(row.id) ?? null : null,
  }))
  const baseline = guestYieldBaseline(history)
  const stats = guestTemplateStats(history, { baseline })
  const fetched = rows
    .filter((row) => row.status === 'FETCHED' || row.status === 'SATURATED' || row.status === 'EXHAUSTED')
    .map((row) => ({ keyword: row.keyword, neighborhood: asNeighborhood(row.neighborhood) }))

  const metros = await db.select({ name: localities.name, population: localities.population })
    .from(localities)
    .where(eq(localities.kind, 'metro'))
  const states = Object.entries(STATE_NAMES)
    .filter(([code]) => code !== 'DC' && code !== 'PR')
    .map(([, name]) => name)
  const entities = [
    ...guestMetroEntities(metros, { limit: options.metros ?? 300 }),
    ...guestStateEntities(states),
    ...GUEST_TOURISM_REGIONS,
  ]
  return {
    entities,
    stats,
    baseline,
    known: rows.map((row) => row.normalizedKeyword),
    fetched,
    yieldsFile,
  }
}

/** Newest exports/guest-post-outreach/keyword-yields-*.csv, or the explicit path. */
function resolveYieldsFile(path: string | undefined): string | null {
  if (path) {
    const full = resolve(path)
    if (!existsSync(full)) throw new Error(`Yields file not found: ${full}`)
    return full
  }
  const dir = resolve(process.cwd(), 'exports/guest-post-outreach')
  if (!existsSync(dir)) return null
  const files = readdirSync(dir).filter((name) => /^keyword-yields-.*\.csv$/.test(name)).sort()
  const latest = files.at(-1)
  return latest ? join(dir, latest) : null
}

/** keyword_id → tracker pitchable count; null where the tracker has no attributed verdicts yet. */
export function readTrackerYields(file: string): Map<number, number | null> {
  const out = new Map<number, number | null>()
  for (const row of parseLeadCsv(readFileSync(file, 'utf8'))) {
    const id = Number(row['keyword_id'])
    if (!Number.isInteger(id)) continue
    const unknown = /unknown/i.test(row['evaluation_coverage'] ?? '')
    const count = Number(row['pitchable_opportunities'])
    out.set(id, unknown || !Number.isFinite(count) ? null : count)
  }
  return out
}

/**
 * Exact-phrase US volume through the shared keyword-volume cache, which asks
 * Google Ads (free) for misses and never falls back to a paid provider.
 * Returns a number for a measurement (null avg from Google Ads reads as 0) and
 * null when Google Ads could not be reached, so an outage never marks a phrase
 * zero-volume.
 */
async function lookupVolumes(db: Database, keywords: readonly string[], log: (message: string) => void): Promise<Map<string, number | null>> {
  const wanted = [...new Set(keywords.map((keyword) => keyword.trim().toLowerCase()))]
  const out = new Map<string, number | null>()
  if (wanted.length === 0) return out
  const result = await ensureKeywordVolumesFromEnv(db, { keywords: wanted, locationCode: null })
  if (result.fetched > 0) log(`Google Ads volume for ${result.fetched} keywords`)
  for (const keyword of wanted) {
    const row = result.volumes.get(keyword)
    out.set(keyword, !row || row.source === 'no_data' ? null : row.avgMonthlySearches ?? 0)
  }
  return out
}

async function insertTemplateKeyword(
  db: Database,
  candidate: GuestTemplateCandidate,
  status: 'NEW' | 'SKIPPED',
  skipReason: string | null,
): Promise<boolean> {
  const normalized = normalizeFrontierKeyword(candidate.keyword)
  if (!normalized) return false
  const inserted = await db.insert(hhtOppGuestKeywords).values({
    keyword: candidate.keyword,
    normalizedKeyword: normalized,
    sourceType: GUEST_TEMPLATE_SOURCE,
    status,
    skipReason,
    bucket: candidate.bucket,
    leadType: 'guest_post',
  }).onConflictDoNothing({ target: hhtOppGuestKeywords.normalizedKeyword }).returning({ id: hhtOppGuestKeywords.id })
  return inserted.length > 0
}

function asNeighborhood(value: string | null): Neighborhood | null {
  if (value === 'saturated' || value === 'productive' || value === 'neutral') return value
  return null
}
