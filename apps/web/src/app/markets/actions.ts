'use server'

import { revalidatePath } from 'next/cache'
import { SITE_STATUSES, type SiteStatus } from '@rnr/core'
import {
  addSerpTarget,
  createSite,
  db,
  deleteDiscoveryRun,
  deleteOpportunityCellMetrics,
  deleteOpportunityCellsBulk,
  DiscoveryEnqueueError,
  enqueueCatalogCellResearch,
  enqueueMarketDiscovery,
  getCellDetail,
  getSiteById,
  importKeywordCsv,
  listCatalogSerpMetricsForCell,
  previewOpportunityDeepDive,
  PromoteError,
  promoteDiscoveryHit,
  removeFromShortlist,
  researchBulkEnabled,
  resolveLocalityAndNiche,
  SerpTargetError,
  setKeywordActive,
  SiteValidationError,
  startOpportunityDeepDive,
  updateSite,
} from '@rnr/data'

/** Market (cell) actions. All take FormData only, so they pass to client components directly. */

const str = (fd: FormData, k: string): string | null => {
  const v = fd.get(k)
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null
}

export interface SimpleResult {
  ok: boolean
  error?: string
}

/**
 * Start targeting a cell: create the one row everything else hangs off.
 *
 * The cell uniqueness is enforced by a partial index (sites_active_cell_uq), so a second
 * attempt fails at the database. Translated here into a sentence, because
 * "duplicate key value violates unique constraint" is not an answer.
 */
export async function startTargetingAction(fd: FormData): Promise<SimpleResult> {
  const localitySlug = str(fd, 'localitySlug')
  const nicheSlug = str(fd, 'nicheSlug')
  if (localitySlug === null || nicheSlug === null) return { ok: false, error: 'Missing cell.' }

  const cell = await getCellDetail(db(), { localitySlug, nicheSlug })
  if (cell === null) return { ok: false, error: 'No such locality + niche.' }
  if (cell.site !== null) {
    return {
      ok: false,
      error: `You are already targeting ${cell.nicheLabel} in ${cell.localityName}, ${cell.stateCode}.`,
    }
  }

  try {
    await createSite(db(), {
      localityId: cell.localityId,
      nicheId: cell.nicheId,
      domain: str(fd, 'domain'),
      displayName: str(fd, 'displayName'),
      shortlistItemId: cell.shortlist?.id ?? null,
      status: 'building',
    })
  } catch (e) {
    if (e instanceof SiteValidationError) return { ok: false, error: e.message }
    const m = (e as Error).message ?? String(e)
    if (/sites_active_cell_uq/.test(m)) {
      return {
        ok: false,
        error: `Another site already targets ${cell.nicheLabel} in ${cell.localityName}. One website per cell.`,
      }
    }
    if (/sites_domain_uq/.test(m)) {
      return { ok: false, error: `That domain is already used by another cell.` }
    }
    return { ok: false, error: m }
  }

  revalidatePath(`/markets/${localitySlug}/${nicheSlug}`)
  revalidatePath('/markets')
  revalidatePath('/pipeline')
  return { ok: true }
}

function revalidateMarketPaths(opts: {
  siteId?: number
  localitySlug?: string | null
  nicheSlug?: string | null
}) {
  revalidatePath('/markets')
  revalidatePath('/pipeline')
  revalidatePath('/sites')
  if (opts.siteId) revalidatePath(`/sites/${opts.siteId}`)
  if (opts.localitySlug && opts.nicheSlug) {
    revalidatePath(`/markets/${opts.localitySlug}/${opts.nicheSlug}`)
  }
}

/**
 * Edit a targeted market: domain, display name, status, notes.
 * Form fields: siteId, domain?, displayName?, status?, notes?
 */
