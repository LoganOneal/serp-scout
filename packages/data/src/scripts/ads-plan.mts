/**
 * Paid search: pick keywords, plan a campaign, and do not launch it.
 *
 * ==================== NOTHING HERE SPENDS AT GOOGLE ====================
 * `plan` and `board` are free and offline. `validate` sends a VALIDATE-ONLY
 * mutation, which Google checks in full and applies nothing.
 *
 * Actually creating a campaign needs FOUR deliberate conditions:
 *   LIVE_CALLS_ENABLED=true, GOOGLE_ADS_MUTATIONS_ENABLED=true, --confirm,
 *   and --apply. There is no single flag that does it.
 * ======================================================================
 *
 *   pnpm tsx --conditions=react-server packages/data/src/scripts/ads-plan.mts <command>
 *
 *   plan <domain> --budget=50 [--conv-bps=300] [--forecast] [--max=500]
 *   board <planId> [--verdict=BUY]
 *   validate <planId> [--arm=treatment]
 *   launch <planId> --arm=treatment --apply --confirm      (blocked without both env gates)
 */
import 'dotenv/config'
import { formatBps, formatMicrosUsd, usdToMicros } from '@rnr/core'
import { db } from '../db.js'
import { findSiteByDomain } from '../spaces/sites.js'
import { buildAdsPlan, listPlanKeywords } from '../ads/plan.js'
import { launchPlan } from '../ads/launch.js'
import { googleAdsMutationsEnabled } from '../providers/google-ads/client.js'

const argv = process.argv.slice(2)
const command = argv[0] ?? 'help'
const positional = argv.slice(1).filter((a) => !a.startsWith('--'))
const flag = (n: string): boolean => argv.includes(`--${n}`)
const opt = (n: string): string | undefined => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`))
  return hit?.slice(n.length + 3)
}
const bullet = (lines: string[]): void => lines.forEach((l) => console.log(`   · ${l}`))

/**
 * Deterministic by default, seeded from the command line rather than the clock.
 *
 * A plan whose allocation and experiment arms cannot be reproduced is a plan
 * nobody can audit when the result is disputed six weeks later.
 */
function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x100000000
  }
}

async function plan(domain: string | undefined): Promise<void> {
  if (!domain) throw new Error('a domain is required, e.g. hotelhottubs.com')
  const site = await findSiteByDomain(db(), domain)
  if (!site) throw new Error(`No site for ${domain}`)

  const budgetUsd = Number(opt('budget') ?? '50')
  const convBps = opt('conv-bps') ? Number(opt('conv-bps')) : null
  const seed = Number(opt('seed') ?? '1')

  const r = await buildAdsPlan(db(), {
    siteId: site.id,
    name: opt('name') ?? `${domain} search ${new Date().toISOString().slice(0, 10)}`,
    dailyBudgetMicros: usdToMicros(budgetUsd),
    achievedConversionBps: convBps,
    maxKeywords: Number(opt('max') ?? '500'),
    forecast: flag('forecast'),
    random: lcg(seed),
    ...(opt('brand') ? { brandTerms: opt('brand')!.split(',') } : {}),
    ...(opt('order-value') || opt('commission-bps')
      ? {
          economicsOverride: {
            ...(opt('order-value') ? { orderValueMicros: usdToMicros(Number(opt('order-value'))) } : {}),
            ...(opt('commission-bps') ? { commissionRateBps: Number(opt('commission-bps')) } : {}),
          },
        }
      : {}),
  })

  console.log(`plan #${r.planId} · daily budget ${formatMicrosUsd(usdToMicros(budgetUsd))} · seed ${seed}`)
  for (const [k, v] of Object.entries(r.byVerdict)) console.log(`   ${k.padEnd(9)} ${v}`)
  console.log(
    `allocated ${r.allocatedKeywords} keyword(s), ${formatMicrosUsd(r.allocatedBudgetMicros)}/day`,
  )
  if (r.forecast) {
    console.log(
      `google forecast: ${r.forecast.clicks ?? '—'} clicks, ` +
        `${r.forecast.costMicros === null ? '—' : formatMicrosUsd(r.forecast.costMicros)} ` +
        `(${r.forecast.source})`,
    )
  }
  if (r.experimentVerdict) console.log(`experiment: ${r.experimentVerdict}`)
  if (r.notes.length) bullet(r.notes)
}

