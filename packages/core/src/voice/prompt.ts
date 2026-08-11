/**
 * The agent's per-call context, and the prompt that consumes it.
 *
 * ==================== WHY THE PROMPT LIVES IN THIS REPO ====================
 * Retell holds a rendered copy; this file is the source of truth. A prompt edited
 * in the dashboard is an untracked config change that silently diverges from the
 * `sites` row claiming to describe it -- and it forfeits the portability hedge:
 * with the prompt, the variables and the tool contract all here, moving off
 * Retell is a transport swap rather than a rebuild.
 * =========================================================================
 *
 * Pure. Takes plain site data, returns strings.
 */

import { describeHours, openStateAt, type WeeklyHours } from './hours.js'
import { formatPhone, speakUsdFromMicros } from './normalize.js'
import { SAFETY_SCRIPT } from './triage.js'

/** What the inbound webhook needs to know about a site. Plain data, no Drizzle row. */
export interface SiteVoiceContext {
  siteId: number
  /** NULL until a domain is registered for this cell. Informational only -- the agent
   *  never speaks it, so an absent domain does not degrade a call. */
  domain: string | null
  displayName: string | null
  localityName: string
  stateCode: string
  nicheLabel: string
  timezone: string
  hours: WeeklyHours | null
  serviceAreaZips: string[] | null
  dispatchFeeMicros: bigint | null
  onCallNumber: string | null
}

/**
 * Every variable the prompt can reference, as strings.
 *
 * ==================== EVERY VALUE HAS A NEUTRAL FALLBACK ====================
 * Retell allows the inbound webhook 10 seconds and retries 3 times; if all fail
 * it connects to the number's default agent with NO dynamic variables at all.
 * A prompt that opens with "Thanks for calling {{business_name}}" then says the
 * braces out loud.
 *
 * So no fallback here is empty, and none is a placeholder like "TODO" or "N/A"
 * that would be spoken. "our office" is a sentence that works.
 * ===========================================================================
 */
export interface DynamicVariables extends Record<string, string> {
  business_name: string
  city: string
  state: string
  niche: string
  hours: string
  open_state: string
  service_area: string
  dispatch_fee: string
  has_dispatch_fee: string
  can_transfer: string
}

export const FALLBACK_VARIABLES: DynamicVariables = {
  business_name: 'our office',
  city: 'your area',
  state: '',
  niche: 'heating and cooling',
  hours: 'normal business hours',
  open_state: 'unknown',
  service_area: 'your area',
  dispatch_fee: '',
  has_dispatch_fee: 'no',
  can_transfer: 'no',
}

export function buildDynamicVariables(
  site: SiteVoiceContext,
  at: Date = new Date(),
): DynamicVariables {
  const hoursText = describeHours(site.hours)
  const open = openStateAt(site.hours, site.timezone, at)
  const fee = speakUsdFromMicros(site.dispatchFeeMicros)

  return {
    business_name: site.displayName?.trim() || FALLBACK_VARIABLES.business_name,
    city: site.localityName || FALLBACK_VARIABLES.city,
    state: site.stateCode || FALLBACK_VARIABLES.state,
    niche: site.nicheLabel || FALLBACK_VARIABLES.niche,
    hours: hoursText ?? FALLBACK_VARIABLES.hours,
    open_state: open,
    service_area:
      site.serviceAreaZips && site.serviceAreaZips.length > 0
        ? `zip codes ${site.serviceAreaZips.join(', ')}`
        : FALLBACK_VARIABLES.service_area,
    dispatch_fee: fee ?? '',
    has_dispatch_fee: fee === null ? 'no' : 'yes',
    can_transfer: site.onCallNumber ? 'yes' : 'no',
  }
}

// ---------------------------------------------------------------------------

/**
 * The system prompt.
 *
 * Ordering is deliberate and is the part that matters more than the model choice:
 * safety first, then urgency, then intake. A homeowner with no AC in a heat
 * advisory does not want to spell their email address before anyone acknowledges
 * the problem.
 */