export async function updateMarketAction(fd: FormData): Promise<SimpleResult> {
  const siteId = Number(str(fd, 'siteId'))
  if (!Number.isInteger(siteId) || siteId <= 0) return { ok: false, error: 'Missing market.' }

  const site = await getSiteById(db(), siteId)
  if (!site) return { ok: false, error: 'Market not found.' }

  const statusRaw = str(fd, 'status')
  let status: SiteStatus | undefined
  if (statusRaw) {
    if (!(SITE_STATUSES as readonly string[]).includes(statusRaw)) {
      return { ok: false, error: `Invalid status: ${statusRaw}` }
    }
    status = statusRaw as SiteStatus
  }

  // Empty domain means "clear" → store null (allowed for pre-registration).
  const domainField = fd.get('domain')
  const domain =
    typeof domainField === 'string' ? domainField.trim() || null : undefined
  const displayNameField = fd.get('displayName')
  const displayName =
    typeof displayNameField === 'string' ? displayNameField.trim() || null : undefined
  const notesField = fd.get('notes')
  const notes = typeof notesField === 'string' ? notesField.trim() || null : undefined

  try {
    await updateSite(db(), siteId, {
      ...(domain !== undefined ? { domain } : {}),
      ...(displayName !== undefined ? { displayName } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(notes !== undefined ? { notes } : {}),
    })
  } catch (e) {
    if (e instanceof SiteValidationError) return { ok: false, error: e.message }
    const m = (e as Error).message ?? String(e)
    if (/sites_domain_uq/i.test(m)) {
      return { ok: false, error: 'That domain is already used by another market.' }
    }
    return { ok: false, error: m }
  }

  const detail = await import('@rnr/data').then((m) => m.getSiteDetail(db(), siteId))
  revalidateMarketPaths({
    siteId,
    localitySlug: detail?.localitySlug,
    nicheSlug: detail?.nicheSlug,
  })
  return { ok: true }
}

/** Change only status (list dropdown). Form: siteId, status */
export async function setMarketStatusAction(fd: FormData): Promise<SimpleResult> {
  const siteId = Number(str(fd, 'siteId'))
  const statusRaw = str(fd, 'status')
  if (!Number.isInteger(siteId) || siteId <= 0) return { ok: false, error: 'Missing market.' }
  if (!statusRaw || !(SITE_STATUSES as readonly string[]).includes(statusRaw)) {
    return { ok: false, error: 'Pick a valid status.' }
  }
  await updateSite(db(), siteId, { status: statusRaw as SiteStatus })
  const detail = await import('@rnr/data').then((m) => m.getSiteDetail(db(), siteId))
  revalidateMarketPaths({
    siteId,
    localitySlug: detail?.localitySlug,
    nicheSlug: detail?.nicheSlug,
  })
  return { ok: true }
}

/**
 * Soft-delete a market (status → dropped). History is kept; cell can be re-targeted later.
 * Form: siteId, confirm = "drop"
 */
export async function dropMarketAction(fd: FormData): Promise<SimpleResult> {
  const siteId = Number(str(fd, 'siteId'))
  const confirm = str(fd, 'confirm')
  if (!Number.isInteger(siteId) || siteId <= 0) return { ok: false, error: 'Missing market.' }
  if (confirm !== 'drop') return { ok: false, error: 'Confirm drop to remove this market.' }

  const site = await getSiteById(db(), siteId)
  if (!site) return { ok: false, error: 'Market not found.' }

  await updateSite(db(), siteId, { status: 'dropped' })
  const detail = await import('@rnr/data').then((m) => m.getSiteDetail(db(), siteId))
  revalidateMarketPaths({
    siteId,
    localitySlug: detail?.localitySlug,
    nicheSlug: detail?.nicheSlug,
  })
  return { ok: true }
}

/** Remove a shortlisted (not yet targeted) cell from the pipeline. Form: shortlistId */
export async function removePipelineItemAction(fd: FormData): Promise<SimpleResult> {
  const shortlistId = Number(str(fd, 'shortlistId'))
  if (!Number.isInteger(shortlistId) || shortlistId <= 0) {
    return { ok: false, error: 'Missing pipeline item.' }
  }
  await removeFromShortlist(db(), shortlistId)
  revalidatePath('/pipeline')
  revalidatePath('/markets')
  revalidatePath('/shortlist')
  return { ok: true }
}

/** Delete a discovery/sweep run (cascades jobs, hits, metrics). Form: runId */
export async function deleteDiscoveryRunAction(fd: FormData): Promise<SimpleResult> {
  const runId = Number(str(fd, 'runId'))
  if (!Number.isInteger(runId) || runId <= 0) return { ok: false, error: 'Missing run.' }
  const res = await deleteDiscoveryRun(db(), runId)
  if (!res.ok) return res
  revalidatePath('/research')
  revalidatePath('/markets')
  return { ok: true }
}

/** Remove one opportunity grid cell's metrics so it can be swept again. */
export async function deleteOpportunityCellAction(fd: FormData): Promise<SimpleResult> {
  const researchKeywordId = Number(str(fd, 'researchKeywordId'))
  const researchGeoId = Number(str(fd, 'researchGeoId'))
  if (!Number.isInteger(researchKeywordId) || researchKeywordId <= 0) {
    return { ok: false, error: 'Missing keyword.' }
  }
  if (!Number.isInteger(researchGeoId) || researchGeoId <= 0) {
    return { ok: false, error: 'Missing market.' }
  }
  const res = await deleteOpportunityCellMetrics(db(), { researchKeywordId, researchGeoId })
  if (!res.ok) return res
  revalidatePath('/research')
  return { ok: true }
}

/**
 * Bulk delete opportunity cells.
 * Form: cells = JSON array of { researchKeywordId, researchGeoId }
 */
export async function deleteOpportunityCellsBulkAction(
  fd: FormData,
): Promise<SimpleResult & { deleted?: number }> {
  const raw = str(fd, 'cells')
  if (!raw) return { ok: false, error: 'Nothing selected.' }
  let pairs: Array<{ researchKeywordId: number; researchGeoId: number }>
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return { ok: false, error: 'Invalid selection payload.' }
    pairs = parsed.map((p) => ({
      researchKeywordId: Number((p as { researchKeywordId?: unknown }).researchKeywordId),
      researchGeoId: Number((p as { researchGeoId?: unknown }).researchGeoId),
    }))
  } catch {
    return { ok: false, error: 'Invalid selection payload.' }
  }
  const res = await deleteOpportunityCellsBulk(db(), pairs)
  if (!res.ok) return res
  revalidatePath('/research')
  return { ok: true, deleted: res.deleted }
}

