'use server'

import { revalidatePath } from 'next/cache'
import {
  createEnrichRun,
  db,
  deleteEnrichRunById,
  executeEnrichRun,
  failEnrichRun,
} from '@rnr/data'

export interface StartEnrichState {
  ok: boolean
  message: string
  runId?: number
}

/**
 * Kick off one ENRICH MODE run.
 *
 * The row is created here so the operator sees it immediately, and the work is
 * handed to Trigger.dev when a key is configured. Without one — local dev —
 * the run executes inline, which is fine there because `pnpm dev` has no
 * request timeout, and would not be fine on Vercel.
 */
export async function startEnrichRun(
  _prev: StartEnrichState | null,
  formData: FormData,
): Promise<StartEnrichState> {
  const niche = String(formData.get('niche') ?? '').trim()
  const locationCode = Number(formData.get('locationCode'))
  const locality = String(formData.get('locality') ?? '').trim()
  const maxResults = Number(formData.get('maxResults') ?? 200)
  // Absent = off. A missing field must never turn a paid stage on.
  const paidOptions = {
    checkSpam: formData.get('checkSpam') === '1',
    checkRankings: formData.get('checkRankings') === '1',
    checkAuthority: formData.get('checkAuthority') === '1',
    renderUnknown: formData.get('renderUnknown') === '1',
    maxRankingLookups: Math.max(1, Math.min(100, Number(formData.get('maxRankingLookups') ?? 15))),
  }

  if (!niche) return { ok: false, message: 'Enter a niche, e.g. "plumber".' }
  if (!Number.isInteger(locationCode) || locationCode <= 0) {
    return { ok: false, message: 'Pick a market.' }
  }

  const database = db()
  const runId = await createEnrichRun(database, {
    niche,
    locality: locality || String(locationCode),
    locationCode,
    maxResults: Number.isFinite(maxResults) ? Math.min(Math.max(maxResults, 1), 700) : 200,
    paidOptions,
  })

  if (process.env['TRIGGER_SECRET_KEY']?.trim()) {
    try {
      const { domainEnrich } = await import('@/trigger/domain-enrich')
      await domainEnrich.trigger({ runId }, { idempotencyKey: `domain-enrich-run-${runId}` })
      revalidatePath('/scout/domains')
      return {
        ok: true,
        runId,
        message: `Run #${runId} started. Trigger.dev is working through the market — reload for progress.`,
      }
    } catch (err) {
      await failEnrichRun(database, runId, `Trigger.dev kickoff failed: ${(err as Error).message}`)
      revalidatePath('/scout/domains')
      return { ok: false, runId, message: `Could not start run #${runId}: ${(err as Error).message}` }
    }
  }

  try {
    const result = await executeEnrichRun(database, runId, { concurrency: 6 })
    revalidatePath('/scout/domains')
    return {
      ok: true,
      runId,
      message: `Run #${runId} complete — ${result.candidates} candidate(s) from ${result.uniqueDomains} domain(s).`,
    }
  } catch (err) {
    revalidatePath('/scout/domains')
    return { ok: false, runId, message: `Run #${runId} failed: ${(err as Error).message}` }
  }
}

export async function deleteEnrichRun(formData: FormData): Promise<void> {
  const runId = Number(formData.get('runId'))
  if (!Number.isInteger(runId) || runId <= 0) return
  // Candidates cascade; the spend_ledger line does not reference the run, so
  // the money stays on the books exactly as it does for discovery runs.
  await deleteEnrichRunById(db(), runId)
  revalidatePath('/scout/domains')
}

/**
 * Same run, started from a market page instead of the Domains page.
 *
 * Delegates rather than duplicating so there is one code path that creates a
 * run and dispatches it; only the revalidation differs, because the operator is
 * looking at the market cell and expects the panel under their cursor to
 * update, not a page they are not on.
 */
export async function startEnrichForMarket(
  prev: StartEnrichState | null,
  formData: FormData,
): Promise<StartEnrichState> {
  const result = await startEnrichRun(prev, formData)
  // 'layout' so every /markets/[locality]/[niche] cell picks up the new run.
  revalidatePath('/portfolio', 'layout')
  return result
}
