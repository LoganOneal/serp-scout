import { logger, schedules, task } from '@trigger.dev/sdk/v3'
import { db, generateHhtOppRecommendations, refreshStaleHhtOppOpportunities } from '@rnr/data'

export const hhtOppRefresh = task({
  id: 'hht-opp-refresh',
  maxDuration: 3_600,
  retry: { maxAttempts: 1 },
  run: async (payload: { limit?: number } = {}) => {
    logger.info('HHT Opportunity Engine refresh starting', payload)
    const refreshed = await refreshStaleHhtOppOpportunities(db(), { limit: payload.limit ?? 8 })
    const recommendations = await generateHhtOppRecommendations(db())
    logger.info('HHT Opportunity Engine refresh finished', {
      stale: refreshed.stale,
      crawled: refreshed.refreshed.length,
      recommendations: recommendations.length,
    })
    return { stale: refreshed.stale, crawled: refreshed.refreshed.length, recommendations: recommendations.length }
  },
})

/** Weekly guideline refresh + strategy recommendations. Enable in the Trigger dashboard after deploy. */
export const hhtOppRefreshSchedule = schedules.task({
  id: 'hht-opp-refresh-schedule',
  cron: '0 12 * * 1',
  maxDuration: 3_600,
  run: async () => {
    await hhtOppRefresh.trigger({ limit: 8 })
    return { kicked: true }
  },
})
