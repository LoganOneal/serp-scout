import {
  ATTIO_WORKSTREAMS,
  printReport,
  type AttioWorkstream,
  type SyncReport,
} from '@rnr/core'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { attioClientFromEnv } from './client.js'
import { processFollowups } from './followups.js'
import { applyEditorsChoicePatches, loadEditorsChoicePatchPlan, restoreEditorsChoiceStatuses } from './ec-patches.js'
import { plannedSetupReport, setupAttioLists } from './setup.js'
import { backfillOutreachFromGmail, loadGmailOutreachFile } from './gmail-backfill.js'
import { listSourceKeys, syncTargets } from './sync.js'
import { loadBacklinkTargets } from './sources/backlinks.js'
import { loadEditorsChoiceTargets } from './sources/editors-choice.js'
import { loadGuestPostTargets } from './sources/guest-posts.js'
import { db } from '../db.js'

export interface CliOptions {
  command: 'setup' | 'sync' | 'followups' | 'outreach' | 'patch'
  apply: boolean
  source: 'editors-choice' | 'backlinks' | 'guest-posts' | 'all'
  file?: string
  restoreStatus?: boolean
  env?: Record<string, string | undefined>
}

export function parseArgv(argv: string[]): CliOptions {
  const command = (argv[0] as CliOptions['command']) ?? 'help'
  if (command !== 'setup' && command !== 'sync' && command !== 'followups' && command !== 'outreach' && command !== 'patch') {
    throw new Error('Usage: attio setup|sync|followups|outreach|patch [--dry-run|--apply] [--source=...] [--file=...] [--restore-status]')
  }
  const apply = argv.includes('--apply')
  const sourceRaw = argv.find((a) => a.startsWith('--source='))?.slice(9) ?? 'all'
  const source = (['editors-choice', 'backlinks', 'guest-posts', 'all'] as const).includes(sourceRaw as 'all')
    ? (sourceRaw as CliOptions['source'])
    : 'all'
  const file = argv.find((a) => a.startsWith('--file='))?.slice(7)
  const restoreStatus = argv.includes('--restore-status')
  if (argv.includes('--dry-run') && argv.includes('--apply')) {
    throw new Error('Pass only one of --dry-run or --apply')
  }
  return { command, apply, source, file, restoreStatus }
}

export async function runAttioCli(opts: CliOptions): Promise<SyncReport[]> {
  const env = opts.env ?? process.env
  const dryRun = !opts.apply
  if (!env.ATTIO_API_KEY) {
    if (opts.apply) throw new Error('ATTIO_API_KEY is missing')
    return sourceOnlyDryRun(opts)
  }
  const client = attioClientFromEnv(env)
  if (opts.command === 'setup') {
    const workstreams = opts.source === 'all' ? undefined : [opts.source]
    const report = await setupAttioLists({ client, dryRun, workstreams })
    console.log(printReport(report))
    return [report]
  }
  if (opts.command === 'followups') {
    const report = await processFollowups({ client, dryRun, env })
    console.log(printReport(report))
    return [report]
  }
  if (opts.command === 'outreach') {
    const file = opts.file ?? resolve(process.cwd(), 'config/attio/gmail-outreach.json')
    const loaded = loadGmailOutreachFile(file)
    const workstreams = opts.source === 'all' ? undefined : [opts.source]
    const report = await backfillOutreachFromGmail({
      client,
      dryRun,
      rows: loaded.rows,
      workstreams,
      env,
    })
    console.log(printReport(report))
    return [report]
  }
  if (opts.command === 'patch') {
    if (opts.restoreStatus) {
      const report = await restoreEditorsChoiceStatuses({ client, dryRun })
      console.log(printReport(report))
      return [report]
    }
    const file = opts.file ?? resolve(process.cwd(), 'config/attio/editors-choice-patches-v3.json')
    const plan = loadEditorsChoicePatchPlan(file)
    const report = await applyEditorsChoicePatches({ client, plan, dryRun })
    console.log(printReport(report))
    return [report]
  }

  const sources: AttioWorkstream[] =
    opts.source === 'all' ? [...ATTIO_WORKSTREAMS] : [opts.source]
  const reports: SyncReport[] = []
  for (const workstream of sources) {
    const loaded = await loadSource(workstream, opts.source !== 'all')
    if (!loaded.targets.length && loaded.skipped.some((row) => row.reason === 'hht_repo_not_configured')) {
      console.log(`skip ${workstream}: Hotel Hot Tubs repo not configured (set HHT_REPO or run that repo's workflow)`)
      continue
    }
    const existing = dryRun ? [] : await listSourceKeys(client, workstream).catch(() => [])
    const incoming = new Set(loaded.targets.map((t) => t.sourceKey))
    const stale = existing.filter((key) => !incoming.has(key))
    const report = await syncTargets({
      client,
      workstream,
      targets: loaded.targets,
      dryRun,
      staleKeys: stale,
    })
    for (const row of loaded.skipped) {
      report.skipped.push({ kind: 'entry', action: 'skip', name: String(row.id), reason: row.reason })
    }
    console.log(printReport(report))
    reports.push(report)
  }
  return reports
}

