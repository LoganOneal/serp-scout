import { describe, expect, it } from 'vitest'
import { DataForSeoClient, fetchAccountStatus } from './client.js'
import { loadContract } from './contracts.js'
import { ENDPOINTS } from './endpoints.js'
import { AccountIssueError, DfsShapeError, DfsTaskError } from './errors.js'

/**
 * The client's three gates, tested against captured payloads.
 *
 * Gate 3 -- the task-level status check -- is the one every naive client omits,
 * and the one the real 40207 capture below proves is load-bearing.
 */

const creds = { login: 'test@example.com', password: 'secret' }

function clientReturning(body: unknown, status = 200, contentType = 'application/json') {
  return new DataForSeoClient({
    credentials: creds,
    fetchImpl: async () =>
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'content-type': contentType },
      }),
  })
}

describe('client gate 1 -- HTTP status', () => {
  it('rejects a 500', async () => {
    const c = clientReturning({ tasks: [] }, 500)
    await expect(c.get(ENDPOINTS.USER_DATA)).rejects.toThrow(/HTTP 500/)
  })

  it('rejects a 401 as a transport failure, not an account hold', async () => {
    // Bad credentials are an honest 401 and a different problem from a hold:
    // they should not abort a run with an AccountIssueError.
    const c = clientReturning('Unauthorized', 401, 'text/plain')
    await expect(c.get(ENDPOINTS.USER_DATA)).rejects.not.toBeInstanceOf(AccountIssueError)
  })
})

describe('client gate 2 -- body shape', () => {
  it('rejects an HTML page served under HTTP 200', async () => {
    // The Census API does exactly this for a missing key: 8,529 bytes of HTML
    // with a 200 status. A status code is not evidence of content.
    const c = clientReturning('<html><head><title>Missing Key</title></head></html>', 200, 'text/html')
    await expect(c.get(ENDPOINTS.USER_DATA)).rejects.toBeInstanceOf(DfsShapeError)
  })

  it('rejects a JSON body with no tasks array', async () => {
    const c = clientReturning({ status_code: 20000, status_message: 'Ok.' })
    await expect(c.get(ENDPOINTS.USER_DATA)).rejects.toBeInstanceOf(DfsShapeError)
  })

  it('rejects an empty tasks array', async () => {
    const c = clientReturning({ status_code: 20000, tasks: [] })
    await expect(c.get(ENDPOINTS.USER_DATA)).rejects.toBeInstanceOf(DfsShapeError)
  })
})

describe('client gate 3 -- TASK-level status', () => {
  it('ABORTS on the real 40207 IP-whitelist payload', async () => {
    // ============ THE TRAP, AS ACTUALLY CAPTURED FROM THE API ============
    // HTTP 200. Top-level status_code 20000. status_message "Ok."
    // The only signal is tasks[0].status_code = 40207.
    //
    // Read as "no results", this scores every SERP in the corpus as having no
    // competitors -- and the credentials are VALID, so nothing else looks wrong.
    // =====================================================================
    const payload = loadContract('error_ip_not_whitelisted').payload as {
      status_code: number
      tasks: Array<{ status_code: number }>
    }
    expect(payload.status_code).toBe(20000) // outer envelope claims success
    expect(payload.tasks[0]!.status_code).toBe(40207)

    const c = clientReturning(payload)
    const err = await c.get(ENDPOINTS.USER_DATA).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AccountIssueError)
    expect((err as AccountIssueError).statusCode).toBe(40207)
    // The message must say why this aborts rather than degrading.
    expect((err as Error).message).toMatch(/score every SERP as wide open/)
  })

  it('aborts on a paused account', async () => {
    const payload = loadContract('error_account_paused').payload
    const c = clientReturning(payload)
    await expect(c.get(ENDPOINTS.SERP_ORGANIC_LIVE)).rejects.toBeInstanceOf(AccountIssueError)
  })

  it('raises an ordinary task error for a wrong path, NOT an account issue', async () => {
    // "Invalid Path." must stay recoverable: aborting whole runs for a
    // per-keyword error would be its own failure mode.
    const payload = loadContract('error_invalid_path').payload
    const c = clientReturning(payload)
    const err = await c.get('/serp/google/organic/locations').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DfsTaskError)
    expect(err).not.toBeInstanceOf(AccountIssueError)
    expect((err as DfsTaskError).statusMessage).toBe('Invalid Path.')
  })

  it('never lets an account issue be caught as an empty result set', async () => {
    // The behavioural guarantee, stated as a test: there must be no path from a
    // 402xx task code to a successful call returning zero rows.
    const payload = loadContract('error_ip_not_whitelisted').payload
    const c = clientReturning(payload)
    let returned: unknown = 'DID NOT THROW'
    try {
      returned = await c.get(ENDPOINTS.USER_DATA)
    } catch {
      returned = 'THREW'
    }
    expect(returned).toBe('THREW')
  })
})

describe('client success path', () => {
  it('unwraps tasks[0].result', async () => {
    const c = clientReturning(loadContract('user_data').payload)
    const status = await fetchAccountStatus(c)
    expect(status.login).toBe('operator@example.com')
    expect(status.balanceUsd).toBeCloseTo(41.7382, 4)
    expect(status.canMakeRequests).toBe(true)
  })

  it('reports a zero balance as unusable', async () => {
    const payload = {
      status_code: 20000,
      tasks: [
        {
          status_code: 20000,
          status_message: 'Ok.',
          result: [{ login: 'x@y.com', money: { balance: 0 } }],
        },
      ],
    }
    const c = clientReturning(payload)
    const status = await fetchAccountStatus(c)
    // A zero balance must block a scan: an unfunded account returns empty SERPs,
    // which score as wide-open markets.
    expect(status.canMakeRequests).toBe(false)
  })

  it('returns an empty shape, not undefined, for a successful task with null result', async () => {
    const payload = {
      status_code: 20000,
      tasks: [{ status_code: 20000, status_message: 'Ok.', result: null }],
    }
    const c = clientReturning(payload)
    await expect(c.get(ENDPOINTS.USER_DATA)).resolves.toEqual([])
  })

  it('refuses to construct with blank credentials', () => {
    expect(() => new DataForSeoClient({ credentials: { login: '', password: '' } })).toThrow(
      /credentials missing/,
    )
  })
})
