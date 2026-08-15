/**
 * Does the FREE half of contact discovery actually reach these sites?
 *
 * Page fetching costs nothing and is the stage most likely to fail silently —
 * Cloudflare, JS-rendered contact pages, and sites with no /contact at all all
 * produce "no pages" for completely different reasons. This separates them
 * before any model tokens are spent on top.
 *
 *   pnpm tsx --conditions=react-server packages/data/src/scripts/probe-contact-fetch.mts [domain ...]
 */
import 'dotenv/config'
import { fetchContactPages } from '../links/contacts.js'

const domains =
  process.argv.slice(2).length > 0
    ? process.argv.slice(2)
    : ['johnnyafrica.com', 'mantripping.com', 'girlwiththepassport.com', 'minitravellers.co.uk']

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi

for (const domain of domains) {
  const r = await fetchContactPages(domain, { maxPages: 2 })
  const emails = [
    ...new Set(r.pages.flatMap((p) => [...p.text.matchAll(EMAIL_RE)].map((m) => m[0].toLowerCase()))),
  ]
  const state = r.pages.length > 0 ? 'ok' : r.blocked ? 'BLOCKED' : 'no pages'
  console.log(
    `${domain.padEnd(26)} ${state.padEnd(8)} pages ${r.pages.length}/${r.tried} tried · ` +
      `addresses visible in text: ${emails.slice(0, 2).join(', ') || '(none)'}`,
  )
  for (const p of r.pages) console.log(`    ${p.url}  (${p.text.length} chars)`)
}

console.log(
  '\nAn address visible here is what the model would extract. "no pages" and "BLOCKED" are both\n' +
    'UNKNOWN — neither means the site publishes no contact.',
)
