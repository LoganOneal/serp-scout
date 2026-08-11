import 'dotenv/config'
import { db } from '../db.js'
import { collectFromStoredSerps } from '../domains/collect-from-serps.js'
const locationCode = Number(process.argv[2] ?? 1023191)
const r = await collectFromStoredSerps(db(), { locationCode })
const organic = r.filter((x) => x.sources.includes('organic'))
const ranked = r.filter((x) => x.serpRank != null)
console.log(`location ${locationCode}: ${r.length} domain(s) harvested for $0.00`)
console.log(`  ${organic.length} seen in organic · ${ranked.length} with a rank\n`)
for (const x of r.slice(0, 12))
  console.log(`  #${String(x.serpRank ?? '—').padStart(3)}  ${x.name.padEnd(38)} [${x.sources.join('+')}]  ${x.seenKeyword ?? ''}`)
process.exit(0)