/** Deactivate a SERP keyword on a market (stops watching). Form: keywordId, siteId */
export async function removeKeywordAction(fd: FormData): Promise<SimpleResult> {
  const keywordId = Number(str(fd, 'keywordId'))
  const siteId = Number(str(fd, 'siteId'))
  if (!Number.isInteger(keywordId) || keywordId <= 0) return { ok: false, error: 'Missing keyword.' }
  await setKeywordActive(db(), keywordId, false)
  if (Number.isInteger(siteId) && siteId > 0) {
    const detail = await import('@rnr/data').then((m) => m.getSiteDetail(db(), siteId))
    revalidateMarketPaths({
      siteId,
      localitySlug: detail?.localitySlug,
      nicheSlug: detail?.nicheSlug,
    })
  }
  return { ok: true }
}

export interface ImportResult {
  ok: boolean
  detail: string
  skipped?: string[]
}

/** Import a Semrush CSV. Reports counts AND every skipped row. */
export async function importKeywordsAction(fd: FormData): Promise<ImportResult> {
  const siteId = Number(str(fd, 'siteId'))
  const csv = str(fd, 'csv')
  if (!Number.isInteger(siteId) || siteId <= 0) return { ok: false, detail: 'Missing site.' }
  if (csv === null) return { ok: false, detail: 'Nothing to import.' }

  try {
    const s = await importKeywordCsv(db(), { siteId, csv })
    revalidatePath('/markets')
    return {
      ok: true,
      detail:
        `Imported ${s.inserted} new and updated ${s.updated} existing keyword${s.updated === 1 ? '' : 's'} ` +
        `(delimiter "${s.delimiter}", columns read: ${s.columnsFound.join(', ')}` +
        (s.columnsIgnored.length > 0 ? `; ignored: ${s.columnsIgnored.join(', ')}` : '') +
        `). ${s.skipped.length} row${s.skipped.length === 1 ? '' : 's'} skipped.`,
      skipped: s.skipped.map((k) => `Line ${k.line}: ${k.reason}`),
    }
  } catch (e) {
    // A missing keyword column is a wrong-file problem, and the message names the headers
    // it actually saw so it is actionable.
    return { ok: false, detail: (e as Error).message }
  }
}

