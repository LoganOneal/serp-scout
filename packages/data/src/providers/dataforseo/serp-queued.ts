import { PRICE, type Micros } from '@rnr/core'
import type { DataForSeoClient } from './client.js'
import { ENDPOINTS } from './endpoints.js'

/**
 * Queued organic SERPs.
 *
 * ==================== 70% CHEAPER, MINUTES SLOWER ====================
 * Measured by balance delta 2026-08-07:
 *   live       /serp/google/organic/live/advanced   $0.00200
 *   task_post  /serp/google/organic/task_post       $0.00060
 *   task_get   /serp/google/organic/task_get/...    $0.00000
 *
 * A full 58-niche x 50-market sweep at 3 keywords goes from $17.40 to $5.22.
 * The cost is latency: a posted task was still not ready after several minutes,
 * which is why this cannot be awaited inside a job and needs the two-phase
 * lifecycle (post -> `awaiting` -> collect).
 * =====================================================================
 *
 * ==================== NEVER POLL task_get ====================
 * Ask `tasks_ready` first, then fetch each id ONCE. Polling `task_get` on a
 * task that is not ready returns 40601 "Task Handed" and the result is GONE --
 * paid for, unrecoverable, and no exception is raised. That failure was
 * reproduced during this work, not theorised.
 * ============================================================
 */

export interface PostedSerpTask {
  taskId: string
  costMicros: Micros
}

export interface QueuedSerpRequest {
  keyword: string
  locationCode: number
  device: 'desktop' | 'mobile'
  os: string
  depth: number
}

interface TaskPostResponse {
  id?: string
  status_code?: number
  status_message?: string
}

/** Queue one SERP. Billed now; the result is collected later. */
export async function postSerpTask(
  client: DataForSeoClient,
  req: QueuedSerpRequest,
): Promise<PostedSerpTask> {
  /**
   * `client.post` unwraps to `tasks[0].result`, but task_post carries the id on
   * the TASK, not in the result -- and its result is null. So the id is read
   * off the raw envelope instead.
   */
  const body = await client.postRaw<{ tasks?: TaskPostResponse[] }>(
    ENDPOINTS.SERP_ORGANIC_TASK_POST,
    [
      {
        keyword: req.keyword,
        location_code: req.locationCode,
        language_code: 'en',
        device: req.device,
        os: req.os,
        depth: req.depth,
      },
    ],
  )
  const task = body?.tasks?.[0]
  const taskId = task?.id
  if (!taskId) {
    throw new Error(
      `task_post returned no task id (status ${task?.status_code} ${task?.status_message ?? ''})`,
    )
  }
  return { taskId, costMicros: PRICE.serpOrganicTask }
}

/**
 * Task ids DataForSEO says are finished and waiting.
 *
 * Free. This is the ONLY safe way to learn a task is ready.
 */
export async function fetchReadyTaskIds(client: DataForSeoClient): Promise<Set<string>> {
  const result = await client.get<Array<{ id?: string }>>(ENDPOINTS.SERP_ORGANIC_TASKS_READY)
  const ids = new Set<string>()
  for (const r of result ?? []) if (r?.id) ids.add(r.id)
  return ids
}

export interface QueuedSerpResult {
  rawItems: Array<Record<string, unknown>>
  /** Free — the task was paid for at post time. */
  costMicros: Micros
}

/**
 * Collect a ready task. Call once per id, only after `tasks_ready` listed it.
 */
export async function getSerpTaskResult(
  client: DataForSeoClient,
  taskId: string,
): Promise<QueuedSerpResult> {
  const result = await client.get<Array<{ items?: Array<Record<string, unknown>> }>>(
    `${ENDPOINTS.SERP_ORGANIC_TASK_GET}/${encodeURIComponent(taskId)}`,
  )
  const items = result?.[0]?.items
  return {
    rawItems: Array.isArray(items) ? items : [],
    costMicros: 0n,
  }
}
