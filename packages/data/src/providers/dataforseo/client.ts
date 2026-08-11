import {
  ACCOUNT_ISSUE_PATTERN,
  DFS_BASE,
  DFS_RATE_LIMIT,
  RATE_LIMIT_PATTERN,
  DFS_OK,
  DFS_TASK_CREATED,
  ENDPOINTS,
} from './endpoints.js'
import {
  AccountIssueError,
  RateLimitError,
  DfsHttpError,
  DfsShapeError,
  DfsTaskError,
} from './errors.js'

/**
 * Retries for a rate-limited request, and the first backoff step.
 *
 * Three attempts across ~1s + 2s + 4s covers a burst without holding a job for
 * a whole minute. If the limit is still refusing after that, the caller sees a
 * RateLimitError -- which requeues the job rather than failing the run.
 */
const RATE_LIMIT_RETRIES = 3
const RATE_LIMIT_BASE_MS = 1_000

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * DataForSEO HTTP client.
 *
 * Every response passes THREE gates, in this order, and none of them is
 * optional:
 *
 *   1. HTTP status is 2xx
 *   2. the body is JSON with a `tasks` array          <- catches HTML error pages
 *   3. tasks[0].status_code === 20000                 <- catches task-level errors
 *
 * Gate 3 is the one that matters most and the one every naive client omits.
 * DataForSEO returns HTTP 200 for essentially everything, including invalid
 * paths, malformed payloads, and suspended accounts. A failed task looks exactly
 * like a successful request from the outside.
 */

export interface DfsCredentials {
  login: string
  password: string
}

export interface DfsTaskEnvelope<T> {
  status_code: number
  status_message: string
  tasks?: Array<{
    id?: string
    status_code: number
    status_message: string
    result?: T | null
    result_count?: number
  }>
}

export interface DfsClientOptions {
  credentials: DfsCredentials
  baseUrl?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
  /** First backoff step for a rate-limited retry. Tests set this small. */
  rateLimitBaseMs?: number
  /** Called after every successful response, for the spend ledger. */
  onSpend?: (info: { path: string; rows: number }) => void
}

export class DataForSeoClient {
  private readonly auth: string
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly rateLimitBaseMs: number

  constructor(private readonly opts: DfsClientOptions) {
    const { login, password } = opts.credentials
    if (!login || !password) {
      // Fail loudly at construction. A client with blank credentials would
      // otherwise 401 on every call and read as "the API has no data".
      throw new Error(
        'DataForSEO credentials missing. Set DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD, ' +
          'or leave LIVE_CALLS_ENABLED unset to use the fixture providers.',
      )
    }
    this.auth = Buffer.from(`${login}:${password}`).toString('base64')
    this.baseUrl = opts.baseUrl ?? DFS_BASE
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.timeoutMs = opts.timeoutMs ?? 120_000
    // Injectable so the retry can be asserted without 26 seconds of real
    // sleeping in the unit suite.
    this.rateLimitBaseMs = opts.rateLimitBaseMs ?? RATE_LIMIT_BASE_MS
  }