export async function addSerpTargetAction(fd: FormData): Promise<SimpleResult> {
  const keywordId = Number(str(fd, 'keywordId'))
  const permalink = str(fd, 'permalink')
  if (!Number.isInteger(keywordId) || keywordId <= 0) return { ok: false, error: 'Missing keyword.' }
  if (permalink === null) return { ok: false, error: 'Paste the permalink of your comment.' }

  try {
    await addSerpTarget(db(), { keywordId, permalinkOrUrl: permalink })
    revalidatePath('/markets')
    return { ok: true }
  } catch (e) {
    if (e instanceof SerpTargetError) return { ok: false, error: e.message }
    return { ok: false, error: (e as Error).message }
  }
}

export interface PromoteResultView {
  ok: boolean
  error?: string
  warning?: string
  siteId?: number
  targetId?: number
  volume?: number | null
  volumeSource?: string
}

/**
 * Promote a discovery Reddit hit into this market's SERP monitoring.
 *
 * Creates/reuses the cell site, upserts the keyword (volume via Google Ads when live),
 * and starts watching the thread (post-only until a comment permalink is attached).
 */
export async function promoteDiscoveryHitAction(fd: FormData): Promise<PromoteResultView> {
  const hitId = Number(str(fd, 'hitId'))
  const nicheIdRaw = str(fd, 'nicheId')
  const nicheId = nicheIdRaw ? Number(nicheIdRaw) : undefined
  const commentPermalink = str(fd, 'commentPermalink')
  const localitySlug = str(fd, 'localitySlug')
  const nicheSlug = str(fd, 'nicheSlug')

  if (!Number.isInteger(hitId) || hitId <= 0) return { ok: false, error: 'Missing discovery hit.' }

  try {
    const res = await promoteDiscoveryHit(db(), {
      hitId,
      nicheId: nicheId !== undefined && Number.isInteger(nicheId) ? nicheId : undefined,
      commentPermalink,
    })
    revalidatePath('/markets')
    if (localitySlug && nicheSlug) revalidatePath(`/markets/${localitySlug}/${nicheSlug}`)
    return {
      ok: true,
      warning: res.warning ?? undefined,
      siteId: res.siteId,
      targetId: res.targetId,
      volume: res.volume,
      volumeSource: res.volumeSource,
    }
  } catch (e) {
    if (e instanceof PromoteError) return { ok: false, error: e.message }
    return { ok: false, error: (e as Error).message }
  }
}

export interface MarketRedditScanResult {
  ok: boolean
  error?: string
  runId?: number
  jobCount?: number
  detail?: string
}

/**
 * Local SERP research for a market cell: expanded buy-intent keyword cluster ×
 * desktop+mobile at the locality's location_code.
 * Accepts either localitySlug+nicheSlug or localityId+nicheId (research wizard).
 */
