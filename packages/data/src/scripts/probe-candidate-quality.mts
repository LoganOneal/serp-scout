/**
 * Are the candidates actually GOOD domains, or just old ones?
 *
 * The triage answers "is it dead". It never asks whether the link profile is
 * an asset or a liability. Spam score and rank are already returned by the bulk
 * endpoints we call -- we have simply not been reading them.
 */
import 'dotenv/config'
import { createDfsClientFromEnv } from '../providers/dataforseo/keyword-volume.js'
import { fetchBulkBacklinks } from '../providers/dataforseo/backlinks.js'

const client = createDfsClientFromEnv()!
const targets = [
  'fredsmithplumbing.com',
  'hays-nyc.com',
  'macfelderplumbing.com',
  'matthewjplumb.com',
  'impplumbing.com',
  'emeraldmechanicalsolutions.com',
  'nationwideplumbers.com',
  'caracozzaplumbing.com',
  'plumber-ny.com',
  'aaatotal.com',
]
const r = await fetchBulkBacklinks(client, targets)
console.log('domain                            rank  refDom  mainDom  spam   verdict')
console.log('-'.repeat(84))
for (const t of targets) {
  const a = r.authorities.get(t)
  if (!a) { console.log(`${t.padEnd(32)} (no data)`); continue }
  const spam = a.spamScore
  const verdict =
    spam != null && spam >= 30 ? 'LIABILITY — high spam'
    : (a.referringMainDomains ?? 0) < 10 ? 'thin profile'
    : spam != null && spam >= 15 ? 'mixed'
    : 'clean-ish'
  console.log(
    `${t.padEnd(32)} ${String(a.rank ?? '—').padStart(4)} ${String(a.referringDomains ?? '—').padStart(7)} ` +
      `${String(a.referringMainDomains ?? '—').padStart(8)} ${String(spam ?? '—').padStart(5)}   ${verdict}`,
  )
}
