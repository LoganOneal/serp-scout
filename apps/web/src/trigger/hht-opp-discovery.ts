import { logger, task } from '@trigger.dev/sdk/v3'
import { db, executeHhtOppDiscoveryRun, failHhtOppDiscoveryRun } from '@rnr/data'

export const hhtOppDiscovery = task({
  id: 'hht-opp-discovery',
  maxDuration: 3_600,
  retry: { maxAttempts: 1 },
  run: async (payload: { runId: number }) => {
    logger.info('HHT Opportunity Engine discovery starting', { runId: payload.runId })
    try {
      const result = await executeHhtOppDiscoveryRun(db(), payload.runId)
      logger.info('HHT Opportunity Engine discovery finished', result)
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await failHhtOppDiscoveryRun(db(), payload.runId, message)
      throw error
    }
  },
})
