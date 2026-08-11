import { describe, expect, it, vi } from 'vitest'
import { DataForSeoClient } from './client.js'
import {
  AccountIssueError,
  RateLimitError,
  isFatalProviderError,
  isRetryableProviderError,
} from './errors.js'

/**
 * A rate limit must not read as a suspended account.
 *
 * ==================== WHAT THIS COST ====================
 * DataForSEO answers "The rates limit per minute has been exceeded: 6 >= 6"
 * with status 40202, which sits inside the 402xx payment/access range the
 * client treated wholesale as fatal. So the most ordinary recoverable failure
 * it has marked the entire discovery run FAILED and every pending job with it.
 *
 * The blanket range was right about the thing it was written for -- a paused
 * account must abort, because empty SERPs score every market as wide open --
 * and wrong about the one code inside it that says nothing about the account.
 * =======================================================
 */

const envelope = (statusCode: number, statusMessage: string) =>
  JSON.stringify({
    status_code: statusCode,
    status_message: statusMessage,
    tasks: [{ status_code: statusCode, status_message: statusMessage, result: null }],
  })

const okEnvelope = JSON.stringify({
  status_code: 20000,
  status_message: 'Ok.',
  tasks: [{ status_code: 20000, status_message: 'Ok.', result: [{ ok: true }] }],
})

function clientWith(bodies: string[]) {
  let i = 0
  const fetchImpl = vi.fn(async () => {
    const body = bodies[Math.min(i, bodies.length - 1)]!
    i += 1
    return new Response(body, { status: 200 })
  })
  const client = new DataForSeoClient({
    credentials: { login: 'a', password: 'b' },
    fetchImpl: fetchImpl as unknown as typeof fetch,
    // Real backoff is seconds, because the limit is per MINUTE. The retry
    // BEHAVIOUR is what these assert, not the wall-clock of the wait.
    rateLimitBaseMs: 1,
  })
  return { client, fetchImpl }
}

const RATE_LIMITED = envelope(40202, 'The rates limit per minute has been exceeded: 6 >= 6.')

describe('rate limit is transient, not an account issue', () => {
  it('classifies 40202 as retryable and NOT fatal', () => {
    const e = new RateLimitError(40202, 'The rates limit per minute has been exceeded: 6 >= 6.')
    expect(isFatalProviderError(e)).toBe(false)
    expect(isRetryableProviderError(e)).toBe(true)
  })

  it('still treats a paused account as fatal', () => {
    // The guard this range was written for must keep working.
    const e = new AccountIssueError(40200, 'Account is temporarily paused.')
    expect(isFatalProviderError(e)).toBe(true)
    expect(isRetryableProviderError(e)).toBe(false)
  })

  it('retries a rate-limited request and succeeds', async () => {
    const { client, fetchImpl } = clientWith([RATE_LIMITED, okEnvelope])
    await expect(client.get('/x')).resolves.toEqual([{ ok: true }])
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('gives up as a RateLimitError, never as an AccountIssueError', async () => {
    // The distinction is the whole point: the caller requeues one and condemns
    // the run on the other.
    const { client } = clientWith([RATE_LIMITED])
    await expect(client.get('/x')).rejects.toBeInstanceOf(RateLimitError)
    await expect(client.get('/x')).rejects.not.toBeInstanceOf(AccountIssueError)
  })

  it('does not retry a paused account — that is not going to clear', async () => {
    const { client, fetchImpl } = clientWith([envelope(40200, 'Account is temporarily paused.')])
    await expect(client.get('/x')).rejects.toBeInstanceOf(AccountIssueError)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('matches the wording even if the code moves', async () => {
    // The codes are undocumented and have changed before, so the message is
    // the belt to that braces.
    const { client } = clientWith([envelope(40299, 'Too Many Requests')])
    await expect(client.get('/x')).rejects.toBeInstanceOf(RateLimitError)
  })
})
