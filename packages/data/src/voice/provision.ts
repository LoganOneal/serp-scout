import 'server-only'
import { promptFingerprint, toE164 } from '@rnr/core'
import type { Database } from '../db.js'
import { getSiteById, updateSite } from '../sites.js'
import type { VoiceProviders } from '../providers/voice.js'
import type { NumberConfig } from '../providers/twilio/client.js'
import { publicBaseUrl } from './agents.js'

/**
 * Attach a DID to the trunk and import it into Retell.
 *
 * ==================== ONE IMPLEMENTATION, TWO FRONT DOORS ====================
 * This was the body of `scripts/provision-site.ts`. It moved here so the CLI and the
 * setup wizard run the SAME code -- two implementations of "provision a number" would
 * drift, and the failure mode of the drift is a line that half works.
 *
 * The two-step shape is preserved exactly: `inspect` only reads, `apply` writes, and
 * nothing writes without an explicit confirm. Attaching a number to a trunk silently
 * removes it from Programmable Voice, and whatever it does today -- forwards to a
 * cell, runs a Studio flow, hits an answering service -- stops the moment it lands.
 * ==========================================================================
 */

export class ProvisionError extends Error {}

export interface ProvisionBlocker {
  id: 'no_dr_url' | 'no_origination' | 'no_agent' | 'no_base_url' | 'missing_env' | 'no_number'
  detail: string
}

export interface ProvisionInspection {
  siteId: number
  phoneNumber: string
  agentId: string | null
  /** What the number does at Twilio right now. NULL = this account does not hold it. */
  current: NumberConfig | null
  /** True when the number currently answers via Programmable Voice. */
  wouldBreakExistingRouting: boolean
  alreadyOnTrunk: boolean
  trunkSid: string | null
  disasterRecoveryUrl: string | null
  originationUris: string[]
  pointsAtRetell: boolean
  inboundWebhookUrl: string | null
  blockers: ProvisionBlocker[]
}

function requireEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  blockers: ProvisionBlocker[],
): string | null {
  const v = env[name]
  if (!v) {
    blockers.push({ id: 'missing_env', detail: `${name} is not set. See docs/telephony.md.` })
    return null
  }
  return v
}

/** Read-only. Everything the operator needs to decide whether to proceed. */
export async function inspectProvisioning(
  db: Database,
  args: {
    siteId: number
    phoneNumber: string
    providers: VoiceProviders
    env?: NodeJS.ProcessEnv
  },
): Promise<ProvisionInspection> {
  const env = args.env ?? process.env
  const blockers: ProvisionBlocker[] = []

  const site = await getSiteById(db, args.siteId)
  if (site === null) throw new ProvisionError(`No site #${args.siteId}.`)

  const e164 = toE164(args.phoneNumber)
  if (e164 === null) {
    throw new ProvisionError(`"${args.phoneNumber}" is not a valid US number in E.164 form.`)
  }

  const base = publicBaseUrl(env)
  if (base === null) blockers.push({ id: 'no_base_url', detail: 'PUBLIC_BASE_URL is not set.' })

  const agentId = site.retellAgentId ?? env['RETELL_AGENT_ID'] ?? null
  if (agentId === null) {
    blockers.push({
      id: 'no_agent',
      detail: 'This site has no agent, and RETELL_AGENT_ID is unset. Bind an agent first.',
    })
  }

  const trunkSid = requireEnv(env, 'TWILIO_TRUNK_SID', blockers)
  requireEnv(env, 'TWILIO_TERMINATION_URI', blockers)

  const current = await args.providers.getNumberConfig(e164)
  if (current === null) {
    blockers.push({ id: 'no_number', detail: `Twilio has no number ${e164} on this account.` })
  }

  let disasterRecoveryUrl: string | null = null
  let originationUris: string[] = []
  let pointsAtRetell = false

  if (trunkSid !== null) {
    const trunk = await args.providers.getTrunk(trunkSid)
    if (trunk === null) {
      blockers.push({ id: 'missing_env', detail: `Trunk ${trunkSid} not found.` })
    } else {
      disasterRecoveryUrl = trunk.disasterRecoveryUrl
      const uris = await args.providers.listTrunkOriginationUris(trunkSid)
      originationUris = uris.map((u) => u.sipUrl)
      pointsAtRetell = uris.some((u) => u.enabled && /sip\.retellai\.com/i.test(u.sipUrl))

      /**
       * A hard refusal, not a warning.
       *
       * Without a Disaster Recovery URL, a Retell outage is a dead business line, and it
       * fails silently from the caller's side -- they hear nothing and call a competitor.
       */
      if (trunk.disasterRecoveryUrl === null) {
        blockers.push({
          id: 'no_dr_url',
          detail:
            `Trunk ${trunkSid} has no Disaster Recovery URL. Set it to ` +
            `${base ?? '{PUBLIC_BASE_URL}'}/api/twilio/failover — without it, a Retell outage ` +
            'is a dead business line with no fallback.',
        })
      }
      if (!pointsAtRetell) {
        blockers.push({
          id: 'no_origination',
          detail:
            'Trunk has no enabled origination URI pointing at sip:sip.retellai.com. Inbound ' +
            'calls would never reach Retell.',
        })
      }
    }
  }

  return {
    siteId: args.siteId,
    phoneNumber: e164,
    agentId,
    current,
    wouldBreakExistingRouting:
      current !== null && (current.voiceUrl !== null || current.voiceApplicationSid !== null),
    alreadyOnTrunk: current !== null && trunkSid !== null && current.trunkSid === trunkSid,
    trunkSid,
    disasterRecoveryUrl,
    originationUris,
    pointsAtRetell,
    inboundWebhookUrl: base === null ? null : `${base}/api/retell/inbound`,
    blockers,
  }
}

