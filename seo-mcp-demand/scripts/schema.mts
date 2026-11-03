// One-off: print a Semrush MCP report schema via the stored OAuth session.
import { config } from 'dotenv'
import { readFileSync } from 'node:fs'
import { loadCredential, saveCredential, engineDb } from '../../packages/data/src/hht-engine/jobs.js'
import { closeEngineDatabase } from '../../packages/data/src/hht-engine/db.js'
import { SemrushMcpClient } from '../../packages/data/src/hht-engine/semrush-mcp.js'

config()
const raw = readFileSync('.env', 'utf8').split(/\r?\n/).find(line => line.startsWith('DATABASE_URL='))?.slice(13).trim()
if (raw) process.env.DATABASE_URL = raw.replace(/^(["'])(.*)\1$/, '$2')

const credential = await loadCredential(engineDb())
if (!credential) throw new Error('No Semrush session')
const client = new SemrushMcpClient(credential, fetch, next => saveCredential(engineDb(), next))
await client.ensureFresh()
const internal = client as unknown as { initialize(): Promise<void>; rpc(body: unknown): Promise<{ result?: { content?: Array<{ text?: string }> } } | null> }
await internal.initialize()
for (const report of process.argv.slice(2)) {
  const message = await internal.rpc({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name: 'get_report_schema', arguments: { report } } })
  console.log(report, (message?.result?.content?.[0]?.text ?? '').replace(/"enum":\[[^\]]*\]/g, "\"enum\":[...]").slice(0, 2500))
}
await closeEngineDatabase()
