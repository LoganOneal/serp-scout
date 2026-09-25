'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import {
  HHT_PX_OUTREACH_STATUSES,
  isHhtPxOutreachStatus,
  isHhtPxPageType,
} from '@rnr/core'
import {
  aggregateHhtPxProspects,
  db,
  enrichHhtPxDomains,
  expandHhtPxKeywordIdeas,
  fetchHhtPxSerps,
  fetchHhtPxVolumes,
  overrideHhtPxSerpResult,
  pauseHhtPxRun,
  previewHhtPxSerpCalls,
  prioritizeHhtPxKeywords,
  seedHhtPxLibrary,
  updateHhtPxOutreach,
} from '@rnr/data'

function messageUrl(path: string, message: string, tone: 'success' | 'error' = 'success'): string {
  const [pathname, existing] = path.split('?')
  const params = new URLSearchParams(existing)
  params.set('message', message)
  params.set('tone', tone)
  return `${pathname}?${params}`
}

function isRedirectError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'digest' in error && String(error.digest).startsWith('NEXT_REDIRECT')
}

function limitFrom(formData: FormData, fallback: number): number {
  const parsed = Number(formData.get('limit') ?? fallback)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(1, Math.min(1000, Math.trunc(parsed)))
}

function refreshPaths(): void {
  revalidatePath('/hht-px')
  revalidatePath('/hht-px', 'layout')
}

export async function seedHhtPxLibraryAction(): Promise<never> {
  try {
    const result = await seedHhtPxLibrary(db())
    refreshPaths()
    redirect(
      messageUrl(
        '/hht-px',
        `Library ready: ${result.geographies} geographies, ${result.templates} templates, ${result.keywords.total} keywords (${result.keywords.inserted} new).`,
      ),
    )
  } catch (error) {
    if (isRedirectError(error)) throw error
    redirect(messageUrl('/hht-px', error instanceof Error ? error.message : 'Seed failed.', 'error'))
  }
}

export async function fetchHhtPxVolumesAction(formData: FormData): Promise<never> {
  try {
    const result = await fetchHhtPxVolumes(db(), {
      limit: limitFrom(formData, 200),
      retryFailed: formData.get('retryFailed') === '1',
    })
    refreshPaths()
    redirect(
      messageUrl(
        '/hht-px?view=keywords',
        result.error
          ? `Volume batch stopped after ${result.processed}: ${result.error}`
          : `Stored US destination volume for ${result.processed} keywords. ${result.remaining} remaining.`,
        result.error ? 'error' : 'success',
      ),
    )
  } catch (error) {
    if (isRedirectError(error)) throw error
    redirect(messageUrl('/hht-px', error instanceof Error ? error.message : 'Volume fetch failed.', 'error'))
  }
}

export async function prioritizeHhtPxAction(): Promise<never> {
  try {
    const result = await prioritizeHhtPxKeywords(db())
    refreshPaths()
    redirect(messageUrl('/hht-px', `Marked ${result.representatives} geography × variant-group representatives for Semrush.`))
  } catch (error) {
    if (isRedirectError(error)) throw error
    redirect(messageUrl('/hht-px', error instanceof Error ? error.message : 'Prioritization failed.', 'error'))
  }
}

export async function fetchHhtPxSerpsAction(formData: FormData): Promise<never> {
  try {
    const limit = limitFrom(formData, 10)
    const refresh = formData.get('refresh') === '1'
    const preview = await previewHhtPxSerpCalls(db(), { limit, refresh, includeExperimental: formData.get('experimental') === '1' })
    if (preview.newCalls > 0 && formData.get('confirm') !== '1') {
      redirect(
        messageUrl(
          '/hht-px',
          `Confirm Semrush MCP queue: ${preview.selected} selected, ${preview.cached} cached, ${preview.newCalls} new phrase_organic reports. The HTTP API key is not used.`,
          'error',
        ),
      )
    }
    const result = await fetchHhtPxSerps(db(), {
      limit,
      refresh,
      includeExperimental: formData.get('experimental') === '1',
      retryFailed: formData.get('retryFailed') === '1',
    })
    refreshPaths()
    const queued = result.queued > 0 && result.processed === 0
    const names = result.preview.keywords.slice(0, 8).map((row) => row.keyword).join(', ')
    redirect(
      messageUrl(
        '/hht-px?view=keywords',
        result.processed > 0
          ? `Ingested ${result.processed} Semrush MCP SERPs.`
          : queued
            ? `Queued ${result.queued} keywords for Semrush MCP phrase_organic (HTTP API key is not used)${names ? `: ${names}` : ''}.`
            : result.error
              ? `SERP batch stopped after ${result.processed}: ${result.error}`
              : `No new Semrush MCP SERP work (${result.cached} already cached).`,
        result.processed > 0 || queued || !result.error ? 'success' : 'error',
      ),
    )
  } catch (error) {
    if (isRedirectError(error)) throw error
    redirect(messageUrl('/hht-px', error instanceof Error ? error.message : 'SERP fetch failed.', 'error'))
  }
}

