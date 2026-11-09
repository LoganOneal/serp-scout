/**
 * Lookalike expansion for guest-post discovery (docs/plan-guest-post-scale.md §3.2).
 *
 *   pnpm hht:lookalike preview [--seeds 10]
 *       PURSUE seeds in the tracker, which are done, the next ones, and the Semrush unit estimate. No network.
 *   pnpm hht:lookalike --seeds 3 --limit 100 [--dry-run] [--no-semrush] [--signals=author_bio,blogroll]
 *                      [--competitors 15] [--concurrency 3] [--only=a.com,b.com] [--semrush=mcp|api]
 *       Run the next N seeds (stop starting seeds once --limit new candidates are found), write candidates
 *       into the export-leads flow, and print the command that exports them.
 *       --dry-run runs everything (including Semrush, which is billed) but rolls the DB writes back.
 *       --semrush=mcp (default) uses the HHT engine's Semrush MCP login and usage ledger;
 *       --semrush=api uses SEMRUSH_API_KEY and measures units from the key's balance.
 *       --organic-from=file.json reads {"<seed>": {"data": <execute_report data>, "units": N}} pulled with
 *       the Semrush MCP tool instead of calling Semrush (for when the engine login is expired).
 *   pnpm hht:lookalike report
 *       Pitchable per exported domain, lookalike vs SERP vs legacy.
 *
 * Pilot (not run yet; 1,800 units/seed at 15 competitor rows (measured) → ~90k units; --competitors 10 → ~60k):
 *   python3 .agents/skills/guest-post-pitches/scripts/run_tools.py exclusions
 *   pnpm hht:lookalike --seeds 50 --limit 2000
 *   pnpm hht:opp export-leads --keyword-ids=<printed ids> --link-limit=0
 */
import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { LOOKALIKE_SIGNALS, type LookalikeSignal } from '@rnr/core'
import { closeDb, db } from '../db.js'
import { lookalikeYieldReport, previewGuestLookalike, runGuestLookalike } from '../hht-opp/guest-lookalike.js'

const argv = process.argv.slice(2)
const command = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'run'
const flag = (name: string): boolean => argv.includes(`--${name}`)
function opt(name: string): string | undefined {
  const eq = argv.find((arg) => arg.startsWith(`--${name}=`))
  if (eq) return eq.slice(name.length + 3)
  const index = argv.indexOf(`--${name}`)
  const next = index >= 0 ? argv[index + 1] : undefined
  return next && !next.startsWith('--') ? next : undefined
}
const int = (name: string): number | undefined => {
  const raw = opt(name)
  if (raw == null) return undefined
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) throw new Error(`--${name} must be a non-negative integer`)
  return value
}

async function main(): Promise<void> {
  const database = db()
  switch (command) {
    case 'preview': {
      console.log(JSON.stringify(await previewGuestLookalike(database, { seeds: int('seeds'), competitorRows: int('competitors') }), null, 2))
      break
    }
    case 'run': {
      let signals: LookalikeSignal[] = opt('signals')
        ? opt('signals')!.split(',').map((s) => s.trim()).filter((s): s is LookalikeSignal => (LOOKALIKE_SIGNALS as readonly string[]).includes(s))
        : [...LOOKALIKE_SIGNALS]
      if (flag('no-semrush')) signals = signals.filter((signal) => signal !== 'organic_competitor')
      if (signals.length === 0) throw new Error(`--signals must name at least one of ${LOOKALIKE_SIGNALS.join(', ')}`)
      const result = await runGuestLookalike(database, {
        seeds: int('seeds') ?? 3,
        limit: int('limit') ?? null,
        signals,
        competitorRows: int('competitors'),
        concurrency: int('concurrency'),
        semrushBackend: opt('semrush') === 'api' ? 'api' : 'mcp',
        organicHarvest: opt('organic-from') ? JSON.parse(readFileSync(opt('organic-from')!, 'utf8')) : undefined,
        only: opt('only')?.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
        dryRun: flag('dry-run'),
      })
      console.log(JSON.stringify(result, null, 2))
      console.error(`Semrush units used: ${result.semrush.units}`)
      break
    }
    case 'report': {
      console.log(JSON.stringify(await lookalikeYieldReport(database), null, 2))
      break
    }
    default:
      console.log('Usage: pnpm hht:lookalike preview | --seeds N --limit M [--dry-run] [--no-semrush] | report')
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
  .finally(() => closeDb())