export interface ProvisionResult {
  phoneNumber: string
  agentId: string
  attachedToTrunk: boolean
  imported: boolean
  /** True when the DID was already in Retell and only its webhook was retargeted. */
  retargetedInstead: boolean
  inboundWebhookUrl: string
}

/** Writes. Refuses on any blocker — there is no override, by design. */
export async function applyProvisioning(
  db: Database,
  args: {
    siteId: number
    phoneNumber: string
    providers: VoiceProviders
    env?: NodeJS.ProcessEnv
  },
): Promise<ProvisionResult> {
  const env = args.env ?? process.env
  const inspection = await inspectProvisioning(db, args)

  if (inspection.blockers.length > 0) {
    throw new ProvisionError(
      `Refusing to provision:\n${inspection.blockers.map((b) => `  - ${b.detail}`).join('\n')}`,
    )
  }

  const site = (await getSiteById(db, args.siteId))!
  const { phoneNumber, trunkSid, agentId, current, inboundWebhookUrl } = inspection

  if (!inspection.alreadyOnTrunk) {
    await args.providers.attachNumberToTrunk(trunkSid!, current!.sid)
  }

  /**
   * Import once, then retarget.
   *
   * `/import-phone-number` is a 400 for a DID Retell already holds, so a re-run after a
   * host move used to abort here -- leaving `inbound_webhook_url` pointing at a dead
   * tunnel. That URL is how Retell learns which agent answers, so a stale one means the
   * caller reaches a fallback agent that cannot save a lead.
   */
  let retargetedInstead = false
  try {
    await args.providers.importPhoneNumber({
      phoneNumber,
      terminationUri: env['TWILIO_TERMINATION_URI']!,
      sipTrunkAuthUsername: env['TWILIO_SIP_CRED_USERNAME'],
      sipTrunkAuthPassword: env['TWILIO_SIP_CRED_PASSWORD'],
      inboundAgentId: agentId!,
      inboundWebhookUrl: inboundWebhookUrl!,
      nickname: `${site.domain ?? `site-${site.id}`} - ${site.displayName ?? 'site'} #${site.id}`,
      allowedInboundCountries: ['US'],
    })
  } catch (e) {
    // Only an already-imported number is recoverable. A bad termination URI or a
    // rejected credential must still fail loudly rather than be papered over.
    const message = e instanceof Error ? e.message : String(e)
    const body = String((e as { body?: string })?.body ?? '')
    const alreadyImported = /already/i.test(message) || /already/i.test(body) || /-> 400$/.test(message)
    if (!alreadyImported) throw e

    retargetedInstead = true
    await args.providers.updatePhoneNumberWebhook({
      phoneNumber,
      inboundWebhookUrl: inboundWebhookUrl!,
      inboundAgentId: agentId!,
    })
  }

  await updateSite(db, args.siteId, {
    trackingNumber: phoneNumber,
    twilioNumberSid: current!.sid,
    retellAgentId: agentId!,
    retellNumberImportedAt: new Date(),
    // Only meaningful when the script came from this repo; a dashboard-built agent
    // keeps whatever the create path recorded, which may be null.
    ...(site.promptFingerprint === null ? {} : { promptFingerprint: promptFingerprint() }),
  })

  return {
    phoneNumber,
    agentId: agentId!,
    attachedToTrunk: !inspection.alreadyOnTrunk,
    imported: !retargetedInstead,
    retargetedInstead,
    inboundWebhookUrl: inboundWebhookUrl!,
  }
}
