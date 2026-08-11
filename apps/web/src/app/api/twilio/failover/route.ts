import { db, recordWebhookEvent, resolveSiteByNumber } from '@rnr/data'

/**
 * Twilio Elastic SIP Trunk Disaster Recovery URL.
 *
 * ==================== THIS IS WHY THE BUSINESS LINE DOES NOT DIE ====================
 * Twilio invokes this when delivery to ALL configured origination URIs fails --
 * Retell is down, the SIP config is wrong, the network is broken. Without it the
 * caller hears nothing and calls a competitor, and for an HVAC business in July
 * that is the most expensive possible failure.
 *
 * Twilio POSTs `To` and `From` and expects TwiML back, so one URL serves every
 * site: resolve `To` to the site, and dial that site's on-call number.
 *
 * KNOW ITS LIMIT. This fires on DELIVERY failure only. It does not fire when Retell
 * answers and the agent is broken -- wrong greeting, dead air, a bad prompt deploy.
 * That class is caught by abandon rate and disconnection_reason on the dashboard.
 * =================================================================================
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request): Promise<Response> {
  const form = await readForm(req)
  const to = form.get('To') ?? form.get('Called') ?? null
  const from = form.get('From') ?? null

  let onCall: string | null = null
  let siteId: number | null = null
  let displayName: string | null = null

  try {
    if (to !== null) {
      const site = await resolveSiteByNumber(db(), to)
      if (site !== null) {
        siteId = site.siteId
        onCall = site.onCallNumber
        displayName = site.displayName
      }
    }
  } catch {
    // Fall through to the generic message. A database outage during a Retell
    // outage must still produce speakable TwiML.
  }

  /**
   * Logged on EVERY invocation.
   *
   * A failover nobody notices is an outage you never learn about. The site
   * dashboard reads these rows, because "your AI was down for six hours last
   * Tuesday" is not something to discover from a customer complaint.
   *
   * Best-effort: if this write fails the caller still gets connected.
   */
  await recordWebhookEvent(db(), {
    provider: 'twilio',
    // Timestamped so each failover is its own row rather than colliding on the
    // (event_type, call_id) dedupe key -- every occurrence is worth counting.
    eventType: `twilio_failover:${to ?? 'unknown'}:${Date.now()}`,
    retellCallId: null,
    siteId,
    payload: { to, from, resolvedSiteId: siteId, onCall, at: new Date().toISOString() },
    signatureValid: false,
  }).catch(() => {})

  return twiml(
    onCall === null
      ? // No on-call number configured: say something true rather than dialling
        // nowhere. An unexplained hang-up is worse than an apology.
        `<Response>
  <Say voice="Polly.Joanna">Thanks for calling${displayName ? ` ${escapeXml(displayName)}` : ''}. We're having a phone system problem right now. Please leave your name, number and address after the tone and we'll call you straight back.</Say>
  <Record maxLength="120" playBeep="true" timeout="5"/>
  <Say voice="Polly.Joanna">We didn't catch that. Please try calling again shortly.</Say>
</Response>`
      : `<Response>
  <Say voice="Polly.Joanna">One moment please, connecting you.</Say>
  <Dial timeout="25" answerOnBridge="true">${escapeXml(onCall)}</Dial>
  <Say voice="Polly.Joanna">Sorry, we couldn't reach anyone. Please leave a message after the tone.</Say>
  <Record maxLength="120" playBeep="true" timeout="5"/>
</Response>`,
  )
}

/** Twilio may be configured with GET. Accept both rather than 405 mid-outage. */
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const proxied = new Request(url.toString(), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: url.searchParams.toString(),
  })
  return POST(proxied)
}

async function readForm(req: Request): Promise<URLSearchParams> {
  const text = await req.text().catch(() => '')
  const type = req.headers.get('content-type') ?? ''
  if (type.includes('application/json')) {
    try {
      const o = JSON.parse(text) as Record<string, unknown>
      const p = new URLSearchParams()
      for (const [k, v] of Object.entries(o)) p.set(k, String(v))
      return p
    } catch {
      return new URLSearchParams()
    }
  }
  return new URLSearchParams(text)
}

function twiml(xml: string): Response {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n${xml}`, {
    status: 200,
    headers: { 'content-type': 'text/xml; charset=utf-8' },
  })
}

/** The on-call number and business name go into XML. Escaped, not trusted. */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}
