/**
 * Build the Twilio Elastic SIP Trunk that connects your numbers to Retell.
 *
 *   pnpm twilio:setup-trunk                 # dry run: shows your numbers and the plan
 *   pnpm twilio:setup-trunk --confirm       # create it
 *   pnpm twilio:setup-trunk --confirm --write-env
 *
 * ==================== WHY A TRUNK AT ALL ====================
 * Retell cannot answer a Twilio number directly. Voice reaches it over an Elastic
 * SIP Trunk: Twilio ORIGINATES inbound calls to sip:sip.retellai.com, and Retell
 * TERMINATES outbound calls back through your trunk's domain. `termination_uri` is a
 * required field on Retell's import API even for an inbound-only setup, because it is
 * how Retell identifies which trunk is yours.
 *
 * This does the eight console steps: trunk, domain, credential list, credential,
 * attach, origination URI, disaster recovery URL. It does NOT attach any phone
 * number -- that is `pnpm sites:provision`, separately, because attaching a number
 * silently removes it from Programmable Voice and deserves its own confirmation.
 * ===========================================================
 */
import 'dotenv/config'
import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { TwilioClient } from '../providers/twilio/client.js'

const RETELL_SIP_URI = 'sip:sip.retellai.com'

function has(flag: string): boolean {
  return process.argv.slice(2).includes(`--${flag}`)
}
function flag(name: string): string | null {
  const argv = process.argv.slice(2)
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? (argv[i + 1] ?? null) : null
}

/**
 * 16 chars, guaranteed to contain upper, lower and a digit.
 *
 * Twilio rejects the whole credential request otherwise, and the error does not say
 * which rule was broken.
 */
function sipPassword(): string {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
  const lower = 'abcdefghijkmnopqrstuvwxyz'
  const digit = '23456789'
  const all = upper + lower + digit
  const bytes = randomBytes(32)
  const pick = (set: string, i: number): string => set[bytes[i]! % set.length]!

  const chars = [pick(upper, 0), pick(lower, 1), pick(digit, 2)]
  for (let i = 3; i < 16; i++) chars.push(pick(all, i))
  // Shuffle so the guaranteed characters are not always in positions 0-2.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = bytes[i + 16]! % (i + 1)
    const t = chars[i]!
    chars[i] = chars[j]!
    chars[j] = t
  }
  return chars.join('')
}

