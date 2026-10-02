import { sql } from 'drizzle-orm'
import type { EngineDatabase } from './db.js'

export const SEMRUSH_OAUTH_SECRET = 'semrush_oauth_token'
export const ENGINE_VAULT_SECRETS = {
  googleAdsDeveloperToken: 'google_ads_developer_token',
  googleAdsClientId: 'google_ads_client_id',
  googleAdsClientSecret: 'google_ads_client_secret',
  googleAdsRefreshToken: 'google_ads_refresh_token',
  googleAdsCustomerId: 'google_ads_customer_id',
  googleAdsLoginCustomerId: 'google_ads_login_customer_id',
  googleServiceAccountJson: 'google_service_account_json',
  semrushOauthToken: SEMRUSH_OAUTH_SECRET,
} as const

export async function readVaultSecret(
  db: EngineDatabase,
  name: string,
): Promise<string | null> {
  const rows = await db.execute<{ decrypted_secret: string }>(sql`
    SELECT decrypted_secret
      FROM vault.decrypted_secrets
     WHERE name = ${name}
     ORDER BY updated_at DESC
     LIMIT 1
  `)
  return (rows as unknown as Array<{ decrypted_secret: string }>)[0]?.decrypted_secret ?? null
}

export async function upsertVaultSecret(
  db: EngineDatabase,
  input: { name: string; secret: string; description: string },
): Promise<'created' | 'updated'> {
  const rows = await db.execute<{ id: string }>(sql`
    SELECT id::text
      FROM vault.decrypted_secrets
     WHERE name = ${input.name}
     ORDER BY updated_at DESC
     LIMIT 1
  `)
  const id = (rows as unknown as Array<{ id: string }>)[0]?.id
  if (id) {
    await db.execute(sql`
      SELECT vault.update_secret(
        ${id}::uuid,
        ${input.secret},
        ${input.name},
        ${input.description}
      )
    `)
    return 'updated'
  }
  await db.execute(sql`
    SELECT vault.create_secret(
      ${input.secret},
      ${input.name},
      ${input.description}
    )
  `)
  return 'created'
}

export async function vaultSecretNames(db: EngineDatabase): Promise<string[]> {
  const rows = await db.execute<{ name: string }>(sql`
    SELECT name
      FROM vault.decrypted_secrets
     WHERE name IS NOT NULL
     ORDER BY name
  `)
  return (rows as unknown as Array<{ name: string }>).map((row) => row.name)
}
