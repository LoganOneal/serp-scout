import { buildDynamicVariables, FALLBACK_VARIABLES } from '@rnr/core'
import { db, parseInboundEvent, resolveSiteByNumber } from '@rnr/data'

/**
 * Retell's inbound call webhook. THE multi-tenant mechanism.
 *
 * Fires BEFORE the call connects, and lets one agent serve every site: we look up
 * the dialled number, and hand back the business name, hours, service area and fee
 * as dynamic variables plus `metadata.site_id`.
 *
 * ==================== THIS RUNS WHILE THE PHONE IS RINGING ====================
 * Retell allows 10 seconds, retries 3 times, then connects to the number's default
 * agent with NO dynamic variables at all. So this handler does ONE indexed lookup
 * and returns. No analytics writes, no lead history, no aggregate queries. Anything
 * added here is added to every caller's ring time.
 * ===========================================================================
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Deliberately NOT signature-gated, unlike /events and /tool.
 *
 * Rejecting here does not protect anything: the endpoint writes nothing, and the
 * only data it returns is the business's own public-facing name, hours and service
 * area. Meanwhile a wrong or missing key would degrade EVERY call to the fallback
 * agent -- generic greeting, no site context, unattributed lead.
 *
 * The asymmetry decides it: strict verification on the write paths, availability on
 * the ring path.
 */
export async function POST(req: Request): Promise<Response> {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return json({}, 200)
  }

  const parsed = parseInboundEvent(body)
  if (parsed === null || parsed.toNumber === null) {
    // `{}` rather than `reject: true`. A malformed payload is our problem, not the
    // caller's, and the default agent answering generically beats a dead line.
    return json({ call_inbound: {} }, 200)
  }

  try {
    const site = await resolveSiteByNumber(db(), parsed.toNumber)

    if (site === null) {
      // Unknown number: let the default agent answer. The resulting call arrives
      // with no site_id, lands in the unattributed view with a reason, and that IS
      // the alert that a number is unregistered. Silently rejecting the call would
      // lose a real customer to protect nothing.
      return json({ call_inbound: {} }, 200)
    }

    return json(
      {
        call_inbound: {
          dynamic_variables: buildDynamicVariables(site),
          // The frozen join key. Every later webhook for this call carries it, so
          // `calls.site_id` never has to be re-derived from the phone number -- see
          // the schema comment on that column.
          metadata: { site_id: site.siteId, domain: site.domain },
        },
      },
      200,
    )
  } catch {
    // A database blip must not drop the call. Fallback variables mean the agent
    // still speaks a coherent sentence ("Thanks for calling our office") instead of
    // reading braces out loud.
    return json({ call_inbound: { dynamic_variables: FALLBACK_VARIABLES } }, 200)
  }
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
