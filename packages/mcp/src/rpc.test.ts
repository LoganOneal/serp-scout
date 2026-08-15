import { describe, expect, it } from 'vitest'
import {
  drainLines,
  handleRequest,
  jsonSafe,
  LATEST_PROTOCOL_VERSION,
  RPC,
  type ToolDefinition,
} from './rpc.js'

const tools: ToolDefinition[] = [
  {
    name: 'echo',
    description: 'echo',
    inputSchema: { type: 'object', properties: {} },
    handler: async (a) => ({ got: a['x'], price: 240_000_000n }),
  },
  {
    name: 'boom',
    description: 'always fails',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      throw new Error('relation "supply_items" does not exist')
    },
  },
]

const opts = { tools, serverInfo: { name: 'test', version: '0.0.0' } }
// `null` means "send it as a notification" — a default parameter cannot express
// that, because passing `undefined` explicitly still falls back to the default.
const call = (method: string, params?: Record<string, unknown>, id: number | null = 1) =>
  handleRequest(
    { jsonrpc: '2.0', ...(id === null ? {} : { id }), method, ...(params ? { params } : {}) },
    opts,
  )

describe('initialize', () => {
  it('echoes a protocol version it supports', async () => {
    const r = await call('initialize', { protocolVersion: '2024-11-05' })
    expect((r?.result as { protocolVersion: string }).protocolVersion).toBe('2024-11-05')
  })

  /** Asserting a version we were not asked for makes a client parse absent fields. */
  it('answers with its own version when the client asks for one it does not know', async () => {
    const r = await call('initialize', { protocolVersion: '1999-01-01' })
    expect((r?.result as { protocolVersion: string }).protocolVersion).toBe(LATEST_PROTOCOL_VERSION)
  })

  /** Tools only. Advertising sampling would let this server prompt the model back. */
  it('advertises tools and nothing else', async () => {
    const r = await call('initialize', {})
    expect((r?.result as { capabilities: Record<string, unknown> }).capabilities).toEqual({
      tools: { listChanged: false },
    })
  })
})

describe('notifications', () => {
  /**
   * A reply to a notification is a protocol violation, and some clients treat
   * the stray response as the answer to a LATER request — which produces a
   * mismatch that looks like a tool returning the wrong data.
   */
  it('returns nothing for a request with no id', async () => {
    expect(await call('ping', undefined, null)).toBeNull()
    expect(await call('notifications/initialized', undefined, null)).toBeNull()
  })

  it('returns nothing for notifications/initialized even when given an id', async () => {
    expect(await call('notifications/initialized')).toBeNull()
  })
})

describe('tools', () => {
  it('lists tools without their handlers', async () => {
    const r = await call('tools/list')
    const listed = (r?.result as { tools: Array<Record<string, unknown>> }).tools
    expect(listed.map((t) => t.name)).toEqual(['echo', 'boom'])
    expect(listed[0]).not.toHaveProperty('handler')
  })

  it('calls a tool and serialises the result as text content', async () => {
    const r = await call('tools/call', { name: 'echo', arguments: { x: 7 } })
    const res = r?.result as { content: Array<{ text: string }>; isError: boolean }
    expect(res.isError).toBe(false)
    expect(JSON.parse(res.content[0]!.text)).toEqual({ got: 7, price: '240000000' })
  })

  /**
   * A tool failure is a RESULT with isError, not a JSON-RPC error. The model can
   * read a result and correct its call; a transport error is invisible to it.
   */
  it('reports a throwing tool as isError with the message intact', async () => {
    const r = await call('tools/call', { name: 'boom' })
    const res = r?.result as { content: Array<{ text: string }>; isError: boolean }
    expect(res.isError).toBe(true)
    expect(res.content[0]!.text).toMatch(/relation "supply_items" does not exist/)
    expect(r?.error).toBeUndefined()
  })

  it('names the recovery when the tool does not exist', async () => {
    const r = await call('tools/call', { name: 'nope' })
    expect(r?.error?.code).toBe(RPC.INVALID_PARAMS)
    expect(r?.error?.message).toMatch(/tools\/list/)
  })

  it('returns METHOD_NOT_FOUND for an unimplemented method', async () => {
    expect((await call('resources/list'))?.error?.code).toBe(RPC.METHOD_NOT_FOUND)
  })
})

describe('jsonSafe', () => {
  /**
   * Money is bigint micros and JSON.stringify throws on it outright. Serialised
   * as a decimal STRING, not a Number: aggregate micros exceed 2^53 and a
   * silently rounded price is exactly what integer micros exist to prevent.
   */
  it('serialises bigint as a string, never a number', () => {
    expect(JSON.parse(JSON.stringify({ m: 9_007_199_254_740_993n }, jsonSafe))).toEqual({
      m: '9007199254740993',
    })
  })

  it('serialises Date as ISO 8601', () => {
    expect(jsonSafe('d', new Date('2026-08-14T00:00:00Z'))).toBe('2026-08-14T00:00:00.000Z')
  })
})

describe('drainLines', () => {
  /**
   * A chunk boundary can land mid-message on any stream. Parsing the fragment
   * produces a parse error that looks like a malformed client.
   */
  it('holds back a partial trailing line', () => {
    expect(drainLines('{"a":1}\n{"b":2}\n{"c":')).toEqual({
      lines: ['{"a":1}', '{"b":2}'],
      rest: '{"c":',
    })
  })

  it('drops blank lines rather than trying to parse them', () => {
    expect(drainLines('{"a":1}\n\n\n').lines).toEqual(['{"a":1}'])
  })
})