export async function aggregateHhtPxAction(): Promise<never> {
  try {
    const result = await aggregateHhtPxProspects(db())
    refreshPaths()
    redirect(messageUrl('/hht-px?view=pages', `Deduped to ${result.pages} prospect pages across ${result.domains} domains.`))
  } catch (error) {
    if (isRedirectError(error)) throw error
    redirect(messageUrl('/hht-px', error instanceof Error ? error.message : 'Aggregation failed.', 'error'))
  }
}

export async function enrichHhtPxAction(formData: FormData): Promise<never> {
  try {
    const result = await enrichHhtPxDomains(db(), { limit: limitFrom(formData, 15), retryFailed: formData.get('retryFailed') === '1' })
    refreshPaths()
    redirect(
      messageUrl(
        '/hht-px?view=domains',
        result.processed > 0
          ? `Enriched ${result.processed} prospectable domains from Semrush MCP.`
          : result.queued > 0
            ? `Queued ${result.queued} domains for Semrush MCP enrichment (HTTP API key is not used)${result.domains.length ? `: ${result.domains.slice(0, 8).join(', ')}` : ''}.`
            : result.error
              ? `Enrichment stopped after ${result.processed}: ${result.error}`
              : 'No domains waiting for Semrush MCP enrichment.',
        result.processed > 0 || result.queued > 0 || !result.error ? 'success' : 'error',
      ),
    )
  } catch (error) {
    if (isRedirectError(error)) throw error
    redirect(messageUrl('/hht-px', error instanceof Error ? error.message : 'Domain enrichment failed.', 'error'))
  }
}

export async function expandHhtPxIdeasAction(): Promise<never> {
  try {
    const result = await expandHhtPxKeywordIdeas(db())
    refreshPaths()
    redirect(
      messageUrl(
        '/hht-px?view=keywords',
        result.error
          ? result.error
          : `Stored ${result.inserted} Google keyword ideas separately. Promote before they enter SERP selection.`,
        result.error ? 'error' : 'success',
      ),
    )
  } catch (error) {
    if (isRedirectError(error)) throw error
    redirect(messageUrl('/hht-px', error instanceof Error ? error.message : 'Keyword idea expansion failed.', 'error'))
  }
}

export async function pauseHhtPxAction(): Promise<never> {
  await pauseHhtPxRun(db())
  refreshPaths()
  redirect(messageUrl('/hht-px', 'Pipeline paused. Completed stages stay persisted.'))
}

export async function overrideHhtPxSerpAction(formData: FormData): Promise<never> {
  const resultId = Number(formData.get('resultId'))
  const keywordId = Number(formData.get('keywordId'))
  const pageType = String(formData.get('pageType') ?? '')
  const prospectable = String(formData.get('isProspectable') ?? '')
  try {
    await overrideHhtPxSerpResult(db(), resultId, {
      pageType: isHhtPxPageType(pageType) ? pageType : undefined,
      isProspectable: prospectable === 'yes' ? true : prospectable === 'no' ? false : undefined,
    })
    refreshPaths()
    redirect(messageUrl(`/hht-px/keywords/${keywordId}`, 'Classification override saved.'))
  } catch (error) {
    if (isRedirectError(error)) throw error
    redirect(messageUrl(`/hht-px/keywords/${keywordId}`, error instanceof Error ? error.message : 'Override failed.', 'error'))
  }
}

export async function updateHhtPxOutreachAction(formData: FormData): Promise<never> {
  const pageId = Number(formData.get('pageId') ?? 0)
  const domainId = Number(formData.get('domainId') ?? 0)
  const status = String(formData.get('status') ?? '')
  const view = String(formData.get('view') ?? 'pages')
  if (!isHhtPxOutreachStatus(status) || !HHT_PX_OUTREACH_STATUSES.includes(status)) {
    redirect(messageUrl(`/hht-px?view=${view}`, 'Unknown outreach status.', 'error'))
  }
  try {
    await updateHhtPxOutreach(db(), {
      pageId: pageId > 0 ? pageId : undefined,
      domainId: domainId > 0 ? domainId : undefined,
      status,
      notes: String(formData.get('notes') ?? '') || undefined,
    })
    refreshPaths()
    redirect(messageUrl(pageId > 0 ? `/hht-px/pages/${pageId}` : `/hht-px?view=${view}`, 'Outreach status updated.'))
  } catch (error) {
    if (isRedirectError(error)) throw error
    redirect(messageUrl('/hht-px', error instanceof Error ? error.message : 'Outreach update failed.', 'error'))
  }
}
