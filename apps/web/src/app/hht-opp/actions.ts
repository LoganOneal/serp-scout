'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import {
  HHT_OPP_STATUSES,
  normalizeWeights,
  type HhtOppScoreWeights,
  type HhtOppStatus,
} from '@rnr/core'
import {
  createHhtOppDiscoveryRun,
  db,
  discoverHhtOppMentions,
  enrichHhtOppDomains,
  enrichQualifiedHhtOppDomains,
  executeHhtOppDiscoveryRun,
  expandHhtOppAuthors,
  expandHhtOppGraph,
  failHhtOppDiscoveryRun,
  generateHhtOppDraft,
  generateHhtOppRecommendations,
  isHhtOppSearchStrategy,
  mineHhtOppCompetitors,
  mineHhtOppDirectories,
  recordHhtOppOutreach,
  refreshStaleHhtOppOpportunities,
  researchHhtOppSeeds,
  saveHhtOppCompetitors,
  saveHhtOppScoreWeights,
  scanHhtOppBrokenLinks,
  setHhtOppRecommendationStatus,
  updateHhtOppStatus,
  type DraftTone,
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

function parseUrls(raw: string): string[] {
  return raw
    .split(/[\n,]+/)
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 5)
}

export async function researchHhtOppSeedsAction(formData: FormData): Promise<never> {
  const urls = parseUrls(String(formData.get('urls') ?? ''))
  if (urls.length === 0) {
    redirect(messageUrl('/hht-opp', 'Paste at least one publisher URL.', 'error'))
  }
  try {
    const results = await researchHhtOppSeeds(db(), urls)
    const created = results.reduce((sum, row) => sum + row.created, 0)
    const updated = results.reduce((sum, row) => sum + row.updated, 0)
    const errors = results.filter((row) => row.error).map((row) => `${row.domain}: ${row.error}`)
    const summary = `Researched ${results.length} domain${results.length === 1 ? '' : 's'}: ${created} new, ${updated} updated.`
    revalidatePath('/hht-opp')
    redirect(messageUrl('/hht-opp', errors.length ? `${summary} ${errors.join(' ')}` : summary, errors.length ? 'error' : 'success'))
  } catch (error) {
    redirect(messageUrl('/hht-opp', error instanceof Error ? error.message : 'Research failed.', 'error'))
  }
}

export async function generateHhtOppDraftAction(formData: FormData): Promise<never> {
  const opportunityId = Number(formData.get('opportunityId'))
  const tone = String(formData.get('tone') ?? 'default') as DraftTone
  if (!Number.isInteger(opportunityId) || opportunityId <= 0) {
    redirect(messageUrl('/hht-opp', 'Missing opportunity.', 'error'))
  }
  try {
    const draft = await generateHhtOppDraft(db(), opportunityId, tone)
    revalidatePath('/hht-opp')
    revalidatePath(`/hht-opp/${opportunityId}`)
    redirect(messageUrl(`/hht-opp/${opportunityId}`, `Draft #${draft.id} ready for human approval. Nothing was sent.`))
  } catch (error) {
    redirect(messageUrl(`/hht-opp/${opportunityId}`, error instanceof Error ? error.message : 'Draft failed.', 'error'))
  }
}

export async function updateHhtOppStatusAction(formData: FormData): Promise<void> {
  const opportunityId = Number(formData.get('opportunityId'))
  const status = String(formData.get('status') ?? '')
  if (!Number.isInteger(opportunityId) || opportunityId <= 0) throw new Error('Invalid opportunity')
  if (!HHT_OPP_STATUSES.includes(status as HhtOppStatus)) throw new Error('Invalid status')
  await updateHhtOppStatus(db(), opportunityId, status as HhtOppStatus)
  revalidatePath('/hht-opp')
  revalidatePath(`/hht-opp/${opportunityId}`)
}

