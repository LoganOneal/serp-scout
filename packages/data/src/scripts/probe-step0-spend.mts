import 'dotenv/config'
import postgres from 'postgres'

/** What the step-0 experiment actually put on the books. */
const s = postgres(process.env['DATABASE_URL']!, { max: 1 })

const rows = await s`
  select endpoint, count(*)::int as n, sum(cost_micros)::bigint as micros
    from spend_ledger
   where note like 'experiment=%'
   group by endpoint
   order by micros desc
`

let total = 0n
for (const r of rows) {
  total += BigInt(r['micros'] as string)
  console.log(
    String(r['endpoint']).padEnd(44) +
      String(r['n']).padStart(4) +
      '  $' +
      (Number(r['micros']) / 1e6).toFixed(4),
  )
}
console.log(`${'TOTAL LEDGERED'.padEnd(44)}      $${(Number(total) / 1e6).toFixed(4)}`)

await s.end()
