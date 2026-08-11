import 'server-only'
import { isAbsolute, resolve, sep } from 'node:path'
import type { Call } from '../schema.js'
import { resolveFromRoot } from '../paths.js'

/**
 * Naming and path safety for recordings.
 *
 * Split out from recordings.ts so the storage backends can use it without importing the
 * module that imports them. The rules here apply to BOTH backends: a blob key is built
 * the same way as a filename, and is validated the same way before use.
 */

/**
 * The recordings directory, resolved identically in every process.
 *
 * ==================== NOT RELATIVE TO cwd ====================
 * `RECORDINGS_DIR=./.recordings` used to be resolved against `process.cwd()`, and the
 * writer and the reader have different working directories: `pnpm worker` runs from
 * the repo root, `pnpm dev` runs `next dev` from `apps/web`. So the worker wrote to
 * <root>/.recordings and the web app looked in <root>/apps/web/.recordings.
 *
 * Every recording saved correctly; every play button 404'd; the browser rendered that
 * as a 0-second clip. It read as data loss and was in fact a disagreement about what
 * `.` means. Anchored on the workspace root, both processes agree.
 *
 * An ABSOLUTE value is honoured verbatim -- that is what a deployment sets, and it has
 * no cwd ambiguity to fix.
 * ============================================================
 */
export function recordingsDir(env: NodeJS.ProcessEnv = process.env, from?: string): string {
  const configured = env['RECORDINGS_DIR']?.trim()
  if (configured && isAbsolute(configured)) return configured
  return resolveFromRoot(configured && configured !== '' ? configured : '.recordings', from)
}

/**
 * Relative path for a call's audio: `{siteId}/{yyyy-mm}/{retellCallId}.wav`.
 *
 * Stored relative, resolved against the storage backend at read time, so moving the
 * directory -- or swapping local disk for Vercel Blob -- does not require rewriting
 * every row. This string is the object's identity in both backends.
 */
export function recordingRelPath(
  call: Pick<Call, 'siteId' | 'retellCallId' | 'createdAt'> & { startedAt?: Date | null },
): string {
  // The month the CALL happened, not the month the row was written. Those differ
  // whenever a call is backfilled, and an operator browsing recordings by month
  // means the conversation's date -- filing a March call under August makes the
  // directory layout useless for the one thing it exists for.
  const when = call.startedAt ?? call.createdAt ?? new Date()
  const month = `${when.getUTCFullYear()}-${String(when.getUTCMonth() + 1).padStart(2, '0')}`
  const site = call.siteId === null ? 'unattributed' : String(call.siteId)
  // The call id comes from Retell and lands in a filesystem path, so it is
  // constrained to a safe charset rather than trusted.
  const safeId = call.retellCallId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128)
  return `${site}/${month}/${safeId}.wav`
}

/**
 * Resolve a stored relative path to an absolute one, refusing escapes.
 *
 * `recording_path` is read from the database and used to open a file that is then
 * streamed to an HTTP client. If a row ever contained `../../.env`, this is the
 * only thing standing between that and an arbitrary file read.
 */
export function resolveRecordingPath(
  relPath: string,
  env: NodeJS.ProcessEnv = process.env,
  from?: string,
): string | null {
  if (isAbsolute(relPath)) return null
  const root = resolve(recordingsDir(env, from))
  const full = resolve(root, relPath)
  if (full !== root && !full.startsWith(root + sep)) return null
  return full
}

/**
 * Is this key safe to send to a remote object store?
 *
 * The traversal check above is filesystem arithmetic and does not transfer to a URL path,
 * so the blob backend needs its own answer to the same question: `recording_path` is
 * database-sourced text that becomes part of a request. A key with `..`, a leading slash,
 * a backslash or a control character is refused rather than normalised, because there is
 * no benign row that contains one.
 */
export function isSafeObjectKey(relPath: string): boolean {
  if (relPath === '' || relPath.length > 512) return false
  if (relPath.startsWith('/') || relPath.includes('\\')) return false
  if (Array.from(relPath).some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)) return false
  if (isAbsolute(relPath)) return false
  return relPath.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..')
}
