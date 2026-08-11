import {
  clearEventHandlerError,
  db,
  handleCallEvent,
  markEventHandlerError,
  parseRetellEvent,
  recordWebhookEvent,
  retellApiKey,
  verifyRetellSignature,
} from '@rnr/data'

/**
 * Retell's call lifecycle webhooks: call_started, call_ended, call_analyzed.
 *
 * Order is load-bearing: RECORD the payload, then act on it. A handler that throws
 * still leaves the raw body in `webhook_events`, so an ingest bug is replayable
 * rather than lost -- the same argument as `spend_ledger` storing a row per
 * purchase instead of a running total.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request): Promise<Response> {
  // The RAW body, not a re-serialised object. Re-serialising changes whitespace and
  // key order, and the signature then fails for a reason that looks exactly like a
  // wrong secret.
  const raw = await req.text()

  const verdict = verifyRetellSignature({
    rawBody: raw,
    signature: req.headers.get('x-retell-signature'),
    apiKey: retellApiKey(),
  })

  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return new Response('bad json', { status: 400 })
  }

  const parsed = parseRetellEvent(body)
  if (parsed === null) {
    // An event type we do not model (or a shape change). Recorded so it is
    // discoverable, acknowledged so Retell stops retrying something we will never
    // consume.
    await recordWebhookEvent(db(), {
      eventType: 'unparsed',
      retellCallId: null,
      payload: body,
      signatureValid: verdict.valid,
    }).catch(() => {})
    return new Response('ignored', { status: 200 })
  }

  // transcript_updated fires on every turn. Storing them would be one row per
  // sentence per call with the final transcript already arriving on call_ended.
  if (parsed.eventType === 'transcript_updated') {
    return new Response('ok', { status: 200 })
  }

  const callId = parsed.call?.callId ?? null

  const { shouldProcess, eventId } = await recordWebhookEvent(db(), {
    eventType: parsed.eventType,
    retellCallId: callId,
    siteId: parsed.call?.siteId ?? null,
    payload: body,
    signatureValid: verdict.valid,
  })

  /**
   * Invalid signature: the payload is STORED but not acted on, and we answer 401.
   *
   * Both halves matter. Storing means a genuinely misconfigured key loses nothing
   * -- the events can be replayed once it is fixed. Answering 401 rather than 200
   * means the misconfiguration is loud instead of a dashboard that silently stops
   * updating, and the site connection panel surfaces the invalid-signature count.
   */
  if (!verdict.valid) {
    return new Response(`signature: ${verdict.reason}`, { status: 401 })
  }

  // A duplicate of a delivery that already succeeded. It must still get a 2xx or
  // Retell keeps redelivering it.
  if (!shouldProcess) return new Response('duplicate', { status: 200 })

  if (parsed.call === null) {
    return new Response('no call payload', { status: 200 })
  }

  try {
    await handleCallEvent(db(), { eventType: parsed.eventType, parsed: parsed.call })
    // Clears the reprocessable flag when this was a retry of a failed handler.
    if (eventId !== null) await clearEventHandlerError(db(), eventId).catch(() => {})
  } catch (e) {
    const message = (e as Error).message ?? String(e)
    // Written BEFORE the 500, and it is what makes the retry actually reprocess --
    // see the shouldProcess comment in ingest.ts. Without it the dedupe key would
    // answer "duplicate" to every retry and the 500 would be advice nobody takes.
    if (eventId !== null) await markEventHandlerError(db(), eventId, message).catch(() => {})
    return new Response('handler error', { status: 500 })
  }

  return new Response('ok', { status: 200 })
}
