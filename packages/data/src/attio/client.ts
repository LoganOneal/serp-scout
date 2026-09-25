/**
 * Thin typed Attio REST client. All HTTP goes through here.
 * Retries 429 (Retry-After) and transient 5xx. Never logs secrets.
 */

export class AttioError extends Error {
  readonly status: number
  readonly code: string | null
  readonly retryAfterMs: number | null

  constructor(args: { status: number; message: string; code?: string | null; retryAfterMs?: number | null }) {
    super(args.message)
    this.name = 'AttioError'
    this.status = args.status
    this.code = args.code ?? null
    this.retryAfterMs = args.retryAfterMs ?? null
  }
}

export interface AttioRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string
  query?: Record<string, string | number | boolean | undefined>
  body?: unknown
}

export interface AttioClientOptions {
  apiKey: string
  baseUrl?: string
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  maxRetries?: number
  logger?: (message: string) => void
}

const DEFAULT_BASE = 'https://api.attio.com/v2'

export class AttioClient {
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly sleep: (ms: number) => Promise<void>
  private readonly maxRetries: number
  private readonly logger: (message: string) => void

  constructor(opts: AttioClientOptions) {
    if (!opts.apiKey?.trim()) throw new Error('ATTIO_API_KEY is missing')
    this.apiKey = opts.apiKey.trim()
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/$/, '')
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.maxRetries = opts.maxRetries ?? 5
    this.logger = opts.logger ?? ((message) => console.error(message))
  }

  async request<T>(req: AttioRequest): Promise<T> {
    const url = this.url(req.path, req.query)
    let attempt = 0
    while (true) {
      const response = await this.fetchImpl(url, {
        method: req.method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: 'application/json',
          ...(req.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
      })
      if (response.status === 429 || (response.status >= 500 && response.status < 600)) {
        if (attempt >= this.maxRetries) {
          throw await this.error(response)
        }
        const wait = retryDelay(response, attempt)
        this.logger(`Attio ${response.status} on ${req.method} ${req.path}; retrying in ${wait}ms`)
        await this.sleep(wait)
        attempt += 1
        continue
      }
      if (!response.ok) throw await this.error(response)
      if (response.status === 204) return undefined as T
      return (await response.json()) as T
    }
  }

  get<T>(path: string, query?: AttioRequest['query']): Promise<T> {
    return this.request<T>({ method: 'GET', path, query })
  }
  post<T>(path: string, body?: unknown, query?: AttioRequest['query']): Promise<T> {
    return this.request<T>({ method: 'POST', path, body, query })
  }
  put<T>(path: string, body?: unknown, query?: AttioRequest['query']): Promise<T> {
    return this.request<T>({ method: 'PUT', path, body, query })
  }
  patch<T>(path: string, body?: unknown, query?: AttioRequest['query']): Promise<T> {
    return this.request<T>({ method: 'PATCH', path, body, query })
  }

  private url(path: string, query?: AttioRequest['query']): string {
    const trimmed = path.startsWith('/') ? path : `/${path}`
    const url = new URL(`${this.baseUrl}${trimmed}`)
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined) continue
      url.searchParams.set(key, String(value))
    }
    return url.toString()
  }

  private async error(response: Response): Promise<AttioError> {
    let message = `Attio HTTP ${response.status}`
    let code: string | null = null
    try {
      const body = (await response.json()) as { message?: string; code?: string }
      if (body.message) message = body.message
      if (body.code) code = body.code
    } catch {
      /* ignore non-JSON */
    }
    return new AttioError({
      status: response.status,
      message,
      code,
      retryAfterMs: retryDelay(response, 0),
    })
  }
}

export function retryDelay(response: Response, attempt: number): number {
  const header = response.headers.get('retry-after')
  if (header) {
    const seconds = Number(header)
    if (Number.isFinite(seconds)) return Math.max(250, seconds * 1000)
    const when = Date.parse(header)
    if (Number.isFinite(when)) return Math.max(250, when - Date.now())
  }
  return Math.min(8_000, 400 * 2 ** attempt)
}

export function attioClientFromEnv(
  env: Record<string, string | undefined> = process.env,
  extras: Partial<AttioClientOptions> = {},
): AttioClient {
  const apiKey = env.ATTIO_API_KEY
  if (!apiKey) throw new Error('ATTIO_API_KEY is missing')
  return new AttioClient({ apiKey, baseUrl: env.ATTIO_API_BASE, ...extras })
}
