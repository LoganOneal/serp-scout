import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
config({ path: resolve(root, '../.env') })
config({ path: join(root, '.env') })
const cacheDir = join(root, 'cache')
mkdirSync(cacheDir, { recursive: true })
const offline = process.argv.includes('--offline')
let semrushRequests = 0

export async function cachedFetch(label, url, options = {}) {
  const identity = JSON.stringify({ label, url: String(url).replace(/([?&]key=)[^&]+/g, '$1REDACTED'), method: options.method ?? 'GET', body: options.body })
  const key = createHash('sha256').update(identity).digest('hex')
  const path = join(cacheDir, `${key}.json`)
  if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8'))
  if (offline) throw new Error(`Missing cache for ${label}`)
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(45000),
    headers: { 'User-Agent': 'CrakSEO-demand-research/1.0', ...options.headers },
  })
  const record = {
    label, identity: JSON.parse(identity), fetched_at: new Date().toISOString(),
    status: response.status, content_type: response.headers.get('content-type'),
    body: await response.text(),
  }
  writeFileSync(path, JSON.stringify(record, null, 2))
  if (response.status === 429) throw new Error(`Rate limited at ${label}; response cached, no automatic retry`)
  return record
}

export async function semrush(type, params = {}) {
  const key = process.env.SEMRUSH_API_KEY
  if (!key && !offline) throw new Error('SEMRUSH_API_KEY is not configured')
  const url = new URL('https://api.semrush.com/')
  for (const [name, value] of Object.entries({ type, ...params, key: key ?? 'OFFLINE' })) url.searchParams.set(name, String(value))
  const record = await cachedFetch(`semrush:${type}:${JSON.stringify(params)}`, url)
  if (record.status !== 200 || /^ERROR/i.test(record.body.trim())) {
    throw new Error(`Semrush ${type}: HTTP ${record.status}; ${record.body.slice(0, 180).replaceAll(key ?? 'OFFLINE', 'REDACTED')}`)
  }
  return record
}

async function collect() {
  const studyConfig = JSON.parse(readFileSync(join(root, 'scripts/config.json'), 'utf8'))
  const planPath = join(root, 'data/semrush_fetch_plan.json')
  if (!existsSync(planPath)) throw new Error('Run prepare.py before collection')
  if (!offline && !process.argv.includes('--credits-approved')) throw new Error('Explicit --credits-approved required; cash budget remains $0')
  const stage = process.argv.find(argument => argument.startsWith('--stage='))?.split('=')[1] ?? 'keywords'
  const plan = JSON.parse(readFileSync(planPath, 'utf8')).filter(item => item.stage === stage)
  console.log(`Stage ${stage}: ${plan.length} planned report requests, cache-first; no paid fallback`)
  for (const item of plan) {
    semrushRequests++
    if (semrushRequests > studyConfig.max_semrush_requests_per_run) throw new Error('Configured Semrush request cap reached')
    await semrush(item.type, item.params)
    if (semrushRequests % 25 === 0) console.log(`${semrushRequests}/${plan.length} report responses available`)
  }
}

async function main() {
  const command = process.argv[2]
  if (command === 'probe') {
    const record = await semrush('phrase_this', { phrase: 'backlink checker', database: 'us', export_columns: 'Ph,Nq,Cp,Co,Nr,Td', display_limit: 1 })
    console.log(JSON.stringify({ label: record.label, status: record.status, result: record.body }, null, 2))
  } else if (command === 'public') {
    const sources = JSON.parse(readFileSync(join(root, 'scripts/sources.json'), 'utf8'))
    for (const source of sources) {
      try {
        let url = source.url
        for (let page = 1; page <= 15; page++) {
          const label = page === 1 ? source.name : `${source.name}:page:${page}`
          const record = await cachedFetch(label, url)
          console.log(`${label}: HTTP ${record.status}, ${record.body.length} bytes`)
          if (record.status !== 200 || !/^(registry|smithery):/.test(source.name)) break
          const data = JSON.parse(record.body)
          if (source.name.startsWith('registry:') && data.metadata?.nextCursor) {
            const next = new URL(source.url)
            next.searchParams.set('cursor', data.metadata.nextCursor)
            url = next.toString()
          } else if (source.name.startsWith('smithery:') && data.pagination?.currentPage < data.pagination?.totalPages) {
            const next = new URL(source.url)
            next.searchParams.set('page', String(data.pagination.currentPage + 1))
            url = next.toString()
          } else break
          if (page === 15) console.log(`${source.name}: pagination cap reached; coverage incomplete`)
        }
      } catch (error) {
        console.log(`${source.name}: ${error.message}`)
      }
    }
  } else if (command === 'enrich') {
    const sources = JSON.parse(readFileSync(join(root, 'data/fetch_plan.json'), 'utf8'))
    for (const source of sources) {
      const record = await cachedFetch(source.name, source.url)
      console.log(`${source.name}: HTTP ${record.status}, ${record.body.length} bytes`)
      if (record.status === 403 && source.name.startsWith('github:')) {
        console.log('GitHub access/rate limit reached; stopping enrichment without retry')
        break
      }
    }
  } else if (command === 'collect') {
    await collect()
  } else {
    throw new Error('Expected probe, public, enrich or collect; --offline forbids network access')
  }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}