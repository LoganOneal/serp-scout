import { describe, expect, it } from 'vitest'
import { fetchKeywordVolumes, googleAdsConfigured } from './keyword-volume.js'

describe('googleAdsConfigured', () => {
  it('requires token, customer, and OAuth trio', () => {
    expect(googleAdsConfigured({})).toBe(false)
    expect(
      googleAdsConfigured({
        GOOGLE_ADS_DEVELOPER_TOKEN: 'x',
        GOOGLE_ADS_CUSTOMER_ID: '330-882-4376',
        GOOGLE_ADS_CLIENT_ID: 'id',
        GOOGLE_ADS_CLIENT_SECRET: 'sec',
        GOOGLE_ADS_REFRESH_TOKEN: 'ref',
      }),
    ).toBe(true)
  })
})

describe('fetchKeywordVolumes', () => {
  it('returns null volumes in fixture mode (not zeros)', async () => {
    const r = await fetchKeywordVolumes(['electrician', 'plumber'], {
      live: false,
      env: {},
    })
    expect(r.source).toBe('fixture')
    expect(r.rows).toHaveLength(2)
    expect(r.rows.every((row) => row.avgMonthlySearches === null)).toBe(true)
    expect(r.geoTargetCriteriaIds).toEqual([2840])
  })

  it('passes custom geo criteria to the API body', async () => {
    let body: unknown
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const u = String(url)
      if (u.includes('oauth2')) {
        return new Response(JSON.stringify({ access_token: 'ya29.test' }), { status: 200 })
      }
      body = JSON.parse(String(init?.body ?? '{}'))
      return new Response(
        JSON.stringify({
          results: [{ text: 'junk removal', keywordMetrics: { avgMonthlySearches: 720 } }],
        }),
        { status: 200 },
      )
    }

    const r = await fetchKeywordVolumes(['junk removal'], {
      live: true,
      geoTargetCriteriaIds: [1023191],
      env: {
        GOOGLE_ADS_DEVELOPER_TOKEN: 'dev',
        GOOGLE_ADS_CUSTOMER_ID: '3308824376',
        GOOGLE_ADS_CLIENT_ID: 'id',
        GOOGLE_ADS_CLIENT_SECRET: 'sec',
        GOOGLE_ADS_REFRESH_TOKEN: 'ref',
      },
      fetchImpl: fetchImpl as typeof fetch,
    })

    expect(r.source).toBe('google_ads')
    expect(r.geoTargetCriteriaIds).toEqual([1023191])
    expect(r.rows[0]?.avgMonthlySearches).toBe(720)
    expect(body).toMatchObject({
      keywords: ['junk removal'],
      geoTargetConstants: ['geoTargetConstants/1023191'],
    })
  })

  it('skips live when OAuth is incomplete', async () => {
    const r = await fetchKeywordVolumes(['electrician'], {
      live: true,
      env: {
        GOOGLE_ADS_DEVELOPER_TOKEN: 'tok',
        GOOGLE_ADS_CUSTOMER_ID: '3308824376',
        // missing client/secret/refresh
      },
    })
    expect(r.source).toBe('skipped')
    expect(r.error).toMatch(/REFRESH_TOKEN|CLIENT/)
  })

  it('parses a successful metrics response', async () => {
    const fetchImpl = async (url: string | URL | Request): Promise<Response> => {
      const u = String(url)
      if (u.includes('oauth2')) {
        return new Response(JSON.stringify({ access_token: 'ya29.test' }), { status: 200 })
      }
      return new Response(
        JSON.stringify({
          results: [
            {
              text: 'electrician',
              keywordMetrics: {
                avgMonthlySearches: 5400,
                competitionIndex: 42,
                lowTopOfPageBidMicros: 1_200_000,
                highTopOfPageBidMicros: 4_500_000,
              },
            },
          ],
        }),
        { status: 200 },
      )
    }

    const r = await fetchKeywordVolumes(['electrician', 'missing'], {
      live: true,
      env: {
        GOOGLE_ADS_DEVELOPER_TOKEN: 'dev',
        GOOGLE_ADS_LOGIN_CUSTOMER_ID: '484-151-7599',
        GOOGLE_ADS_CUSTOMER_ID: '330-882-4376',
        GOOGLE_ADS_CLIENT_ID: 'id',
        GOOGLE_ADS_CLIENT_SECRET: 'sec',
        GOOGLE_ADS_REFRESH_TOKEN: 'ref',
      },
      fetchImpl: fetchImpl as typeof fetch,
    })

    expect(r.source).toBe('google_ads')
    expect(r.error).toBeNull()
    expect(r.rows[0]).toMatchObject({
      keyword: 'electrician',
      avgMonthlySearches: 5400,
      competitionIndex: 42,
    })
    expect(r.rows[0]!.lowTopOfPageBidMicros).toBe(1_200_000n)
    expect(r.rows[1]?.avgMonthlySearches).toBeNull()
  })

  it('chunks large requests without requiring callers to manage the planning quota', async () => {
    let metricsCalls = 0
    const fetchImpl = async (url: string | URL | Request): Promise<Response> => {
      if (String(url).includes('oauth2')) {
        return new Response(JSON.stringify({ access_token: 'ya29.test' }), { status: 200 })
      }
      metricsCalls += 1
      return new Response(JSON.stringify({ results: [] }), { status: 200 })
    }

    await fetchKeywordVolumes(
      Array.from({ length: 101 }, (_, i) => `keyword ${i}`),
      {
        live: true,
        requestIntervalMs: 0,
        env: {
          GOOGLE_ADS_DEVELOPER_TOKEN: 'dev',
          GOOGLE_ADS_CUSTOMER_ID: '3308824376',
          GOOGLE_ADS_CLIENT_ID: 'id',
          GOOGLE_ADS_CLIENT_SECRET: 'sec',
          GOOGLE_ADS_REFRESH_TOKEN: 'ref',
        },
        fetchImpl: fetchImpl as typeof fetch,
      },
    )

    expect(metricsCalls).toBe(2)
  })

  it('assigns grouped metrics to every returned close variant', async () => {
    const fetchImpl = async (url: string | URL | Request): Promise<Response> => {
      if (String(url).includes('oauth2')) {
        return new Response(JSON.stringify({ access_token: 'ya29.test' }), { status: 200 })
      }
      return new Response(
        JSON.stringify({
          results: [
            {
              text: 'chicago hotel hot tub',
              closeVariants: [
                'chicago hotels with jacuzzi in room',
                'hotels with hot tubs in room chicago',
              ],
              keywordMetrics: { avgMonthlySearches: 2900 },
            },
          ],
        }),
        { status: 200 },
      )
    }

    const result = await fetchKeywordVolumes(
      ['chicago hotels with jacuzzi in room', 'hotels with hot tubs in room chicago'],
      {
        live: true,
        env: {
          GOOGLE_ADS_DEVELOPER_TOKEN: 'dev',
          GOOGLE_ADS_CUSTOMER_ID: '3308824376',
          GOOGLE_ADS_CLIENT_ID: 'id',
          GOOGLE_ADS_CLIENT_SECRET: 'sec',
          GOOGLE_ADS_REFRESH_TOKEN: 'ref',
        },
        fetchImpl: fetchImpl as typeof fetch,
      },
    )

    expect(result.rows.map((row) => row.avgMonthlySearches)).toEqual([2900, 2900])
  })
})
