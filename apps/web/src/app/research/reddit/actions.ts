'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import {
  cancelDiscoveryRun,
  db,
  DiscoveryEnqueueError,
  enqueueDiscoveryRun,
  mapDiscoveryNiche,
  previewDiscoveryEnqueue,
  PromoteError,
  promoteDiscoveryHit,
} from '@rnr/data'
import {
  DiscoveryCsvError,
  parseDiscoveryGeoCsv,
  parseDiscoveryNicheCsv,
} from '@rnr/core'

const str = (fd: FormData, k: string): string | null => {
  const v = fd.get(k)
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null
}

export interface PreviewResult {
  ok: boolean
  error?: string
  detail?: string
  nicheCount?: number
  geoResolved?: number
  geoUnresolved?: number
  geoUnscannableSource?: number
  jobCount?: number
  estimatedCostUsd?: string
  budgetCapUsd?: string
  usedFixtures?: boolean
  hardCap?: number
  nicheSkipped?: string[]
  geoSkipped?: string[]
}

function microsToUsd(m: bigint): string {
  const whole = m / 1_000_000n
  const frac = (m % 1_000_000n).toString().padStart(6, '0').slice(0, 4)
  return `$${whole}.${frac}`
}

function parseCsVs(fd: FormData): {
  niches: ReturnType<typeof parseDiscoveryNicheCsv>['rows']
  geos: ReturnType<typeof parseDiscoveryGeoCsv>['rows']
  nicheSkipped: string[]
  geoSkipped: string[]
} {
  const nichesCsv = str(fd, 'nichesCsv')
  const geosCsv = str(fd, 'geosCsv')
  if (nichesCsv === null) throw new DiscoveryCsvError('Paste a niches CSV.')
  if (geosCsv === null) throw new DiscoveryCsvError('Paste a geographies CSV.')

  const niches = parseDiscoveryNicheCsv(nichesCsv)
  const geos = parseDiscoveryGeoCsv(geosCsv)
  return {
    niches: niches.rows,
    geos: geos.rows.map((g) => ({
      name: g.name,
      state: g.state,
      population: g.population,
      kind: g.kind,
    })),
    nicheSkipped: niches.skipped.map((s) => `Line ${s.line}: ${s.reason}`),
    geoSkipped: geos.skipped.map((s) => `Line ${s.line}: ${s.reason}`),
  }
}

