/**
 * Attio outreach CRM
 *
 *   pnpm attio:setup --dry-run
 *   pnpm attio:setup --apply
 *   pnpm attio:sync --source=backlinks --dry-run
 *   pnpm attio:sync --source=all --apply
 *   pnpm attio:followups --dry-run
 *   pnpm attio:followups --apply
 *   pnpm attio:patch --apply
 *
 * Outbound email is never sent. ATTIO_SEND_ENABLED must stay unset.
 */
import 'dotenv/config'
import { parseArgv, runAttioCli } from '../attio/cli.js'
import { closeDb } from '../db.js'

async function main() {
  const argv = process.argv.slice(2)
  if (argv[0] === 'help' || argv.length === 0) {
    console.log(`Usage:
  pnpm attio:setup --dry-run | --apply
  pnpm attio:sync --source=editors-choice|backlinks|guest-posts|all --dry-run | --apply
  pnpm attio:followups --dry-run | --apply
  pnpm attio:outreach --dry-run | --apply [--file=config/attio/gmail-outreach.json]
  pnpm attio:patch --dry-run | --apply [--file=config/attio/editors-choice-patches-v3.json]`)
    return
  }
  const command = argv[0] === 'setup' || argv[0] === 'sync' || argv[0] === 'followups' || argv[0] === 'outreach' || argv[0] === 'patch' ? argv[0] : inferCommand()
  const rest = argv[0] === command ? argv.slice(1) : argv
  await runAttioCli(parseArgv([command, ...rest]))
}

function inferCommand(): 'setup' | 'sync' | 'followups' | 'outreach' | 'patch' {
  const name = process.argv[1] ?? ''
  if (name.includes('followup')) return 'followups'
  if (name.includes('outreach')) return 'outreach'
  if (name.includes('patch')) return 'patch'
  if (name.includes('setup')) return 'setup'
  return 'sync'
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
  .finally(() => closeDb())