export async function enqueueMarketRedditAction(fd: FormData): Promise<MarketRedditScanResult> {
  const localitySlug = str(fd, 'localitySlug')
  const nicheSlug = str(fd, 'nicheSlug')
  const localityIdRaw = str(fd, 'localityId')
  const nicheIdRaw = str(fd, 'nicheId')

  try {
    let localityId: number
    let nicheId: number
    let localitySlugOut: string
    let nicheSlugOut: string
    let placeLabel: string
    let nicheLabel: string

    if (localitySlug !== null && nicheSlug !== null) {
      const cell = await getCellDetail(db(), { localitySlug, nicheSlug })
      if (cell === null) return { ok: false, error: 'No such market cell.' }
      localityId = cell.localityId
      nicheId = cell.nicheId
      localitySlugOut = localitySlug
      nicheSlugOut = nicheSlug
      placeLabel = `${cell.localityName}, ${cell.stateCode}`
      nicheLabel = cell.nicheLabel
    } else if (localityIdRaw !== null && nicheIdRaw !== null) {
      const lid = Number(localityIdRaw)
      const nid = Number(nicheIdRaw)
      if (!Number.isFinite(lid) || !Number.isFinite(nid)) {
        return { ok: false, error: 'Invalid locality or niche id.' }
      }
      const resolved = await resolveLocalityAndNiche(db(), { localityId: lid, nicheId: nid })
      if (!resolved) return { ok: false, error: 'Locality or niche not found.' }
      localityId = resolved.localityId
      nicheId = resolved.nicheId
      localitySlugOut = resolved.localitySlug
      nicheSlugOut = resolved.nicheSlug
      placeLabel = resolved.placeLabel
      nicheLabel = resolved.nicheLabel
    } else {
      return { ok: false, error: 'Pick a place and a niche to research.' }
    }

    const { run, preview } = await enqueueMarketDiscovery(db(), {
      localityId,
      nicheId,
    })
    revalidatePath(`/markets/${localitySlugOut}/${nicheSlugOut}`)
    revalidatePath('/markets')
    revalidatePath('/research')
    return {
      ok: true,
      runId: run.id,
      jobCount: preview.jobCount,
      detail:
        `Queued ${preview.jobCount} geo-targeted SERP job${preview.jobCount === 1 ? '' : 's'} ` +
        `(buy-intent cluster × desktop+mobile for ${placeLabel}) · ${nicheLabel}` +
        (preview.usedFixtures ? ' (fixtures, $0).' : '.') +
        ' Cron fills metrics over a few minutes — reload history / market page.',
    }
  } catch (e) {
    if (e instanceof DiscoveryEnqueueError) return { ok: false, error: e.message }
    return { ok: false, error: (e as Error).message }
  }
}

export interface CatalogImportResult {
  ok: boolean
  error?: string
  detail?: string
  skipped?: string[]
}

/**
 * @deprecated Catalog is seeded server-side (names only). UI import removed.
 * Kept so old clients get a clear error instead of a silent no-op.
 */
export async function importResearchCatalogAction(_fd: FormData): Promise<CatalogImportResult> {
  return {
    ok: false,
    error:
      'CSV import is disabled. Catalog is seeded with keyword/market names only; volume is measured via Google Ads on market sweep.',
  }
}

export interface CatalogResearchResult {
  ok: boolean
  error?: string
  detail?: string
  runId?: number
  jobCount?: number
  estimatedCost?: string
  selectionNote?: string | null
  requiresWorker?: boolean
  defaultBudgetCapCents?: number
  previewOnly?: boolean
}

/**
 * Micros to a dollar string.
 *
 * ==================== THIS PRINTED 100x THE REAL COST ====================
 * It divided by 10,000 -- which is micros to CENTS -- and then printed the
 * result behind a dollar sign. A 4-SERP dry run reported "est. $9.80" for a
 * run that costs just under a cent, and every sweep preview an operator ever
 * approved carried the same 100x overstatement.
 *
 * Sub-cent totals are shown as "<$0.01" rather than rounded to "$0.00": a real
 * charge should never render as free.
 * ========================================================================
 */
function formatMicros(m: bigint): string {
  if (m === 0n) return '$0.00 (fixtures)'
  const usd = Number(m) / 1_000_000
  if (usd < 0.01) return '<$0.01'
  return `$${usd.toFixed(2)}`
}

function parseIdList(fd: FormData, key: string): number[] | undefined {
  const raw = str(fd, key)
  if (raw === null || raw === '') return undefined
  const ids = raw
    .split(/[,\s]+/)
    .map((x) => Number(x))
    .filter((n) => Number.isFinite(n) && n > 0)
  return ids.length > 0 ? ids : undefined
}

/**
 * Opportunity funnel: niche×market market sweep (desktop default).
 * Form: dryRun, nicheIds (preferred) or keywordIds, geoIds, devices, budgetCapCents, workerAck
 */
