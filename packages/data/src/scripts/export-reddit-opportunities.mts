import 'dotenv/config'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { closeDb, db } from '../db.js'
import {
  listRedditOpportunityExportRows,
  redditOpportunityRowsToCsv,
} from '../serp/reddit-opportunity-export.js'

function argValue(name: string): string | null {
  const exact = process.argv.indexOf(name)
  if (exact >= 0) return process.argv[exact + 1] ?? null
  const prefixed = process.argv.find((arg) => arg.startsWith(`${name}=`))
  return prefixed?.slice(name.length + 1) ?? null
}

const runRaw = argValue('--run')
const allRuns = process.argv.includes('--all')
if ((runRaw === null) === !allRuns) {
  throw new Error(
    'Choose exactly one scope: --run <id> for one run, or --all for every discovery run.',
  )
}

const runId = runRaw === null ? null : Number(runRaw)
if (runId !== null && (!Number.isInteger(runId) || runId <= 0)) {
  throw new Error(`Invalid run id: ${runRaw}`)
}

const outputArg = argValue('--output')
const defaultName =
  runId === null ? 'reddit-opportunities-all-runs.csv' : `reddit-opportunities-run-${runId}.csv`
const outputPath = resolve(outputArg ?? `exports/${defaultName}`)

try {
  /**
   * One exported row per measured SERP that returned Reddit.
   *
   * A SERP may contain several Reddit threads; ROW_NUMBER keeps the highest
   * absolute result, matching the opportunity grid's "best Reddit" logic.
   * Keeping exact query and device beside niche/geography makes duplicate-looking
   * rows auditable on older runs that measured several variants or devices.
   */
  const rows = await listRedditOpportunityExportRows(db(), { runId })
  const csv = redditOpportunityRowsToCsv(rows)

  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, csv, 'utf8')

  console.log(`Exported ${rows.length.toLocaleString()} top Reddit opportunities.`)
  console.log(outputPath)
} finally {
  await closeDb()
}
