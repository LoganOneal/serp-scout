/**
 * Attach a Twilio number to a site and import it into Retell.
 *
 *   pnpm sites:provision kenoshaair.com --number +14145550134
 *   pnpm sites:provision kenoshaair.com --number +14145550134 --confirm
 *
 * ==================== WITHOUT --confirm THIS ONLY READS ====================
 * These are working business numbers. Attaching one to an Elastic SIP Trunk
 * silently removes it from Programmable Voice, and whatever it does today --
 * forwards to the owner's cell, runs a Studio flow, hits an answering service --
 * stops the moment the attach succeeds.
 *
 * So the default is a dry run that PRINTS the number's current configuration and
 * stops. LIVE_CALLS_ENABLED governs spend; this governs call routing on a line
 * customers are already dialling, which is a different and less reversible thing.
 * ========================================================================
 *
 * It also REFUSES to proceed when the trunk has no Disaster Recovery URL, because
 * without one a Retell outage is a dead business phone line -- see docs/telephony.md.
 */
import 'dotenv/config'
import { promptFingerprint, toE164 } from '@rnr/core'
import { closeDb, db } from '../db.js'
import { getSiteByDomain, updateSite } from '../sites.js'
import { createVoiceProviders } from '../providers/voice.js'
import { liveCallsEnabled } from '../providers/index.js'

function flag(name: string): string | null {
  const argv = process.argv.slice(2)
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? (argv[i + 1] ?? null) : null
}