export async function opportunityDeepDiveAction(fd: FormData): Promise<CatalogResearchResult> {
  const dryRun = str(fd, 'dryRun') !== 'false'
  const nicheIds = parseIdList(fd, 'nicheIds')
  const keywordIds = parseIdList(fd, 'keywordIds')
  const geoIds = parseIdList(fd, 'geoIds')
  const devicesRaw = str(fd, 'devices') ?? 'desktop'
  const devices =
    devicesRaw === 'both' || devicesRaw === 'desktop,mobile'
      ? (['desktop', 'mobile'] as const)
      : (['desktop'] as const)
  const budgetRaw = str(fd, 'budgetCapCents')
  const budgetCapCents = budgetRaw !== null ? Number(budgetRaw) : undefined
  const workerAck = str(fd, 'workerAck') === 'true'
  const maxKwRaw = str(fd, 'maxKeywordsPerNiche')
  const maxKeywordsPerNiche = maxKwRaw !== null ? Number(maxKwRaw) : undefined
  /**
   * Paid extras. Absent means OFF -- an older client that does not send these
   * fields must not silently start buying volume and maps again.
   */
  const fetchVolume = str(fd, 'fetchVolume') === 'true'
  // Queued SERPs cost $0.0006 instead of $0.0020 and arrive in minutes.
  const useQueuedSerp = str(fd, 'useQueuedSerp') === 'true'
  const fetchMaps = str(fd, 'fetchMaps') === 'true'
  // Buys a second SERP per keyword x market x device. See discoveryRuns.
  const includeGeoExplicit = str(fd, 'includeGeoExplicit') === 'true'

  if (!dryRun && !researchBulkEnabled()) {
    return {
      ok: false,
      error: 'Bulk research is disabled (RESEARCH_BULK_ENABLED=false).',
    }
  }

  if (!geoIds?.length) {
    return { ok: false, error: 'Select at least one market.' }
  }
  if (!nicheIds?.length && !keywordIds?.length) {
    return { ok: false, error: 'Select at least one niche (or keyword).' }
  }

  try {
    if (dryRun) {
      const p = await previewOpportunityDeepDive(db(), {
        nicheIds,
        keywordIds,
        geoIds,
        devices: [...devices],
        includeNearMe: false,
        includeGeoExplicit,
        maxKeywordsPerNiche,
        fetchVolume,
        fetchMaps,
      })
      return {
        ok: true,
        previewOnly: true,
        jobCount: p.jobCount,
        estimatedCost: formatMicros(p.estimatedCostMicros),
        selectionNote: p.selectionNote,
        requiresWorker: p.requiresLongLivedWorker,
        defaultBudgetCapCents: p.defaultBudgetCapCents,
        detail:
          `Sweep preview: ${p.jobCount} geo-targeted SERPs · ${p.keywordCount} keywords × ` +
          `${p.geoCount} markets × ${p.devices.join('+')} · est. ${formatMicros(p.estimatedCostMicros)}` +
          (p.selectionNote ? ` · ${p.selectionNote}` : '') +
          (p.requiresLongLivedWorker
            ? ' · Large run: cron drains multiple jobs/min; keep tab open and reload history.'
            : ''),
      }
    }

    const { preview, run } = await startOpportunityDeepDive(db(), {
      nicheIds,
      keywordIds,
      geoIds,
      devices: [...devices],
      includeNearMe: false,
      includeGeoExplicit,
      maxKeywordsPerNiche,
      fetchVolume,
      fetchMaps,
      useQueuedSerp,
      budgetCapCents:
        budgetCapCents !== undefined && Number.isFinite(budgetCapCents)
          ? Math.trunc(budgetCapCents)
          : undefined,
      workerAck,
    })

    if (preview.requiresLongLivedWorker && !workerAck && !preview.usedFixtures) {
      // Soft: still allow; multi-job cron handles bulk. Require ack only if checkbox used.
    }

    // Prefer Trigger.dev long runner when configured; cron remains a safety net.
    let runnerNote =
      '. Jobs drain via cron (and Trigger.dev when TRIGGER_SECRET_KEY is set). Reload Market sweep shortly.'
    if (process.env['TRIGGER_SECRET_KEY']?.trim()) {
      try {
        const { discoveryDrain } = await import('@/trigger/discovery-drain')
        await discoveryDrain.trigger(
          { runId: run.id, budgetMs: 12 * 60_000, maxJobs: 500 },
          { idempotencyKey: `discovery-drain-run-${run.id}` },
        )
        runnerNote =
          '. Trigger.dev is draining this run (long worker). Reload Market sweep for progress.'
      } catch (triggerErr) {
        runnerNote =
          `. Trigger.dev kickoff failed (${(triggerErr as Error).message.slice(0, 80)}); cron will still drain.`
      }
    }

    revalidatePath('/research')
    revalidatePath('/markets')
    return {
      ok: true,
      runId: run.id,
      jobCount: preview.jobCount,
      estimatedCost: formatMicros(preview.estimatedCostMicros),
      selectionNote: preview.selectionNote,
      detail:
        `Queued opportunity sweep #${run.id}: ${preview.jobCount} jobs` +
        (preview.usedFixtures ? ' (fixtures, $0)' : ` · ${formatMicros(preview.estimatedCostMicros)}`) +
        runnerNote,
    }
  } catch (e) {
    if (e instanceof DiscoveryEnqueueError) return { ok: false, error: e.message }
    return { ok: false, error: (e as Error).message }
  }
}

