import { eq } from 'drizzle-orm'
import type { Database } from '../db.js'
import { omRunEvents, omRuns } from '../schema.js'

export type LogChannel = 'DISCOVERY' | 'DOMAIN' | 'MARKET' | 'ECONOMICS' | 'QUEUE' | 'LLM' | 'ADS' | 'SCORE'

export function omLog(channel: LogChannel, lines: string[]): void {
  console.log(`[${channel}]`)
  for (const line of lines) console.log(line)
}

export async function startOmRun(db: Database, command: string): Promise<number> {
  const rows = await db.insert(omRuns).values({ command, status: 'running' }).returning({ id: omRuns.id })
  return rows[0]!.id
}

export async function finishOmRun(db: Database, runId: number, status: 'done' | 'failed', notes?: string): Promise<void> {
  await db
    .update(omRuns)
    .set({ status, finishedAt: new Date(), notes: notes ?? null })
    .where(eq(omRuns.id, runId))
}

export async function recordOmEvent(
  db: Database,
  args: { runId?: number; channel: LogChannel; message: string; details?: Record<string, unknown> },
): Promise<void> {
  omLog(args.channel, [args.message])
  await db.insert(omRunEvents).values({
    runId: args.runId ?? null,
    channel: args.channel,
    message: args.message,
    details: args.details ?? null,
  })
}
