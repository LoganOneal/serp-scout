import { logger, task } from '@trigger.dev/sdk/v3'

/** Smoke-test task — verify Trigger.dev wiring. Safe to delete later. */
export const helloWorldTask = task({
  id: 'hello-world',
  maxDuration: 60,
  run: async (payload: { name?: string }) => {
    logger.log('Hello from Trigger.dev', { payload })
    return {
      message: `Hello, ${payload.name ?? 'world'}`,
      at: new Date().toISOString(),
    }
  },
})
