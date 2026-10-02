import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { config as loadDotenv } from 'dotenv'
import { closeEngineDatabase, executeEngineSql } from '../hht-engine/db.js'
import { engineDb } from '../hht-engine/jobs.js'
import { runBatch } from '../hht-engine/batch.js'
import { ingestLlmAnswers } from '../hht-engine/llm-tasks.js'
import { runGoogleDesktopOAuth, GOOGLE_ADS_SCOPE } from '../hht-engine/oauth.js'
import { runPreflight } from '../hht-engine/preflight.js'
import {
  ENGINE_VAULT_SECRETS,
  readVaultSecret,
  upsertVaultSecret,
} from '../hht-engine/vault.js'

loadDotenv()
for (const key of ['DATABASE_URL'] as const) {
  const raw = rawEnvValue(readFileSync('.env', 'utf8'), key)
  if (raw) process.env[key] = raw
}

const command = process.argv[2]
const db = engineDb()

try {
  if (command === 'migrate') {
    for (const filename of [
      '0037_hht_backlink_engine.sql',
      '0038_hht_backlink_engine_pipeline.sql',
      '0039_hht_engine_gads_pause.sql',
      '0040_hht_engine_notification_vault.sql',
      '0041_hht_guest_post_personalization.sql',
      '0042_hht_lead_review.sql',
    ]) {
      await executeEngineSql(readFileSync(resolve('packages/data/drizzle', filename), 'utf8'))
      console.log(`Applied ${filename}.`)
    }
  } else if (command === 'secrets:load') {
    const mappings = [
      ['GOOGLE_ADS_DEVELOPER_TOKEN', ENGINE_VAULT_SECRETS.googleAdsDeveloperToken],
      ['GOOGLE_ADS_CLIENT_ID', ENGINE_VAULT_SECRETS.googleAdsClientId],
      ['GOOGLE_ADS_CLIENT_SECRET', ENGINE_VAULT_SECRETS.googleAdsClientSecret],
      ['GOOGLE_ADS_REFRESH_TOKEN', ENGINE_VAULT_SECRETS.googleAdsRefreshToken],
      ['GOOGLE_ADS_CUSTOMER_ID', ENGINE_VAULT_SECRETS.googleAdsCustomerId],
      ['GOOGLE_ADS_LOGIN_CUSTOMER_ID', ENGINE_VAULT_SECRETS.googleAdsLoginCustomerId],
      ['GOOGLE_SERVICE_ACCOUNT_JSON', ENGINE_VAULT_SECRETS.googleServiceAccountJson],
    ] as const
    for (const [envName, secretName] of mappings) {
      const value = process.env[envName]?.trim()
      if (!value) {
        if (envName === 'GOOGLE_ADS_LOGIN_CUSTOMER_ID') continue
        throw new Error(`${envName} is missing from .env`)
      }
      const action = await upsertVaultSecret(db, {
        name: secretName,
        secret: value,
        description: `HHT engine ${secretName}`,
      })
      console.log(`${secretName}: ${action}`)
    }
  } else if (command === 'auth:google-ads') {
    const clientId = await requiredSecret(ENGINE_VAULT_SECRETS.googleAdsClientId)
    const clientSecret = await requiredSecret(ENGINE_VAULT_SECRETS.googleAdsClientSecret)
    const token = await runGoogleDesktopOAuth({ clientId, clientSecret, scopes: [GOOGLE_ADS_SCOPE] })
    const action = await upsertVaultSecret(db, {
      name: ENGINE_VAULT_SECRETS.googleAdsRefreshToken,
      secret: token.refreshToken,
      description: 'HHT engine Google Ads OAuth refresh token',
    })
    console.log(`${ENGINE_VAULT_SECRETS.googleAdsRefreshToken}: ${action}`)
  } else if (command === 'sync:semrush') {
    execFileSync(
      process.execPath,
      ['--import', 'tsx', 'packages/data/src/scripts/hht-engine-sync-semrush.mts'],
      { stdio: 'inherit', env: process.env },
    )
  } else if (command === 'sync:install') {
    execFileSync(
      process.execPath,
      ['--import', 'tsx', 'packages/data/src/scripts/hht-engine-install-semrush-sync.mts'],
      { stdio: 'inherit', env: process.env },
    )
  } else if (command === 'run-batch') {
    console.log(JSON.stringify(await runBatch(db), null, 2))
  } else if (command === 'ingest-llm') {
    console.log(JSON.stringify(await ingestLlmAnswers(db), null, 2))
  } else if (command === 'run-all') {
    const first = await runBatch(db)
    console.log(JSON.stringify({ stage: 'first_batch', ...first }, null, 2))
    if (first.pendingLlmTasks > 0) {
      console.log('Answer llm-tasks.json into llm-answers.json, then run `pnpm engine ingest-llm` followed by `pnpm engine run-batch`.')
      process.exitCode = 2
    } else {
      const second = await runBatch(db)
      console.log(JSON.stringify({ stage: 'second_batch', ...second }, null, 2))
    }
  } else if (command === 'preflight') {
    const result = await runPreflight(db)
    for (const item of result.checks) {
      console.log(`${item.status} ${item.name}: ${item.detail}`)
    }
    if (!result.passed) process.exitCode = 1
  } else {
    console.error('Usage: pnpm engine <migrate|secrets:load|auth:google-ads|sync:semrush|sync:install|preflight|run-batch|ingest-llm|run-all>')
    process.exitCode = 1
  }
} finally {
  await closeEngineDatabase()
}

async function requiredSecret(name: string): Promise<string> {
  const value = await readVaultSecret(db, name)
  if (!value) throw new Error(`Vault secret ${name} is missing; run pnpm engine secrets:load`)
  return value
}

function rawEnvValue(source: string, key: string): string | null {
  const line = source.split(/\r?\n/).find((candidate) => candidate.startsWith(`${key}=`))
  if (!line) return null
  const value = line.slice(key.length + 1).trim()
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1)
  }
  return value
}
