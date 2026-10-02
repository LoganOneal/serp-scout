import { HHT_ENGINE_SEMRUSH_MCP_URL, HHT_ENGINE_SEMRUSH_TOKEN_ENDPOINT } from '@rnr/core'

export interface SemrushConnectorCredential {
  accessToken: string
  refreshToken: string
  tokenType: string
  expiresAt: string
  clientId: string
  tokenEndpoint: string
  mcpUrl: string
  cursorUpdatedAtMs: number | null
  syncedAt: string
}

export function expiresAtFromAccessToken(accessToken: string, expiresInSeconds: number, now = Date.now()): string {
  const payload = accessToken.split('.')[1]
  if (payload) {
    try {
      const json = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { exp?: number }
      if (typeof json.exp === 'number') return new Date(json.exp * 1000).toISOString()
    } catch {
      // Opaque access tokens use expires_in from the moment of issue.
    }
  }
  return new Date(now + expiresInSeconds * 1000).toISOString()
}

export function credentialFromCursorTokens(input: {
  accessToken: string
  refreshToken: string
  tokenType?: string
  expiresIn: number
  clientId: string
  cursorUpdatedAtMs: number | null
  now?: number
}): SemrushConnectorCredential {
  const now = input.now ?? Date.now()
  return {
    accessToken: input.accessToken,
    refreshToken: input.refreshToken,
    tokenType: input.tokenType || 'Bearer',
    expiresAt: expiresAtFromAccessToken(input.accessToken, input.expiresIn, now),
    clientId: input.clientId,
    tokenEndpoint: HHT_ENGINE_SEMRUSH_TOKEN_ENDPOINT,
    mcpUrl: HHT_ENGINE_SEMRUSH_MCP_URL,
    cursorUpdatedAtMs: input.cursorUpdatedAtMs,
    syncedAt: new Date(now).toISOString(),
  }
}

export function accessTokenExpired(credential: SemrushConnectorCredential, now = Date.now(), skewMs = 120_000): boolean {
  return new Date(credential.expiresAt).getTime() - skewMs <= now
}