/** Dry-run or confirm bulk catalog research (defaults desktop for opportunity funnel). */
export async function catalogBulkResearchAction(fd: FormData): Promise<CatalogResearchResult> {
  // Delegate to opportunity path with dual-device if requested.
  if (str(fd, 'devices') === null) fd.set('devices', 'both')
  return opportunityDeepDiveAction(fd)
}

/** Research one catalog keyword × geo cell. */
export async function catalogCellResearchAction(fd: FormData): Promise<CatalogResearchResult> {
  const kwId = Number(str(fd, 'researchKeywordId'))
  const geoId = Number(str(fd, 'researchGeoId'))
  if (!Number.isFinite(kwId) || !Number.isFinite(geoId)) {
    return { ok: false, error: 'Pick a keyword and a geography first.' }
  }
  try {
    const { preview, run } = await enqueueCatalogCellResearch(db(), {
      researchKeywordId: kwId,
      researchGeoId: geoId,
      dryRun: false,
    })
    revalidatePath('/')
    revalidatePath('/markets')
    return {
      ok: true,
      runId: run!.id,
      jobCount: preview.jobCount,
      estimatedCost: formatMicros(preview.estimatedCostMicros),
      detail:
        `Queued run #${run!.id}: ${preview.jobCount} SERPs` +
        ` (${preview.devices?.join('+') ?? 'desktop+mobile'}, primary + near me)` +
        (preview.usedFixtures
          ? ' · fixtures $0'
          : ` · est. ${formatMicros(preview.estimatedCostMicros)}`) +
        '. Wait for cron/worker, then reload or re-select the cell to see metrics.',
    }
  } catch (e) {
    if (e instanceof DiscoveryEnqueueError) return { ok: false, error: e.message }
    return { ok: false, error: (e as Error).message }
  }
}

export interface CatalogCellMetricsResult {
  ok: boolean
  error?: string
  metrics: Array<{
    device: string
    keyword: string
    firstOrganicRankAbsolute: number | null
    adsAboveOrganicCount: number
    localProfilesAboveOrganicCount: number
    organicCount: number
    paidCount: number
    redditHitCount: number
    relatedSearches: string[] | null
    measuredAt: string
  }>
}

/** Load latest layout metrics for a catalog keyword × geo selection. */
export async function catalogCellMetricsAction(fd: FormData): Promise<CatalogCellMetricsResult> {
  const kwId = Number(str(fd, 'researchKeywordId'))
  const geoId = Number(str(fd, 'researchGeoId'))
  if (!Number.isFinite(kwId) || !Number.isFinite(geoId)) {
    return { ok: false, error: 'Pick a keyword and a geography first.', metrics: [] }
  }
  try {
    const rows = await listCatalogSerpMetricsForCell(db(), {
      researchKeywordId: kwId,
      researchGeoId: geoId,
    })
    return {
      ok: true,
      metrics: rows.map((m) => ({
        device: m.device,
        keyword: m.keyword,
        firstOrganicRankAbsolute: m.firstOrganicRankAbsolute,
        adsAboveOrganicCount: m.adsAboveOrganicCount,
        localProfilesAboveOrganicCount: m.localProfilesAboveOrganicCount,
        organicCount: m.organicCount,
        paidCount: m.paidCount,
        redditHitCount: m.redditHitCount,
        relatedSearches: m.relatedSearches,
        measuredAt: m.measuredAt.toISOString(),
      })),
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message, metrics: [] }
  }
}
