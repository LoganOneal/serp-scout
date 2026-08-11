import 'server-only'
import { createReadStream } from 'node:fs'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Readable } from 'node:stream'
import { head, put, get } from '@vercel/blob'
import { isSafeObjectKey, resolveRecordingPath } from './recording-path.js'

/**
 * Where recording bytes live.
 *
 * ==================== WHY THIS IS A SEAM ====================
 * The bytes were on local disk, which is correct for `pnpm worker` on a laptop and
 * impossible on Vercel: the filesystem is per-invocation, so the function that writes a
 * recording is not the function that later serves it. Writing succeeds, the row records
 * a path, and every play button 404s -- the exact shape of the "0 seconds" bug, except
 * this time the bytes really would be gone.
 *
 * So storage becomes a provider seam, the same pattern as the SERP and voice providers:
 * local disk when there is no blob token, Vercel Blob when there is. Both implementations
 * key on the SAME relative path, so `calls.recording_path` means the same thing in both
 * and switching hosts is not a data migration.
 * ===========================================================
 */

/** A readable body plus the arithmetic an HTTP range response needs. */
export interface OpenedRecording {
  /** Web stream, so the route can hand it straight to a Response. */
  stream: ReadableStream<Uint8Array>
  /** Bytes in THIS response. Equals `size` for a full read. */
  length: number
  /** Total object size, needed for Content-Range. */
  size: number
  /** Inclusive byte offsets actually served, or null when the whole object is served. */
  range: { start: number; end: number } | null
}

/** Inclusive, as HTTP means it. `end` may exceed the object; it is clamped. */
export interface WantedRange {
  start: number
  end?: number | undefined
}

export interface RecordingStore {
  /** Which backend answered. Surfaced in logs so a misconfiguration is visible. */
  readonly kind: 'local' | 'blob'
  put(relPath: string, bytes: Uint8Array): Promise<void>
  /** Byte size, or null when the object is absent or empty. */
  size(relPath: string): Promise<number | null>
  open(relPath: string, wanted?: WantedRange | undefined): Promise<OpenedRecording | null>
}

/**
 * Clamp a requested range against a known size.
 *
 * Shared by both backends deliberately. When each implementation did its own arithmetic,
 * a seek could be satisfiable on disk and unsatisfiable on Blob for the same file, which
 * would show up as a player that works locally and stutters in production.
 *
 * Null means UNSATISFIABLE -- the caller answers 416, not an empty 206, because some
 * players treat a zero-length 206 as a corrupt file.
 */
export function clampRange(
  size: number,
  wanted: WantedRange | undefined,
): { start: number; end: number } | null {
  if (wanted === undefined) return { start: 0, end: size - 1 }
  const start = Math.max(0, Math.floor(wanted.start))
  if (start >= size) return null
  const end = Math.min(size - 1, wanted.end === undefined ? size - 1 : Math.floor(wanted.end))
  if (end < start) return null
  return { start, end }
}

/** Parse `bytes 200-1023/8192` from a response. Null when absent or unparseable. */
export function parseContentRange(
  value: string | null,
): { start: number; end: number; size: number } | null {
  if (value === null) return null
  const m = /^bytes\s+(\d+)-(\d+)\/(\d+)$/.exec(value.trim())
  if (!m) return null
  const [start, end, size] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (end < start || size <= end) return null
  return { start, end, size }
}

// --- local disk -----------------------------------------------------------------

class LocalStore implements RecordingStore {
  readonly kind = 'local' as const
  constructor(private readonly env: NodeJS.ProcessEnv) {}

  async put(relPath: string, bytes: Uint8Array): Promise<void> {
    const abs = this.resolve(relPath)
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, bytes)
  }

  async size(relPath: string): Promise<number | null> {
    const abs = resolveRecordingPath(relPath, this.env)
    if (abs === null) return null
    try {
      const s = await stat(abs)
      return s.isFile() && s.size > 0 ? s.size : null
    } catch {
      // A row claiming a path that is not there is a real state -- the directory was
      // cleared, the volume is not mounted -- and the caller renders it as missing
      // rather than throwing a 500 at someone clicking play.
      return null
    }
  }

  async open(relPath: string, wanted?: WantedRange): Promise<OpenedRecording | null> {
    const abs = resolveRecordingPath(relPath, this.env)
    if (abs === null) return null
    const size = await this.size(relPath)
    if (size === null) return null

    const range = clampRange(size, wanted)
    if (range === null) return null

    const stream = Readable.toWeb(
      createReadStream(abs, { start: range.start, end: range.end }),
    ) as ReadableStream<Uint8Array>

    const full = range.start === 0 && range.end === size - 1
    return {
      stream,
      length: range.end - range.start + 1,
      size,
      // A full read reports `range: null` so the route answers 200, matching the
      // previous behaviour exactly -- `wanted === undefined` and "the range happens to
      // cover everything" are the same response.
      range: wanted === undefined || full ? null : range,
    }
  }

  private resolve(relPath: string): string {
    const abs = resolveRecordingPath(relPath, this.env)
    if (abs === null) throw new Error(`Refused to write outside RECORDINGS_DIR: ${relPath}`)
    return abs
  }
}

