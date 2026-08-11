/**
 * Trigger.dev consumer for ENRICH MODE.
 *
 * Runs on Trigger rather than in the server action because the triage stages
 * are slow by nature — Wayback's CDX index answers in ~10s per domain and RDAP
 * is deliberately throttled — so a 200-domain market runs for minutes. That is
 * far past a serverless request timeout, and the work is IO-bound waiting on
 * free public services, not anything we can make faster by paying.
 */
import { logger, task } from '@trigger.dev/sdk/v3'
import { db, executeEnrichRun } from '@rnr/data'

export const domainEnrich = task({
  id: 'domain-enrich',
  /**
   * Harvesting stored SERP domains multiplied the seed: a market can now carry
   * 500+ domains rather than ~120. At ~15s of network wait each, 8 workers is
   * roughly 16 minutes for 500 -- so the budget is raised well past that rather
   * than left to time out mid-market on the first wide run.
   */
  maxDuration: 3_600, // 60 minutes
  retry: {
    // Stage 1 has already been paid for by the time triage starts, and the
    // ledger line is written immediately, so a retry re-buys the business list.
    // One attempt keeps a transient DNS blip from costing a second Maps call.
    maxAttempts: 1,
  },
  run: async (payload: { runId: number }) => {
    logger.info('domain-enrich starting', { runId: payload.runId })

    const result = await executeEnrichRun(db(), payload.runId, {
      // Raised with the seed. Every stage here waits on the network rather than
      // burning CPU, and DNS/HTTP/RDAP are all free.
      concurrency: 10,
      // Majestic (5a) and the registrar availability check (3e) stay unset:
      // no credentials are configured for either. The score records them as
      // missing rather than scoring those domains low for want of data.
    })

    logger.info('domain-enrich complete', {
      runId: result.runId,
      uniqueDomains: result.uniqueDomains,
      candidates: result.candidates,
      costMicros: String(result.costMicros),
    })

    return {
      runId: result.runId,
      uniqueDomains: result.uniqueDomains,
      candidates: result.candidates,
      costMicros: String(result.costMicros),
    }
  },
})
