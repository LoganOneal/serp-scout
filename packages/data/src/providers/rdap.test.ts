import { describe, expect, it, vi } from 'vitest'
import { checkAvailability, checkAvailabilityBatch, emdDomain } from './rdap.js'

const response = (status: number): Response => new Response(status === 404 ? '' : '{}', { status })

/** A DNS resolver that always finds nothing, so the RDAP branch is what is tested. */
const noNs = async () => []
/** A DNS resolver that finds nameservers. */
const hasNs = async () => ['ns1.example.com', 'ns2.example.com']

describe('RDAP availability -- three states', () => {
  it('404 means AVAILABLE', () => {
    return checkAvailability('kenoshatreeserviceco9x.com', {
      fetchImpl: async () => response(404),
      resolveNsImpl: noNs,
    }).then((r) => {
      expect(r.available).toBe(true)
      expect(r.method).toBe('rdap')
      expect(r.httpStatus).toBe(404)
    })
  })

  it('200 means REGISTERED', async () => {
    const r = await checkAvailability('google.com', {
      fetchImpl: async () => response(200),
      resolveNsImpl: noNs,
    })
    expect(r.available).toBe(false)
    expect(r.method).toBe('rdap')
  })

  it('429 means UNKNOWN, never available', async () => {
    // A rate-limited registry is not a yes. This is the single most important
    // assertion in this file: reading a 429 as availability sends someone to buy
    // a domain that is already taken.
    const r = await checkAvailability('kenoshaplumbing.com', {
      fetchImpl: async () => response(429),
      resolveNsImpl: noNs,
    })
    expect(r.available).toBeNull()
    expect(r.available).not.toBe(true)
    expect(r.detail).toMatch(/HTTP 429, which is not an answer/)
  })

  it('5xx means UNKNOWN', async () => {
    for (const status of [500, 502, 503]) {
      const r = await checkAvailability('example-abc.com', {
        fetchImpl: async () => response(status),
        resolveNsImpl: noNs,
      })
      expect(r.available).toBeNull()
    }
  })

  it('a network failure means UNKNOWN', async () => {
    const r = await checkAvailability('example-abc.com', {
      fetchImpl: async () => {
        throw new Error('ECONNRESET')
      },
      resolveNsImpl: noNs,
    })
    expect(r.available).toBeNull()
    expect(r.detail).toMatch(/RDAP request failed/)
  })

  it('a timeout means UNKNOWN', async () => {
    const r = await checkAvailability('example-abc.com', {
      timeoutMs: 1,
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const e = new Error('aborted')
            e.name = 'AbortError'
            reject(e)
          })
        }),
      resolveNsImpl: noNs,
    })
    expect(r.available).toBeNull()
  })

  it('refuses to answer for a non-.com TLD rather than guessing', async () => {
    const r = await checkAvailability('kenoshatreeservice.net')
    expect(r.available).toBeNull()
    expect(r.method).toBe('none')
  })
})

describe('RDAP DNS fallback is asymmetric', () => {
  it('nameservers PRESENT proves registered', async () => {
    const r = await checkAvailability('parked-domain.com', {
      fetchImpl: async () => response(429),
      resolveNsImpl: hasNs,
    })
    expect(r.available).toBe(false)
    expect(r.method).toBe('dns')
    expect(r.detail).toMatch(/proves the domain is registered/)
  })

  it('nameservers ABSENT proves NOTHING and yields null', async () => {
    // Registered domains are routinely undelegated: parked without NS, newly
    // registered, expired-but-not-released, or held by a registrar. Absence of
    // nameservers cannot be upgraded to "available".
    const r = await checkAvailability('undelegated.com', {
      fetchImpl: async () => response(503),
      resolveNsImpl: noNs,
    })
    expect(r.available).toBeNull()
    expect(r.detail).toMatch(/proves nothing/)
  })

  it('an NXDOMAIN from the resolver also yields null', async () => {
    const r = await checkAvailability('nxdomain.com', {
      fetchImpl: async () => response(503),
      resolveNsImpl: async () => {
        throw new Error('queryNs ENOTFOUND')
      },
    })
    expect(r.available).toBeNull()
    expect(r.detail).toMatch(/proves nothing/)
  })
})

describe('RDAP batching', () => {
  it('throttles between requests', async () => {
    const calls: number[] = []
    const started = Date.now()
    await checkAvailabilityBatch(['a-test.com', 'b-test.com', 'c-test.com'], {
      throttleMs: 20,
      fetchImpl: async () => {
        calls.push(Date.now() - started)
        return response(404)
      },
      resolveNsImpl: noNs,
    })
    expect(calls).toHaveLength(3)
    // Three requests with two 20ms gaps.
    expect(calls[2]! - calls[0]!).toBeGreaterThanOrEqual(35)
  })

  it('keys results by lowercased domain', async () => {
    const out = await checkAvailabilityBatch(['MixedCase.com'], {
      throttleMs: 0,
      fetchImpl: async () => response(404),
      resolveNsImpl: noNs,
    })
    expect(out.get('mixedcase.com')?.available).toBe(true)
  })
})

describe('EMD construction', () => {
  it('concatenates locality and niche tokens', () => {
    expect(emdDomain('Kenosha', 'treeservice')).toBe('kenoshatreeservice.com')
    expect(emdDomain('San Buenaventura', 'plumbing')).toBe('sanbuenaventuraplumbing.com')
    expect(emdDomain("Coeur d'Alene", 'roofing')).toBe('coeurdaleneroofing.com')
    expect(emdDomain('Winston-Salem', 'hvac')).toBe('winstonsalemhvac.com')
  })
})
