/**
 * Attach a Twilio number to a site and import it into Retell.
 *
 *   pnpm sites:provision kenoshaair.com --number +14145550134
 *   pnpm sites:provision kenoshaair.com --number +14145550134 --confirm
 *   pnpm sites:provision --site 11 --number +16693695287
 *
 * ==================== WITHOUT --confirm THIS ONLY READS ====================
 * These are working business numbers. Attaching one to an Elastic SIP Trunk silently
 * removes it from Programmable Voice, and whatever it does today -- forwards to the
 * owner's cell, runs a Studio flow, hits an answering service -- stops the moment the
 * attach succeeds.
 *
 * So the default is a dry run that PRINTS the number's current configuration and stops.
 * LIVE_CALLS_ENABLED governs spend; this governs call routing on a line customers are
 * already dialling, which is a different and less reversible thing.
 * ========================================================================
 *
 * The logic lives in voice/provision.ts so this script and the setup wizard cannot
 * drift apart. This file is argument parsing and printing, nothing else.
 */
import 'dotenv/config'
import { closeDb, db } from '../db.js'
import { getSiteByDomain, getSiteById } from '../sites.js'
import { createVoiceProviders } from '../providers/voice.js'
import { liveCallsEnabled } from '../providers/index.js'
import { applyProvisioning, inspectProvisioning } from '../voice/provision.js'

function flag(name: string): string | null {
  const argv = process.argv.slice(2)
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? (argv[i + 1] ?? null) : null
}

function has(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`)
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const numberRaw = flag('number')
  const siteFlag = flag('site')
  const domain = argv.find(
    (a) => !a.startsWith('--') && !argv[argv.indexOf(a) - 1]?.startsWith('--'),
  )

  if (!numberRaw || (!domain && !siteFlag)) {
    console.error(
      'Usage: pnpm sites:provision <domain> --number +1XXXXXXXXXX [--confirm]\n' +
        '   or: pnpm sites:provision --site <id> --number +1XXXXXXXXXX [--confirm]',
    )
    process.exit(1)
  }

  // Resolvable by id as well as domain: a cell can be targeted, given a number and
  // provisioned before anyone registers a domain for it.
  const site = siteFlag
    ? await getSiteById(db(), Number(siteFlag))
    : await getSiteByDomain(db(), domain!)
  if (site === null) {
    console.error(
      siteFlag ? `No site #${siteFlag}.` : `No site with domain "${domain}". Create it at /sites first.`,
    )
    await closeDb()
    process.exit(1)
  }

  const confirm = has('confirm')
  const providers = createVoiceProviders()

  console.log(`\nSite      ${site.domain ?? `#${site.id}`} (#${site.id})`)
  console.log(`Number    ${numberRaw}`)
  console.log(
    `Mode      ${providers.live ? 'LIVE — real Twilio and Retell calls' : 'FIXTURES (LIVE_CALLS_ENABLED is not "true")'}`,
  )
  if (!confirm) console.log('Action    DRY RUN (pass --confirm to apply)')

  const inspection = await inspectProvisioning(db(), {
    siteId: site.id,
    phoneNumber: numberRaw,
    providers,
  })

  if (inspection.current === null) {
    console.error(`\nTwilio has no number ${inspection.phoneNumber} on this account.`)
    await closeDb()
    process.exit(1)
  }

  console.log('\nCurrent Twilio configuration')
  console.log(`  sid            ${inspection.current.sid}`)
  console.log(`  friendly name  ${inspection.current.friendlyName ?? '—'}`)
  console.log(`  voice url      ${inspection.current.voiceUrl ?? '—'}`)
  console.log(`  voice app sid  ${inspection.current.voiceApplicationSid ?? '—'}`)
  console.log(`  trunk sid      ${inspection.current.trunkSid ?? '— not on a trunk —'}`)
  console.log(`  sms url        ${inspection.current.smsUrl ?? '—'}`)

  if (inspection.wouldBreakExistingRouting) {
    console.log(
      '\n  !! This number currently answers via Programmable Voice.\n' +
        '     Attaching it to the trunk WILL stop that. If it forwards to a cell today,\n' +
        "     that cell is probably the right value for this site's on-call number.",
    )
  }

  console.log('\nTrunk')
  console.log(`  sid              ${inspection.trunkSid ?? '—'}`)
  console.log(`  origination      ${inspection.originationUris.join(', ') || '— none —'}`)
  console.log(`  disaster recovery ${inspection.disasterRecoveryUrl ?? '— NOT SET —'}`)

  if (inspection.blockers.length > 0) {
    console.error('\nRefusing to provision:')
    for (const b of inspection.blockers) console.error(`  - ${b.detail}`)
    await closeDb()
    process.exit(1)
  }

  if (!confirm) {
    console.log('\nDry run complete. Nothing changed. Re-run with --confirm to:')
    console.log(
      `  1. attach ${inspection.phoneNumber} to trunk ${inspection.trunkSid} (this takes it off Programmable Voice)`,
    )
    console.log(`  2. import it into Retell against agent ${inspection.agentId}`)
    console.log(`  3. set its inbound webhook to ${inspection.inboundWebhookUrl}`)
    console.log(`  4. record the number on site #${site.id}`)
    await closeDb()
    return
  }

  const result = await applyProvisioning(db(), {
    siteId: site.id,
    phoneNumber: numberRaw,
    providers,
  })

  console.log(
    `\n1. ${result.attachedToTrunk ? `Attached ${result.phoneNumber} to trunk ${inspection.trunkSid}.` : `Already attached to trunk ${inspection.trunkSid}, skipped.`}`,
  )
  console.log(
    `2. ${result.imported ? `Imported into Retell against agent ${result.agentId}.` : 'Already imported into Retell; patched its inbound webhook instead.'}`,
  )
  console.log(`3. Inbound webhook set to ${result.inboundWebhookUrl}.`)
  console.log(`4. Recorded on site #${site.id}.`)

  console.log('\nOne manual step remains, and nothing before it proves anything:')
  console.log(`  CALL ${result.phoneNumber} FROM A REAL CELL PHONE.`)
  console.log('  Retell cannot validate this configuration until a call is made.')
  console.log(`  Then check the site page — the "not connected" banner should clear.`)
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
