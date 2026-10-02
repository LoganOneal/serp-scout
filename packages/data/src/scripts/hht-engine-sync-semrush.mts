/**
 * Copy the Cursor Semrush MCP login to the engine.
 *
 * The connector token is encrypted in Cursor's local database. This Mac is the
 * only place that can read it. Run this while logged in, after the one-time
 * keychain Allow for "Cursor Safe Storage". The helper writes the copied OAuth
 * session to Supabase Vault. Replacing the account is still done in Cursor's
 * MCP settings. A reboot can ask for keychain access again.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { config as loadDotenv } from 'dotenv'
import { accessTokenExpired, credentialFromCursorTokens } from '../hht-engine/credential.js'
import { bufferToCursorValue, cursorValueToBuffer, decryptCursorSecret, encryptCursorSecret } from '../hht-engine/cursor-crypto.js'
import { closeEngineDatabase } from '../hht-engine/db.js'
import { engineDb, loadCredential, saveCredential } from '../hht-engine/jobs.js'
import { refreshSemrushCredential } from '../hht-engine/semrush-mcp.js'

loadDotenv()
const rawDatabaseUrl = rawEnvValue(readFileSync('.env', 'utf8'), 'DATABASE_URL')
if (rawDatabaseUrl) process.env['DATABASE_URL'] = rawDatabaseUrl

const CURSOR_DB = join(
  homedir(),
  'Library/Application Support/Cursor/User/globalStorage/state.vscdb',
)
const TOKEN_SUFFIX = 'W3VzZXItc2VtcnVzaDo6bWNwU2NvcGU6cHJvZmlsZTpaR1ZtWVhWc2RBXSBtY3BfdG9rZW5z'
const CLIENT_SUFFIX = 'W3VzZXItc2VtcnVzaDo6bWNwU2NvcGU6cHJvZmlsZTpaR1ZtWVhWc2RBXSBtY3BfY2xpZW50X2luZm9ybWF0aW9u'

function keychainPassword(): string {
  return execFileSync(
    'security',
    ['find-generic-password', '-w', '-s', 'Cursor Safe Storage', '-a', 'Cursor Key'],
    { encoding: 'utf8', timeout: 60_000 },
  ).trim()
}

function readSecret(db: DatabaseSync, suffix: string, password: string): unknown {
  const row = db.prepare('SELECT key, value FROM ItemTable WHERE key LIKE ?').get(`%${suffix}`) as { key: string; value: string } | undefined
  if (!row) throw new Error(`Cursor is missing the Semrush connector secret (${suffix.slice(0, 12)})`)
  return { key: row.key, json: JSON.parse(decryptCursorSecret(password, cursorValueToBuffer(row.value))) }
}

function cursorUpdatedAt(db: DatabaseSync): number | null {
  const row = db.prepare(
    "SELECT value FROM ItemTable WHERE key LIKE '%W3VzZXItc2VtcnVza%' AND key LIKE '%b2F1dGhfdXBkYXRlZF9hdF9tcw%' LIMIT 1",
  ).get() as { value: string } | undefined
  if (!row) return null
  const parsed = Number(String(row.value).replace(/\D/g, ''))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

async function main(): Promise<void> {
  const password = keychainPassword()
  const db = new DatabaseSync(CURSOR_DB)
  const tokenRow = readSecret(db, TOKEN_SUFFIX, password) as {
    key: string
    json: { access_token: string; refresh_token: string; token_type?: string; expires_in: number }
  }
  const clientRow = readSecret(db, CLIENT_SUFFIX, password) as { json: { client_id: string } }
  let credential = credentialFromCursorTokens({
    accessToken: tokenRow.json.access_token,
    refreshToken: tokenRow.json.refresh_token,
    tokenType: tokenRow.json.token_type,
    expiresIn: tokenRow.json.expires_in,
    clientId: clientRow.json.client_id,
    cursorUpdatedAtMs: cursorUpdatedAt(db),
  })
  if (accessTokenExpired(credential, Date.now(), 15 * 60_000)) {
    credential = await refreshSemrushCredential(credential)
    const plaintext = JSON.stringify({
      access_token: credential.accessToken,
      refresh_token: credential.refreshToken,
      token_type: credential.tokenType,
      expires_in: Math.max(60, Math.round((new Date(credential.expiresAt).getTime() - Date.now()) / 1000)),
    })
    const stored = bufferToCursorValue(encryptCursorSecret(password, plaintext))
    db.prepare('UPDATE ItemTable SET value = ? WHERE key = ?').run(stored, tokenRow.key)
  }
  const engine = engineDb()
  const existing = await loadCredential(engine)
  const sameCursorSession =
    existing?.cursorUpdatedAtMs !== null &&
    existing?.cursorUpdatedAtMs === credential.cursorUpdatedAtMs
  const saved =
    sameCursorSession &&
    existing &&
    new Date(existing.expiresAt).getTime() > new Date(credential.expiresAt).getTime()
      ? existing
      : credential
  if (saved === credential) await saveCredential(engine, credential)
  if (saved.refreshToken !== tokenRow.json.refresh_token || saved.accessToken !== tokenRow.json.access_token) {
    const plaintext = JSON.stringify({
      access_token: saved.accessToken,
      refresh_token: saved.refreshToken,
      token_type: saved.tokenType,
      expires_in: Math.max(60, Math.round((new Date(saved.expiresAt).getTime() - Date.now()) / 1000)),
    })
    const stored = bufferToCursorValue(encryptCursorSecret(password, plaintext))
    db.prepare('UPDATE ItemTable SET value = ? WHERE key = ?').run(stored, tokenRow.key)
  }
  db.close()
  await closeEngineDatabase()
  console.log(`semrush_oauth_token: ${saved === credential ? 'updated' : 'kept_newer_vault_copy'}; expires_at=${saved.expiresAt}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'sync failed')
  process.exit(1)
})

function rawEnvValue(source: string, key: string): string | null {
  const line = source.split(/\r?\n/).find((candidate) => candidate.startsWith(`${key}=`))
  if (!line) return null
  const value = line.slice(key.length + 1).trim()
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) return value.slice(1, -1)
  return value
}
