import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Retell webhook signature verification.
 *
 * Scheme, per docs.retellai.com/features/secure-webhook:
 *
 *   X-Retell-Signature: v={unix_millis},d={hex_hmac}
 *   d = HMAC-SHA256(raw_body + timestamp, api_key), hex
 *   timestamp must be within 5 minutes of now
 *
 * ==================== THERE IS NO BYPASS FLAG ====================
 * No SKIP_SIGNATURE, no `if (!isProduction) return true`. Such a flag ships to
 * production eventually and turns /api/retell/tool into an open write endpoint --
 * anyone on the internet could POST fabricated leads into the CRM, and the rows
 * would be indistinguishable from real ones.
 *
 * The simulator signs its payloads with the same key instead, so the verified
 * path is the only path AND the tested one.
 * ================================================================
 */

/** Retell's documented replay window. */
export const SIGNATURE_TOLERANCE_MS = 5 * 60 * 1000

export type VerifyFailure =
  | 'missing_signature'
  | 'malformed_signature'
  | 'stale_timestamp'
  | 'digest_mismatch'
  | 'missing_key'

export interface VerifyResult {
  valid: boolean
  /** null when valid. Persisted on the event row so failures are diagnosable. */
  reason: VerifyFailure | null
}

const HEADER = /^v=(\d+),d=([0-9a-f]+)$/i

/**
 * Verify a raw body against a signature header.
 *
 * `rawBody` MUST be the exact bytes received. Re-serialised JSON changes
 * whitespace and key order and fails verification for reasons that look like a
 * wrong secret -- which is a genuinely expensive afternoon.
 */
export function verifyRetellSignature(args: {
  rawBody: string
  signature: string | null | undefined
  apiKey: string | null | undefined
  /** Injectable for tests. Never passed in production. */
  now?: number
}): VerifyResult {
  const { rawBody, signature, apiKey } = args
  const now = args.now ?? Date.now()

  if (!apiKey) return { valid: false, reason: 'missing_key' }
  if (!signature) return { valid: false, reason: 'missing_signature' }

  const m = HEADER.exec(signature.trim())
  if (!m) return { valid: false, reason: 'malformed_signature' }

  const timestamp = m[1]!
  const received = m[2]!.toLowerCase()

  const ts = Number(timestamp)
  if (!Number.isFinite(ts)) return { valid: false, reason: 'malformed_signature' }
  // Absolute difference: a clock skewed either way is equally unverifiable, and a
  // future-dated signature is exactly what a replay looks like.
  if (Math.abs(now - ts) > SIGNATURE_TOLERANCE_MS) {
    return { valid: false, reason: 'stale_timestamp' }
  }

  const expected = createHmac('sha256', apiKey).update(rawBody + timestamp).digest('hex')

  // Length check first: timingSafeEqual throws on a length mismatch rather than
  // returning false, which would surface as a 500 instead of a 401.
  if (expected.length !== received.length) return { valid: false, reason: 'digest_mismatch' }
  const ok = timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(received, 'utf8'))
  return ok ? { valid: true, reason: null } : { valid: false, reason: 'digest_mismatch' }
}

/**
 * Produce a valid signature. Used ONLY by the simulator and the tests.
 *
 * Exported deliberately rather than duplicated in the test file: if the signing
 * and verifying halves can drift apart, the simulator starts passing against a
 * verifier that real Retell traffic would fail.
 */
export function signRetellPayload(args: {
  rawBody: string
  apiKey: string
  now?: number
}): string {
  const timestamp = String(args.now ?? Date.now())
  const digest = createHmac('sha256', args.apiKey).update(args.rawBody + timestamp).digest('hex')
  return `v=${timestamp},d=${digest}`
}