export async function enrichHhtOppSelectedAction(formData: FormData): Promise<never> {
  const ids = String(formData.get('domainIds') ?? '')
    .split(',')
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0)
  if (ids.length === 0) redirect(messageUrl('/hht-opp', 'Select at least one qualified opportunity first.', 'error'))
  try {
    const results = await enrichHhtOppDomains(db(), ids, { approvedReview: true })
    const ok = results.filter((row) => row.enriched).length
    const errors = results.filter((row) => row.error).map((row) => `${row.domain}: ${row.error}`)
    revalidatePath('/hht-opp')
    redirect(
      messageUrl(
        '/hht-opp',
        errors.length ? `Enriched ${ok}. ${errors.join(' ')}` : `Enriched ${ok} domain${ok === 1 ? '' : 's'} with Semrush.`,
        errors.length ? 'error' : 'success',
      ),
    )
  } catch (error) {
    redirect(messageUrl('/hht-opp', error instanceof Error ? error.message : 'Enrichment failed.', 'error'))
  }
}

export async function enrichHhtOppQualifiedAction(): Promise<never> {
  try {
    const results = await enrichQualifiedHhtOppDomains(db())
    const ok = results.filter((row) => row.enriched).length
    revalidatePath('/hht-opp')
    redirect(messageUrl('/hht-opp', `Enriched ${ok} PASS domain${ok === 1 ? '' : 's'}. REVIEW rows were left for manual approval.`))
  } catch (error) {
    redirect(messageUrl('/hht-opp', error instanceof Error ? error.message : 'Enrichment failed.', 'error'))
  }
}

export async function startHhtOppDiscoveryAction(formData: FormData): Promise<never> {
  const queryLimit = Number(formData.get('queryLimit') ?? 4)
  const domainLimit = Number(formData.get('domainLimit') ?? 6)
  const strategyRaw = String(formData.get('strategy') ?? '').trim()
  const name = String(formData.get('name') ?? '').trim()
  const strategies = isHhtOppSearchStrategy(strategyRaw) ? [strategyRaw] : undefined
  const useFixture = formData.get('useFixture') === '1'

  try {
    const { id: runId } = await createHhtOppDiscoveryRun(db(), {
      name: name || undefined,
      queryLimit,
      domainLimit,
      strategies,
      useFixture,
    })

    if (process.env['TRIGGER_SECRET_KEY']?.trim()) {
      try {
        const { hhtOppDiscovery } = await import('@/trigger/hht-opp-discovery')
        await hhtOppDiscovery.trigger({ runId }, { idempotencyKey: `hht-opp-discovery-${runId}` })
      } catch (error) {
        await failHhtOppDiscoveryRun(
          db(),
          runId,
          `Trigger.dev kickoff failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        )
        redirect(
          messageUrl(
            '/hht-opp?view=strategies',
            `Could not start run #${runId}: ${error instanceof Error ? error.message : 'Trigger.dev failed.'}`,
            'error',
          ),
        )
      }
      revalidatePath('/hht-opp')
      redirect(
        messageUrl(
          '/hht-opp?view=strategies',
          `Discovery run #${runId} started in the background. Reload Strategies to follow yield.`,
        ),
      )
    }

    const result = await executeHhtOppDiscoveryRun(db(), runId)
    const source = result.live ? 'DataForSEO' : 'offline fixture catalog (no SERP spend)'
    const summary = `Run #${result.runId} via ${source}: ${result.queries} queries, ${result.newDomains} new domains, ${result.created} opportunities created.`
    revalidatePath('/hht-opp')
    redirect(
      messageUrl(
        '/hht-opp?view=strategies',
        result.error ? `${summary} ${result.error}` : summary,
        result.error ? 'error' : 'success',
      ),
    )
  } catch (error) {
    if (isRedirectError(error)) throw error
    redirect(
      messageUrl(
        '/hht-opp?view=strategies',
        error instanceof Error ? error.message : 'Discovery failed.',
        'error',
      ),
    )
  }
}

function summarizeResearch(label: string, researched: Array<{ created: number; updated: number; error: string | null }>): string {
  const created = researched.reduce((sum, row) => sum + row.created, 0)
  const updated = researched.reduce((sum, row) => sum + row.updated, 0)
  return `${label}: ${researched.length} domains, ${created} new, ${updated} updated.`
}