function has(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`)
}

function required(name: string, value: string | undefined): string {
  if (!value) {
    console.error(`${name} is not set. See docs/telephony.md for the full list.`)
    process.exit(1)
  }
  return value
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const domain = argv.find((a) => !a.startsWith('--') && !argv[argv.indexOf(a) - 1]?.startsWith('--'))
  const numberRaw = flag('number')

  if (!domain || !numberRaw) {
    console.error('Usage: pnpm sites:provision <domain> --number +1XXXXXXXXXX [--confirm]')
    process.exit(1)
  }

  const e164 = toE164(numberRaw)
  if (e164 === null) {
    console.error(`"${numberRaw}" is not a valid US number in E.164 form.`)
    process.exit(1)
  }

  const site = await getSiteByDomain(db(), domain)
  if (site === null) {
    console.error(`No site with domain "${domain}". Create it at /sites first.`)
    await closeDb()
    process.exit(1)
  }

  const confirm = has('confirm')
  const providers = createVoiceProviders()

  console.log(`\nSite      ${site.domain} (#${site.id})`)
  console.log(`Number    ${e164}`)
  console.log(`Mode      ${providers.live ? 'LIVE — real Twilio and Retell calls' : 'FIXTURES (LIVE_CALLS_ENABLED is not "true")'}`)
  if (!confirm) console.log('Action    DRY RUN (pass --confirm to apply)')

  // --- 1. What does this number do today? ----------------------------------
  const current = await providers.getNumberConfig(e164)
  if (current === null) {
    console.error(`\nTwilio has no number ${e164} on this account.`)
    await closeDb()
    process.exit(1)
  }

  console.log('\nCurrent Twilio configuration')
  console.log(`  sid            ${current.sid}`)
  console.log(`  friendly name  ${current.friendlyName ?? '—'}`)
  console.log(`  voice url      ${current.voiceUrl ?? '—'}`)
  console.log(`  voice app sid  ${current.voiceApplicationSid ?? '—'}`)
  console.log(`  trunk sid      ${current.trunkSid ?? '— not on a trunk —'}`)
  console.log(`  sms url        ${current.smsUrl ?? '—'}`)

  if (current.voiceUrl !== null || current.voiceApplicationSid !== null) {
    console.log(
      '\n  !! This number currently answers via Programmable Voice.\n' +
        '     Attaching it to the trunk WILL stop that. If it forwards to a cell today,\n' +
        "     that cell is probably the right value for this site's on-call number.",
    )
  }

  // --- 2. Trunk preconditions ----------------------------------------------
  const trunkSid = required('TWILIO_TRUNK_SID', process.env['TWILIO_TRUNK_SID'])
  const terminationUri = required('TWILIO_TERMINATION_URI', process.env['TWILIO_TERMINATION_URI'])
  const agentId = site.retellAgentId ?? process.env['RETELL_AGENT_ID']
  if (!agentId) {
    console.error('\nNo agent: set RETELL_AGENT_ID, or set the agent on the site first.')
    await closeDb()
    process.exit(1)
  }
  const baseUrl = required('PUBLIC_BASE_URL', process.env['PUBLIC_BASE_URL']).replace(/\/$/, '')

  const trunk = await providers.getTrunk(trunkSid)
  if (trunk === null) {
    console.error(`\nTrunk ${trunkSid} not found.`)
    await closeDb()
    process.exit(1)
  }

  const origination = await providers.listTrunkOriginationUris(trunkSid)
  const pointsAtRetell = origination.some(
    (u) => u.enabled && /sip\.retellai\.com/i.test(u.sipUrl),
  )

  console.log('\nTrunk')
  console.log(`  sid              ${trunk.sid}`)
  console.log(`  origination      ${origination.map((u) => u.sipUrl).join(', ') || '— none —'}`)
  console.log(`  disaster recovery ${trunk.disasterRecoveryUrl ?? '— NOT SET —'}`)

  const blockers: string[] = []
  if (trunk.disasterRecoveryUrl === null) {
    /**
     * A hard refusal, not a warning.
     *
     * Without a Disaster Recovery URL, a Retell outage or one wrong SIP field is a
     * dead phone line, and the caller just hears nothing and calls a competitor.
     * The same spirit as runScan refusing a non-'dataforseo' location code: the
     * cheap check that prevents the expensive silent failure.
     */
    blockers.push(
      `Trunk ${trunkSid} has no Disaster Recovery URL. Set it to\n` +
        `      ${baseUrl}/api/twilio/failover\n` +
        '      Without it, a Retell outage is a dead business line with no fallback.',
    )
  }
  if (!pointsAtRetell) {
    blockers.push(
      'Trunk has no enabled origination URI pointing at sip:sip.retellai.com.\n' +
        '      Inbound calls would never reach Retell.',
    )
  }

  if (blockers.length > 0) {
    console.error('\nRefusing to provision:')
    for (const b of blockers) console.error(`  - ${b}`)
    await closeDb()
    process.exit(1)
  }

  // --- 3. Apply -------------------------------------------------------------
  if (!confirm) {
    console.log('\nDry run complete. Nothing changed. Re-run with --confirm to:')
    console.log(`  1. attach ${e164} to trunk ${trunkSid} (this takes it off Programmable Voice)`)
    console.log(`  2. import it into Retell against agent ${agentId}`)
    console.log(`  3. set its inbound webhook to ${baseUrl}/api/retell/inbound`)
    console.log(`  4. record the number on site #${site.id}`)
    await closeDb()
    return
  }

  if (current.trunkSid === trunkSid) {
    console.log(`\n1. Already attached to trunk ${trunkSid}, skipping.`)
  } else {
    await providers.attachNumberToTrunk(trunkSid, current.sid)
    console.log(`\n1. Attached ${e164} to trunk ${trunkSid}.`)
  }

  /**
   * ==================== IMPORT ONCE, THEN RETARGET ====================
   * `/import-phone-number` is a 400 for a DID Retell already holds, so re-running this after
   * a host move used to abort here -- leaving `inbound_webhook_url` pointing at the old
   * tunnel. That URL is how Retell learns which agent answers, so a dead one means the
   * caller reaches a fallback agent with no business name that cannot save a lead.
   *
   * So: import if it is new, patch the webhook if it is not. Either way the script ends with
   * the webhook pointing at PUBLIC_BASE_URL, which is what makes it safe to re-run.
   * ==================================================================
   */
  const inboundWebhookUrl = `${baseUrl}/api/retell/inbound`
  try {
    await providers.importPhoneNumber({
      phoneNumber: e164,
      terminationUri,
      sipTrunkAuthUsername: process.env['TWILIO_SIP_CRED_USERNAME'],
      sipTrunkAuthPassword: process.env['TWILIO_SIP_CRED_PASSWORD'],
      inboundAgentId: agentId,
      // Set HERE, at provisioning time. This is what makes "forgot to paste the
      // webhook URL into the dashboard" structurally impossible rather than merely
      // detectable after the fact.
      inboundWebhookUrl,
      nickname: `${site.domain} - ${site.displayName ?? 'site'} #${site.id}`,
      allowedInboundCountries: ['US'],
    })
    console.log(`2. Imported into Retell against agent ${agentId}.`)
  } catch (e) {
    // Only an already-imported number is recoverable here. A bad termination URI or a
    // rejected credential must still fail loudly rather than be papered over.
    const message = e instanceof Error ? e.message : String(e)
    const alreadyImported =
      /already/i.test(message) || /-> 400$/.test(message) || /already/i.test(String((e as { body?: string })?.body ?? ''))
    if (!alreadyImported) throw e

    console.log(`2. Already imported into Retell; patching its inbound webhook instead.`)
    await providers.updatePhoneNumberWebhook({
      phoneNumber: e164,
      inboundWebhookUrl,
      inboundAgentId: agentId,
    })
  }
  console.log(`3. Inbound webhook set to ${inboundWebhookUrl}.`)

  await updateSite(db(), site.id, {
    trackingNumber: e164,
    twilioNumberSid: current.sid,
    retellAgentId: agentId,
    retellNumberImportedAt: new Date(),
    promptFingerprint: promptFingerprint(),
  })
  console.log(`4. Recorded on site #${site.id}.`)

  console.log('\nOne manual step remains, and nothing before it proves anything:')
  console.log(`  CALL ${e164} FROM A REAL CELL PHONE.`)
  console.log('  Retell cannot validate this configuration until a call is made.')
  console.log(`  Then check ${baseUrl}/sites/${site.id} — the "not connected" banner should clear.`)
  if (!liveCallsEnabled()) {
    console.log(
      '\n  (Fixture mode: nothing was actually changed at Twilio or Retell. Set\n' +
        '   LIVE_CALLS_ENABLED=true to provision for real.)',
    )
  }

  await closeDb()
}

main().catch(async (e) => {
  console.error(`\nFailed: ${(e as Error).message}`)
  await closeDb()
  process.exit(1)
})
