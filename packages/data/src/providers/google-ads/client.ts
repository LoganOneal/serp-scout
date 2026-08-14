import 'server-only'
import type { GoogleAdsEnv } from './keyword-volume.js'

/**
 * Shared Google Ads plumbing: OAuth, account ids, API version.
 *
 * Extracted because there are now three callers (volume, ideas, forecast) plus
 * the mutate framework, and four copies of a token refresh is four places for
 * the login-customer-id header to be wrong in a way that only shows up as a
 * permissions error nobody can attribute.
 */

export function googleAdsApiVersion(env: GoogleAdsEnv = process.env): string {
  // Ideas needs v22; v21 answers 400 UNSUPPORTED_VERSION. See keyword-volume.ts.
  return env['GOOGLE_ADS_API_VERSION']?.trim() || 'v22'
}

export function googleAdsIds(env: GoogleAdsEnv = process.env): {
  customerId: string
  loginCustomerId: string
} {
  const digits = (v: string | undefined): string => (v ?? '').replace(/\D/g, '')
  const customerId = digits(env['GOOGLE_ADS_CUSTOMER_ID'])
  const loginCustomerId = digits(env['GOOGLE_ADS_LOGIN_CUSTOMER_ID']) || customerId
  return { customerId, loginCustomerId }
}

export async function googleAdsAccessToken(
  env: GoogleAdsEnv,
  fetchImpl: typeof fetch,
): Promise<string> {
  const body = new URLSearchParams({
    client_id: env['GOOGLE_ADS_CLIENT_ID']!.trim(),
    client_secret: env['GOOGLE_ADS_CLIENT_SECRET']!.trim(),
    refresh_token: env['GOOGLE_ADS_REFRESH_TOKEN']!.trim(),
    grant_type: 'refresh_token',
  })
  const res = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  const json = (await res.json()) as { access_token?: string; error_description?: string }
  if (!res.ok || !json.access_token) {
    throw new Error(`Google Ads token exchange failed: ${json.error_description ?? res.status}`)
  }
  return json.access_token
}

/**
 * ==================== THE SECOND GATE, AND WHY IT EXISTS ====================
 * `LIVE_CALLS_ENABLED` governs spending cents at data vendors — a SERP is
 * $0.002 and the budget guard caps a run. This governs creating campaigns in a
 * Google Ads account that bills a credit card with a daily budget, where the
 * failure mode is not "we spent $3 more than expected" but "an unattended
 * campaign spent for a week".
 *
 * Reusing one flag for both would mean that enabling live SERP purchases — a
 * routine, cheap, capped action — also enables uncapped ad spend. Those are not
 * the same decision and must not share a switch.
 *
 * Same shape as the telephony provisioning script, which is dry-run until
 * `--confirm`. Both flags must be the exact string 'true': a misconfigured env
 * var fails toward $0.
 * ==========================================================================
 */
export function googleAdsMutationsEnabled(env: GoogleAdsEnv = process.env): boolean {
  return env['GOOGLE_ADS_MUTATIONS_ENABLED'] === 'true'
}

export class GoogleAdsMutationBlocked extends Error {}

/**
 * Throws unless BOTH gates are open and the caller passed an explicit confirm.
 *
 * Three independent conditions, deliberately. Any one of them being an accident
 * — a stale env var, a copied command line — is not enough to spend money.
 */
export function assertMutationsAllowed(args: {
  confirm: boolean
  env?: GoogleAdsEnv
  what: string
}): void {
  const env = args.env ?? process.env

  if (env['LIVE_CALLS_ENABLED'] !== 'true') {
    throw new GoogleAdsMutationBlocked(
      `Refusing to ${args.what}: LIVE_CALLS_ENABLED is not the exact string "true".`,
    )
  }
  if (!googleAdsMutationsEnabled(env)) {
    throw new GoogleAdsMutationBlocked(
      `Refusing to ${args.what}: GOOGLE_ADS_MUTATIONS_ENABLED is not the exact string "true". ` +
        `This is a SEPARATE gate from LIVE_CALLS_ENABLED on purpose — enabling $0.002 SERP ` +
        `purchases must not also enable uncapped ad spend.`,
    )
  }
  if (!args.confirm) {
    throw new GoogleAdsMutationBlocked(
      `Refusing to ${args.what}: both gates are open but --confirm was not passed. ` +
        `The last step is always deliberate.`,
    )
  }
}
