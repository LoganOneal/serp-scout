import { randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'

export const GOOGLE_ADS_SCOPE = 'https://www.googleapis.com/auth/adwords'

export async function runGoogleDesktopOAuth(input: {
  clientId: string
  clientSecret: string
  scopes: string[]
  openBrowser?: (url: string) => void
  fetchImpl?: typeof fetch
}): Promise<{ refreshToken: string; scope: string }> {
  const state = randomBytes(24).toString('hex')
  const fetchImpl = input.fetchImpl ?? fetch
  let resolveCode!: (value: string) => void
  let rejectCode!: (error: Error) => void
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve
    rejectCode = reject
  })
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/oauth/callback') {
      response.writeHead(404)
      response.end('Not found')
      return
    }
    if (url.searchParams.get('state') !== state) {
      response.writeHead(400)
      response.end('Invalid OAuth state')
      rejectCode(new Error('Google OAuth returned an invalid state'))
      return
    }
    const error = url.searchParams.get('error')
    const authCode = url.searchParams.get('code')
    if (error || !authCode) {
      response.writeHead(400)
      response.end('Authorization failed. You can close this tab.')
      rejectCode(new Error(`Google OAuth failed: ${error ?? 'missing code'}`))
      return
    }
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('Authorization complete. You can close this tab.')
    resolveCode(authCode)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not bind OAuth callback server')
  const redirectUri = `http://127.0.0.1:${address.port}/oauth/callback`
  const authorizationUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  authorizationUrl.search = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: input.scopes.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state,
  }).toString()
  const openBrowser = input.openBrowser ?? ((url: string) => {
    execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [url])
  })
  openBrowser(authorizationUrl.toString())
  let authorizationCode: string
  try {
    authorizationCode = await code
  } finally {
    server.close()
  }
  const tokenResponse = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      code: authorizationCode,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  })
  const body = await tokenResponse.text()
  if (!tokenResponse.ok) {
    throw new Error(`Google OAuth token exchange failed (${tokenResponse.status}): ${body.slice(0, 300)}`)
  }
  const token = JSON.parse(body) as { refresh_token?: string; scope?: string }
  if (!token.refresh_token) {
    throw new Error('Google OAuth did not return a refresh token; revoke the existing grant and retry')
  }
  return { refreshToken: token.refresh_token, scope: token.scope ?? input.scopes.join(' ') }
}