async function board(planId: string | undefined): Promise<void> {
  if (!planId) throw new Error('a plan id is required')
  const rows = await listPlanKeywords(db(), Number(planId), { limit: 40 })
  if (rows.length === 0) return void console.log('no keywords in this plan')

  const dash = (v: unknown): string => (v === null || v === undefined ? '—' : String(v))
  console.log(
    `${'verdict'.padEnd(9)} ${'vol'.padStart(8)} ${'org'.padStart(4)} ${'inc'.padStart(5)} ` +
      `${'need'.padStart(8)} ${'maxcpc'.padStart(9)} ${'arm'.padStart(10)}  keyword`,
  )
  for (const r of rows) {
    console.log(
      `${dash(r.verdict).padEnd(9)} ${dash(r.volume).padStart(8)} ${dash(r.organicPosition).padStart(4)} ` +
        `${(r.incrementalityBps === null ? '—' : `${r.incrementalityBps / 100}%`).padStart(5)} ` +
        `${formatBps(r.requiredConversionBpsHigh).padStart(8)} ` +
        `${(r.maxCpcMicros === null ? '—' : formatMicrosUsd(r.maxCpcMicros, { precision: 2 })).padStart(9)} ` +
        `${dash(r.experimentArm).padStart(10)}  ${r.keyword}`,
    )
  }
  console.log(
    `\n"need" is the conversion rate required to BREAK EVEN at the high end of Google's bid range.\n` +
      `It is not a prediction of profit — see docs/plan-paid-search.md §2.`,
  )
}

const PLACEHOLDER_AD = {
  headlines: [
    'Hotels With Hot Tubs',
    'In-Room Jacuzzi Suites',
    'Compare Hot Tub Hotels',
    'Private In-Room Hot Tubs',
    'Book A Jacuzzi Suite',
  ],
  descriptions: [
    'Find hotels with a private hot tub in the room. Compare rates and book direct.',
    'Handpicked jacuzzi suites, updated weekly. See photos, prices and availability.',
  ],
  finalUrl: '',
}

async function validate(planId: string | undefined): Promise<void> {
  if (!planId) throw new Error('a plan id is required')
  const r = await launchPlan(db(), {
    planId: Number(planId),
    ...(opt('arm') ? { arm: opt('arm') as 'treatment' | 'control' } : {}),
    ads: PLACEHOLDER_AD,
    validateOnly: true,
  })
  console.log(
    `validate-only · ok=${r.ok} · ad groups ${r.campaign.adGroups.length} · ` +
      `keywords ${r.campaign.adGroups.reduce((a, g) => a + g.keywords.length, 0)} · ` +
      `operations ${r.operations.length}`,
  )
  if (r.errors.length) bullet(r.errors)
  if (r.notes.length) bullet(r.notes)
  console.log('\nNothing was created. Google checked the request and applied nothing.')
}

async function launch(planId: string | undefined): Promise<void> {
  if (!planId) throw new Error('a plan id is required')
  if (!flag('apply')) {
    console.log(
      'Refusing: --apply not passed. `launch` without it is a no-op by design — use `validate`.',
    )
    return
  }
  const r = await launchPlan(db(), {
    planId: Number(planId),
    ...(opt('arm') ? { arm: opt('arm') as 'treatment' | 'control' } : {}),
    ads: PLACEHOLDER_AD,
    validateOnly: false,
    confirm: flag('confirm'),
  })
  console.log(`applied=${r.applied} ok=${r.ok}`)
  if (r.errors.length) bullet(r.errors)
  if (r.notes.length) bullet(r.notes)
}

try {
  switch (command) {
    case 'plan':
      await plan(positional[0])
      break
    case 'board':
      await board(positional[0])
      break
    case 'validate':
      await validate(positional[0])
      break
    case 'launch':
      await launch(positional[0])
      break
    default:
      console.log(
        [
          'ads-plan <command>',
          '',
          '  plan     <domain> --budget=50 [--conv-bps=300] [--forecast] [--seed=1]   $0',
          '  board    <planId>                                                        $0',
          '  validate <planId> [--arm=treatment]   Google checks, applies nothing     $0',
          '  launch   <planId> --arm=treatment --apply --confirm                      $$',
          '',
          `  LIVE_CALLS_ENABLED          ${process.env['LIVE_CALLS_ENABLED'] === 'true' ? 'true' : 'not set'}`,
          `  GOOGLE_ADS_MUTATIONS_ENABLED ${googleAdsMutationsEnabled() ? 'true' : 'not set'}  <- a SEPARATE gate`,
          '',
          '  A launch needs BOTH gates plus --apply plus --confirm. Campaigns are',
          '  created PAUSED regardless, so enabling is still a human act in the UI.',
        ].join('\n'),
      )
  }
} finally {
  await db().$client.end()
}
