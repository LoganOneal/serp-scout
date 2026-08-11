import { describe, expect, it } from 'vitest'
import { clampRange, parseContentRange, recordingStore } from './recording-store.js'
import { isSafeObjectKey } from './recording-path.js'

/**
 * The range arithmetic and the backend choice.
 *
 * Both are shared between local disk and Vercel Blob precisely so a seek cannot behave
 * differently in production than it does on a laptop, so they are tested once, here,
 * against the seam rather than against either backend.
 */

function envWith(over: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete env[k]
    else env[k] = v
  }
  return env
}

describe('clampRange', () => {
  it('treats no request as the whole object', () => {
    expect(clampRange(8192, undefined)).toEqual({ start: 0, end: 8191 })
  })

  it('clamps an end past the object to the last byte', () => {
    // Players routinely ask for bytes=0- or an end far past the file.
    expect(clampRange(1000, { start: 0, end: 999_999 })).toEqual({ start: 0, end: 999 })
    expect(clampRange(1000, { start: 500 })).toEqual({ start: 500, end: 999 })
  })

  it('returns null for an unsatisfiable start, so the caller can answer 416', () => {
    // An empty 206 instead of a 416 makes some players treat the file as corrupt.
    expect(clampRange(1000, { start: 1000 })).toBeNull()
    expect(clampRange(1000, { start: 5000 })).toBeNull()
  })

  it('returns null when the range inverts rather than serving a negative length', () => {
    expect(clampRange(1000, { start: 600, end: 500 })).toBeNull()
  })

  it('floors fractional offsets instead of passing them to a byte reader', () => {
    expect(clampRange(1000, { start: 10.9, end: 20.9 })).toEqual({ start: 10, end: 20 })
  })

  it('never produces a negative start', () => {
    expect(clampRange(1000, { start: -50, end: 10 })).toEqual({ start: 0, end: 10 })
  })
})

describe('parseContentRange', () => {
  it('reads a well-formed header', () => {
    expect(parseContentRange('bytes 200-1023/8192')).toEqual({ start: 200, end: 1023, size: 8192 })
  })

  /**
   * The point of this function is deciding whether a 206 may be CLAIMED. Anything it cannot
   * read must come back null so the caller falls back to reporting a full 200 -- labelling a
   * whole-file body as bytes 200-1023 hands the player garbage.
   */
  it('returns null for anything it cannot fully account for', () => {
    for (const bad of [
      null,
      '',
      'bytes */8192', // unsatisfiable response, no served range
      'bytes 200-1023/*', // unknown total
      'items 200-1023/8192',
      'bytes 1023-200/8192', // inverted
      'bytes 200-8192/8192', // end at or past the total
      'bytes 200-1023',
    ]) {
      expect(parseContentRange(bad), String(bad)).toBeNull()
    }
  })
})

describe('isSafeObjectKey', () => {
  it('accepts the shape recordingRelPath produces', () => {
    expect(isSafeObjectKey('1/2026-08/call_d477f530a2412a266ee41ff5a24.wav')).toBe(true)
    expect(isSafeObjectKey('unattributed/2026-03/call_x.wav')).toBe(true)
  })

  /**
   * The filesystem traversal guard is path arithmetic and does not transfer to a URL, so
   * the blob backend needs this. `recording_path` is database text that becomes part of a
   * request.
   */
  it('refuses traversal, absolute keys, backslashes and control characters', () => {
    for (const bad of [
      '',
      '../secrets.wav',
      '1/../../etc/passwd',
      '/1/2026-08/x.wav',
      '1\\2026-08\\x.wav',
      './x.wav',
      '1//x.wav',
      `1/2026-08/x\n.wav`,
      'a'.repeat(600),
    ]) {
      expect(isSafeObjectKey(bad), JSON.stringify(bad)).toBe(false)
    }
  })
})

describe('recordingStore', () => {
  it('uses local disk when there is no blob token', () => {
    expect(recordingStore(envWith({ BLOB_READ_WRITE_TOKEN: undefined, VERCEL: undefined })).kind).toBe(
      'local',
    )
  })

  it('uses Blob when a token is present', () => {
    expect(recordingStore(envWith({ BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_test' })).kind).toBe('blob')
  })

  it('treats a blank token as absent rather than as a token', () => {
    expect(recordingStore(envWith({ BLOB_READ_WRITE_TOKEN: '   ', VERCEL: undefined })).kind).toBe(
      'local',
    )
  })

  /**
   * ==================== THE ASSERTION THAT MATTERS ====================
   * Falling back to local disk on Vercel would "work": the write lands on a per-invocation
   * filesystem, `recording_path` is set, and the recording is gone before anyone plays it.
   * That is a stored-and-lost state that reads as stored -- the same class of failure as the
   * "0 seconds" bug, except the bytes really would be unrecoverable.
   * ==================================================================
   */
  it('REFUSES to fall back to disk on Vercel with no blob token', () => {
    expect(() => recordingStore(envWith({ BLOB_READ_WRITE_TOKEN: undefined, VERCEL: '1' }))).toThrow(
      /BLOB_READ_WRITE_TOKEN/,
    )
  })
})