export async function mineHhtOppCompetitorsAction(formData: FormData): Promise<never> {
  const seeds = parseUrls(String(formData.get('seeds') ?? ''))
  try {
    const result = await mineHhtOppCompetitors(db(), {
      seeds: seeds.length ? seeds : undefined,
      domainLimit: Number(formData.get('domainLimit') ?? 6),
    })
    revalidatePath('/hht-opp')
    redirect(
      messageUrl(
        '/hht-opp?view=strategies',
        result.error
          ? result.error
          : `Competitor mine: ${result.overlaps} overlaps, ${result.researched} researched, ${result.created} created.`,
        result.error ? 'error' : 'success',
      ),
    )
  } catch (error) {
    if (isRedirectError(error)) throw error
    redirect(messageUrl('/hht-opp?view=strategies', error instanceof Error ? error.message : 'Competitor mining failed.', 'error'))
  }
}

export async function discoverHhtOppMentionsAction(): Promise<never> {
  try {
    const result = await discoverHhtOppMentions(db(), { useFixture: process.env['LIVE_CALLS_ENABLED'] !== 'true' })
    revalidatePath('/hht-opp')
    redirect(messageUrl('/hht-opp?view=strategies', summarizeResearch('Unlinked mentions', result.researched)))
  } catch (error) {
    if (isRedirectError(error)) throw error
    redirect(messageUrl('/hht-opp?view=strategies', error instanceof Error ? error.message : 'Mention scan failed.', 'error'))
  }
}

export async function scanHhtOppBrokenLinksAction(): Promise<never> {
  try {
    const result = await scanHhtOppBrokenLinks(db())
    revalidatePath('/hht-opp')
    redirect(messageUrl('/hht-opp?view=strategies', `Broken-link scan: ${result.checked} URLs checked, ${result.created} created, ${result.updated} updated.`))
  } catch (error) {
    if (isRedirectError(error)) throw error
    redirect(messageUrl('/hht-opp?view=strategies', error instanceof Error ? error.message : 'Broken-link scan failed.', 'error'))
  }
}

export async function expandHhtOppAuthorsAction(): Promise<never> {
  try {
    const result = await expandHhtOppAuthors(db(), { useFixture: process.env['LIVE_CALLS_ENABLED'] !== 'true' })
    revalidatePath('/hht-opp')
    redirect(messageUrl('/hht-opp?view=learning', summarizeResearch(`Author graph (${result.authors} authors)`, result.researched)))
  } catch (error) {
    if (isRedirectError(error)) throw error
    redirect(messageUrl('/hht-opp?view=learning', error instanceof Error ? error.message : 'Author expansion failed.', 'error'))
  }
}

export async function mineHhtOppDirectoriesAction(): Promise<never> {
  try {
    const result = await mineHhtOppDirectories(db())
    revalidatePath('/hht-opp')
    redirect(messageUrl('/hht-opp?view=strategies', summarizeResearch(`Directory mining (${result.directories} lists)`, result.researched)))
  } catch (error) {
    if (isRedirectError(error)) throw error
    redirect(messageUrl('/hht-opp?view=strategies', error instanceof Error ? error.message : 'Directory mining failed.', 'error'))
  }
}

export async function expandHhtOppGraphAction(): Promise<never> {
  try {
    const result = await expandHhtOppGraph(db())
    revalidatePath('/hht-opp')
    redirect(messageUrl('/hht-opp?view=strategies', summarizeResearch('Backlink graph', result.researched)))
  } catch (error) {
    if (isRedirectError(error)) throw error
    redirect(messageUrl('/hht-opp?view=strategies', error instanceof Error ? error.message : 'Graph expansion failed.', 'error'))
  }
}

export async function refreshStaleHhtOppAction(): Promise<never> {
  try {
    const result = await refreshStaleHhtOppOpportunities(db())
    revalidatePath('/hht-opp')
    redirect(messageUrl('/hht-opp', `Refresh: ${result.stale} stale, ${result.refreshed.length} re-crawled.`))
  } catch (error) {
    if (isRedirectError(error)) throw error
    redirect(messageUrl('/hht-opp', error instanceof Error ? error.message : 'Refresh failed.', 'error'))
  }
}