async function main(): Promise<void> {
  const accountSid = process.env['TWILIO_ACCOUNT_SID']
  const authToken = process.env['TWILIO_AUTH_TOKEN']
  if (!accountSid || !authToken) {
    console.error(
      'TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set in .env.\n' +
        'Find them at https://console.twilio.com (Account Info).',
    )
    process.exit(1)
  }

  const confirm = has('confirm')
  const region = flag('region') ?? 'us1'
  const base = (process.env['PUBLIC_BASE_URL'] ?? '').replace(/\/$/, '')
  const drUrl = base === '' ? null : `${base}/api/twilio/failover`
  const reachable = drUrl !== null && !/localhost|127\.0\.0\.1/.test(drUrl)

  const twilio = new TwilioClient(accountSid, authToken)

  // --- 1. What numbers do you have? ---------------------------------------
  console.log('\nNumbers on this Twilio account')
  const numbers = await twilio.listNumbers()
  if (numbers.length === 0) {
    console.log('  (none)')
  }
  for (const n of numbers) {
    const routing = n.trunkSid
      ? `on trunk ${n.trunkSid}`
      : n.voiceUrl || n.voiceApplicationSid
        ? 'Programmable Voice'
        : 'no voice config'
    console.log(`  ${n.phoneNumber.padEnd(14)} ${routing.padEnd(24)} ${n.friendlyName ?? ''}`)
  }

  // --- 2. Trunk ------------------------------------------------------------
  const existingSid = process.env['TWILIO_TRUNK_SID']
  const trunks = await twilio.listTrunks()
  let trunk = existingSid
    ? trunks.find((t) => t.sid === existingSid)
    : trunks.find((t) => t.friendlyName === 'rank-and-rent')

  console.log('\nTrunk')
  if (trunk) {
    console.log(`  reuse  ${trunk.sid}  ${trunk.domainName}`)
  } else {
    // Globally unique across all of Twilio, so it is derived from the account SID.
    // A friendly word collides with somebody else's trunk on the first attempt.
    const domain = `rnr-${accountSid.slice(-8).toLowerCase()}.pstn.twilio.com`
    console.log(`  create rank-and-rent  ${domain}`)
    if (confirm) {
      const made = await twilio.createTrunk({
        friendlyName: 'rank-and-rent',
        domainName: domain,
        ...(reachable && drUrl ? { disasterRecoveryUrl: drUrl } : {}),
      })
      trunk = { sid: made.sid, friendlyName: 'rank-and-rent', domainName: made.domainName }
      console.log(`  created ${made.sid}`)
    }
  }

  if (!confirm) {
    console.log('\nPlan (nothing has changed)')
    console.log('  1. create/reuse the trunk above')
    console.log(`  2. add origination URI ${RETELL_SIP_URI}   <- makes inbound calls reach Retell`)
    console.log('  3. create a SIP credential list + credential for termination auth')
    console.log('  4. attach that credential list to the trunk')
    console.log(
      reachable
        ? `  5. set the disaster recovery URL to ${drUrl}`
        : '  5. SKIP the disaster recovery URL -- PUBLIC_BASE_URL is unset or localhost',
    )
    console.log('\nRe-run with --confirm to apply. Add --write-env to append the results to .env.')
    if (!reachable) {
      console.log(
        '\n  NOTE: without a public PUBLIC_BASE_URL the disaster recovery URL cannot be set,\n' +
          '  and `pnpm sites:provision` will refuse to attach a number until it is. Get the\n' +
          '  tunnel first, then re-run this. Everything else here works now.',
      )
    }
    return
  }

  if (!trunk) {
    console.error('Trunk creation did not return a sid.')
    process.exit(1)
  }

  // --- 3. Origination (inbound -> Retell) ---------------------------------
  console.log('\nOrigination')
  const origination = await twilio.listTrunkOriginationUris(trunk.sid)
  if (origination.some((u) => u.sipUrl.includes('sip.retellai.com'))) {
    console.log(`  already points at ${RETELL_SIP_URI}`)
  } else {
    await twilio.addOriginationUri(trunk.sid, { friendlyName: 'retell', sipUrl: RETELL_SIP_URI })
    console.log(`  added ${RETELL_SIP_URI}`)
  }

  // --- 4. Termination auth -------------------------------------------------
  console.log('\nTermination auth')
  const attached = await twilio.listTrunkCredentialLists(trunk.sid)
  let username: string | null = null
  let password: string | null = null

  if (attached.length > 0) {
    console.log(`  a credential list is already attached (${attached[0]!.sid})`)
    console.log('  keeping it -- the existing password is not readable back from Twilio.')
    console.log('  If you do not have it, delete the list in the console and re-run.')
  } else {
    const lists = await twilio.listCredentialLists()
    let listSid = lists.find((l) => l.friendlyName === 'rank-and-rent')?.sid ?? null
    if (listSid === null) {
      listSid = (await twilio.createCredentialList('rank-and-rent')).sid
      console.log(`  created credential list ${listSid}`)
    }
    username = `rnr${accountSid.slice(-6).toLowerCase()}`
    password = sipPassword()
    await twilio.addCredential(listSid, { username, password })
    await twilio.attachCredentialListToTrunk(trunk.sid, listSid)
    console.log(`  created credential "${username}" and attached the list`)
  }

  // --- 5. Disaster recovery ------------------------------------------------
  console.log('\nDisaster recovery')
  if (reachable && drUrl) {
    await twilio.setDisasterRecoveryUrl(trunk.sid, drUrl)
    console.log(`  set to ${drUrl}`)
  } else {
    // Refused rather than set to a localhost URL that would silently never answer.
    console.log('  NOT SET -- PUBLIC_BASE_URL is unset or localhost.')
    console.log('  Re-run after the tunnel is up. Until then a Retell outage is a dead line,')
    console.log('  and sites:provision will refuse to attach a number.')
  }

  // --- 6. What to put in .env ---------------------------------------------
  const terminationUri = trunk.domainName.replace('.pstn.twilio.com', `.pstn.${region}.twilio.com`)

  const lines = [
    `TWILIO_TRUNK_SID=${trunk.sid}`,
    `TWILIO_TERMINATION_URI=${terminationUri}`,
    ...(username && password
      ? [`TWILIO_SIP_CRED_USERNAME=${username}`, `TWILIO_SIP_CRED_PASSWORD=${password}`]
      : []),
  ]

  console.log('\n--- .env ---------------------------------------------------------')
  for (const l of lines) console.log(l)
  console.log('------------------------------------------------------------------')
  if (password) {
    console.log('The password is shown ONCE. Twilio will not reveal it again.')
  }
  console.log(
    `\nTermination URI uses the ${region} region. Twilio also accepts the unlocalized\n` +
      `${trunk.domainName} -- the regional form avoids an extra network hop, and\n` +
      'calls.latency_e2e_p50_ms lets you A/B the two over ten calls each.',
  )

  if (has('write-env')) {
    writeEnv(lines)
    console.log('\nWritten to .env.')
  } else {
    console.log('\nPaste those into .env (or re-run with --write-env).')
  }

  console.log('\nNext:')
  console.log(`  pnpm sites:provision <domain> --number <one of the numbers above>`)
  console.log('  (dry run first -- it prints what the number does today before changing it)')
}

/**
 * Upsert keys into .env rather than appending.
 *
 * An append produced DUPLICATE keys the first time this ran, because .env already
 * held empty placeholders for all four. dotenv resolves a duplicate by taking the
 * last one, so the app still worked -- but `grep KEY= .env | cut -d= -f2` then
 * returns two lines, and every shell script reading the file that way silently gets
 * a multi-line value. Rewriting in place keeps the file something you can grep.
 */
function writeEnv(pairs: string[]): void {
  const existing = readFileSync('.env', 'utf8').split('\n')
  const incoming = new Map(pairs.map((p) => [p.slice(0, p.indexOf('=')), p]))

  const out = existing.map((line) => {
    if (!line.includes('=') || line.trim().startsWith('#')) return line
    const key = line.slice(0, line.indexOf('=')).trim()
    const replacement = incoming.get(key)
    if (replacement === undefined) return line
    incoming.delete(key)
    return replacement
  })

  // Anything with no existing key to replace gets appended once.
  if (incoming.size > 0) {
    out.push('', '# Written by pnpm twilio:setup-trunk', ...incoming.values())
  }
  writeFileSync('.env', out.join('\n'))
}

main().catch((e) => {
  console.error(`\nFailed: ${(e as Error).message}`)
  process.exit(1)
})
