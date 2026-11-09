/**
 * Mint a Search Console refresh token, and prove it reaches the right property.
 *
 * ==================== WHY THIS SCRIPT EXISTS ====================
 * `searchConsoleConfigured` needs three things and already has two: it falls
 * back to GOOGLE_ADS_CLIENT_ID/SECRET for the OAuth app, and those are set. The
 * only missing piece is GSC_REFRESH_TOKEN — a refresh token carrying the
 * `webmasters.readonly` scope.
 *
 * That single absent value is what makes 975 of 975 keywords UNKNOWN: the
 * verdict pass reports every one of them as waiting on `position`, and Search
 * Console is the free and complete source for it. There was no way to obtain the
 * token from inside this repo, so it was a permanent blocker on a free signal.
 *
 * ==================== AND WHY IT VERIFIES BEFORE PRINTING ====================
 * The failure this catches is authorising the WRONG GOOGLE ACCOUNT. That
 * produces a perfectly valid refresh token which then returns zero rows for
 * every query — and zero rows from Search Console is indistinguishable from
 * "we rank for nothing", which is a real and expected answer for a young site.
 *
 * So the token is exchanged, used to list the properties it can actually see,
 * and the list is printed BEFORE the token is. If the domain you want is not in
 * that list, the token is wrong no matter how well it authenticated.
 * ===========================================================================
 *
 *   pnpm tsx --conditions=react-server packages/data/src/scripts/gsc-auth.mts
 *   pnpm tsx --conditions=react-server packages/data/src/scripts/gsc-auth.mts --port=8976
 */
import 'dotenv/config'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

const arg = (n: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3)

const clientId = process.env['GSC_CLIENT_ID']?.trim() || process.env['GOOGLE_ADS_CLIENT_ID']?.trim()
const clientSecret =
  process.env['GSC_CLIENT_SECRET']?.trim() || process.env['GOOGLE_ADS_CLIENT_SECRET']?.trim()

if (!clientId || !clientSecret) {
  console.error(
    'No OAuth app credentials. Set GSC_CLIENT_ID/GSC_CLIENT_SECRET, or GOOGLE_ADS_CLIENT_ID/\n' +
      'GOOGLE_ADS_CLIENT_SECRET — Search Console reuses the Google Ads OAuth app when its own\n' +
      'are unset.',
  )
  process.exit(1)
}

/** Read-only. This token can never write to Search Console or touch Ads. */
const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly'

const wanted = Number(arg('port') ?? '0')

const server = createServer()
await new Promise<void>((r) => server.listen(wanted, '127.0.0.1', r))
const port = (server.address() as AddressInfo).port
const redirectUri = `http://localhost:${port}`

const consent =
  'https://accounts.google.com/o/oauth2/v2/auth?' +
  new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPE,
    /**
     * Both are required and both are easy to omit. Without `offline` Google
     * returns only an access token, which expires in an hour; without
     * `consent` it withholds the refresh token on every authorisation after
     * the first, so a retry silently produces a token you cannot store.
     */
    access_type: 'offline',
    prompt: 'consent',
  }).toString()

console.log('\nOpen this URL and authorise as the Google account that OWNS the Search Console property:\n')
console.log(consent)
console.log(`\nWaiting on ${redirectUri} …`)
console.log(
  `\nIf Google says redirect_uri_mismatch, this OAuth client is a "Web application" rather than\n` +
    `a "Desktop app". Either add ${redirectUri} to its Authorised redirect URIs, or re-run with\n` +
    `--port=<a port you have already registered>.\n`,
)

const code = await new Promise<string>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('timed out after 5 minutes')), 300_000)
  server.on('request', (req, res) => {
    const url = new URL(req.url ?? '/', redirectUri)
    const err = url.searchParams.get('error')
    const got = url.searchParams.get('code')
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(
      `<html><body style="font:16px system-ui;padding:3rem">` +
        (got
          ? '<h2>Authorised.</h2><p>Return to your terminal.</p>'
          : `<h2>Failed</h2><pre>${err ?? 'no code returned'}</pre>`) +
        `</body></html>`,
    )
    clearTimeout(timer)
    if (got) resolve(got)
    else reject(new Error(err ?? 'no code returned'))
  })
})

server.close()

const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  }),
})

const token = (await tokenRes.json()) as {
  refresh_token?: string
  access_token?: string
  error_description?: string
  error?: string
}

if (!tokenRes.ok || !token.refresh_token) {
  console.error(
    `\nToken exchange failed: ${token.error_description ?? token.error ?? tokenRes.status}`,
  )
  if (tokenRes.ok && !token.refresh_token) {
    console.error(
      'Google returned an access token but no refresh token. That happens when the account has\n' +
        'already granted this app and `prompt=consent` was not honoured — revoke it at\n' +
        'https://myaccount.google.com/permissions and run this again.',
    )
  }
  process.exit(1)
}

// --- Verify BEFORE printing the token ---------------------------------------
const sitesRes = await fetch('https://searchconsole.googleapis.com/webmasters/v3/sites', {
  headers: { authorization: `Bearer ${token.access_token}` },
})
const sites = (await sitesRes.json()) as {
  siteEntry?: Array<{ siteUrl: string; permissionLevel: string }>
}

console.log('\nProperties this token can read:')
const entries = sites.siteEntry ?? []
if (entries.length === 0) {
  console.log('  (none)')
  console.log(
    '\nThe token is valid and sees NO properties, which almost always means you authorised a\n' +
      'different Google account than the one that owns the property. Nothing here can detect\n' +
      'that later: zero rows from Search Console reads exactly like "we rank for nothing".\n' +
      'Revoke at https://myaccount.google.com/permissions and re-run, choosing the owning account.',
  )
} else {
  for (const s of entries) console.log(`  ${s.permissionLevel.padEnd(16)} ${s.siteUrl}`)
}

console.log('\nAdd this to .env:\n')
console.log(`GSC_REFRESH_TOKEN=${token.refresh_token}`)
console.log(
  '\nThen: affiliate-research.mts rankings <domain> --live\n' +
    '\nsiteUrlCandidates tries sc-domain:, https://, https://www. and http:// in order, so it\n' +
    'does not matter which form the property is registered under — but it must appear above.',
)
