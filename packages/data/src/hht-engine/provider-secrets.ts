import type { EngineDatabase } from './db.js'
import type { GoogleServiceAccountCredentials } from './gmail.js'
import { ENGINE_VAULT_SECRETS, readVaultSecret } from './vault.js'

export async function googleAdsEnv(db: EngineDatabase): Promise<NodeJS.ProcessEnv> {
  const values = await Promise.all([
    required(db, ENGINE_VAULT_SECRETS.googleAdsDeveloperToken),
    required(db, ENGINE_VAULT_SECRETS.googleAdsClientId),
    required(db, ENGINE_VAULT_SECRETS.googleAdsClientSecret),
    required(db, ENGINE_VAULT_SECRETS.googleAdsRefreshToken),
    required(db, ENGINE_VAULT_SECRETS.googleAdsCustomerId),
    readVaultSecret(db, ENGINE_VAULT_SECRETS.googleAdsLoginCustomerId),
  ])
  return {
    ...process.env,
    GOOGLE_ADS_DEVELOPER_TOKEN: values[0],
    GOOGLE_ADS_CLIENT_ID: values[1],
    GOOGLE_ADS_CLIENT_SECRET: values[2],
    GOOGLE_ADS_REFRESH_TOKEN: values[3],
    GOOGLE_ADS_CUSTOMER_ID: values[4],
    GOOGLE_ADS_LOGIN_CUSTOMER_ID: values[5] ?? undefined,
  }
}

export async function googleServiceAccountCredentials(
  db: EngineDatabase,
): Promise<GoogleServiceAccountCredentials> {
  const raw = await required(db, ENGINE_VAULT_SECRETS.googleServiceAccountJson)
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>
  } catch {
    throw new Error(`Vault secret ${ENGINE_VAULT_SECRETS.googleServiceAccountJson} is not valid JSON`)
  }
  const clientEmail = stringField(parsed, 'client_email')
  const privateKey = stringField(parsed, 'private_key')
  const clientId = stringField(parsed, 'client_id')
  return {
    clientEmail,
    privateKey,
    clientId,
    tokenUri: typeof parsed['token_uri'] === 'string' ? parsed['token_uri'] : undefined,
  }
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key]
  if (typeof field !== 'string' || !field.trim()) {
    throw new Error(`Google service account JSON is missing ${key}`)
  }
  return field
}

async function required(db: EngineDatabase, name: string): Promise<string> {
  const value = await readVaultSecret(db, name)
  if (!value) throw new Error(`Vault secret ${name} is missing`)
  return value
}
