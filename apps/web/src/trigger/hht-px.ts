import { logger, task } from '@trigger.dev/sdk/v3'
import {
  aggregateHhtPxProspects,
  db,
  enrichHhtPxDomains,
  fetchHhtPxSerps,
  fetchHhtPxVolumes,
  prioritizeHhtPxKeywords,
  seedHhtPxLibrary,
} from '@rnr/data'

export const hhtPxPipeline = task({
  id: 'hht-px-pipeline',
  maxDuration: 3_600,
  retry: { maxAttempts: 1 },
  run: async (payload: {
    stage: 'seed' | 'volume' | 'prioritize' | 'serp' | 'aggregate' | 'enrich'
    limit?: number
    retryFailed?: boolean
    refresh?: boolean
    confirmSerp?: boolean
  }) => {
    logger.info('HHT SERP prospecting stage starting', payload)
    const database = db()
    switch (payload.stage) {
      case 'seed':
        return seedHhtPxLibrary(database)
      case 'volume':
        return fetchHhtPxVolumes(database, { limit: payload.limit, retryFailed: payload.retryFailed })
      case 'prioritize':
        return prioritizeHhtPxKeywords(database)
      case 'serp':
        if (!payload.confirmSerp) {
          throw new Error('Refusing to queue Semrush MCP SERPs without confirmSerp')
        }
        return fetchHhtPxSerps(database, {
          limit: payload.limit,
          retryFailed: payload.retryFailed,
          refresh: payload.refresh,
        })
      case 'aggregate':
        return aggregateHhtPxProspects(database)
      case 'enrich':
        return enrichHhtPxDomains(database, { limit: payload.limit, retryFailed: payload.retryFailed })
      default:
        throw new Error(`Unknown stage ${payload.stage}`)
    }
  },
})
