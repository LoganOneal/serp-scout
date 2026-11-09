import { describe, expect, it } from 'vitest'
import { collapseAgentVersions, parseAgent, parsePhoneNumber } from './agent-audit.js'

/**
 * Shapes taken from a real `list-agents` / `list-phone-numbers` probe of the live
 * account, not invented: the version duplication below is exactly what came back.
 */
const rows = (
  [
    ['agent_roger', 3, false, 1000],
    ['agent_roger', 2, true, 900],
    ['agent_roger', 1, true, 800],
    ['agent_roger', 0, false, 700],
    ['agent_sj', 0, false, 2000],
  ] as const
).map(([id, version, published, ts]) => ({
  agent_id: id,
  agent_name: id === 'agent_roger' ? 'Roger' : 'San Jose',
  version,
  is_published: published,
  last_modification_timestamp: ts,
  response_engine: { type: 'conversation-flow', conversation_flow_id: 'flow_1' },
}))

describe('collapseAgentVersions', () => {
  const parsed = rows.map(parseAgent).filter((a): a is NonNullable<typeof a> => a !== null)

  it('returns one row per agent, not one per version', () => {
    const fleet = collapseAgentVersions(parsed)
    expect(fleet).toHaveLength(2)
    expect(fleet.map((f) => f.agentId).sort()).toEqual(['agent_roger', 'agent_sj'])
  })

  it('keeps the highest version, which is what an unpinned number follows', () => {
    const roger = collapseAgentVersions(parsed).find((f) => f.agentId === 'agent_roger')!
    expect(roger.version).toBe(3)
    expect(roger.versionCount).toBe(4)
  })

  /**
   * The published version is carried separately because a number pinned to
   * "latest_published" follows it instead. When the two differ, which one answers the
   * phone is the entire question.
   */
  it('reports the highest published version, which can differ from the newest', () => {
    const roger = collapseAgentVersions(parsed).find((f) => f.agentId === 'agent_roger')!
    expect(roger.publishedVersion).toBe(2)
    expect(roger.isPublished).toBe(false) // v3, the newest, is a draft
  })

  it('reports null rather than 0 when nothing was ever published', () => {
    const sj = collapseAgentVersions(parsed).find((f) => f.agentId === 'agent_sj')!
    expect(sj.publishedVersion).toBeNull()
  })

  it('sorts most-recently-modified first, so the agent you just built is at the top', () => {
    expect(collapseAgentVersions(parsed)[0]!.agentId).toBe('agent_sj')
  })

  it('does not let an unknown version sort as the best one', () => {
    const withNull = [...parsed, parseAgent({ agent_id: 'agent_roger', version: null })!]
    const roger = collapseAgentVersions(withNull).find((f) => f.agentId === 'agent_roger')!
    expect(roger.version).toBe(3)
  })
})

describe('parsePhoneNumber', () => {
  it('reads the agent binding from the post-deprecation inbound_agents list', () => {
    const n = parsePhoneNumber({
      phone_number: '+15203694399',
      nickname: 'kenoshaair.com',
      inbound_webhook_url: 'https://x.test/api/retell/inbound',
      inbound_agents: [{ agent_id: 'agent_roger', weight: 1 }],
    })
    expect(n?.inboundAgentIds).toEqual(['agent_roger'])
    expect(n?.inboundAgentVersion).toBeNull()
  })

  it('surfaces a pinned version', () => {
    const n = parsePhoneNumber({
      phone_number: '+18654216517',
      inbound_agents: [{ agent_id: 'agent_x', weight: 1, agent_version: 0 }],
    })
    expect(n?.inboundAgentVersion).toBe(0)
  })

  it('accepts an environment tag as the pin', () => {
    const n = parsePhoneNumber({
      phone_number: '+18654216517',
      inbound_agents: [{ agent_id: 'agent_x', weight: 1, agent_version: 'latest_published' }],
    })
    expect(n?.inboundAgentVersion).toBe('latest_published')
  })

  it('is null without a phone number, and empty rather than null without agents', () => {
    expect(parsePhoneNumber({ inbound_agents: [] })).toBeNull()
    expect(parsePhoneNumber({ phone_number: '+1555' })?.inboundAgentIds).toEqual([])
  })
})
