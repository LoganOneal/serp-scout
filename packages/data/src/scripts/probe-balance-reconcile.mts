/**
 * Does the ledger match the account? The ledger only records spend that goes
 * through the app. Probe scripts calling DataForSEO directly do not write to
 * it, so a gap is expected -- the point is to size it, not assume it.
 */
import 'dotenv/config'
import postgres from 'postgres'
const auth = 'Basic ' + Buffer.from(`${process.env['DATAFORSEO_LOGIN']}:${process.env['DATAFORSEO_PASSWORD']}`).toString('base64')
const r = await (await fetch('https://api.dataforseo.com/v3/appendix/user_data', { headers: { Authorization: auth } })).json()
const money = r.tasks?.[0]?.result?.[0]?.money
console.log('DataForSEO account:')
console.log(`  balance      $${money?.balance?.toFixed(4)}`)
console.log(`  total spent  $${money?.total?.toFixed(4)}`)
console.log(`  today        $${money?.statistic?.today?.toFixed?.(4) ?? JSON.stringify(money?.statistic?.today)}`)

const sql = postgres(process.env['DIRECT_DATABASE_URL']?.trim() || process.env['DATABASE_URL']!, { max: 1, prepare: false })
const [l] = await sql<Array<any>>`
  SELECT sum(cost_micros)::text total FROM spend_ledger WHERE created_at > now() - interval '24 hours'`
console.log(`\nledger, last 24h: $${(Number(l.total)/1e6).toFixed(4)}`)
console.log('\nSpend that BYPASSES the ledger by design: every probe-*.mts script,')
console.log('which calls DataForSEO directly rather than through the run pipeline.')
await sql.end()