export async function generateHhtOppRecommendationsAction(): Promise<never> {
  try {
    const rows = await generateHhtOppRecommendations(db())
    revalidatePath('/hht-opp')
    redirect(messageUrl('/hht-opp?view=learning', `${rows.length} strategy recommendations ready for human approval.`))
  } catch (error) {
    if (isRedirectError(error)) throw error
    redirect(messageUrl('/hht-opp?view=learning', error instanceof Error ? error.message : 'Learning failed.', 'error'))
  }
}

export async function setHhtOppRecommendationAction(formData: FormData): Promise<void> {
  const id = Number(formData.get('id'))
  const status = String(formData.get('status') ?? '')
  if (!Number.isInteger(id) || !['proposed', 'approved', 'dismissed'].includes(status)) return
  await setHhtOppRecommendationStatus(db(), id, status as 'proposed' | 'approved' | 'dismissed')
  revalidatePath('/hht-opp')
}

export async function recordHhtOppOutreachAction(formData: FormData): Promise<never> {
  const opportunityId = Number(formData.get('opportunityId'))
  try {
    await recordHhtOppOutreach(db(), {
      opportunityId,
      dateSent: formData.get('dateSent') ? new Date(String(formData.get('dateSent'))) : new Date(),
      channel: String(formData.get('channel') ?? 'email') || 'email',
      reply: formData.get('reply') === '1',
      positiveReply: formData.get('positiveReply') === '1',
      priceQuoted: formData.get('priceQuoted') ? Number(formData.get('priceQuoted')) : null,
      linkAcquired: formData.get('linkAcquired') === '1',
      linkUrl: String(formData.get('linkUrl') ?? '') || null,
      targetHhtUrl: String(formData.get('targetHhtUrl') ?? '') || null,
      finalCost: formData.get('finalCost') ? Number(formData.get('finalCost')) : null,
      linkAttribute: String(formData.get('linkAttribute') ?? '') || null,
      liveDate: formData.get('liveDate') ? new Date(String(formData.get('liveDate'))) : null,
      notes: String(formData.get('notes') ?? '') || null,
    })
    revalidatePath('/hht-opp')
    revalidatePath(`/hht-opp/${opportunityId}`)
    redirect(messageUrl(`/hht-opp/${opportunityId}`, 'Outreach outcome saved. Nothing was sent from this app.'))
  } catch (error) {
    if (isRedirectError(error)) throw error
    redirect(messageUrl(`/hht-opp/${opportunityId}`, error instanceof Error ? error.message : 'Save failed.', 'error'))
  }
}

export async function saveHhtOppCompetitorsAction(formData: FormData): Promise<never> {
  const domains = String(formData.get('competitors') ?? '')
    .split(/[\n,]+/)
    .map((value) => value.trim())
    .filter(Boolean)
  try {
    const saved = await saveHhtOppCompetitors(db(), domains)
    revalidatePath('/settings')
    revalidatePath('/hht-opp')
    redirect(`/settings?message=${encodeURIComponent(`Saved ${saved.length} competitor domains.`)}#hht-opp-competitors`)
  } catch (error) {
    redirect(`/settings?tone=error&message=${encodeURIComponent(error instanceof Error ? error.message : 'Save failed')}#hht-opp-competitors`)
  }
}

export async function saveHhtOppWeightsAction(formData: FormData): Promise<never> {
  const weights: HhtOppScoreWeights = {
    seoValue: Number(formData.get('seoValue')),
    feasibility: Number(formData.get('feasibility')),
    topicalRelevance: Number(formData.get('topicalRelevance')),
    editorialQuality: Number(formData.get('editorialQuality')),
    costEfficiency: Number(formData.get('costEfficiency')),
    freshness: Number(formData.get('freshness')),
  }
  try {
    await saveHhtOppScoreWeights(db(), normalizeWeights(weights))
    revalidatePath('/settings')
    revalidatePath('/hht-opp')
    redirect('/settings?message=Opportunity+Engine+score+weights+saved.#hht-opp-weights')
  } catch (error) {
    redirect(`/settings?tone=error&message=${encodeURIComponent(error instanceof Error ? error.message : 'Save failed')}#hht-opp-weights`)
  }
}
