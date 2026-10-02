import { sql } from 'drizzle-orm'
import { getEngineDatabase, type EngineDatabase } from './db.js'
import { hhtEngineJobs, hhtEngineSemrushUsage, hhtEngineSystemState } from './schema.js'
import type { SemrushConnectorCredential } from './credential.js'
import { readVaultSecret, SEMRUSH_OAUTH_SECRET, upsertVaultSecret } from './vault.js'

export interface EngineJob {
  id: number
  type: string
  status: string
  idempotencyKey: string
  payload: Record<string, unknown>
  attempts: number
  maxAttempts: number
}

export async function enqueueJob(
  db: EngineDatabase,
  job: { type: string; idempotencyKey: string; payload: Record<string, unknown> },
): Promise<void> {
  await db.insert(hhtEngineJobs).values({
    type: job.type,
    idempotencyKey: job.idempotencyKey,
    payload: job.payload,
    status: 'pending',
  }).onConflictDoNothing({ target: hhtEngineJobs.idempotencyKey })
}

export async function claimNextJob(db: EngineDatabase, workerId: string): Promise<EngineJob | null> {
  const rows = await db.execute<{ id: number }>(sql`
    UPDATE hht_engine.jobs
       SET status = 'running',
           locked_by = ${workerId},
           heartbeat_at = now(),
           attempts = attempts + 1,
           updated_at = now()
     WHERE id = (
       SELECT id FROM hht_engine.jobs
        WHERE status = 'pending' AND run_after <= now()
        ORDER BY id
        LIMIT 1
        FOR UPDATE SKIP LOCKED
     )
       AND status = 'pending'
    RETURNING id
  `)
  const id = (rows as unknown as Array<{ id: number }>)[0]?.id
  if (id === undefined) return null
  const [row] = await db.select().from(hhtEngineJobs).where(sql`${hhtEngineJobs.id} = ${id}`)
  if (!row) return null
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    idempotencyKey: row.idempotencyKey,
    payload: row.payload,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
  }
}

export async function completeJob(db: EngineDatabase, id: number): Promise<void> {
  await db.execute(sql`
    UPDATE hht_engine.jobs SET status = 'done', heartbeat_at = now(), updated_at = now() WHERE id = ${id}
  `)
}

export async function blockJob(
  db: EngineDatabase,
  id: number,
  status: 'blocked_on_semrush' | 'blocked_on_gads' | 'WAITING_ON_LLM',
): Promise<void> {
  await db.execute(sql`
    UPDATE hht_engine.jobs
       SET status = ${status}, locked_by = null, heartbeat_at = null, updated_at = now()
     WHERE id = ${id}
  `)
}

export async function failJob(db: EngineDatabase, id: number, error: string, attempts: number, maxAttempts: number): Promise<void> {
  const dead = attempts >= maxAttempts
  const delaySeconds = Math.min(3600, 2 ** attempts * 15)
  await db.execute(sql`
    UPDATE hht_engine.jobs
       SET status = ${dead ? 'dead' : 'pending'},
           last_error = ${error.slice(0, 500)},
           locked_by = null,
           heartbeat_at = null,
           run_after = now() + (${delaySeconds} || ' seconds')::interval,
           updated_at = now()
     WHERE id = ${id}
  `)
}

export async function saveCredential(db: EngineDatabase, credential: SemrushConnectorCredential): Promise<void> {
  await upsertVaultSecret(db, {
    name: SEMRUSH_OAUTH_SECRET,
    secret: JSON.stringify(credential),
    description: 'Cursor Semrush MCP OAuth session for the HHT engine',
  })
}

export async function loadCredential(db: EngineDatabase): Promise<SemrushConnectorCredential | null> {
  const value = await readVaultSecret(db, SEMRUSH_OAUTH_SECRET)
  return value ? JSON.parse(value) as SemrushConnectorCredential : null
}

export async function recordSemrushUnits(db: EngineDatabase, report: string, units: number | null, jobId: number | null): Promise<void> {
  await db.insert(hhtEngineSemrushUsage).values({ report, units, jobId })
  if (units && units > 0) {
    await db.execute(sql`
      UPDATE hht_engine.system_state
         SET units_used = units_used + ${units}, updated_at = now()
       WHERE id = 1
    `)
  }
}

export async function setGadsState(db: EngineDatabase, state: string): Promise<boolean> {
  const [row] = await db.select().from(hhtEngineSystemState).where(sql`${hhtEngineSystemState.id} = 1`)
  if (row?.gadsState === state) return false
  const gadsPausedAt = state === 'GADS_RUNNING' ? null : new Date()
  await db.insert(hhtEngineSystemState).values({ id: 1, gadsState: state, gadsPausedAt }).onConflictDoUpdate({
    target: hhtEngineSystemState.id,
    set: { gadsState: state, gadsPausedAt, updatedAt: new Date() },
  })
  return true
}

export async function setSemrushState(db: EngineDatabase, state: string): Promise<boolean> {
  const [row] = await db.select().from(hhtEngineSystemState).where(sql`${hhtEngineSystemState.id} = 1`)
  if (row?.semrushState === state) return false
  await db.insert(hhtEngineSystemState).values({ id: 1, semrushState: state }).onConflictDoUpdate({
    target: hhtEngineSystemState.id,
    set: {
      semrushState: state,
      semrushPausedAt: state === 'RUNNING' || state === 'LOW_CREDITS' ? null : new Date(),
      updatedAt: new Date(),
    },
  })
  return true
}

export function engineDb(): EngineDatabase {
  return getEngineDatabase()
}
