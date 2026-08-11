import { describe, expect, it, vi } from 'vitest'
import { QueryTimeoutError, queryOr, withQueryTimeout } from './query-timeout.js'

/**
 * The deadline that stops a stalled query from becoming a 300-second hang.
 *
 * The bug this exists for: under concurrency a few queries against the transaction pooler
 * stopped returning. `connect_timeout` did not cover it -- the connection was already
 * established and had merely gone quiet -- so the render waited, the request produced zero
 * bytes, and the platform killed it. No error, no log, no way to distinguish it from slow.
 */

describe('withQueryTimeout', () => {
  it('returns the value when the query finishes in time', async () => {
    await expect(withQueryTimeout('fast', async () => 42, 1_000)).resolves.toBe(42)
  })

  it('rejects with a labelled error when it does not', async () => {
    const stalled = withQueryTimeout('listMarkets', () => new Promise<never>(() => {}), 20)
    await expect(stalled).rejects.toBeInstanceOf(QueryTimeoutError)
    // The label is in the message because "a query timed out" is not actionable and
    // "listMarkets did not return" is.
    await expect(stalled).rejects.toThrow(/listMarkets.*20ms/)
  })

  it('passes a real rejection through unchanged rather than reporting a timeout', async () => {
    // A refused connection and a stalled one need different responses, so they must not be
    // collapsed into the same error.
    await expect(
      withQueryTimeout('boom', async () => {
        throw new Error('connection refused')
      }),
    ).rejects.toThrow('connection refused')
  })

  it('leaves no pending timer, so a CLI script is not held open by a settled query', async () => {
    // Without the clearTimeout, `pnpm worker` and every script would sit for the full timeout
    // after finishing -- a pending timer keeps the event loop alive. Asserted by counting
    // live timers rather than by spying on clearTimeout, which replaces a global and leaked
    // into every later test in this file when it was written that way.
    vi.useFakeTimers()
    try {
      const before = vi.getTimerCount()
      await withQueryTimeout('done', async () => 'ok', 30_000)
      expect(vi.getTimerCount()).toBe(before)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('queryOr', () => {
  it('yields the query result when it succeeds', async () => {
    await expect(queryOr('ok', async () => [1, 2, 3], [])).resolves.toEqual([1, 2, 3])
  })

  it('falls back to the STATED unknown value on a timeout', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await expect(queryOr('stalled', () => new Promise<number[]>(() => {}), [], 20)).resolves.toEqual(
        [],
      )
      // Logged, because a page silently degrading is how you come to believe a market
      // produced no calls when the query merely stalled.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('stalled'))
    } finally {
      warn.mockRestore()
    }
  })

  it('preserves null as the fallback, distinct from a zero', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // The whole point: an unavailable measurement is null, which the UI renders as an em
      // dash. Falling back to 0 here would put "0 calls" on screen for a query that never ran.
      await expect(
        queryOr<number | null>('stats', () => new Promise(() => {}), null, 20),
      ).resolves.toBeNull()
    } finally {
      warn.mockRestore()
    }
  })
})