// --- Vercel Blob ----------------------------------------------------------------

/**
 * Blob-backed storage.
 *
 * Objects are written with `access: 'private'`, so the blob URL is NOT a capability:
 * reads require the store token, which only the server has. Recordings are recordings of
 * strangers describing their home and giving their phone number, and a public bucket
 * would make an unguessable URL the only thing protecting them. Authorisation stays where
 * it already is -- the `/api/recordings/:callId` route -- rather than moving to obscurity.
 */
class BlobStore implements RecordingStore {
  readonly kind = 'blob' as const
  constructor(private readonly token: string) {}

  async put(relPath: string, bytes: Uint8Array): Promise<void> {
    if (!isSafeObjectKey(relPath)) {
      throw new Error(`Refused to store an unsafe recording key: ${JSON.stringify(relPath)}`)
    }
    // A view over the same memory, not a copy -- the SDK's body type wants a Buffer and a
    // call recording is megabytes.
    const body = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    await put(relPath, body, {
      access: 'private',
      // The path is the identity. A random suffix would mean the key we store and the
      // key we later read are different strings, which is how you lose a file you own.
      addRandomSuffix: false,
      contentType: 'audio/wav',
      // Re-fetching a call must overwrite rather than fail.
      allowOverwrite: true,
      token: this.token,
    })
  }

  async size(relPath: string): Promise<number | null> {
    if (!isSafeObjectKey(relPath)) return null
    try {
      const meta = await head(relPath, { token: this.token })
      return meta.size > 0 ? meta.size : null
    } catch {
      // `head` throws BlobNotFoundError for a missing object, which is a normal state
      // here -- the row claims a path and the object is not there.
      return null
    }
  }

  async open(relPath: string, wanted?: WantedRange): Promise<OpenedRecording | null> {
    if (!isSafeObjectKey(relPath)) return null
    const size = await this.size(relPath)
    if (size === null) return null

    const range = clampRange(size, wanted)
    if (range === null) return null

    const full = range.start === 0 && range.end === size - 1
    const askRange = wanted !== undefined && !full

    let res: Awaited<ReturnType<typeof get>>
    try {
      res = await get(relPath, {
        access: 'private',
        token: this.token,
        ...(askRange ? { headers: { range: `bytes=${range.start}-${range.end}` } } : {}),
      })
    } catch {
      return null
    }
    if (res === null || res.statusCode !== 200) return null

    /**
     * ==================== DO NOT CLAIM 206 WITHOUT CONTENT-RANGE ====================
     * `get` models 200 and 304 but not 206, so the only evidence of what was actually
     * served is the raw header. If a Range was sent and the response came back WITHOUT
     * Content-Range, the body is the whole object -- reporting it as a partial response
     * would hand the player 8MB of audio labelled as bytes 200-1023, which decodes as
     * garbage or silence.
     *
     * Ignoring a Range is allowed by the spec. Lying about having honoured one is not.
     * ==============================================================================
     */
    const served = parseContentRange(res.headers.get('content-range'))
    if (askRange && served !== null) {
      return {
        stream: res.stream,
        length: served.end - served.start + 1,
        size: served.size,
        range: { start: served.start, end: served.end },
      }
    }

    return { stream: res.stream, length: size, size, range: null }
  }
}

// --- selection ------------------------------------------------------------------

/**
 * Pick a backend.
 *
 * ==================== NO SILENT FALLBACK TO A DISK THAT VANISHES ====================
 * On Vercel with no blob token, falling back to local disk would "succeed": the write
 * lands on a per-invocation filesystem, the row records a path, and the recording is
 * gone before anyone plays it -- a stored-and-lost state that reads as stored. So a
 * serverless runtime with no token is a hard error, surfaced into
 * `recording_missing_reason` where an operator can see it.
 *
 * Locally the absence of a token is the normal case and means disk.
 * ==================================================================================
 */
export function recordingStore(env: NodeJS.ProcessEnv = process.env): RecordingStore {
  const token = env['BLOB_READ_WRITE_TOKEN']?.trim()
  if (token) return new BlobStore(token)

  // Vercel sets VERCEL=1 in every runtime, build and function alike.
  if (env['VERCEL']) {
    throw new Error(
      'BLOB_READ_WRITE_TOKEN is not set, and local disk does not persist on Vercel. ' +
        'Create a Blob store (`vercel blob store add`) and add the token to this environment.',
    )
  }
  return new LocalStore(env)
}
