import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'
import { loadCredential, saveCredential, engineDb } from '../../packages/data/src/hht-engine/jobs.js'
import { closeEngineDatabase } from '../../packages/data/src/hht-engine/db.js'
import { accessTokenExpired } from '../../packages/data/src/hht-engine/credential.js'
import { refreshSemrushCredential, SemrushMcpClient } from '../../packages/data/src/hht-engine/semrush-mcp.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
config()
if (existsSync('.env')) {
  const raw = readFileSync('.env', 'utf8').split(/\r?\n/).find(line => line.startsWith('DATABASE_URL='))?.slice(13).trim()
  if (raw) process.env.DATABASE_URL = raw.replace(/^(["'])(.*)\1$/, '$2')
}
const cache = join(root, 'cache')
mkdirSync(cache, { recursive: true })
let client: SemrushMcpClient | null = null

async function cachedReport(report: string, params: Record<string, unknown>, catalog = false): Promise<unknown> {
  const identity = { provider: 'semrush-oauth', report, params }
  const label = catalog ? `semrush-oauth-catalog:${report}` : `semrush:${report}:${JSON.stringify(params)}`
  const path = join(cache, `${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}.json`)
  if (existsSync(path)) {
    const saved = JSON.parse(readFileSync(path, 'utf8'))
    if (saved.status !== 200) throw new Error(`Semrush cached failure (${saved.error_kind}); no retry performed`)
    return saved.data
  }
  if (process.argv.includes('--offline')) throw new Error('Missing Semrush cache; offline mode forbids requests')
  if (!client) {
    let credential = await loadCredential(engineDb())
    if (!credential) throw new Error('No existing Semrush OAuth session is stored')
    if (accessTokenExpired(credential, Date.now(), 15 * 60_000)) {
      if (!process.argv.includes('--refresh-approved')) throw new Error('Existing Semrush OAuth token is expired or near expiry; no refresh performed')
      try {
        credential = await refreshSemrushCredential(credential)
        await saveCredential(engineDb(), credential)
      } catch {
        throw new Error('Semrush OAuth refresh failed; reconnect the shared session in Cursor')
      }
    }
    client = new SemrushMcpClient(credential, fetch, async next => { await saveCredential(engineDb(), next) })
  }
  try {
    const result = catalog ? await client.listReports(report) : await client.executeReport(report, params)
    const data = catalog ? result : (result as { data: unknown }).data
    const units = catalog ? null : (result as { units: number | null }).units
    writeFileSync(path, JSON.stringify({ label, identity, fetched_at: new Date().toISOString(), status: 200, units, data }, null, 2))
    return data
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    // Semrush can wrap ERROR 132 inside an ERROR 403, which the shared classifier reads as invalid.
    const kind = /ERROR 132|BALANCE IS ZERO|NOT ENOUGH API UNITS/i.test(message)
      ? 'exhausted'
      : error && typeof error === 'object' && 'kind' in error ? String(error.kind) : 'unknown'
    if (kind === 'empty') {
      writeFileSync(path, JSON.stringify({ label, identity, fetched_at: new Date().toISOString(), status: 200, units: null, data: [] }, null, 2))
      return []
    }
    // Not cached, so the same request resumes after Kai fixes credits or login.
    if (kind === 'exhausted' || kind === 'auth' || kind === 'rate_limit') {
      throw new Error(`PAUSED: Semrush ${kind === 'exhausted' ? 'credits exhausted' : kind} (${message.slice(0, 300)}). Resume by rerunning the same command.`)
    }
    writeFileSync(path, JSON.stringify({ label, identity, fetched_at: new Date().toISOString(), status: 'failed', data: null, error_kind: kind, error_message: error instanceof Error ? error.message.slice(0, 600) : '' }, null, 2))
    throw new Error(`Semrush request failed (${kind}): ${error instanceof Error ? error.message.slice(0, 400) : ''}`)
  }
}

async function collect() {
  const config = JSON.parse(readFileSync(join(root, 'scripts/config.json'), 'utf8'))
  const stage = process.argv.find(argument => argument.startsWith('--stage='))?.split('=')[1] ?? 'keywords'
  const limit = Number(process.argv.find(argument => argument.startsWith('--limit='))?.split('=')[1] ?? config.max_semrush_requests_per_run)
  const planPath = process.argv.find(argument => argument.startsWith('--plan='))?.split('=')[1] ?? join(root, 'data/semrush_fetch_plan.json')
  const plan = JSON.parse(readFileSync(planPath, 'utf8'))
    .filter((item: { stage: string }) => item.stage === stage)
    .slice(0, Math.min(limit, config.max_semrush_requests_per_run))
  console.log(`Stage ${stage}: ${plan.length} report requests via Cursor Semrush OAuth, cache-first`)
  let done = 0
  try {
    for (const item of plan as Array<{ type: string; params: Record<string, unknown> }>) {
      await cachedReport(item.type, item.params)
      done++
      if (done % 25 === 0) console.log(`${done}/${plan.length}`)
    }
  } finally {
    console.log(`Completed ${done}/${plan.length}`)
  }
}

async function main() {
  if (process.argv[2] === 'collect') return collect()
  if (process.argv[2] !== 'probe') throw new Error('Expected probe or collect')
  const data = await cachedReport('domain_overview', {}, true)
  console.log(JSON.stringify(data).slice(0, 14000))
}

main().catch(error => {
  const message = error instanceof Error ? error.message : ''
  console.error(/Semrush|offline/.test(message) ? message : 'Credential-store access failed; no secrets printed')
  process.exitCode = 1
}).finally(closeEngineDatabase)