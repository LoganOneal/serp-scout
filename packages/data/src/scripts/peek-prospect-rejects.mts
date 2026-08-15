/** Why a prospecting run rejected what it rejected. Free. */
import 'dotenv/config'
import { and, eq } from 'drizzle-orm'
import { db } from '../db.js'
import { linkProspects } from '../schema.js'

const runId = Number(process.argv[2])

const rows = await db()
  .select({
    domain: linkProspects.domain,
    reason: linkProspects.verdictReason,
    ranked: linkProspects.rankedKeywords,
    etv: linkProspects.organicEtv,
    spam: linkProspects.spamScore,
  })
  .from(linkProspects)
  .where(and(eq(linkProspects.runId, runId), eq(linkProspects.verdict, 'REJECT')))

const buckets = new Map<string, number>()
for (const r of rows) {
  const key = /below the/.test(r.reason ?? '')
    ? 'no traffic (below the ranked-keyword floor)'
    : /Spam score/.test(r.reason ?? '')
      ? 'spam ceiling'
      : /already have a link/.test(r.reason ?? '')
        ? 'already linked'
        : 'other'
  buckets.set(key, (buckets.get(key) ?? 0) + 1)
}

console.log(`${rows.length} rejected\n`)
for (const [k, n] of [...buckets].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  ${k}`)
}

console.log('\nA sample of what the traffic gate caught:')
for (const r of rows.filter((x) => (x.ranked ?? 0) < 50).slice(0, 8)) {
  console.log(`  ${r.domain.padEnd(38)} ranked ${String(r.ranked ?? '—').padStart(6)} · etv ${String(r.etv === null ? '—' : Math.round(r.etv)).padStart(8)}`)
}

await db().$client.end()
