import { logger, task } from '@trigger.dev/sdk/v3'
import { db, executeHotelBlRun, failHotelBlRun } from '@rnr/data'

export const hotelBacklinkScout = task({
  id: 'hotel-backlink-scout',
  maxDuration: 3_600,
  retry: { maxAttempts: 1 },
  run: async (payload: { runId: number }) => {
    logger.info('Hotel Backlink Scout starting', { runId: payload.runId })
    try {
      const result = await executeHotelBlRun(db(), payload.runId, { concurrency: 5 })
      logger.info('Hotel Backlink Scout finished', { runId: payload.runId, ...result })
      return { runId: payload.runId, ...result }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await failHotelBlRun(db(), payload.runId, message)
      throw error
    }
  },
})
