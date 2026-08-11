import { describe, expect, it } from 'vitest'
import { bulkItemsOf, listContracts, loadContract, resultOf } from './contracts.js'
import { normaliseMapPackResult, normaliseOrganicResult } from './serp.js'
import { ACCOUNT_ISSUE_PATTERN, DFS_OK, ENDPOINTS } from './endpoints.js'

/**
 * Contract tests: does the adapter read the fields the API actually returns?
 *
 * These assert against captured payloads rather than against hand-built objects,
 * because a hand-built object encodes our beliefs and the whole class of bug
 * being guarded here IS a wrong belief.
 */

// ---------------------------------------------------------------------------
// THE Trap 1 guard
// ---------------------------------------------------------------------------

describe('bulk_ranks returns ONLY {target, rank}', () => {
  const items = bulkItemsOf<Record<string, unknown>>(loadContract('bulk_ranks').payload)

  it('has items to assert on', () => {
    expect(items.length).toBeGreaterThan(0)
  })

  it('does NOT return referring_domains, referring_main_domains, or backlinks', () => {
    // ================== THE MOST IMPORTANT TEST IN THIS REPO ==================
    // Reading refdomains off bulk_ranks yields undefined -> null for every domain
    // in the corpus. Nothing throws. The 0.40-weight authorityWall component
    // silently drops out of every score, the model renormalises around the hole
    // exactly as designed, and the only symptom is a coverage percentage nobody
    // reads. This survived for months.
    //
    // It is a NEGATIVE assertion on purpose: it fails when the API gains a field
    // we might wrongly start trusting, and it cannot be satisfied by agreeing
    // with whatever the adapter currently does.
    // =========================================================================
    for (const item of items) {
      expect(item).not.toHaveProperty('referring_domains')
      expect(item).not.toHaveProperty('referring_main_domains')
      expect(item).not.toHaveProperty('referring_domains_nofollow')
      expect(item).not.toHaveProperty('backlinks')
    }
  })

  it('has exactly the two keys and no others', () => {
    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual(['rank', 'target'])
    }
  })
})

describe('bulk_referring_domains is where the link counts actually live', () => {
  const items = bulkItemsOf<Record<string, unknown>>(
    loadContract('bulk_referring_domains').payload,
  )

  it('returns all three fields the scorer needs', () => {
    expect(items.length).toBeGreaterThan(0)
    for (const item of items) {
      expect(item).toHaveProperty('referring_domains')
      expect(item).toHaveProperty('referring_domains_nofollow')
      expect(item).toHaveProperty('referring_main_domains')
      expect(typeof item['referring_main_domains']).toBe('number')
    }
  })

  it('reports main domains at or below total domains', () => {
    // The reason referring_main_domains is preferred: 400 referring domains that
    // are 380 subdomains of one blog network is not a 400-domain competitor.
    for (const item of items) {
      expect(item['referring_main_domains'] as number).toBeLessThanOrEqual(
        item['referring_domains'] as number,
      )
    }
  })

  it('does not return a rank -- that is a different endpoint', () => {
    for (const item of items) expect(item).not.toHaveProperty('rank')
  })
})

describe('bulk_spam_score', () => {
  const items = bulkItemsOf<Record<string, unknown>>(loadContract('bulk_spam_score').payload)

  it('returns spam_score in 0-100 and nothing else of substance', () => {
    expect(items.length).toBeGreaterThan(0)
    for (const item of items) {
      expect(item).toHaveProperty('target')
      expect(item).toHaveProperty('spam_score')
      const s = item['spam_score'] as number
      expect(s).toBeGreaterThanOrEqual(0)
      expect(s).toBeLessThanOrEqual(100)
      /**
       * "Nothing else of substance" is the point: this endpoint does NOT carry
       * rank or referring domains, which is why the pipeline fans out three
       * requests. Asserted as the absence of those fields rather than an exact
       * key list -- the live payload also carries a `type` discriminator, and a
       * provider adding a harmless field should not fail the suite.
       */
      expect(Object.keys(item)).not.toContain('rank')
      expect(Object.keys(item)).not.toContain('referring_domains')
    }
  })
})