/** Preview cost and geo resolve without writing a run. */
export async function previewDiscoveryAction(fd: FormData): Promise<PreviewResult> {
  try {
    const parsed = parseCsVs(fd)
    const budgetCapCents = Number(str(fd, 'budgetCapCents') ?? '500')
    if (!Number.isFinite(budgetCapCents) || budgetCapCents < 0) {
      return { ok: false, error: 'Budget cap (cents) must be a non-negative number.' }
    }

    const { preview } = await previewDiscoveryEnqueue(db(), {
      niches: parsed.niches.map((n) => ({
        label: n.label,
        slug: n.slug,
        keywordPrimary: n.keywordPrimary,
        keywordNearMe: n.keywordNearMe,
        nearMeSynthesised: n.nearMeSynthesised,
      })),
      geos: parsed.geos,
      budgetCapCents,
    })

    return {
      ok: true,
      detail:
        `${preview.jobCount} SERP jobs · ${preview.geoResolved} geos resolved` +
        (preview.geoUnresolved + preview.geoUnscannableSource > 0
          ? ` · ${preview.geoUnresolved + preview.geoUnscannableSource} geos will not be searched`
          : ''),
      nicheCount: preview.nicheCount,
      geoResolved: preview.geoResolved,
      geoUnresolved: preview.geoUnresolved,
      geoUnscannableSource: preview.geoUnscannableSource,
      jobCount: preview.jobCount,
      estimatedCostUsd: microsToUsd(preview.estimatedCostMicros),
      budgetCapUsd: microsToUsd(preview.budgetCapMicros),
      usedFixtures: preview.usedFixtures,
      hardCap: preview.hardCap,
      nicheSkipped: parsed.nicheSkipped,
      geoSkipped: parsed.geoSkipped,
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/** Enqueue a discovery run and redirect to its page. */
export async function enqueueDiscoveryAction(fd: FormData): Promise<PreviewResult> {
  try {
    const parsed = parseCsVs(fd)
    const budgetCapCents = Number(str(fd, 'budgetCapCents') ?? '500')
    const label = str(fd, 'label')
    const mode = (str(fd, 'commentabilityMode') ?? 'on_promote') as
      | 'none'
      | 'on_promote'
      | 'after_discovery'

    if (!Number.isFinite(budgetCapCents) || budgetCapCents < 0) {
      return { ok: false, error: 'Budget cap (cents) must be a non-negative number.' }
    }

    const { run, preview } = await enqueueDiscoveryRun(db(), {
      niches: parsed.niches.map((n) => ({
        label: n.label,
        slug: n.slug,
        keywordPrimary: n.keywordPrimary,
        keywordNearMe: n.keywordNearMe,
        nearMeSynthesised: n.nearMeSynthesised,
      })),
      geos: parsed.geos,
      budgetCapCents,
      commentabilityMode: mode === 'after_discovery' ? 'on_promote' : mode, // after_discovery deferred to PR 9
      label: label ?? undefined,
    })

    revalidatePath('/research/reddit')
    redirect(`/research/reddit/${run.id}`)
    // unreachable — satisfy types
    return {
      ok: true,
      jobCount: preview.jobCount,
      estimatedCostUsd: microsToUsd(preview.estimatedCostMicros),
    }
  } catch (e) {
    // redirect() throws a special Next error — rethrow it
    if (e && typeof e === 'object' && 'digest' in e) throw e
    if (e instanceof DiscoveryEnqueueError) {
      return {
        ok: false,
        error: e.message,
        jobCount: e.preview?.jobCount,
        estimatedCostUsd: e.preview ? microsToUsd(e.preview.estimatedCostMicros) : undefined,
      }
    }
    return { ok: false, error: (e as Error).message }
  }
}

export async function cancelDiscoveryAction(fd: FormData): Promise<{ ok: boolean; error?: string }> {
  const runId = Number(str(fd, 'runId'))
  if (!Number.isInteger(runId) || runId <= 0) return { ok: false, error: 'Missing run.' }
  try {
    await cancelDiscoveryRun(db(), runId)
    revalidatePath(`/research/reddit/${runId}`)
    revalidatePath('/research/reddit')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

export async function mapDiscoveryNicheAction(
  fd: FormData,
): Promise<{ ok: boolean; error?: string }> {
  const discoveryNicheId = Number(str(fd, 'discoveryNicheId'))
  const nicheId = Number(str(fd, 'nicheId'))
  const runId = Number(str(fd, 'runId'))
  if (!Number.isInteger(discoveryNicheId) || discoveryNicheId <= 0) {
    return { ok: false, error: 'Missing discovery niche.' }
  }
  if (!Number.isInteger(nicheId) || nicheId <= 0) {
    return { ok: false, error: 'Pick a seeded niche.' }
  }
  try {
    await mapDiscoveryNiche(db(), { discoveryNicheId, nicheId })
    if (Number.isInteger(runId) && runId > 0) revalidatePath(`/research/reddit/${runId}`)
    revalidatePath('/research/reddit')
    revalidatePath('/markets')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

export interface PromoteActionResult {
  ok: boolean
  error?: string
  warning?: string
  siteId?: number
  targetId?: number
  volume?: number | null
  volumeSource?: string
  marketPath?: string
}

export async function promoteHitAction(fd: FormData): Promise<PromoteActionResult> {
  const hitId = Number(str(fd, 'hitId'))
  const nicheIdRaw = str(fd, 'nicheId')
  const nicheId = nicheIdRaw ? Number(nicheIdRaw) : undefined
  const commentPermalink = str(fd, 'commentPermalink')
  const runId = Number(str(fd, 'runId'))

  if (!Number.isInteger(hitId) || hitId <= 0) return { ok: false, error: 'Missing hit.' }

  try {
    const res = await promoteDiscoveryHit(db(), {
      hitId,
      nicheId: nicheId !== undefined && Number.isInteger(nicheId) ? nicheId : undefined,
      commentPermalink,
    })

    if (Number.isInteger(runId) && runId > 0) revalidatePath(`/research/reddit/${runId}`)
    revalidatePath('/research/reddit')
    revalidatePath('/markets')

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