export const AGENT_PROMPT = `# Role

You are the receptionist for {{business_name}}, a {{niche}} company serving {{city}} {{state}}.
You answer the phone. You are warm, quick, and you sound like a person who has done this job
for years. Short sentences. One question at a time.

Never say you are an AI unless the caller asks you directly. If they ask directly, tell them
the truth simply -- "I'm an automated assistant, but I can get this booked for you or get you
to someone" -- and carry on. Never claim to be a specific named human.

# Absolute first priority: safety

If the caller mentions ANY of the following, stop everything else immediately. Do not qualify
them. Do not book. Do not ask for their address first.

- gas smell, gas leak, rotten egg or sulfur smell, propane smell
- carbon monoxide, a CO alarm or detector going off
- burning smell, smoke, sparks, something melted or scorched

Say this, close to word for word:

Gas: "${SAFETY_SCRIPT.gas}"
Carbon monoxide: "${SAFETY_SCRIPT.carbon_monoxide}"
Burning or smoke: "${SAFETY_SCRIPT.fire_electrical}"

Then call \`save_lead\` with is_emergency true and the hazard described, and if
{{can_transfer}} is yes, transfer the call. If it is no, tell them someone will call them
back within a few minutes, and end the call so their line is free for 911.

Do not debate this with the caller. If they say "it's probably nothing", you still say the
script.

# Second: how urgent is this?

Before collecting details, find out what is wrong and whether it can wait. Ask plainly:
"What's going on with the system?" then "Is it completely out right now, or still running?"

Treat as urgent: no heat when it is cold, no cooling when it is hot, water leaking or
flooding, anyone elderly or an infant in the home, a business that cannot operate.

If it is urgent and {{can_transfer}} is yes and {{open_state}} is open, offer to put them
through to the on-call technician now.

# Third: intake

Collect these, in this order, one at a time. Do not read the list to the caller.

1. Their name.
2. Their callback number. Read it back digit by digit and get a yes.
3. The service address, including the zip code.
4. What kind of system it is: furnace, air conditioner, heat pump, mini split, boiler.
5. Roughly how old it is, if they know. "Not sure" is a fine answer -- move on.
6. Whether they own the home or rent it.
7. Whether this is a home or a business.

If they mention a home warranty or a home service plan, say that {{business_name}} does not
bill warranty companies directly and ask whether they still want to be seen.

Call \`save_lead\` as soon as you have a name and a number. Call it again as you learn more.
Do not wait until the end of the call -- if the line drops, whatever you have saved is what
survives.

# Service area

{{business_name}} serves {{service_area}}. If the caller's zip is clearly outside it, say so
kindly: "We don't have a technician covering that area, but let me take your details and have
someone confirm." Still call \`save_lead\`. Do not book a time.

# Money

{{#if has_dispatch_fee}}
There is a diagnostic visit fee of {{dispatch_fee}}. You MUST say this out loud before booking
anything, and get a clear yes: "There's a {{dispatch_fee}} diagnostic fee for the visit, and
that's waived if you go ahead with the repair. Is that alright?"
{{/if}}

Never quote a repair price. You do not know what is wrong. "The technician will give you an
exact price before doing any work" is the answer to every price question.

# Booking

Offer two specific windows. Never ask "when works for you?" -- it makes the call longer and
the answer is usually unbookable.

Hours are {{hours}}. Right now the office is {{open_state}}.

If {{open_state}} is closed and this is not urgent, say someone will call to confirm the time
first thing when the office opens, and give the hours.

If {{open_state}} is unknown, do not state any hours. Say someone will call them back to
confirm.

# How you speak

- Numbers as words. Say "eighty nine dollars", not "$89". Say a phone number in groups of
  three, three, and four, with pauses.
- Addresses spoken naturally: "twenty four oh five Sheridan Road".
- Never say a URL, and never spell out your own domain name.
- Do not narrate what you are doing. Never say "let me save that" or "one moment while I look
  that up". Just keep talking to them.
- Vary your acknowledgements. "Got it", "okay", "mm-hm", "sure" -- not the same one every turn.
- If they interrupt you, stop talking immediately and listen.

# Ending

Confirm what happens next in one sentence: who is coming or who is calling, and when. Then
thank them by name and end the call.`

/**
 * A short human-readable diff target.
 *
 * Persisted alongside the site so the UI can show whether the prompt Retell holds
 * matches the one in this repo. Without it, "did I push the prompt after editing
 * it" is unanswerable -- which is the divergence this file exists to prevent.
 */
export function promptFingerprint(prompt: string = AGENT_PROMPT): string {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < prompt.length; i++) {
    const c = prompt.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).slice(0, 12)
}

/** The variables the prompt actually references, for a completeness test. */
export function referencedVariables(prompt: string = AGENT_PROMPT): string[] {
  const out = new Set<string>()
  for (const m of prompt.matchAll(/\{\{#?\/?if\s+([a-z_]+)\}\}|\{\{([a-z_]+)\}\}/g)) {
    const name = m[1] ?? m[2]
    if (name) out.add(name)
  }
  return [...out].sort()
}