describe('the three bulk endpoints have DISJOINT field sets', () => {
  it('proves no single call could have supplied all of them', () => {
    // The structural reason the pipeline fans out three requests instead of one.
    const fields = (name: string) =>
      new Set(
        bulkItemsOf<Record<string, unknown>>(loadContract(name).payload).flatMap((i) =>
          Object.keys(i),
        ),
      )
    const ranks = fields('bulk_ranks')
    const refs = fields('bulk_referring_domains')
    const spam = fields('bulk_spam_score')

    const overlap = (a: Set<string>, b: Set<string>) =>
      [...a].filter((k) => b.has(k) && k !== 'target')

    expect(overlap(ranks, refs)).toEqual([])
    expect(overlap(ranks, spam)).toEqual([])
    expect(overlap(refs, spam)).toEqual([])
    // `target` is the merge key and must be present in all three.
    for (const s of [ranks, refs, spam]) expect(s.has('target')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// SERP shape
// ---------------------------------------------------------------------------

describe('organic SERP normalisation', () => {
  const result = resultOf<Array<Record<string, unknown>>>(loadContract('serp_organic').payload)
  const first = result?.[0]

  it('the raw payload mixes organic with non-organic item types', () => {
    // If this stops being true the filter below is untested, not unnecessary.
    const types = new Set(
      ((first?.['items'] as Array<{ type?: string }>) ?? []).map((i) => i.type),
    )
    expect(types.has('organic')).toBe(true)
    expect(types.size).toBeGreaterThan(1)
  })

  it('filters out local_pack and people_also_ask entries', () => {
    const raw = (first?.['items'] as Array<{ type?: string }>) ?? []
    const organicCount = raw.filter((i) => i.type === 'organic').length
    const items = normaliseOrganicResult(first as never)

    // Counted from the payload rather than hardcoded: this is a real page-1
    // capture whose length changes every time the fixture is re-captured, and
    // a literal here would only be asserting what the last probe happened to
    // return. What must hold is that every organic row survives and nothing
    // else does.
    expect(organicCount).toBeGreaterThan(0)
    expect(raw.length).toBeGreaterThan(organicCount)
    expect(items).toHaveLength(organicCount)
    expect(items.every((i) => i.domain.length > 0)).toBe(true)
  })

  it('uses rank_group, not rank_absolute, as the organic position', () => {
    // rank_absolute counts every item type. Using it shifts the whole page down
    // -- the true #1 organic result gets the #2 CTR weight because a local pack
    // sat above it -- which understates how strongly the top is defended.
    const organic =
      (
        (first?.['items'] as Array<{
          type?: string
          rank_group?: number
          rank_absolute?: number
        }>) ?? []
      ).filter((i) => i.type === 'organic')
    const items = normaliseOrganicResult(first as never)

    expect(items.map((i) => i.position)).toEqual(organic.map((i) => i.rank_group))
    // And the two genuinely differ on this page, so the assertion above is not
    // passing by coincidence on a SERP with no packs above the organic block.
    expect(organic.map((i) => i.rank_absolute)).not.toEqual(organic.map((i) => i.rank_group))
  })

  it('strips www and detects homepages', () => {
    const items = normaliseOrganicResult(first as never)
    expect(items.length).toBeGreaterThan(0)

    // No hand-picked domains: a re-capture returns a different page 1, so the
    // assertions are on the transformation, which does not change.
    expect(items.filter((i) => i.domain.startsWith('www.'))).toEqual([])

    // isHomepage must agree with the URL's own path on every row.
    for (const i of items) {
      const path = new URL(i.url).pathname
      expect(i.isHomepage, `${i.url} reported isHomepage=${i.isHomepage}`).toBe(path === '/')
    }
    // Both kinds are present, so neither branch is untested.
    expect(items.some((i) => i.isHomepage)).toBe(true)
    expect(items.some((i) => !i.isHomepage)).toBe(true)
  })
})

describe('map pack normalisation', () => {
  it('reports a local pack and its domains', () => {
    const result = resultOf<Array<Record<string, unknown>>>(loadContract('serp_maps').payload)
    const rawEntries = (
      (result?.[0]?.['items'] as Array<{ type?: string; domain?: string | null }>) ?? []
    ).filter((i) => i.type === 'maps_search')
    const parsed = normaliseMapPackResult(result?.[0] as never)

    expect(parsed.hasLocalPack).toBe(true)
    // Counted from the capture, not hardcoded -- a live pack is 100 entries
    // deep and changes on every re-capture.
    expect(rawEntries.length).toBeGreaterThan(0)
    expect(parsed.entryCount).toBe(rawEntries.length)

    // Businesses with no website count toward the pack but contribute no
    // domain, so the domain list is strictly shorter than the entry count.
    expect(rawEntries.some((e) => !e.domain)).toBe(true)
    expect(parsed.domains.length).toBeLessThan(parsed.entryCount)

    // Normalised the same way organic domains are: www stripped, deduped.
    expect(parsed.domains.filter((d) => d.startsWith('www.'))).toEqual([])
    expect(parsed.domains.length).toBe(new Set(parsed.domains).size)
    // And the capture really does contain a www host, so the strip is exercised.
    expect(rawEntries.some((e) => (e.domain ?? '').startsWith('www.'))).toBe(true)
  })

  it('treats an empty pack as measured-absent, not missing', () => {
    const parsed = normaliseMapPackResult({ items: [] } as never)
    expect(parsed.hasLocalPack).toBe(false)
    expect(parsed.entryCount).toBe(0)
  })
})

describe('locations endpoint', () => {
  it('returns a FLAT array, unlike the backlinks items[] wrapper', () => {
    const result = resultOf<Array<Record<string, unknown>>>(loadContract('locations').payload)
    expect(Array.isArray(result)).toBe(true)
    expect(result![0]).toHaveProperty('location_code')
    expect(result![0]).not.toHaveProperty('items')
  })

  it('publishes the location types the resolver accepts', () => {
    const result = resultOf<Array<{ location_type: string }>>(loadContract('locations').payload)
    const types = new Set(result!.map((r) => r.location_type))
    expect(types).toContain('City')
    expect(types).toContain('County')
    expect(types).toContain('DMA Region')
    // And the Region row that a widening bug would happily match.
    expect(types).toContain('Region')
  })

  it('carries all three county-qualification forms', () => {
    const result = resultOf<Array<{ location_name: string }>>(loadContract('locations').payload)
    const names = result!.map((r) => r.location_name)
    expect(names).toContain('Kenosha,Wisconsin,United States')
    expect(names).toContain('McKinney,Collin County,Texas,United States')
    expect(names).toContain('Orange,Orange,California,United States')
  })

  it('is reached at /serp/google/locations, not the organic sub-path', () => {
    expect(ENDPOINTS.LOCATIONS).toBe('/serp/google/locations')
    expect(ENDPOINTS.LOCATIONS).not.toContain('organic')
  })
})

// ---------------------------------------------------------------------------
// Failures that arrive as HTTP 200
// ---------------------------------------------------------------------------

describe('errors hide inside HTTP 200 responses', () => {
  it('an account hold has a 20000 top-level code and a 402xx task code', () => {
    const payload = loadContract('error_account_paused').payload as {
      status_code: number
      tasks: Array<{ status_code: number; status_message: string }>
    }
    // The outer envelope says OK. Only the task-level code says otherwise.
    expect(payload.status_code).toBe(DFS_OK)
    expect(payload.tasks[0]!.status_code).not.toBe(DFS_OK)
    expect(payload.tasks[0]!.status_code).toBeGreaterThanOrEqual(40200)
    expect(payload.tasks[0]!.status_code).toBeLessThan(40300)
  })

  it('the account-issue pattern matches the real hold message', () => {
    const payload = loadContract('error_account_paused').payload as {
      tasks: Array<{ status_message: string }>
    }
    expect(ACCOUNT_ISSUE_PATTERN.test(payload.tasks[0]!.status_message)).toBe(true)
  })

  it('the pattern does not match an ordinary task failure', () => {
    // A false positive here would abort runs for recoverable per-keyword errors.
    expect(ACCOUNT_ISSUE_PATTERN.test('Invalid Path.')).toBe(false)
    expect(ACCOUNT_ISSUE_PATTERN.test('Invalid Field: location_code.')).toBe(false)
    expect(ACCOUNT_ISSUE_PATTERN.test('Ok.')).toBe(false)
  })

  it('a wrong endpoint path returns Invalid Path inside a 200', () => {
    const payload = loadContract('error_invalid_path').payload as {
      status_code: number
      tasks: Array<{ status_code: number; status_message: string; path: string[] }>
    }
    expect(payload.status_code).toBe(DFS_OK)
    expect(payload.tasks[0]!.status_message).toBe('Invalid Path.')
    // Captured from the plausible-but-wrong path, for the record.
    expect(payload.tasks[0]!.path.join('/')).toBe('v3/serp/google/organic/locations')
  })
})

// ---------------------------------------------------------------------------
// The honesty gate on the fixtures themselves
// ---------------------------------------------------------------------------

describe('fixture provenance', () => {
  it('every contract fixture declares its provenance', () => {
    for (const name of listContracts()) {
      const meta = loadContract(name).__meta
      expect(meta, `${name} has no __meta`).toBeDefined()
      expect(typeof meta.verified, `${name}.verified`).toBe('boolean')
      expect(meta.source.length, `${name}.source`).toBeGreaterThan(10)
    }
  })

  it('CAPTURED FROM THE LIVE API -- run `pnpm probe:dfs` if this fails', () => {
    // =============== THIS TEST IS EXPECTED TO FAIL AT FIRST ==================
    // The payloads shipped in __contracts__/ were transcribed from documentation.
    // Tests asserting against them confirm what we already believe, and a wrong
    // belief about which fields an endpoint returns is precisely Trap 1.
    //
    // A green suite here would be claiming Trap 1 is guarded when it is not. So
    // this fails until real payloads are captured. That is the suite refusing to
    // overstate what it has verified -- the same rule the scoring model applies
    // to unmeasured components.
    //
    //   1. add DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD to .env
    //   2. pnpm probe:dfs        (~$0.08, gated on confirmation)
    //
    // If a field assertion above then breaks, the mechanism worked. Fix the
    // adapter, not the fixture.
    // ========================================================================
    const unverified = listContracts().filter((n) => !loadContract(n).__meta.verified)

    /**
     * A fixture may skip capture ONLY by declaring why it cannot be captured.
     *
     * serp_organic_with_discussions is the case this exists for: it puts the
     * same Reddit post in the organic list AND in the discussions pack so the
     * "both surfaces" branch has something to test, and Google does not return
     * that arrangement on request -- a live capture of it came back with no
     * discussion module at all and destroyed the scenario. Real captured
     * payloads for the module shapes live in serp_perspectives_module and
     * serp_discussions_and_forums_module.
     *
     * The exemption is deliberately narrow: a bare `constructed: true` would
     * reopen the hole this gate exists to close, so the reason must be
     * substantive.
     */
    const undeclared = unverified.filter((n) => {
      const reason = loadContract(n).__meta.constructed
      return typeof reason !== 'string' || reason.trim().length < 60
    })

    expect(
      undeclared,
      `\n\n  ${undeclared.length} contract fixture(s) are transcribed, not captured,\n` +
        '  and do not declare why they cannot be:\n' +
        undeclared.map((n) => `    - ${n}`).join('\n') +
        '\n\n  Trap 1 is NOT yet guarded by real data. Run: pnpm probe:dfs\n' +
        '  If the payload genuinely cannot be captured, set __meta.constructed to\n' +
        '  an explanation of why, and point at the captured fixture that covers\n' +
        '  the same endpoint shape.\n',
    ).toEqual([])
  })
})
