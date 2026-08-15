/**
 * Bearer-token auth, failing closed.
 *
 * ==================== WHY NOT crypto.timingSafeEqual ====================
 * It lives in `node:crypto`, which does not exist on Vercel Edge, Cloudflare
 * Workers, or Deno. This package is installed into a codebase we do not control
 * and cannot survey, so importing a Node builtin to save fifteen lines would
 * trade a portable package for a slightly shorter one — and the failure would
 * be a module-resolution error at deploy time, in someone else's repo.
 *
 * Zero imports is the whole point of this package's dependency policy. The
 * comparison below is the same accumulate-then-compare shape, over the max of
 * the two lengths so that content never short-circuits.
 * =====================================================================
 */

/**
 * Constant-time with respect to CONTENT. Not with respect to length — the
 * lengths are folded into the accumulator so a mismatch cannot pass, but a
 * timing observer could still learn how long the configured token is. That is
 * not a secret worth a hash round-trip; the token's ENTROPY is.
 */
export function safeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length)
  let diff = a.length ^ b.length
  for (let i = 0; i < len; i += 1) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0)
  }
  return diff === 0
}

export function bearerFrom(headers: Headers): string | null {
  const raw = headers.get('authorization') ?? headers.get('Authorization')
  if (!raw) return null
  const m = /^Bearer\s+(.+)$/i.exec(raw.trim())
  return m && m[1] ? m[1].trim() : null
}

export type AuthOutcome =
  /** No token is configured. Every endpoint 503s. See SupplyFeedConfig.token. */
  | { ok: false; reason: 'not_configured' }
  | { ok: false; reason: 'unauthorized' }
  | { ok: true; token: string }

export function authenticate(configured: string | undefined | null, headers: Headers): AuthOutcome {
  const expected = configured?.trim()
  if (!expected) return { ok: false, reason: 'not_configured' }
  const presented = bearerFrom(headers)
  if (!presented || !safeEqual(expected, presented)) return { ok: false, reason: 'unauthorized' }
  return { ok: true, token: presented }
}

/**
 * A fixed-window counter, per token, in memory.
 *
 * Deliberately NOT a sliding window and deliberately NOT shared across
 * instances. It exists to stop a runaway loop hammering the publisher's
 * database, which is a bug-shaped problem, not an adversary-shaped one. Calling
 * it a security control would overstate what a per-instance counter can do on a
 * horizontally-scaled host, and this comment is here so nobody later assumes it
 * is one.
 */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>()

  constructor(
    private readonly perMinute: number,
    private readonly now: () => number,
  ) {}

  /** Returns null when allowed, or the seconds to wait when not. */
  check(key: string): number | null {
    if (this.perMinute <= 0) return null
    const t = this.now()
    const w = this.windows.get(key)
    if (!w || t - w.start >= 60_000) {
      this.windows.set(key, { start: t, count: 1 })
      return null
    }
    w.count += 1
    if (w.count <= this.perMinute) return null
    return Math.max(1, Math.ceil((w.start + 60_000 - t) / 1000))
  }
}
