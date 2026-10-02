import { classifySemrushFailure, type SemrushCallClass } from '@rnr/core'
import { accessTokenExpired, type SemrushConnectorCredential } from './credential.js'

export interface SemrushReportResult {
  data: unknown
  units: number | null
  raw: string
}

export class SemrushMcpError extends Error {
  readonly kind: SemrushCallClass
  constructor(message: string, kind: SemrushCallClass = classifySemrushFailure(message)) {
    super(message)
    this.name = 'SemrushMcpError'
    this.kind = kind
  }
}

export async function refreshSemrushCredential(
  credential: SemrushConnectorCredential,
  fetchImpl: typeof fetch = fetch,
): Promise<SemrushConnectorCredential> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: credential.refreshToken,
    client_id: credential.clientId,
  })
  const res = await fetchImpl(credential.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
  })
  const text = await res.text()
  if (!res.ok) throw new SemrushMcpError(`Semrush token refresh HTTP ${res.status}: ${text.slice(0, 240)}`)
  const json = JSON.parse(text) as {
    access_token?: string
    refresh_token?: string
    token_type?: string
    expires_in?: number
  }
  if (!json.access_token) throw new SemrushMcpError('Semrush token refresh returned no access token', 'auth')
  const expiresIn = json.expires_in ?? 3600
  return {
    ...credential,
    accessToken: json.access_token,
    refreshToken: json.refresh_token || credential.refreshToken,
    tokenType: json.token_type || credential.tokenType,
    expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
    syncedAt: new Date().toISOString(),
  }
}

export class SemrushMcpClient {
  private session: string | null = null
  credential: SemrushConnectorCredential

  constructor(
    credential: SemrushConnectorCredential,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly onCredential?: (next: SemrushConnectorCredential) => Promise<void> | void,
  ) {
    this.credential = credential
  }

  async ensureFresh(): Promise<void> {
    if (!accessTokenExpired(this.credential)) return
    const next = await refreshSemrushCredential(this.credential, this.fetchImpl)
    this.credential = next
    this.session = null
    await this.onCredential?.(next)
  }

  async executeReport(report: string, params: Record<string, unknown>): Promise<SemrushReportResult> {
    await this.ensureFresh()
    await this.initialize()
    const message = await this.rpc({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: { name: 'execute_report', arguments: { report, params } },
    })
    const raw = toolText(message)
    throwIfSemrushFailed(message, raw)
    const payload = reportPayload(raw)
    return {
      data: payload?.data ?? raw,
      units: payload?.metadata?.usage?.api_units ?? null,
      raw,
    }
  }

  async listReports(tool: string): Promise<unknown> {
    await this.ensureFresh()
    await this.initialize()
    const message = await this.rpc({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: { name: tool, arguments: {} },
    })
    const raw = toolText(message)
    throwIfSemrushFailed(message, raw)
    try {
      return JSON.parse(raw)
    } catch {
      return raw
    }
  }

  private async initialize(): Promise<void> {
    if (this.session) return
    await this.rpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'hht-backlink-engine', version: '2' },
      },
    })
    await this.rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })
  }

  private async rpc(body: Record<string, unknown>): Promise<SemrushRpcMessage | null> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${this.credential.accessToken}`,
    }
    if (this.session) headers['mcp-session-id'] = this.session
    const res = await this.fetchImpl(this.credential.mcpUrl, { method: 'POST', headers, body: JSON.stringify(body) })
    const text = await res.text()
    const session = res.headers.get('mcp-session-id')
    if (session) this.session = session
    if (res.status !== 200 && res.status !== 202) {
      throw new SemrushMcpError(`Semrush MCP HTTP ${res.status}: ${text.slice(0, 300)}`)
    }
    if (!text.trim()) return null
    const jsonText = text.includes('\ndata:') || text.startsWith('data:')
      ? text.split('\n').filter((line) => line.startsWith('data:')).at(-1)!.slice(5).trim()
      : text
    return JSON.parse(jsonText) as SemrushRpcMessage
  }
}

interface SemrushRpcMessage {
  error?: { message?: string }
  result?: { content?: Array<{ text?: string }>; isError?: boolean }
}

interface SemrushReportPayload {
  data?: unknown
  metadata?: { usage?: { api_units?: number } }
}

function throwIfSemrushFailed(message: SemrushRpcMessage | null, raw: string): void {
  if (message?.error?.message) throw new SemrushMcpError(message.error.message)
  if (message?.result?.isError) throw new SemrushMcpError(raw || 'Semrush MCP tool error')
}

function reportPayload(raw: string): SemrushReportPayload | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as SemrushReportPayload & { code?: string; message?: string }
    if (typeof parsed.code === 'string' && typeof parsed.message === 'string' && !('data' in parsed)) {
      throw new SemrushMcpError(parsed.message)
    }
    return parsed
  } catch (error) {
    if (error instanceof SemrushMcpError) throw error
    if (/ERROR\s+\d+/i.test(raw)) throw new SemrushMcpError(raw.slice(0, 400))
    return null
  }
}

function toolText(message: SemrushRpcMessage | null): string {
  return message?.result?.content?.[0]?.text ?? ''
}
