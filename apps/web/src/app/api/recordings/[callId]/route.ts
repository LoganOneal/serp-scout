import { db, getCallById, openRecording, recordingSize } from '@rnr/data'

/**
 * Stream a stored recording.
 *
 * Reads `calls.recording_path` -- never the upstream Retell URL, which expires (and is
 * a hard 10-minute window when the PII opt-out is on). If the bytes are not on disk
 * this 404s with the reason, and the UI renders "unavailable" rather than a play
 * button that silently fails.
 *
 * Path traversal is handled in `openRecording`, which refuses anything resolving outside
 * RECORDINGS_DIR on disk and any unsafe key against the blob store. That check lives in
 * the data layer rather than here so it cannot be bypassed by a second caller.
 *
 * This route is also the ONLY way to read a recording in production: the blob objects are
 * private, so the store URL is not a capability and authorisation stays here.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** `bytes=0-1023`, `bytes=1024-`, `bytes=-512`. Null when absent or unparseable. */
function parseRange(
  header: string | null,
  // Needed only for a suffix range ("last N bytes"), which is expressed relative to
  // the end of the file.
  size: number,
): { start: number; end: number | undefined } | null {
  if (header === null) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m) return null

  const rawStart = m[1] ?? ''
  const rawEnd = m[2] ?? ''
  if (rawStart === '' && rawEnd === '') return null

  if (rawStart === '') {
    const suffix = Number(rawEnd)
    if (!Number.isFinite(suffix) || suffix <= 0) return null
    return { start: Math.max(0, size - suffix), end: undefined }
  }

  const start = Number(rawStart)
  if (!Number.isFinite(start)) return null
  if (rawEnd === '') return { start, end: undefined }

  const end = Number(rawEnd)
  if (!Number.isFinite(end)) return null
  return { start, end }
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ callId: string }> },
): Promise<Response> {
  const { callId } = await ctx.params
  const id = Number(callId)
  if (!Number.isInteger(id) || id <= 0) {
    return new Response('bad call id', { status: 400 })
  }

  const call = await getCallById(db(), id)
  if (call === null) return new Response('no such call', { status: 404 })

  if (call.recordingPath === null) {
    // The reason, not a bare 404 -- it is the same text the UI shows, so a direct link
    // is diagnosable too.
    return new Response(call.recordingMissingReason ?? 'Recording has not been fetched yet.', {
      status: 404,
    })
  }

  // Size first: a suffix range ("bytes=-512") cannot be interpreted without it, and
  // this doubles as the on-disk existence check.
  const size = await recordingSize(call.recordingPath)
  if (size === null) {
    return new Response(
      'This call is recorded as having stored audio, but the bytes are not in storage. ' +
        'Check RECORDINGS_DIR locally, or BLOB_READ_WRITE_TOKEN in production.',
      { status: 404 },
    )
  }

  // An unparseable Range is ignored and the whole file served, which is what the spec
  // requires -- rejecting it would break clients that send something we do not model.
  const wanted = parseRange(req.headers.get('range'), size)

  const body = await openRecording(call.recordingPath, process.env, wanted ?? undefined)
  if (body === null) {
    /**
     * Unsatisfiable range. 416 WITH Content-Range is what the spec requires; an empty
     * 206 instead makes some players treat the file as corrupt.
     */
    if (wanted !== null) {
      return new Response('range not satisfiable', {
        status: 416,
        headers: { 'content-range': `bytes */${size}`, 'accept-ranges': 'bytes' },
      })
    }
    return new Response('Recording became unreadable.', { status: 404 })
  }

  const headers: Record<string, string> = {
    'content-type': 'audio/wav',
    'content-length': String(body.length),
    // Advertised unconditionally: without it browsers will not attempt to seek at all,
    // so a 6MB call could only ever be played from the beginning.
    'accept-ranges': 'bytes',
    'content-disposition': `inline; filename="call-${id}.wav"`,
    // Recordings are immutable once fetched, but they are also PII -- cached in the
    // browser only, never by a shared proxy.
    'cache-control': 'private, max-age=3600',
  }

  if (body.range !== null) {
    headers['content-range'] = `bytes ${body.range.start}-${body.range.end}/${body.size}`
  }

  return new Response(body.stream, {
    status: body.range !== null ? 206 : 200,
    headers,
  })
}