async function loadSource(workstream: AttioWorkstream, required = true) {
  if (workstream === 'editors-choice') {
    const membership = firstExisting([
      resolve(process.cwd(), 'content/editors-choice.json'),
      resolve(process.env.HHT_REPO ?? '', 'content/editors-choice.json'),
    ])
    const inventory = firstExisting([
      resolve(process.cwd(), 'content/inventory.json'),
      resolve(process.cwd(), 'content/inventory.json.gz'),
      resolve(process.env.HHT_REPO ?? '', 'content/inventory.json'),
      resolve(process.env.HHT_REPO ?? '', 'content/inventory.json.gz'),
    ])
    const press = firstExisting([
      resolve(process.cwd(), 'config/attio/editors-choice-press-contacts.csv'),
      resolve(process.env.HHT_REPO ?? '', 'content/editors-choice-press-contacts.csv'),
    ])
    if (!membership || !inventory) {
      if (required) {
        throw new Error("Editor's Choice sync needs content/editors-choice.json and inventory. Set HHT_REPO if running from serp-scout.")
      }
      return { targets: [], skipped: [{ id: 'editors-choice', reason: 'hht_repo_not_configured' }] }
    }
    return loadEditorsChoiceTargets({ membershipPath: membership, inventoryPath: inventory, pressContactsPath: press })
  }

  const database = db()
  if (workstream === 'backlinks') return loadBacklinkTargets(database)
  const csv = firstExisting([
    resolve(process.cwd(), 'config/attio/guest-post-submission-rules.csv'),
    resolve(process.cwd(), 'guest-post-submission-rules.csv'),
  ])
  return loadGuestPostTargets(database, csv)
}

async function sourceOnlyDryRun(opts: CliOptions): Promise<SyncReport[]> {
  if (opts.command === 'followups' || opts.command === 'outreach' || opts.command === 'patch') {
    throw new Error(`${opts.command} needs ATTIO_API_KEY even in dry-run because it reads Attio lists.`)
  }
  if (opts.command === 'setup') {
    const workstreams = opts.source === 'all' ? undefined : [opts.source]
    const report = plannedSetupReport({ dryRun: true, workstreams })
    console.log(printReport(report))
    return [report]
  }
  const sources: AttioWorkstream[] =
    opts.source === 'all' ? [...ATTIO_WORKSTREAMS] : [opts.source]
  const reports: SyncReport[] = []
  for (const workstream of sources) {
    const loaded = await loadSource(workstream, opts.source !== 'all')
    if (!loaded.targets.length && loaded.skipped.some((row) => row.reason === 'hht_repo_not_configured')) {
      console.log(`skip ${workstream}: Hotel Hot Tubs repo not configured (set HHT_REPO or run that repo's workflow)`)
      continue
    }
    const report = emptyOfflineReport(workstream, loaded.targets.length, loaded.skipped)
    console.log(printReport(report))
    if (loaded.targets.length) {
      console.log(`sample ${workstream}:`)
      for (const target of loaded.targets.slice(0, 8)) {
        console.log(`  ${target.sourceKey}  ${target.domain ?? 'no-domain'}  ${target.companyName}`)
      }
      if (loaded.targets.length > 8) console.log(`  … ${loaded.targets.length - 8} more`)
    }
    reports.push(report)
  }
  return reports
}

function emptyOfflineReport(
  workstream: AttioWorkstream,
  sourceCount: number,
  skipped: Array<{ id: string; reason: string }>,
) {
  const report = {
    dryRun: true,
    workstream,
    lists: [],
    attributes: [],
    companies: loadedCompanies(sourceCount),
    people: [],
    entries: loadedEntries(sourceCount),
    notes: [],
    tasks: [],
    skipped: skipped.map((row) => ({
      kind: 'entry' as const,
      action: 'skip' as const,
      name: String(row.id),
      reason: row.reason,
    })),
    stale: [],
    errors: [],
    counts: {
      source: sourceCount,
      companiesCreate: sourceCount,
      companiesUpdate: 0,
      peopleCreate: 0,
      peopleUpdate: 0,
      entriesCreate: sourceCount,
      entriesUpdate: 0,
      skipped: skipped.length,
      stale: 0,
      errors: 0,
    },
  }
  return report
}

function loadedCompanies(n: number) {
  return Array.from({ length: Math.min(n, 1) }, () => ({
    kind: 'company' as const,
    action: 'create' as const,
    name: `${n} source companies (offline plan; Attio not queried)`,
    reason: 'offline_plan',
  }))
}

function loadedEntries(n: number) {
  return Array.from({ length: Math.min(n, 1) }, () => ({
    kind: 'entry' as const,
    action: 'create' as const,
    name: `${n} source entries (offline plan; Attio not queried)`,
    reason: 'offline_plan',
  }))
}

function firstExisting(paths: string[]): string | undefined {
  return paths.find((p) => p && existsSync(p))
}
