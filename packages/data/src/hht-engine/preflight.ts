import { readFile } from 'node:fs/promises'
import { sql } from 'drizzle-orm'
import { acquireRunLock, releaseRunLock } from './batch.js'
import { loadEngineConfig, validateEngineConfig } from './config.js'
import type { EngineDatabase } from './db.js'
import { localEmbedding } from './embeddings.js'
import { generateIdeas } from './gads-client.js'
import { GMAIL_NOTIFICATION_ADDRESS, sendGmailNotification } from './gmail.js'
import { loadCredential } from './jobs.js'
import { googleAdsEnv, googleServiceAccountCredentials } from './provider-secrets.js'
import { SemrushMcpClient } from './semrush-mcp.js'
import { ENGINE_VAULT_SECRETS, vaultSecretNames } from './vault.js'

export interface PreflightCheck {
  name: string
  status: 'PASS' | 'FAIL' | 'WARN'
  detail: string
}

export interface PreflightResult {
  passed: boolean
  checks: PreflightCheck[]
}

const EXPECTED_TABLES = [
  'contacts', 'contact_domains', 'crm_events', 'crm_outbox', 'domains', 'drafts',
  'embeddings', 'frontier_log', 'google_ads_usage', 'hht_pages', 'jobs', 'keyword_relationships',
  'keywords', 'lead_review_events', 'lead_reviews', 'llm_tasks', 'notifications', 'opportunities', 'opportunity_pages',
  'page_rankings', 'publisher_pages', 'publisher_research', 'responses', 'run_locks',
  'runs', 'semrush_usage', 'serp_results', 'serp_scans', 'system_state',
]

const EXPECTED_SECRETS = Object.values(ENGINE_VAULT_SECRETS)

const TEMPLATE_PATHS = [
  'config/hht-engine/templates/guest_post.email',
  'config/hht-engine/templates/link_insertion.email',
  'config/hht-engine/templates/guest_post.contact_form',
  'config/hht-engine/templates/link_insertion.contact_form',
]

