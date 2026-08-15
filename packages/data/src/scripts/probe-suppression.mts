/**
 * Does the do-not-contact gate hold at the DOMAIN level, not just the address?
 *
 * Someone who asks to be left alone usually speaks for the site, not just the
 * inbox the mail happened to reach. Suppressing only the exact address means
 * the next contact discovered at that domain is fair game — which is precisely
 * what they asked us not to do.
 *
 *   pnpm tsx --conditions=react-server packages/data/src/scripts/probe-suppression.mts
 */
import 'dotenv/config'
import { eq } from 'drizzle-orm'
import { db } from '../db.js'
import { outreachSuppressions } from '../schema.js'
import { checkSuppression, suppress } from '../links/outreach.js'

const DOMAIN = 'probe-suppression-example.com'

await suppress(db(), { domain: DOMAIN, reason: 'probe — asked not to be contacted' })

const known = await checkSuppression(db(), { email: `james@${DOMAIN}`, domain: DOMAIN })
const other = await checkSuppression(db(), { email: `someoneelse@${DOMAIN}`, domain: DOMAIN })
const unrelated = await checkSuppression(db(), {
  email: 'karen@minitravellers.co.uk',
  domain: 'minitravellers.co.uk',
})
const noEmail = await checkSuppression(db(), { email: null, domain: DOMAIN })

console.log(`suppressed domain, known address  : ${known.suppressed}  (${known.reason})`)
console.log(`suppressed domain, OTHER address  : ${other.suppressed}  <- domain-level is the point`)
console.log(`suppressed domain, no address     : ${noEmail.suppressed}`)
console.log(`unrelated site                    : ${unrelated.suppressed}`)

const pass =
  known.suppressed && other.suppressed && noEmail.suppressed && !unrelated.suppressed
console.log(`\n${pass ? 'PASS' : 'FAIL'} — the gate blocks the whole domain and nothing else.`)

// Probe data does not stay in the suppression list.
await db().delete(outreachSuppressions).where(eq(outreachSuppressions.domain, DOMAIN))
await db().$client.end()
