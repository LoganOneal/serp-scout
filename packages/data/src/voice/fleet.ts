import 'server-only'
import { desc, eq, isNotNull } from 'drizzle-orm'
import {
  collapseAgentVersions,
  parseAgent,
  parsePhoneNumber,
  type AgentCheck,
  type FleetAgent,
  type ParsedPhoneNumber,
} from '@rnr/core'
import type { Database } from '../db.js'
import { localities, niches, sites } from '../schema.js'
import type { VoiceProviders } from '../providers/voice.js'
import { auditStored, getStoredAgent } from './agents.js'

/**
 * The fleet: every agent, the sites bound to it, and the numbers that reach it.
 *
 * ==================== THE CROSS-CHECK NOBODY RUNS ====================
 * `sites.retell_agent_id` says which agent a site BELIEVES answers for it.
 * `list-phone-numbers` says which agent a caller actually reaches. Until these are
 * put side by side, both ways of being wrong are invisible:
 *
 *   - a number pointing at an agent no site claims  -> calls land, nothing resolves
 *     the site, and every lead is unattributed
 *   - a site claiming an agent no number reaches    -> the dashboard looks configured
 *     and the line is dead, which is what San Jose looked like for an afternoon
 *
 * Neither shows up on any existing screen. This is the screen.
 * ===================================================================
 */

export interface FleetSite {
  siteId: number
  domain: string | null
  displayName: string | null
  localityName: string
  stateCode: string
  nicheLabel: string
  trackingNumber: string | null
  /** NULL = recorded but never attached to the trunk and imported. */
  retellNumberImportedAt: Date | null
}

export interface FleetRow {
  agent: FleetAgent
  /** From the last stored snapshot. NULL when this agent has never been pulled. */
  checks: AgentCheck[] | null
  sites: FleetSite[]
  numbers: ParsedPhoneNumber[]
}

export interface Fleet {
  rows: FleetRow[]
  /** Numbers whose agent is not in list-agents at all. Should always be empty. */
  orphanNumbers: ParsedPhoneNumber[]
  /** Sites naming an agent Retell does not have. A typo, or a deleted agent. */
  sitesWithUnknownAgent: FleetSite[]
  /** Sites with an agent bound but no number reaching it. */
  sitesWithNoNumber: FleetSite[]
  /** True when the live lists could not be read; rows then come from storage only. */
  degraded: boolean
  degradedReason: string | null
}

export async function loadFleet(db: Database, providers: VoiceProviders): Promise<Fleet> {
  const siteRows = await db
    .select({
      siteId: sites.id,
      domain: sites.domain,
      displayName: sites.displayName,
      localityName: localities.name,
      stateCode: localities.stateCode,
      nicheLabel: niches.label,
      trackingNumber: sites.trackingNumber,
      retellNumberImportedAt: sites.retellNumberImportedAt,
      retellAgentId: sites.retellAgentId,
    })
    .from(sites)
    .innerJoin(localities, eq(sites.localityId, localities.id))
    .innerJoin(niches, eq(sites.nicheId, niches.id))
    .where(isNotNull(sites.retellAgentId))
    .orderBy(desc(sites.createdAt))

  /**
   * A failed read degrades the page rather than blanking it.
   *
   * The stored snapshots are still worth showing when Retell is unreachable or the key
   * is wrong -- and saying so is more useful than an empty table that reads as "you
   * have no agents".
   */
  let rawAgents: unknown[] = []
  let rawNumbers: unknown[] = []
  let degradedReason: string | null = null
  try {
    ;[rawAgents, rawNumbers] = await Promise.all([
      providers.listAgents(),
      providers.listPhoneNumbers(),
    ])
  } catch (e) {
    degradedReason = (e as Error).message
  }

  const agents = collapseAgentVersions(
    rawAgents.map(parseAgent).filter((a): a is NonNullable<typeof a> => a !== null),
  )
  const numbers = rawNumbers
    .map(parsePhoneNumber)
    .filter((n): n is ParsedPhoneNumber => n !== null)

  const known = new Set(agents.map((a) => a.agentId))
  const toFleetSite = (r: (typeof siteRows)[number]): FleetSite => ({
    siteId: r.siteId,
    domain: r.domain,
    displayName: r.displayName,
    localityName: r.localityName,
    stateCode: r.stateCode,
    nicheLabel: r.nicheLabel,
    trackingNumber: r.trackingNumber,
    retellNumberImportedAt: r.retellNumberImportedAt,
  })

  const rows: FleetRow[] = []
  for (const agent of agents) {
    const mine = siteRows.filter((s) => s.retellAgentId === agent.agentId)
    const stored = await getStoredAgent(db, agent.agentId).catch(() => null)
    rows.push({
      agent,
      // Audited from the last snapshot rather than re-fetching every flow: a fleet of
      // twenty agents would otherwise be forty API calls to render one table.
      checks: stored === null ? null : auditStored(stored),
      sites: mine.map(toFleetSite),
      numbers: numbers.filter((n) => n.inboundAgentIds.includes(agent.agentId)),
    })
  }

  const reachable = new Set(numbers.flatMap((n) => n.inboundAgentIds))

  return {
    rows,
    orphanNumbers: numbers.filter((n) => n.inboundAgentIds.some((id) => !known.has(id))),
    sitesWithUnknownAgent: siteRows
      .filter((s) => !degradedReason && !known.has(s.retellAgentId!))
      .map(toFleetSite),
    sitesWithNoNumber: siteRows
      .filter((s) => !degradedReason && known.has(s.retellAgentId!) && !reachable.has(s.retellAgentId!))
      .map(toFleetSite),
    degraded: degradedReason !== null,
    degradedReason,
  }
}
