/**
 * Link prospecting and guest-post outreach.
 *
 * ==================== NOTHING HERE SENDS EMAIL ====================
 * `draft` produces rows with status 'draft'. There is no send command.
 * Deliverability — warmup, sending-domain separation, throttling, bounce and
 * reply handling — belongs in lemlist, which is already connected.
 * ==================================================================
 *
 *   pnpm tsx --conditions=react-server packages/data/src/scripts/link-outreach.mts <command>
 *
 *   mine     --competitors=a.com,b.com,c.com [--site=hotelhottubs.com] --live
 *            [--limit=200] [--max=500] [--prize=500] [--wall=120] [--ours=20]
 *   board    <runId> [--verdict=PURSUE]
 *   contacts <runId> --live [--limit=25]
 *   draft    <runId> --site=... --from-name="..." --from-email="..."
 *            --address="..." --unsubscribe="..." --topic="..." --live
 *   messages <campaignId>
 *   suppress --email=x@y.com | --domain=y.com --reason="..."
 */
import 'dotenv/config'
import { formatMicrosUsd, usdToMicros, type ProspectVerdict } from '@rnr/core'
import { db } from '../db.js'
import { findSiteByDomain } from '../spaces/sites.js'
import { listProspects, mineProspects } from '../links/mine.js'
import { discoverContacts } from '../links/contacts.js'
import { draftCampaign, listMessages, suppress } from '../links/outreach.js'

const argv = process.argv.slice(2)
const command = argv[0] ?? 'help'
const positional = argv.slice(1).filter((a) => !a.startsWith('--'))
const flag = (n: string): boolean => argv.includes(`--${n}`)
const opt = (n: string): string | undefined =>
  argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3)
const bullet = (lines: string[]): void => lines.forEach((l) => console.log(`   · ${l}`))
const live = flag('live')

async function mine(): Promise<void> {
  const competitors = (opt('competitors') ?? '').split(',').map((c) => c.trim()).filter(Boolean)
  if (competitors.length === 0) throw new Error('--competitors=a.com,b.com,c.com is required')

  const siteDomain = opt('site')
  const site = siteDomain ? await findSiteByDomain(db(), siteDomain) : null

  const prize = opt('prize')
  const wall = opt('wall')
  const ours = opt('ours')

  const r = await mineProspects(db(), {
    competitors,
    ...(site ? { siteId: site.id } : {}),
    live,
    limitPerCompetitor: Number(opt('limit') ?? '200'),
    maxProspects: Number(opt('max') ?? '500'),
    ...(prize && wall && ours
      ? {
          linkValue: {
            prizeMicrosPerMonth: usdToMicros(Number(prize)),
            serpAuthorityWall: Number(wall),
            ourReferringDomains: Number(ours),
            pSuccess: Number(opt('p-success') ?? '0.4'),
            decay: Number(opt('decay') ?? '0.7'),
            horizonMonths: Number(opt('horizon') ?? '12'),
          },
        }
      : {}),
  })

  console.log(
    `run #${r.runId} · referring domains ${r.referringDomainsFound} · excluded ${r.excluded} · ` +
      `dropped to cap ${r.droppedToCap} · cost ${formatMicrosUsd(r.costMicros)}`,
  )
  for (const [k, v] of Object.entries(r.byVerdict)) console.log(`   ${k.padEnd(9)} ${v}`)
  if (r.notes.length) bullet(r.notes)
}

async function board(runId: string | undefined): Promise<void> {
  if (!runId) throw new Error('a run id is required')
  const rows = await listProspects(db(), Number(runId), {
    ...(opt('verdict') ? { verdicts: [opt('verdict') as ProspectVerdict] } : {}),
    limit: 30,
  })
  if (rows.length === 0) return void console.log('no prospects')

  const dash = (v: unknown): string => (v === null || v === undefined ? '—' : String(v))
  console.log(
    `${'verdict'.padEnd(8)} ${'kw'.padStart(8)} ${'etv'.padStart(9)} ${'rank'.padStart(5)} ` +
      `${'spam'.padStart(5)} ${'comp'.padStart(5)} ${'bid'.padStart(9)}  domain`,
  )
  for (const r of rows) {
    console.log(
      `${dash(r.verdict).padEnd(8)} ${dash(r.rankedKeywords).padStart(8)} ` +
        `${(r.organicEtv === null ? '—' : Math.round(r.organicEtv).toLocaleString()).padStart(9)} ` +
        `${dash(r.dfsRank).padStart(5)} ${dash(r.spamScore).padStart(5)} ` +
        `${String(r.competitorLinkCount).padStart(5)} ` +
        `${(r.maxBidMicros === null ? '—' : formatMicrosUsd(r.maxBidMicros, { precision: 2 })).padStart(9)}  ${r.domain}`,
    )
  }
  console.log(
    `\n"comp" = how many of your competitors link there. 1 is plausibly editorial; 4+ is a\n` +
      `marketplace — the easiest sale and the worst footprint. "rank" is DataForSEO rank, NOT Moz DA.`,
  )
}