  /** POST with the standard array-wrapped task payload. */
  /**
   * POST returning the RAW envelope rather than `tasks[0].result`.
   *
   * task_post carries its id on the TASK and leaves `result` null, so the
   * unwrapping `post` does would throw the id away.
   */
  async postRaw<T>(path: string, tasks: unknown[]): Promise<T> {
    // `this.auth` is the base64 pair WITHOUT the scheme, and baseUrl/fetchImpl
    // are injectable for tests -- matching `request` exactly rather than
    // rebuilding any of it.
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${this.auth}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(tasks),
    })
    if (!res.ok) {
      throw new Error(`DataForSEO ${path} returned HTTP ${res.status}`)
    }
    return (await res.json()) as T
  }

  async post<T>(path: string, tasks: unknown[]): Promise<T> {
    return this.request<T>(path, { method: 'POST', body: JSON.stringify(tasks) })
  }

  async get<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: 'GET' })
  }

  /**
   * Wait out a rate limit rather than surfacing it.
   *
   * The account's metadata endpoint allows 6 requests a minute, so a burst --
   * a preflight landing next to a script, or a retry storm -- trips it briefly.
   * Backoff starts above a second because the window is per MINUTE: retrying
   * in 50ms just spends another slot on the same refusal.
   */
  private async request<T>(path: string, init: RequestInit): Promise<T> {
    let lastError: unknown
    for (let attempt = 0; attempt <= RATE_LIMIT_RETRIES; attempt++) {
      try {
        return await this.requestOnce<T>(path, init)
      } catch (e) {
        if (!(e instanceof RateLimitError) || attempt === RATE_LIMIT_RETRIES) throw e
        lastError = e
        // Exponential with jitter, so parallel callers do not resynchronise
        // onto the same slot and trip the limit together again.
        const base = this.rateLimitBaseMs * 2 ** attempt
        const jitter = Math.floor(base * 0.25 * Math.random())
        await sleep(base + jitter)
      }
    }
    throw lastError
  }

  private async requestOnce<T>(path: string, init: RequestInit): Promise<T> {
    const url = `${this.baseUrl}${path}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)

    let res: Response
    let raw: string
    try {
      res = await this.fetchImpl(url, {
        ...init,
        signal: controller.signal,
        headers: {
          Authorization: `Basic ${this.auth}`,
          'Content-Type': 'application/json',
          ...(init.headers ?? {}),
        },
      })
      raw = await res.text()
    } finally {
      clearTimeout(timer)
    }

    // --- Gate 1: HTTP status -------------------------------------------------
    if (!res.ok) {
      // A 401/402 here can also be an account problem, so check the body text
      // before reporting it as a transport failure.
      this.throwIfAccountIssue(res.status * 100, raw)
      throw new DfsHttpError(res.status, path, raw)
    }

    // --- Gate 2: body shape -------------------------------------------------
    // HTTP 200 with an HTML body is a real failure mode across providers (the
    // Census API does exactly this for a missing key). Never trust the status
    // code alone to mean "I received the structure I asked for".
    let parsed: DfsTaskEnvelope<T>
    try {
      parsed = JSON.parse(raw) as DfsTaskEnvelope<T>
    } catch {
      throw new DfsShapeError(path, 'body is not valid JSON', raw)
    }
    if (parsed === null || typeof parsed !== 'object') {
      throw new DfsShapeError(path, 'body is not an object', raw)
    }
    if (!Array.isArray(parsed.tasks)) {
      this.throwIfAccountIssue(parsed.status_code, parsed.status_message ?? '')
      throw new DfsShapeError(path, 'response has no tasks array', raw)
    }

    // --- Gate 3: TASK-LEVEL status ------------------------------------------
    const task = parsed.tasks[0]
    if (!task) throw new DfsShapeError(path, 'tasks array is empty', raw)

    /**
     * `task_post` answers 20100 "Task Created." -- that is its SUCCESS code,
     * not a failure. Treating every non-20000 as fatal made the queued
     * (70%-cheaper) SERP path impossible to call at all.
     */
    if (task.status_code !== DFS_OK && task.status_code !== DFS_TASK_CREATED) {
      // Account problems must be distinguished BEFORE the generic task error,
      // because they have to abort the run rather than be recorded as a gap.
      this.throwIfAccountIssue(task.status_code, task.status_message)
      throw new DfsTaskError(path, task.status_code, task.status_message)
    }

    const rows = task.result_count ?? (Array.isArray(task.result) ? task.result.length : 0)
    this.opts.onSpend?.({ path, rows })

    if (task.result === undefined || task.result === null) {
      // A successful task with no result is legitimate (a SERP with no results),
      // so this is not an error -- but the caller gets an explicit empty shape
      // rather than undefined, so it cannot be confused with a parse failure.
      return [] as unknown as T
    }
    return task.result
  }

  /**
   * Rate limits are checked BEFORE the payment range, because 40202 lives
   * inside it and is not an account problem. See RateLimitError.
   */
  private throwIfRateLimited(statusCode: number, message: string): void {
    if (statusCode === DFS_RATE_LIMIT || RATE_LIMIT_PATTERN.test(message ?? '')) {
      throw new RateLimitError(statusCode, message ?? '')
    }
  }

  private throwIfAccountIssue(statusCode: number, message: string): void {
    this.throwIfRateLimited(statusCode, message)
    // The 402xx family is DataForSEO's payment/access range. The message test is
    // the belt to that braces: the exact codes are not fully documented and have
    // changed, but the wording ("unusual activity... temporarily paused") is
    // consistent.
    const inPaymentRange = statusCode >= 40200 && statusCode < 40300
    if (inPaymentRange || ACCOUNT_ISSUE_PATTERN.test(message ?? '')) {
      throw new AccountIssueError(statusCode, message ?? '')
    }
  }
}

// ---------------------------------------------------------------------------

export interface AccountStatus {
  login: string
  balanceUsd: number
  /** DataForSEO's own flag. False means calls will fail. */
  canMakeRequests: boolean
  raw: unknown
}

/**
 * Free preflight. Called before any scan spends money, so a suspended account or
 * an empty balance is discovered as an explicit error rather than as a locality
 * full of jackpot SERPs.
 */
export async function fetchAccountStatus(client: DataForSeoClient): Promise<AccountStatus> {
  const result = await client.get<
    Array<{
      login?: string
      money?: { balance?: number }
      rates?: unknown
      price?: unknown
    }>
  >(ENDPOINTS.USER_DATA)

  const row = Array.isArray(result) ? result[0] : undefined
  const balanceUsd = row?.money?.balance ?? 0
  return {
    login: row?.login ?? 'unknown',
    balanceUsd,
    canMakeRequests: balanceUsd > 0,
    raw: result,
  }
}
