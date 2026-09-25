import { describe, expect, it } from 'vitest'
import { retryDelay, AttioClient } from './client.js'
import { encodeEntryValues, unwrapValue } from './values.js'
import { setupAttioLists } from './setup.js'
import { syncTargets } from './sync.js'

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

describe('retryDelay', () => {
  it('honours Retry-After seconds', () => {
    const res = new Response('', { status: 429, headers: { 'retry-after': '2' } })
    expect(retryDelay(res, 0)).toBe(2000)
  })
})

describe('value encoding', () => {
  it('encodes CRM fields without dropping populated values', () => {
    expect(unwrapValue([{ status: 'Contacted' }])).toBe('Contacted')
    expect(unwrapValue([{ title: 'Contacted', attribute_type: 'status' }])).toBe('Contacted')
    expect(unwrapValue([{
      attribute_type: 'status',
      status: { title: 'Contact Found', id: { status_id: 'x' } },
    }])).toBe('Contact Found')
    expect(unwrapValue([{
      attribute_type: 'select',
      option: { title: 'Asked backlink', id: { option_id: 'x' } },
    }])).toBe('Asked backlink')
    expect(unwrapValue([{ value: 'editor-choice:gold-strike-casino-resort', attribute_type: 'text' }]))
      .toBe('editor-choice:gold-strike-casino-resort')
    expect(encodeEntryValues({ status: 'New', source_key: 'backlink:https://example.com/a', price_quoted: 150 }))
      .toMatchObject({
        status: 'New',
        source_key: 'backlink:https://example.com/a',
        price_quoted: { currency_value: 150, currency_code: 'USD' },
      })
    expect(encodeEntryValues({
      contact_1_date: '2026-09-08',
      replied_at: '2026-09-10T15:22:00Z',
      sequence: 'Asked backlink',
      suppress_outreach: true,
      primary_contact: null,
      press_media_page: null,
    })).toEqual({
      contact_1_date: '2026-09-08',
      replied_at: '2026-09-10',
      sequence: 'Asked backlink',
      suppress_outreach: true,
      primary_contact: [],
      press_media_page: '',
    })
    expect(encodeEntryValues({ serp_position: 4, keyword_volume: 5400, authority_score: 91, outbound_links: 37 }))
      .toEqual({
        serp_position: 4,
        keyword_volume: 5400,
        authority_score: 91,
        outbound_links: 37,
      })
  })
})

describe('AttioClient retry', () => {
  it('retries 429 then succeeds', async () => {
    let calls = 0
    const client = new AttioClient({
      apiKey: 'test-key',
      sleep: async () => undefined,
      fetchImpl: async () => {
        calls += 1
        if (calls === 1) return jsonResponse(429, { message: 'slow down' }, { 'retry-after': '0' })
        return jsonResponse(200, { data: [] })
      },
    })
    const res = await client.get<{ data: unknown[] }>('/lists')
    expect(res.data).toEqual([])
    expect(calls).toBe(2)
  })

  it('throws AttioError on 400 without retrying forever', async () => {
    const client = new AttioClient({
      apiKey: 'test-key',
      fetchImpl: async () => jsonResponse(400, { message: 'bad', code: 'validation_type' }),
    })
    await expect(client.get('/lists')).rejects.toMatchObject({
      name: 'AttioError',
      status: 400,
      code: 'validation_type',
    })
  })
})

