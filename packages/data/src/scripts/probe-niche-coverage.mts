/**
 * Does the niche catalog cover the service categories in a Keyword Planner export?
 *
 * Reads a Google Ads "Saved Keywords Stats" CSV (UTF-16, tab separated), matches
 * every keyword against the niche catalog using the SAME matcher the sweep uses,
 * and reports what is not covered — grouped into candidate top-level categories
 * rather than dumped as a flat list of misses.
 *
 *   pnpm exec tsx --conditions=react-server \
 *     packages/data/src/scripts/probe-niche-coverage.mts "<path to csv>"
 */
import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { expandServiceIntentKeywords } from '@rnr/core'
import { db } from '../db.js'
import { niches } from '../schema.js'

const path = process.argv[2]
if (!path) throw new Error('Pass the CSV path')

/** The export is UTF-16LE with a BOM, tab separated, and has two preamble rows. */
function readKeywordRows(file: string): Array<{ keyword: string; volume: number | null }> {
  const raw = readFileSync(file)
  const text =
    raw[0] === 0xff && raw[1] === 0xfe ? raw.toString('utf16le') : raw.toString('utf8')
  const lines = text.split(/\r?\n/)
  const headerIndex = lines.findIndex((l) => l.startsWith('Keyword\t'))
  if (headerIndex === -1) throw new Error('No "Keyword" header row found')

  const cols = lines[headerIndex]!.split('\t')
  const volIndex = cols.findIndex((c) => c.trim().toLowerCase().startsWith('avg. monthly'))

  const out: Array<{ keyword: string; volume: number | null }> = []
  for (const line of lines.slice(headerIndex + 1)) {
    const parts = line.split('\t')
    const keyword = (parts[0] ?? '').trim()
    // Totals rows carry no keyword.
    if (!keyword) continue
    const rawVol = (parts[volIndex] ?? '').trim()
    const volume = rawVol ? Number(rawVol) : null
    out.push({ keyword, volume: Number.isFinite(volume) ? volume : null })
  }
  return out
}

const rows = readKeywordRows(path)
console.log(`${rows.length} keyword(s) in the export\n`)

const catalog = await db()
  .select({
    id: niches.id,
    slug: niches.slug,
    label: niches.label,
    keywordNoun: niches.keywordNoun,
    keywordAliases: niches.keywordAliases,
  })
  .from(niches)
console.log(`${catalog.length} niche(s) in the catalog\n`)

/** Same rules the sweep uses, so this reports real coverage rather than a guess. */
function matchNiche(keyword: string): (typeof catalog)[number] | null {
  const k = keyword.trim().toLowerCase()
  if (!k) return null
  const exact = catalog.find((n) => n.keywordNoun.trim().toLowerCase() === k)
  if (exact) return exact
  for (const n of catalog) {
    const cluster = expandServiceIntentKeywords({
      slug: n.slug,
      label: n.slug,
      keywordNoun: n.keywordNoun,
    })
    if (cluster.some((c) => c.toLowerCase() === k)) return n
  }
  let best: (typeof catalog)[number] | null = null
  let bestLen = 0
  for (const n of catalog) {
    for (const raw of [n.keywordNoun, ...(n.keywordAliases ?? [])]) {
      const term = raw.trim().toLowerCase()
      if (!term) continue
      if ((k.includes(term) || term.includes(k)) && term.length > bestLen) {
        best = n
        bestLen = term.length
      }
    }
  }
  return best
}

const matched = new Map<string, { volume: number; count: number }>()
const missed: Array<{ keyword: string; volume: number | null }> = []

for (const r of rows) {
  const n = matchNiche(r.keyword)
  if (n) {
    const cur = matched.get(n.slug) ?? { volume: 0, count: 0 }
    cur.volume += r.volume ?? 0
    cur.count += 1
    matched.set(n.slug, cur)
  } else {
    missed.push(r)
  }
}

const missedVolume = missed.reduce((a, b) => a + (b.volume ?? 0), 0)
const totalVolume = rows.reduce((a, b) => a + (b.volume ?? 0), 0)

console.log('==================== COVERAGE ====================')
console.log(`matched : ${rows.length - missed.length}/${rows.length} keywords`)
console.log(
  `by volume: ${(((totalVolume - missedVolume) / totalVolume) * 100).toFixed(1)}% covered ` +
    `(${missedVolume.toLocaleString()} searches/mo uncovered)\n`,
)

console.log(`${catalog.length - matched.size} catalog niche(s) matched NOTHING in this export:`)
for (const n of catalog.filter((x) => !matched.has(x.slug))) {
  console.log(`   ${n.slug.padEnd(34)} (${n.keywordNoun})`)
}

/**
 * Group the misses by their head noun so the output names candidate NICHES
 * rather than listing 400 unmatched phrases.
 */
const STOP = new Set([
  'near','me','in','the','a','for','of','and','best','top','cost','cheap','local','service',
  'services','company','companies','contractor','contractors','repair','installation','install',
  'replacement','my','your','how','much','to','is','what','emergency','24','7','hour','same','day',
])
const heads = new Map<string, { volume: number; examples: string[] }>()
for (const m of missed) {
  const tokens = m.keyword.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t && !STOP.has(t))
  const head = tokens.slice(0, 2).join(' ') || m.keyword.toLowerCase()
  const cur = heads.get(head) ?? { volume: 0, examples: [] }
  cur.volume += m.volume ?? 0
  if (cur.examples.length < 3) cur.examples.push(m.keyword)
  heads.set(head, cur)
}

console.log(`\n==================== UNCOVERED, by volume ====================`)
const ranked = [...heads.entries()].sort((a, b) => b[1].volume - a[1].volume)
for (const [head, v] of ranked.slice(0, 40)) {
  console.log(
    `${String(Math.round(v.volume)).padStart(9).padEnd(10)} ${head.padEnd(30)} e.g. ${v.examples.slice(0, 2).join(' / ')}`,
  )
}
console.log(`\n(${ranked.length} distinct uncovered head terms in total)`)
process.exit(0)
