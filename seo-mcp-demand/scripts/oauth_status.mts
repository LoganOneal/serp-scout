// One-off: report Cursor's stored Semrush OAuth state (expiry and update times only, never token values).
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { config } from 'dotenv'
import { readFileSync } from 'node:fs'
import { cursorValueToBuffer, decryptCursorSecret } from '../../packages/data/src/hht-engine/cursor-crypto.js'
import { expiresAtFromAccessToken } from '../../packages/data/src/hht-engine/credential.js'
import { engineDb, loadCredential } from '../../packages/data/src/hht-engine/jobs.js'
import { closeEngineDatabase } from '../../packages/data/src/hht-engine/db.js'

config()
const raw = readFileSync('.env', 'utf8').split(/\r?\n/).find(line => line.startsWith('DATABASE_URL='))?.slice(13).trim()
if (raw) process.env.DATABASE_URL = raw.replace(/^(["'])(.*)\1$/, '$2')

const password = execFileSync('security', ['find-generic-password', '-w', '-s', 'Cursor Safe Storage', '-a', 'Cursor Key'], { encoding: 'utf8' }).trim()
const db = new DatabaseSync(join(homedir(), 'Library/Application Support/Cursor/User/globalStorage/state.vscdb'), { readOnly: true })
const rows = db.prepare("SELECT key, value FROM ItemTable WHERE key LIKE '%W3VzZXItc2VtcnVza%'").all() as Array<{ key: string; value: string }>
let cursorTokens: { access_token?: string; refresh_token?: string; expires_in?: number } | null = null
for (const row of rows) {
  const label = Buffer.from(row.key.split('.').pop() ?? '', 'base64').toString('utf8') || row.key.slice(-60)
  let summary = `${String(row.value).length} chars`
  try {
    const json = JSON.parse(decryptCursorSecret(password, cursorValueToBuffer(row.value)))
    if (json.access_token) {
      cursorTokens = json
      summary = `access token expires ${expiresAtFromAccessToken(json.access_token, json.expires_in ?? 0)}; has refresh token: ${Boolean(json.refresh_token)}`
    } else {
      summary = `keys: ${Object.keys(json).join(', ')}`
    }
  } catch {
    const digits = String(row.value).replace(/\D/g, '')
    if (digits.length >= 12) summary = `value ~ ${new Date(Number(digits.slice(0, 13))).toISOString()}`
  }
  console.log(label, '->', summary)
}
db.close()
const vault = await loadCredential(engineDb())
console.log('vault copy: expires', vault?.expiresAt, '; synced', vault?.syncedAt)
console.log('same refresh token as Cursor:', Boolean(vault && cursorTokens && vault.refreshToken === cursorTokens.refresh_token))
console.log('same access token as Cursor:', Boolean(vault && cursorTokens && vault.accessToken === cursorTokens.access_token))
console.log('now', new Date().toISOString())
await closeEngineDatabase()
