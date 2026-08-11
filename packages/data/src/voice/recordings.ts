import 'server-only'
import { eq } from 'drizzle-orm'
import type { Database } from '../db.js'
import { calls, type Call } from '../schema.js'
import { recordingRelPath, resolveRecordingPath } from './recording-path.js'
import {
  recordingStore,
  type OpenedRecording,
  type WantedRange,
} from './recording-store.js'
import type { VoiceProviders } from '../providers/voice.js'

/**
 * Recording storage.
 *
 * ==================== WHY WE RE-HOST ====================
 * Retell's `recording_url` is an S3 link whose lifetime the docs do not specify --
 * and when "Opt-Out of Personal and Sensitive Data Storage" is enabled the docs are
 * explicit that it is accessible for TEN MINUTES and then deleted.
 *
 * A CRM whose headline feature is "recordings of every call" cannot be built on a
 * URL someone else expires. So the bytes are copied into storage we control, and
 * `calls.recording_path` -- not the upstream URL -- is what the UI reads.
 * ======================================================
 *
 * WHERE the bytes go is `recording-store.ts`: local disk in development, a private
 * Vercel Blob store in production. This module is the same either way, because
 * `recording_path` is a relative key both backends understand.
 */

export {
  recordingsDir,
  recordingRelPath,
  resolveRecordingPath,
  isSafeObjectKey,
} from './recording-path.js'
export { recordingStore, clampRange, parseContentRange } from './recording-store.js'
export type { OpenedRecording, RecordingStore, WantedRange } from './recording-store.js'

export interface FetchRecordingResult {
  stored: boolean
  bytes: number | null
  reason: string | null
  /** Which backend took the bytes, for the worker log. Null when nothing was stored. */
  storage: 'local' | 'blob' | null
}

/**
 * Download a call's recording and record the outcome.
 *
 * On failure, writes `recording_missing_reason` and leaves `recording_path` NULL.
 * The UI reads that pair: a NULL path renders "Recording unavailable" plus the
 * reason, never a play button that 404s. Absence of data is displayed as absence,
 * the same rule as everywhere else in this codebase.
 */
export async function fetchRecording(
  db: Database,
  args: { call: Call; providers: VoiceProviders; env?: NodeJS.ProcessEnv },
): Promise<FetchRecordingResult> {
  const { call, providers } = args
  const env = args.env ?? process.env

  const fail = async (reason: string): Promise<FetchRecordingResult> => {
    await db.update(calls).set({ recordingMissingReason: reason }).where(eq(calls.id, call.id))
    return { stored: false, bytes: null, reason, storage: null }
  }

  if (call.recordingUrlUpstream === null) {
    return fail('Retell reported no recording_url for this call.')
  }

  /**
   * Resolve the backend BEFORE downloading.
   *
   * A missing blob token on Vercel throws here, and it is a misconfiguration rather than
   * a transient fault -- so it is written as a reason an operator can read instead of
   * being raised for the job layer to retry forever against a problem no retry fixes.
   */
  let store
  try {
    store = recordingStore(env)
  } catch (e) {
    return fail(`Recording storage is not configured: ${(e as Error).message}`)
  }

  const rel = recordingRelPath(call)

  // Throws on failure so the job layer can apply backoff and retry -- an expired
  // S3 link and a transient 500 are both worth one more attempt.
  const buf = await providers.downloadRecording(call.recordingUrlUpstream)

  if (buf.byteLength === 0) {
    const reason = 'Downloaded recording was empty (0 bytes).'
    await db.update(calls).set({ recordingMissingReason: reason }).where(eq(calls.id, call.id))
    return { stored: false, bytes: 0, reason, storage: store.kind }
  }

  try {
    await store.put(rel, buf)
  } catch (e) {
    // An unsafe key is permanent; a network fault is not. Both are reported, and the
    // job layer decides on retry from the throw below only for the transient kind.
    const message = (e as Error).message
    if (message.startsWith('Refused to')) return fail(message)
    throw e
  }

  await db
    .update(calls)
    .set({
      recordingPath: rel,
      recordingBytes: buf.byteLength,
      recordingFetchedAt: new Date(),
      recordingMissingReason: null,
    })
    .where(eq(calls.id, call.id))

  return { stored: true, bytes: buf.byteLength, reason: null, storage: store.kind }
}

/**
 * Record why no recording will be fetched, without pretending one failed.
 *
 * The UI reads `recording_missing_reason` next to a null path, so this shows
 * "Simulated call" rather than a retry button that could never succeed.
 */
export async function markRecordingSkipped(
  db: Database,
  callId: number,
  reason: string,
): Promise<void> {
  await db.update(calls).set({ recordingMissingReason: reason }).where(eq(calls.id, callId))
}

/**
 * Are the audio bytes actually there?
 *
 * `recording_path` being set is a CLAIM; this is the check. Used by the site page so a
 * play button is never rendered for bytes that are not there -- the same rule as
 * rendering a null measurement as an em dash rather than a zero, applied to a control
 * instead of a value.
 */
export async function recordingExists(
  relPath: string | null,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (relPath === null) return false
  return (await recordingSize(relPath, env)) !== null
}

/**
 * Size, without opening a stream.
 *
 * A ranged request cannot be interpreted before the size is known -- `bytes=-512`
 * means "the last 512 bytes" -- and opening a stream just to read `.size` and then
 * destroy it is a handle opened for nothing.
 *
 * A storage misconfiguration returns null rather than throwing: the caller is a request
 * handler rendering a play button, and "cannot tell" belongs in the missing-reason path,
 * not in a 500.
 */
export async function recordingSize(
  relPath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number | null> {
  try {
    return await recordingStore(env).size(relPath)
  } catch {
    return null
  }
}

/** Open a stored recording for streaming. Null when the bytes are not actually there. */
export async function openRecording(
  relPath: string,
  env: NodeJS.ProcessEnv = process.env,
  /** Inclusive, as HTTP means it. `end` may exceed the object; it is clamped. */
  wanted?: WantedRange | undefined,
): Promise<OpenedRecording | null> {
  try {
    return await recordingStore(env).open(relPath, wanted)
  } catch {
    return null
  }
}
