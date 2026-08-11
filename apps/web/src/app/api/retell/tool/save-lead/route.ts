import { waitUntil } from '@vercel/functions'
import {
  db,
  deliverLeadNow,
  enqueueLeadDelivery,
  getCallByRetellId,
  parseToolCall,
  retellApiKey,
  saveLeadFromTool,
  verifyRetellSignature,
} from '@rnr/data'

/**
 * The mid-call `save_lead` custom function. The AUTHORITATIVE lead source.
 *
 * Called repeatedly during a single call as the agent learns things. This is what
 * makes a lead survive a hang-up -- and in HVAC the caller who gives a name and
 * "my furnace is dead" and then hangs up is still worth $50-200.
 *
 * ==================== THIS IS INSIDE THE CALLER'S TURN ====================
 * The agent is mid-conversation. Respond fast and say almost nothing: the function
 * is configured with speak-during and speak-after both OFF, so anything returned
 * here is for the model's context, not for the caller's ears.
 * ========================================================================
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request): Promise<Response> {
  const raw = await req.text()

  /**
   * Verified strictly, with no bypass.
   *
   * This is a write endpoint reachable from the public internet. Unverified, anyone
   * could POST fabricated leads into the CRM and the rows would be
   * indistinguishable from real ones.
   */
  const verdict = verifyRetellSignature({
    rawBody: raw,
    signature: req.headers.get('x-retell-signature'),
    apiKey: retellApiKey(),
  })
  if (!verdict.valid) {
    return json({ error: `signature: ${verdict.reason}` }, 401)
  }

  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return json({ error: 'bad json' }, 400)
  }

  const tool = parseToolCall(body)
  if (tool.callId === null) {
    return json({ error: 'no call_id' }, 400)
  }

  /**
   * The call row must already exist.
   *
   * It is created by `call_started`, which fires before any tool call. A tool call
   * for an unknown id is either a race we should not paper over or a forged request
   * -- inventing a call row here would let either one create leads.
   */
  const call = await getCallByRetellId(db(), tool.callId)
  if (call === null) {
    return json({ error: 'unknown call' }, 404)
  }

  try {
    const { lead, readyToDeliver } = await saveLeadFromTool(db(), {
      call,
      rawArgs: tool.args,
    })

    /**
     * Alert the contractor NOW, not at end of call.
     *
     * The whole value of mid-call capture is that an emergency reaches a human
     * while the customer is still on the phone. Enqueued (not sent inline) so the
     * SMS round trip never lands inside the caller's turn.
     *
     * ==================== THE ENQUEUE IS THE DURABLE PART ====================
     * The row is written and awaited; the send is then kicked off in `waitUntil`, which
     * keeps the function alive after the response without holding the caller's turn open.
     * If that send fails or the instance dies, the pending row is still there and the
     * per-minute drain picks it up -- so the fast path can fail without losing the lead.
     *
     * Nothing is awaited past the enqueue. A 30-second Twilio timeout inside a tool call
     * would stall the agent mid-sentence, which the caller hears.
     * =======================================================================
     */
    if (readyToDeliver) {
      await enqueueLeadDelivery(db(), lead.id).catch(() => {})
      waitUntil(
        deliverLeadNow(db(), {
          leadId: lead.id,
          workerId: `save-lead:${process.env['VERCEL_DEPLOYMENT_ID'] ?? 'local'}`,
          log: (m) => console.log(`[save-lead] ${m}`),
        }).catch((e) => {
          // Swallowed on purpose: the queue row is the retry, and an unhandled
          // rejection here would be reported as a failure of a request that succeeded.
          console.error(`[save-lead] immediate delivery failed: ${(e as Error).message}`)
        }),
      )
    }

    // Terse and factual. The model gets confirmation; the caller hears nothing.
    return json({ saved: true, captured: lead.capturedFields }, 200)
  } catch (e) {
    // 500 is honest here, but the agent must not stall waiting for a retry -- the
    // next save_lead call will carry the same fields plus whatever came after.
    return json({ saved: false, error: (e as Error).message ?? 'save failed' }, 500)
  }
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
