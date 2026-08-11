/**
 * Copy recordings from local disk into the Vercel Blob store.
 *
 * ==================== WHY THIS IS NOT A NO-OP ====================
 * `calls.recording_path` is a RELATIVE key, deliberately, so the same row addresses the same
 * audio on either backend. But the bytes themselves do not move on their own: production
 * reads the blob store, and every recording captured before the move is on a laptop. Without
 * this, the two existing calls would render "recorded as stored, but not in storage" -- which
 * is honest, and still a loss of the only copy of two real customer conversations.
 *
 * Verifies each upload by reading the size back rather than trusting the write. A recording
 * that is present but truncated is worse than one that is absent, because the UI would show a
 * play button for it.
 *
 *   npx tsx packages/data/src/scripts/migrate-recordings.mts            # report
 *   npx tsx packages/data/src/scripts/migrate-recordings.mts --confirm  # upload
 */
import 'dotenv/config'
import { readFile } from 'node:fs/promises'
import { eq, isNotNull } from 'drizzle-orm'
import { db, closeDb } from '../db.js'
import { calls } from '../schema.js'
import { recordingsDir, resolveRecordingPath } from '../voice/recording-path.js'
import { recordingStore } from '../voice/recording-store.js'

const CONFIRM = process.argv.includes('--confirm')

const token = process.env['BLOB_READ_WRITE_TOKEN']?.trim()
if (!token) {
  console.error(
    'BLOB_READ_WRITE_TOKEN is not set locally. Pull it first:\n' +
      '  vercel env pull --environment=production .env.production\n' +
      'then run this with that value in the environment.',
  )
  process.exit(1)
}

// The DESTINATION is explicitly the blob store; the SOURCE is explicitly local disk. Deriving
// both from the same env would make this script copy a file onto itself.
const blob = recordingStore({ BLOB_READ_WRITE_TOKEN: token } as NodeJS.ProcessEnv)
const localEnv = { ...process.env, BLOB_READ_WRITE_TOKEN: '' } as NodeJS.ProcessEnv

console.log(`source: ${recordingsDir(localEnv)}`)
console.log(`target: Vercel Blob (${blob.kind}), private\n`)

const rows = await db()
  .select({
    id: calls.id,
    path: calls.recordingPath,
    bytes: calls.recordingBytes,
    retellCallId: calls.retellCallId,
  })
  .from(calls)
  .where(isNotNull(calls.recordingPath))

if (rows.length === 0) {
  console.log('No calls have a recording_path. Nothing to migrate.')
  await closeDb()
  process.exit(0)
}

let uploaded = 0
let already = 0
let failed = 0

for (const row of rows) {
  const rel = row.path
  if (rel === null) continue

  const existing = await blob.size(rel)
  if (existing !== null && existing === row.bytes) {
    console.log(`  ${rel}  already in blob (${existing} bytes)`)
    already += 1
    continue
  }

  const abs = resolveRecordingPath(rel, localEnv)
  if (abs === null) {
    console.log(`  ${rel}  REFUSED: resolves outside the recordings directory`)
    failed += 1
    continue
  }

  let buf: Buffer
  try {
    buf = await readFile(abs)
  } catch (e) {
    // Not a failure of the migration: the row's bytes are simply not on THIS machine.
    console.log(`  ${rel}  not on this disk (${(e as Error).message.split(',')[0]})`)
    failed += 1
    continue
  }

  if (!CONFIRM) {
    console.log(`  ${rel}  would upload ${buf.byteLength} bytes`)
    continue
  }

  try {
    await blob.put(rel, buf)
    // Read it back. A truncated object is worse than a missing one, because the UI renders a
    // play button for anything with a non-zero size.
    const after = await blob.size(rel)
    if (after !== buf.byteLength) {
      console.log(`  ${rel}  MISMATCH: wrote ${buf.byteLength}, store reports ${after}`)
      failed += 1
      continue
    }
    // Keep recording_bytes truthful against what was actually stored.
    if (row.bytes !== buf.byteLength) {
      await db().update(calls).set({ recordingBytes: buf.byteLength }).where(eq(calls.id, row.id))
    }
    console.log(`  ${rel}  uploaded and verified (${after} bytes)`)
    uploaded += 1
  } catch (e) {
    console.log(`  ${rel}  FAILED: ${(e as Error).message}`)
    failed += 1
  }
}

console.log(
  `\n${rows.length} recording(s): ${uploaded} uploaded, ${already} already present, ${failed} unavailable.`,
)
if (!CONFIRM) console.log('Dry run. Re-run with --confirm to upload.')
await closeDb()
