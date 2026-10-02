import { describe, expect, it } from 'vitest'
import { HHT_ENGINE_SEMRUSH_MCP_URL, HHT_ENGINE_SEMRUSH_TOKEN_ENDPOINT } from '@rnr/core'
import type { SemrushConnectorCredential } from './credential.js'
import { SemrushMcpClient, SemrushMcpError } from './semrush-mcp.js'

const credential: SemrushConnectorCredential = {
  accessToken: 'access',
  refreshToken: 'refresh',
  tokenType: 'Bearer',
  expiresAt: '2099-01-01T00:00:00.000Z',
  clientId: 'client',
  tokenEndpoint: HHT_ENGINE_SEMRUSH_TOKEN_ENDPOINT,
  mcpUrl: HHT_ENGINE_SEMRUSH_MCP_URL,
  cursorUpdatedAtMs: null,
  syncedAt: '2026-10-02T00:00:00.000Z',
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('Semrush MCP client', () => {
  it('fails a JSON-RPC error instead of treating it as an empty report', async () => {
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { method?: string }
      if (body.method === 'initialize') return jsonResponse({ jsonrpc: '2.0', id: 1, result: {} })
      if (body.method === 'notifications/initialized') return new Response(null, { status: 202 })
      return jsonResponse({
        jsonrpc: '2.0',
        id: 2,
        error: { code: -32603, message: '{"code":"internal","message":"unknown report","retryable":false}' },
      })
    }
    const client = new SemrushMcpClient(credential, fetchImpl)
    await expect(client.executeReport('domain_organic', { domain: 'tubhotels.com' })).rejects.toBeInstanceOf(SemrushMcpError)
  })

  it('fails a unit-balance payload returned as tool text', async () => {
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { method?: string }
      if (body.method === 'initialize') return jsonResponse({ jsonrpc: '2.0', id: 1, result: {} })
      if (body.method === 'notifications/initialized') return new Response(null, { status: 202 })
      return jsonResponse({
        jsonrpc: '2.0',
        id: 2,
        result: {
          content: [{
            type: 'text',
            text: JSON.stringify({
              code: 'no_api_units',
              message: 'The user does not have enough API units to complete this request.',
            }),
          }],
        },
      })
    }
    const client = new SemrushMcpClient(credential, fetchImpl)
    await expect(client.executeReport('resource_organic', { target: 'tubhotels.com' })).rejects.toMatchObject({ kind: 'exhausted' })
  })
})