async function contacts(runId: string | undefined): Promise<void> {
  if (!runId) throw new Error('a run id is required')
  const r = await discoverContacts(db(), Number(runId), {
    live,
    limit: Number(opt('limit') ?? '25'),
  })
  console.log(
    `attempted ${r.attempted} · found ${r.found} · form-only ${r.formOnly} · ` +
      `blocked ${r.blocked} · none ${r.none} · failed ${r.failed}`,
  )
  bullet([r.costNote])
}

async function draft(runId: string | undefined): Promise<void> {
  if (!runId) throw new Error('a run id is required')
  const siteDomain = opt('site')
  if (!siteDomain) throw new Error('--site=hotelhottubs.com is required')
  const site = await findSiteByDomain(db(), siteDomain)
  if (!site) throw new Error(`no site for ${siteDomain}`)

  const r = await draftCampaign(db(), {
    siteId: site.id,
    runId: Number(runId),
    name: opt('name') ?? `${siteDomain} outreach`,
    fromName: opt('from-name') ?? '',
    fromEmail: opt('from-email') ?? '',
    postalAddress: opt('address') ?? '',
    unsubscribeLine: opt('unsubscribe') ?? '',
    proposedTopic: opt('topic') ?? '',
    limit: Number(opt('limit') ?? '25'),
    includePatternAddresses: flag('include-pattern'),
    live,
  })
  console.log(`campaign #${r.campaignId} · drafted ${r.drafted} · blocked ${r.blocked}`)
  if (r.notes.length) bullet(r.notes)
}

async function messages(campaignId: string | undefined): Promise<void> {
  if (!campaignId) throw new Error('a campaign id is required')
  const rows = await listMessages(db(), Number(campaignId))
  if (rows.length === 0) return void console.log('no messages')
  for (const m of rows) {
    console.log(
      `${m.status.padEnd(8)} ${(m.email ?? '—').padEnd(34)} ${m.subject}` +
        (m.blockedReason ? `\n         ! ${m.blockedReason}` : ''),
    )
  }
}

try {
  switch (command) {
    case 'mine':
      await mine()
      break
    case 'board':
      await board(positional[0])
      break
    case 'contacts':
      await contacts(positional[0])
      break
    case 'draft':
      await draft(positional[0])
      break
    case 'messages':
      await messages(positional[0])
      break
    case 'suppress':
      await suppress(db(), {
        ...(opt('email') ? { email: opt('email')! } : {}),
        ...(opt('domain') ? { domain: opt('domain')! } : {}),
        reason: opt('reason') ?? 'manual',
      })
      console.log('suppressed')
      break
    default:
      console.log(
        [
          'link-outreach <command>',
          '',
          '  mine     --competitors=a.com,b.com,c.com [--site=...] --live      $',
          '           [--limit=200] [--max=500] [--prize=500 --wall=120 --ours=20]',
          '  board    <runId> [--verdict=PURSUE]                               $0',
          '  contacts <runId> --live [--limit=25]                              $ (LLM)',
          '  draft    <runId> --site=... --from-name --from-email              $ (LLM)',
          '           --address --unsubscribe --topic --live',
          '  messages <campaignId>                                             $0',
          '  suppress --email=... | --domain=... --reason="..."                $0',
          '',
          '  Nothing here sends email. `draft` writes drafts; sending belongs in lemlist.',
        ].join('\n'),
      )
  }
} finally {
  await db().$client.end()
}
