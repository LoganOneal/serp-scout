import 'dotenv/config'
import { db } from '../db.js'
import { niches } from '../schema.js'
const rows = await db().select({ slug: niches.slug, label: niches.label, noun: niches.keywordNoun }).from(niches)
console.log(`${rows.length} niches:\n`)
for (const r of rows.sort((a, b) => a.slug.localeCompare(b.slug)))
  console.log(`  ${r.slug.padEnd(30)} noun="${r.noun}"  label="${r.label}"`)
process.exit(0)
