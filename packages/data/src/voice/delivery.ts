import 'server-only'
import { eq } from 'drizzle-orm'
import { formatPhone, safetyScriptFor, type HazardKind } from '@rnr/core'
import type { Database } from '../db.js'
import { calls, leadDeliveries, leads, sites, type Lead, type Site } from '../schema.js'
import type { VoiceProviders } from '../providers/voice.js'

/**
 * Lead delivery.
 *
 * One row per ATTEMPT in `lead_deliveries`, mirroring `spend_ledger`: whether the
 * contractor actually received the lead is RECONCILABLE rather than assumed. A
 * counter on the lead row would hide a delivery that silently failed, and a lead
 * captured perfectly and never delivered is a lost lead.
 */

export interface DeliverResult {
  attempted: boolean
  sent: boolean
  reason: string | null
}

/**
 * The SMS body.
 *
 * Written for a phone lock screen: the first line has to say whether this needs
 * attention right now, because that is all the contractor sees before deciding
 * whether to open it.
 */
export function composeLeadSms(args: { lead: Lead; site: Site; domain: string | null }): string {
  const { lead, site } = args
  const lines: string[] = []

  /**
   * Ends in words, never in `null`.
   *
   * A cell can be targeted before a domain is bought, and the first line of this text is
   * the only thing the contractor reads on a lock screen -- "EMERGENCY - null" would be
   * worse than no label at all.
   */
  const label = site.displayName ?? args.domain ?? 'your site'

  if (lead.isEmergency === true) {
    const hazard = lead.hazard as HazardKind | null
    lines.push(hazard ? `EMERGENCY (${hazard.replace(/_/g, ' ')}) - ${label}` : `EMERGENCY - ${label}`)
  } else if (lead.isEmergency === null) {
    // Explicitly stated, not silently omitted. "Urgency unknown" is a prompt to
    // call the customer; a message that just left it out reads as routine.
    lines.push(`New lead (urgency not established) - ${label}`)
  } else {
    lines.push(`New lead - ${label}`)
  }

  lines.push(`${lead.name ?? 'Name not given'} · ${formatPhone(lead.phone) ?? 'no number'}`)

  if (lead.addressLine || lead.zip) {
    lines.push([lead.addressLine, lead.city, lead.zip].filter(Boolean).join(', '))
  }
  if (lead.inServiceArea === false) lines.push('OUTSIDE SERVICE AREA')
  if (lead.isOwner === false) lines.push('Caller is a RENTER - cannot authorise work')

  if (lead.problem) lines.push(`"${lead.problem.slice(0, 160)}"`)
  if (lead.systemType) {
    lines.push(
      `System: ${lead.systemType.replace(/_/g, ' ')}${lead.systemAgeYears !== null ? `, ~${lead.systemAgeYears}y` : ''}`,
    )
  }
  if (lead.appointmentAt) lines.push(`Booked: ${lead.appointmentAt.toISOString().slice(0, 16).replace('T', ' ')}`)

  return lines.join('\n').slice(0, 1500)
}

/**
 * Send the lead to the contractor.
 *
 * Sends FROM the site's tracking number, so the contractor's phone shows a text
 * from the number the customer dialled rather than a random long code that reads
 * as spam. Elastic SIP Trunking is voice-only, so messaging on a trunk number
 * keeps working.
 *
 * Throws on provider failure, so the job layer applies backoff. Records the
 * attempt either way.
 */
