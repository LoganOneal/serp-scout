/**
 * Load blog_discovery_seed_queries.csv into hht_opp_guest_keywords.
 * Existing queries are left untouched (case-insensitive match).
 */
import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { sql } from 'drizzle-orm'
import { closeDb, db } from '../db.js'
import { hhtOppDomains, hhtOppGuestEvaluations, hhtOppGuestKeywords } from '../schema.js'

const csvPath = fileURLToPath(new URL('../../../../.agents/skills/hht-blog-discovery/blog_discovery_seed_queries.csv', import.meta.url))
const migrationPath = fileURLToPath(new URL('../../drizzle/0047_hht_opp_blog_discovery.sql', import.meta.url))

function parseCsv(text: string): Array<{ id: string; query: string; bucket: string; priority: number; leadType: string }> {
  const lines = text.split(/\r?\n/).filter((line) => line.trim())
  const rows: Array<{ id: string; query: string; bucket: string; priority: number; leadType: string }> = []
  for (const line of lines.slice(1)) {
    const cells: string[] = []
    let current = ''
    let quoted = false
    for (const char of line) {
      if (char === '"') {
        quoted = !quoted
        continue
      }
      if (char === ',' && !quoted) {
        cells.push(current)
        current = ''
        continue
      }
      current += char
    }
    cells.push(current)
    const [id, query, bucket, priority, leadType] = cells
    if (!query?.trim()) continue
    rows.push({
      id: id ?? '',
      query: query.trim(),
      bucket: bucket?.trim() ?? '',
      priority: Number(priority),
      leadType: leadType?.trim() ?? '',
    })
  }
  return rows
}

async function main(): Promise<void> {
  const database = db()
  const statements = readFileSync(migrationPath, 'utf8')
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean)
  for (const statement of statements) {
    await database.execute(sql.raw(statement))
  }

  const existing = await database.select({
    keyword: hhtOppGuestKeywords.keyword,
    status: hhtOppGuestKeywords.status,
  }).from(hhtOppGuestKeywords)
  const known = new Map(existing.map((row) => [row.keyword.trim().toLowerCase(), row.status]))

  const seeds = parseCsv(readFileSync(csvPath, 'utf8'))
  let added = 0
  let skipped = 0
  for (const seed of seeds) {
    const key = seed.query.toLowerCase()
    if (known.has(key)) {
      skipped += 1
      continue
    }
    await database.insert(hhtOppGuestKeywords).values({
      keyword: seed.query,
      normalizedKeyword: key,
      sourceType: 'blog_discovery_seed',
      status: 'NEW',
      bucket: seed.bucket,
      priority: seed.priority,
      leadType: seed.leadType,
    })
    known.set(key, 'NEW')
    added += 1
  }

  const domains = await database.select({ rootDomain: hhtOppDomains.rootDomain }).from(hhtOppDomains)
  const evaluations = await database.select({
    rootDomain: hhtOppGuestEvaluations.rootDomain,
    verdict: hhtOppGuestEvaluations.verdict,
  }).from(hhtOppGuestEvaluations)

  const priorityOne = seeds.filter((row) => row.priority === 1)
  console.log(JSON.stringify({
    added,
    skipped,
    priorityOne: priorityOne.map((row) => ({
      query: row.query,
      bucket: row.bucket,
      leadType: row.leadType,
      status: known.get(row.query.toLowerCase()) ?? 'missing',
    })),
    storedDomains: domains.length,
    storedEvaluations: evaluations.length,
  }, null, 2))

  const roots = new Set<string>([
    ...domains.map((row) => row.rootDomain),
    ...evaluations.map((row) => row.rootDomain),
  ])
  const out = fileURLToPath(new URL('../../../../.tmp-known-blog-domains.txt', import.meta.url))
  const { writeFileSync } = await import('node:fs')
  writeFileSync(out, [...roots].sort().join('\n'))
  console.log(`Wrote ${roots.size} known domains`)
  await closeDb()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