export async function runPreflight(db: EngineDatabase): Promise<PreflightResult> {
  const checks: PreflightCheck[] = []
  await check(checks, 'Supabase schema, extensions, and RLS', async () => {
    const extensions = await db.execute<{ extname: string }>(sql`
      SELECT extname FROM pg_extension WHERE extname IN ('vector', 'supabase_vault')
    `)
    const extensionNames = new Set((extensions as unknown as Array<{ extname: string }>).map((row) => row.extname))
    const tables = await db.execute<{ tablename: string; rls: boolean }>(sql`
      SELECT c.relname AS tablename, c.relrowsecurity AS rls
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'hht_engine' AND c.relkind = 'r'
    `)
    const rows = tables as unknown as Array<{ tablename: string; rls: boolean }>
    const policies = await db.execute<{ count: number }>(sql`
      SELECT count(*)::integer AS count FROM pg_policies WHERE schemaname = 'hht_engine'
    `)
    const policyCount = Number((policies as unknown as Array<{ count: number }>)[0]?.count ?? 0)
    const publicTables = await db.execute<{ tablename: string }>(sql`
      SELECT tablename
        FROM pg_tables
       WHERE schemaname = 'public'
         AND tablename LIKE 'hht_engine%'
    `)
    const publicEngineTables = (publicTables as unknown as Array<{ tablename: string }>).map((row) => row.tablename)
    const personalizationColumns = await db.execute<{ table_name: string; column_name: string }>(sql`
      SELECT table_name, column_name
        FROM information_schema.columns
       WHERE table_schema = 'hht_engine'
         AND (
           (table_name = 'domains' AND column_name IN ('submission_method', 'guideline_evidence'))
           OR
           (table_name = 'opportunities' AND column_name IN ('guest_post_pitch_topics', 'guest_post_fit_line'))
           OR
           (table_name = 'crm_outbox' AND column_name IN ('status', 'approved_review_id', 'content_hash', 'queued_at'))
         )
    `)
    const personalizationColumnNames = new Set(
      (personalizationColumns as unknown as Array<{ table_name: string; column_name: string }>)
        .map((row) => `${row.table_name}.${row.column_name}`),
    )
    const missingPersonalizationColumns = [
      'domains.submission_method',
      'domains.guideline_evidence',
      'opportunities.guest_post_pitch_topics',
      'opportunities.guest_post_fit_line',
      'crm_outbox.status',
      'crm_outbox.approved_review_id',
      'crm_outbox.content_hash',
      'crm_outbox.queued_at',
    ].filter((column) => !personalizationColumnNames.has(column))
    const present = new Set(rows.map((row) => row.tablename))
    const missing = EXPECTED_TABLES.filter((table) => !present.has(table))
    const noRls = rows.filter((row) => !row.rls).map((row) => row.tablename)
    if (!extensionNames.has('vector') || !extensionNames.has('supabase_vault') || missing.length || noRls.length || policyCount > 0 || publicEngineTables.length || missingPersonalizationColumns.length) {
      throw new Error(`extensions=${[...extensionNames].join(',')}; missing_tables=${missing.join(',') || 'none'}; missing_personalization_columns=${missingPersonalizationColumns.join(',') || 'none'}; rls_disabled=${noRls.join(',') || 'none'}; policies=${policyCount}; public_engine_tables=${publicEngineTables.join(',') || 'none'}`)
    }
    return `${rows.length} engine tables; vector and supabase_vault enabled; RLS enabled with no policies`
  })
  await check(checks, 'Run lock acquire and release', async () => {
    const owner = `preflight:${Date.now()}`
    if (!await acquireRunLock(db, owner)) throw new Error('run lock is held')
    await releaseRunLock(db, owner)
    return 'acquired and released'
  })
  await check(checks, 'Vault secret names', async () => {
    const names = await vaultSecretNames(db)
    const missing = EXPECTED_SECRETS.filter((name) => !names.includes(name))
    if (missing.length) throw new Error(`missing: ${missing.join(', ')}`)
    return EXPECTED_SECRETS.join(', ')
  })
  await check(checks, 'Semrush MCP OAuth authentication', async () => {
    const credential = await loadCredential(db)
    if (!credential) throw new Error('semrush_oauth_token is missing')
    const client = new SemrushMcpClient(credential)
    await client.listReports('domain_overview')
    return 'OAuth valid through https://mcp.semrush.com/v2/mcp; no paid report called'
  })
  checks.push({
    name: 'Semrush remaining-unit balance',
    status: 'FAIL',
    detail: 'The OAuth MCP session exposes no free remaining-balance call. Semrush documents the free balance endpoint for API keys only.',
  })
  await check(checks, 'Google Ads production GenerateKeywordIdeas', async () => {
    const config = loadEngineConfig()
    const ideas = await generateIdeas({
      seedType: 'keyword',
      seed: 'hotels with hot tubs',
      geoTargetId: config.googleAdsGeoTargetId,
      languageId: config.googleAdsLanguageId,
      env: await googleAdsEnv(db),
    })
    if (ideas.length === 0) throw new Error('production customer returned no keyword ideas')
    return `${ideas.length} real ideas returned in one call`
  })
  checks.push({
    name: 'Google OAuth consent status',
    status: 'WARN',
    detail: 'Confirm the OAuth consent screen is Internal or In production; Testing refresh tokens can expire after 7 days.',
  })
  await check(checks, 'Gmail test email', async () => {
    const id = await sendGmailNotification({
      credentials: await googleServiceAccountCredentials(db),
      subject: 'HHT backlink engine preflight',
      text: `Preflight succeeded at ${new Date().toISOString()}.`,
    })
    return `sent from and to ${GMAIL_NOTIFICATION_ADDRESS}; message ${id}`
  })
  await check(checks, 'Local embedding model', async () => {
    const vector = await localEmbedding('hotels with jacuzzi in room chicago')
    if (vector.length !== 384 || vector.some((value) => !Number.isFinite(value))) throw new Error('invalid vector')
    return `${vector.length}-dimension local ONNX vector produced`
  })
  await check(checks, 'Scraper fetches', async () => {
    const urls = [
      'https://www.hotelhottubs.com/sitemap.xml',
      'https://www.nomadicmatt.com/',
    ]
    for (const url of urls) {
      const response = await fetch(url, { signal: AbortSignal.timeout(15_000), redirect: 'follow' })
      if (!response.ok) throw new Error(`${url} returned ${response.status}`)
      const body = await response.text()
      if (body.length < 100) throw new Error(`${url} returned an unexpectedly short body`)
    }
    return 'HHT sitemap and known publisher page fetched'
  })
  await check(checks, 'Outreach templates', async () => {
    for (const path of TEMPLATE_PATHS) {
      const template = await readFile(path, 'utf8')
      if (/\[\[\s*PLACEHOLDER/i.test(template)) throw new Error(`${path} still contains placeholder markers`)
      if (path.endsWith('.contact_form')) {
        const body = template.split('\n').filter((line) => !line.startsWith('#')).join('\n').trim()
        if (/^subject:/im.test(body)) throw new Error(`${path} must not contain a subject`)
        if (body.length > 1_000) throw new Error(`${path} exceeds 1,000 characters`)
      }
    }
    return TEMPLATE_PATHS.join(', ')
  })
  await check(checks, 'engine.yml validation', async () => {
    const errors = validateEngineConfig(loadEngineConfig())
    if (errors.length) throw new Error(errors.join('; '))
    return 'valid'
  })
  return { passed: checks.every((item) => item.status !== 'FAIL'), checks }
}

function check(
  checks: PreflightCheck[],
  name: string,
  run: () => Promise<string>,
): Promise<void> {
  return run().then(
    (detail) => {
      checks.push({ name, status: 'PASS', detail })
    },
    (error: unknown) => {
      checks.push({
        name,
        status: 'FAIL',
        detail: error instanceof Error ? error.message : String(error),
      })
    },
  )
}