describe('setup is idempotent', () => {
  it('does not recreate a Company list that already exists', async () => {
    const posts: string[] = []
    const client = new AttioClient({
      apiKey: 'test-key',
      fetchImpl: async (input, init) => {
        const url = String(input)
        const method = init?.method ?? 'GET'
        if (url.endsWith('/lists') && method === 'GET') {
          return jsonResponse(200, {
            data: [
              { id: { list_id: '1' }, api_slug: 'editors_choice_targets', name: "Editor's Choice Targets", parent_object: ['companies'] },
              { id: { list_id: '2' }, api_slug: 'backlink_targets', name: 'Backlink Targets', parent_object: ['companies'] },
              { id: { list_id: '3' }, api_slug: 'guest_post_targets', name: 'Guest Post Targets', parent_object: ['companies'] },
            ],
          })
        }
        if (url.includes('/attributes') && method === 'GET') {
          return jsonResponse(200, {
            data: [
              { id: { attribute_id: 'a' }, api_slug: 'status', title: 'Status', type: 'status' },
              { id: { attribute_id: 'b' }, api_slug: 'source_key', title: '_Source Key', type: 'text', is_unique: true },
              { id: { attribute_id: 'c' }, api_slug: 'primary_contact', title: 'Primary Contact', type: 'record-reference' },
              { id: { attribute_id: 'd' }, api_slug: 'hht_listing_url', title: 'HHT Listing URL', type: 'text' },
              { id: { attribute_id: 'e' }, api_slug: 'press_media_page', title: 'Press / Media Page', type: 'text' },
              { id: { attribute_id: 'f' }, api_slug: 'ask_type', title: 'Ask Type', type: 'select' },
              { id: { attribute_id: 'seq' }, api_slug: 'sequence', title: 'Sequence', type: 'select' },
              { id: { attribute_id: 'g' }, api_slug: 'outreach_date', title: 'Outreach Date', type: 'date' },
              { id: { attribute_id: 'g1' }, api_slug: 'contact_1_date', title: '1st Contact', type: 'date' },
              { id: { attribute_id: 'g2' }, api_slug: 'contact_2_date', title: '2nd Contact', type: 'date' },
              { id: { attribute_id: 'g3' }, api_slug: 'contact_3_date', title: '3rd Contact', type: 'date' },
              { id: { attribute_id: 'g4' }, api_slug: 'contact_4_date', title: '4th Contact', type: 'date' },
              { id: { attribute_id: 'g5' }, api_slug: 'replied_at', title: 'Replied At', type: 'date' },
              { id: { attribute_id: 'h' }, api_slug: 'next_follow_up', title: 'Next Follow-up', type: 'date' },
              { id: { attribute_id: 'i' }, api_slug: 'outcome_notes', title: 'Outcome / Notes', type: 'text' },
              { id: { attribute_id: 'sup' }, api_slug: 'suppress_outreach', title: 'Suppress Outreach', type: 'checkbox' },
              { id: { attribute_id: 'j' }, api_slug: 'live_link_coverage_url', title: 'Live Link / Coverage URL', type: 'text' },
              { id: { attribute_id: 'k' }, api_slug: 'source_ref', title: '_Source Ref', type: 'text' },
              { id: { attribute_id: 'l' }, api_slug: 'target_article_url', title: 'Target Article URL', type: 'text' },
              { id: { attribute_id: 'm' }, api_slug: 'hht_page_to_link', title: 'HHT Page to Link', type: 'text' },
              { id: { attribute_id: 'n' }, api_slug: 'placement_type', title: 'Placement Type', type: 'select' },
              { id: { attribute_id: 'o' }, api_slug: 'price_quoted', title: 'Price Quoted', type: 'currency' },
              { id: { attribute_id: 'p' }, api_slug: 'live_backlink_url', title: 'Live Backlink URL', type: 'text' },
              { id: { attribute_id: 'q' }, api_slug: 'guidelines_url', title: 'Guidelines URL', type: 'text' },
              { id: { attribute_id: 'r' }, api_slug: 'pitch_topic', title: 'Pitch / Topic', type: 'text' },
              { id: { attribute_id: 's' }, api_slug: 'link_allowed', title: 'Link Allowed?', type: 'checkbox' },
              { id: { attribute_id: 't' }, api_slug: 'published_url', title: 'Published URL', type: 'text' },
            ],
          })
        }
        if (url.includes('/statuses') && method === 'GET') {
          return jsonResponse(200, { data: [
            { title: 'New' }, { title: 'Researching' }, { title: 'Contact Found' }, { title: 'Ready to Contact' },
            { title: 'Contacted' }, { title: 'Replied' }, { title: 'Positive' }, { title: 'Won / Published' },
            { title: 'No Response' }, { title: 'Rejected' },
          ] })
        }
        if (url.includes('/options') && method === 'GET') {
          return jsonResponse(200, { data: [
            { title: 'Verification' }, { title: 'Photos' }, { title: 'Backlink / Badge' }, { title: 'Mixed' },
            { title: 'New contact' }, { title: 'Asked backlink' }, { title: 'Fact-check' },
            { title: 'Link insertion' }, { title: 'New article' }, { title: 'Paid' }, { title: 'Free / editorial' }, { title: 'Unknown' },
          ] })
        }
        if (method === 'POST') posts.push(url)
        return jsonResponse(200, { data: {} })
      },
    })
    const report = await setupAttioLists({ client, dryRun: false })
    expect(report.lists.every((row) => row.action === 'skip')).toBe(true)
    expect(posts.some((url) => url.endsWith('/lists'))).toBe(false)
  })
})

describe('sync engine', () => {
  it('creates one entry per source key and does not duplicate on the second pass', async () => {
    const created: string[] = []
    let hasEntry = false
    const client = new AttioClient({
      apiKey: 'test-key',
      fetchImpl: async (input, init) => {
        const url = String(input)
        const method = init?.method ?? 'GET'
        const body = init?.body ? JSON.parse(String(init.body)) : {}
        if (url.includes('/records/query')) return jsonResponse(200, { data: [] })
        if (url.includes('/objects/companies/records') && method === 'PUT') {
          return jsonResponse(200, { data: { id: { record_id: 'co-1' } } })
        }
        if (url.includes('/entries/query')) {
          return jsonResponse(200, { data: hasEntry ? [{ id: { entry_id: 'e1', list_id: 'l1' }, parent_record_id: 'co-1', values: { source_key: [{ value: 'backlink:https://example.com/a' }], source_ref: [{ value: 'serp-scout:hht_px_prospect_pages#1' }], status: [{ status: 'Contacted' }], target_article_url: [{ value: 'https://example.com/a' }] } }] : [] })
        }
        if (url.includes('/entries') && method === 'POST') {
          created.push(body.data.entry_values.source_key)
          hasEntry = true
          return jsonResponse(200, { data: { id: { entry_id: 'e1' } } })
        }
        if (url.includes('/notes')) return jsonResponse(200, { data: [] })
        return jsonResponse(200, { data: {} })
      },
    })
    const target = {
      workstream: 'backlinks' as const,
      sourceKey: 'backlink:https://example.com/a',
      sourceRef: 'serp-scout:hht_px_prospect_pages#1',
      companyName: 'example.com',
      domain: 'example.com',
      sourceOwned: {
        source_key: 'backlink:https://example.com/a',
        source_ref: 'serp-scout:hht_px_prospect_pages#1',
        target_article_url: 'https://example.com/a',
      },
    }
    const first = await syncTargets({ client, workstream: 'backlinks', targets: [target], dryRun: false })
    const second = await syncTargets({ client, workstream: 'backlinks', targets: [target], dryRun: false })
    expect(created).toEqual(['backlink:https://example.com/a'])
    expect(first.counts.entriesCreate).toBe(1)
    expect(second.counts.entriesCreate).toBe(0)
    expect(second.entries[0]?.action).toBe('skip')
    expect(second.entries[0]?.reason).not.toContain('status')
  })
})