export async function deliverLead(
  db: Database,
  args: { leadId: number; providers: VoiceProviders },
): Promise<DeliverResult> {
  const { providers } = args

  const rows = await db
    .select({ lead: leads, site: sites, simulated: calls.simulated })
    .from(leads)
    .leftJoin(sites, eq(leads.siteId, sites.id))
    .leftJoin(calls, eq(leads.callId, calls.id))
    .where(eq(leads.id, args.leadId))
    .limit(1)

  const row = rows[0]
  if (!row) return { attempted: false, sent: false, reason: 'Lead no longer exists.' }

  const { lead, site } = row

  /**
   * ==================== NEVER TEXT A HUMAN ABOUT A FAKE LEAD ====================
   * `voice:simulate` and the "Send test event" button create real lead rows, which
   * enqueue real delivery jobs. With LIVE_CALLS_ENABLED=true that texted the
   * contractor's actual phone about a caller who does not exist -- found the first
   * time this ran against a live Twilio account.
   *
   * Recorded as 'suppressed', not 'failed': it worked exactly as designed, and a red
   * row here would hide real delivery failures among the noise.
   * ============================================================================
   */
  if (row.simulated === true && providers.live) {
    // Gated on `providers.live` deliberately. In fixture mode sendSms returns a fake
    // sid and no message leaves the machine, so the e2e suite must still run the full
    // delivery path -- suppressing there would delete the only coverage this code has.
    // The hazard is a LIVE send, and that is exactly what this blocks.
    const reason = 'Simulated call — SMS suppressed so a test cannot page a real person.'
    await db.insert(leadDeliveries).values({
      leadId: lead.id,
      channel: 'sms',
      target: site?.leadAlertNumber ?? site?.onCallNumber ?? '(unconfigured)',
      status: 'suppressed',
      error: reason,
    })
    return { attempted: false, sent: false, reason }
  }
  if (site === null) {
    // Unattributed leads are kept but not delivered: there is no contractor to
    // send them to. Visible in the unattributed view instead of silently dropped.
    return { attempted: false, sent: false, reason: 'Lead has no site, so there is nobody to notify.' }
  }

  const target = site.leadAlertNumber ?? site.onCallNumber
  if (target === null) {
    const reason = 'Site has neither leadAlertNumber nor onCallNumber configured.'
    await db.insert(leadDeliveries).values({
      leadId: lead.id,
      channel: 'sms',
      target: '(unconfigured)',
      status: 'failed',
      error: reason,
    })
    return { attempted: true, sent: false, reason }
  }

  const from = site.trackingNumber
  if (from === null) {
    const reason = 'Site has no tracking number to send from.'
    await db.insert(leadDeliveries).values({
      leadId: lead.id,
      channel: 'sms',
      target,
      status: 'failed',
      error: reason,
    })
    return { attempted: true, sent: false, reason }
  }

  const attempt =
    (
      await db
        .select({ n: leadDeliveries.attempt })
        .from(leadDeliveries)
        .where(eq(leadDeliveries.leadId, lead.id))
    ).length + 1

  const [pending] = await db
    .insert(leadDeliveries)
    .values({ leadId: lead.id, channel: 'sms', target, status: 'pending', attempt })
    .returning()

  try {
    const body = composeLeadSms({ lead, site, domain: site.domain })
    const res = await providers.sendSms({ from, to: target, body })
    await db
      .update(leadDeliveries)
      .set({ status: 'sent', providerId: res.sid, sentAt: new Date() })
      .where(eq(leadDeliveries.id, pending!.id))
    return { attempted: true, sent: true, reason: null }
  } catch (e) {
    const message = (e as Error).message ?? String(e)
    await db
      .update(leadDeliveries)
      .set({ status: 'failed', error: message.slice(0, 2000) })
      .where(eq(leadDeliveries.id, pending!.id))
    // Rethrown so the job layer backs off and retries. The row above is already
    // written, so the failure is on the record even if this process dies next.
    throw e
  }
}

export async function listDeliveriesForSite(db: Database, siteId: number, limit = 100) {
  return db
    .select({ delivery: leadDeliveries, lead: leads })
    .from(leadDeliveries)
    .innerJoin(leads, eq(leadDeliveries.leadId, leads.id))
    .where(eq(leads.siteId, siteId))
    .orderBy(eq(leadDeliveries.status, 'failed'))
    .limit(limit)
}

export { safetyScriptFor }
