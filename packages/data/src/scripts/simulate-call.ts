/**
 * Drive a complete fake call through the real webhook endpoints.
 *
 *   pnpm voice:simulate kenoshaair.com
 *   pnpm voice:simulate kenoshaair.com --scenario gas_emergency
 *   pnpm voice:simulate kenoshaair.com --count 8
 *
 * ==================== WHY THIS EXISTS, AND WHY IT CAME FIRST ====================
 * The alternative way to build a call dashboard is to phone the number, hang up,
 * and squint at logs -- once per iteration, at whatever pace the PSTN allows.
 *
 * This posts SIGNED payloads at the running app in the real order (inbound ->
 * started -> save_lead x2 -> ended -> analyzed), so the whole ingest path and every
 * pixel of the dashboard are developable with no Retell account, no Twilio trunk,
 * and no phone.
 *
 * It signs with RETELL_API_KEY rather than bypassing verification, because a
 * SKIP_SIGNATURE flag would eventually ship and turn the tool endpoint into an open
 * write endpoint. The verified path is the only path, and this exercises it.
 * ==============================================================================
 */
import 'dotenv/config'
import { closeDb, db } from '../db.js'
import { getSiteByDomain } from '../sites.js'
import { fixtureCall, FIXTURE_SCENARIOS, type FixtureScenario } from '../providers/fixtures/voice.js'
import { signRetellPayload } from '../providers/retell/signature.js'

interface Args {
  domain: string
  scenario: FixtureScenario | null
  count: number
  base: string
  apiKey: string
}

function parseArgs(): Args | string {
  const argv = process.argv.slice(2)
  const domain = argv.find((a) => !a.startsWith('--'))
  if (!domain) {
    return 'Usage: pnpm voice:simulate <domain> [--scenario <name>] [--count N]'
  }

  const flag = (name: string): string | null => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 ? (argv[i + 1] ?? null) : null
  }

  const scenarioRaw = flag('scenario')
  if (scenarioRaw !== null && !FIXTURE_SCENARIOS.includes(scenarioRaw as FixtureScenario)) {
    return `Unknown scenario "${scenarioRaw}". One of: ${FIXTURE_SCENARIOS.join(', ')}`
  }

  const base = process.env['PUBLIC_BASE_URL'] ?? 'http://localhost:3000'
  const apiKey = process.env['RETELL_API_KEY']
  if (!apiKey) {
    return (
      'RETELL_API_KEY is not set.\n' +
      'The ingest routes verify every payload and have no bypass flag, so a signed\n' +
      'fixture cannot be produced without it. Any non-empty string works for local\n' +
      'simulation -- it only has to match what the app verifies against.'
    )
  }

  return {
    domain,
    scenario: (scenarioRaw as FixtureScenario | null) ?? null,
    count: Math.max(1, Number(flag('count') ?? '1') || 1),
    base: base.replace(/\/$/, ''),
    apiKey,
  }
}

async function post(
  args: Args,
  path: string,
  payload: unknown,
): Promise<{ status: number; body: string }> {
  const raw = JSON.stringify(payload)
  const res = await fetch(`${args.base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-retell-signature': signRetellPayload({ rawBody: raw, apiKey: args.apiKey }),
    },
    body: raw,
  })
  return { status: res.status, body: (await res.text()).slice(0, 200) }
}

async function main(): Promise<void> {
  const parsed = parseArgs()
  if (typeof parsed === 'string') {
    console.error(parsed)
    process.exit(1)
  }
  const args = parsed

  const site = await getSiteByDomain(db(), args.domain)
  if (site === null) {
    console.error(`No site with domain "${args.domain}". Create it at /sites first.`)
    await closeDb()
    process.exit(1)
  }

  console.log(`Simulating ${args.count} call(s) to ${site.domain} via ${args.base}`)
  if (site.trackingNumber === null) {
    console.log(
      '  Note: this site has no tracking number, so the inbound webhook cannot resolve it\n' +
        '  by dialled number. The events still carry metadata.site_id, so the calls WILL be\n' +
        '  attributed -- that is exactly the split this design relies on.',
    )
  }

  let failures = 0

  for (let i = 0; i < args.count; i++) {
    // Time-seeded id so repeated runs produce distinct calls, but each individual
    // call is still deterministic from its own id.
    const callId = `sim_${site.id}_${Date.now().toString(36)}_${i}`
    const fixture = fixtureCall({
      callId,
      siteId: site.id,
      toNumber: site.trackingNumber ?? '+10000000000',
      ...(args.scenario ? { scenario: args.scenario } : {}),
    })

    const steps: Array<[string, string, unknown]> = [
      ['inbound', '/api/retell/inbound', fixture.inboundPayload],
      ['started', '/api/retell/events', fixture.eventPayloads[0]],
      ...fixture.toolPayloads.map(
        (p, n): [string, string, unknown] => [`save_lead#${n + 1}`, '/api/retell/tool/save-lead', p],
      ),
      ['ended', '/api/retell/events', fixture.eventPayloads[1]],
      ['analyzed', '/api/retell/events', fixture.eventPayloads[2]],
    ]

    console.log(`\n  ${callId} (${fixture.scenario})`)
    for (const [label, path, payload] of steps) {
      try {
        const res = await post(args, path, payload)
        const ok = res.status < 300
        if (!ok) failures++
        console.log(`    ${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(12)} ${res.status} ${ok ? '' : res.body}`)
      } catch (e) {
        failures++
        console.log(`    FAIL ${label.padEnd(12)} ${(e as Error).message}`)
      }
    }
  }

  console.log(
    failures === 0
      ? `\nAll requests accepted. Open ${args.base}/sites/${site.id} — the "not connected" banner should be gone.\n` +
          'Recordings and lead alerts are queued: they only move while `pnpm worker` is running.'
      : `\n${failures} request(s) failed. If they are 401s, RETELL_API_KEY here does not match the app's.`,
  )

  await closeDb()
  if (failures > 0) process.exit(1)
}

main().catch(async (e) => {
  console.error(e)
  await closeDb()
  process.exit(1)
})
