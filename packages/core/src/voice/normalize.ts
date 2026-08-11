/**
 * Normalisation for the three identifiers this system joins on: domains, phone
 * numbers, and zips.
 *
 * All three arrive in more than one shape -- a domain typed with https:// and a
 * trailing slash, a phone number Twilio sends as +14145550134 and a human types
 * as (414) 555-0134 -- and every one of them is used as a lookup key. A site
 * whose tracking number is stored as "414-555-0134" is invisible to an inbound
 * webhook carrying "+14145550134", and the failure is a call that never resolves
 * to a site rather than an error anyone sees.
 */

// --- Domains -----------------------------------------------------------------

/**
 * Lowercase, no scheme, no www, no path, no trailing dot.
 *
 * Returns null rather than a best guess for anything that is not a plausible
 * hostname. `sites.domain` is UNIQUE, so a normaliser that quietly accepts
 * garbage creates rows that can never be matched again.
 */
export function normalizeDomain(input: string): string | null {
  let s = input.trim().toLowerCase()
  if (s === '') return null

  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
  s = s.replace(/^www\./, '')
  // Strip anything after the authority, plus a userinfo prefix and a port.
  s = s.split(/[/?#]/)[0] ?? ''
  s = s.split('@').pop() ?? ''
  s = s.split(':')[0] ?? ''
  s = s.replace(/\.+$/, '')
  if (s === '') return null

  // At least one dot, labels 1-63 of [a-z0-9-] not starting or ending with '-',
  // and a TLD that is alphabetic.
  const labels = s.split('.')
  if (labels.length < 2) return null
  for (const label of labels) {
    if (label.length === 0 || label.length > 63) return null
    if (!/^[a-z0-9-]+$/.test(label)) return null
    if (label.startsWith('-') || label.endsWith('-')) return null
  }
  const tld = labels[labels.length - 1]!
  if (!/^[a-z]{2,}$/.test(tld)) return null

  return s
}

// --- Phone numbers -----------------------------------------------------------

/**
 * To E.164, US/Canada assumed.
 *
 * Only NANP is handled because the whole system is US local service SEO. An
 * international number returns null rather than being coerced -- a wrong country
 * code produces a number that dials successfully to the wrong continent.
 */
export function toE164(input: string): string | null {
  const raw = input.trim()
  if (raw === '') return null

  // Already E.164 and not NANP: accept only well-formed, do not reshape.
  if (raw.startsWith('+')) {
    const digits = raw.slice(1).replace(/\D/g, '')
    if (digits.length < 8 || digits.length > 15) return null
    return `+${digits}`
  }

  const digits = raw.replace(/\D/g, '')
  if (digits.length === 10) {
    if (digits[0] === '0' || digits[0] === '1') return null // invalid NANP area code
    return `+1${digits}`
  }
  if (digits.length === 11 && digits[0] === '1') {
    if (digits[1] === '0' || digits[1] === '1') return null
    return `+${digits}`
  }
  return null
}

/** Display: "+14145550134" -> "(414) 555-0134". Non-NANP passes through. */
export function formatPhone(e164: string | null | undefined): string | null {
  if (!e164) return null
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164)
  if (!m) return e164
  return `(${m[1]}) ${m[2]}-${m[3]}`
}

/**
 * Speakable digits: "+14145550134" -> "4 1 4 ... 5 5 5 ... 0 1 3 4".
 *
 * TTS reads a bare 10-digit string as a single enormous number
 * ("four billion one hundred forty-five million..."), which is the single most
 * common way a phone agent gives itself away. Confirming a callback number is
 * the moment it matters most, because the caller is checking it digit by digit.
 */
export function speakPhone(e164: string | null | undefined): string | null {
  if (!e164) return null
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164)
  if (!m) return e164.replace(/\+/, '').split('').join(' ')
  const chunk = (s: string): string => s.split('').join(' ')
  return `${chunk(m[1]!)}, ${chunk(m[2]!)}, ${chunk(m[3]!)}`
}

// --- Zips --------------------------------------------------------------------

/** 5-digit US zip, ZIP+4 truncated to the 5. Null for anything else. */
export function normalizeZip(input: string | null | undefined): string | null {
  if (!input) return null
  const m = /(\d{5})(?:-\d{4})?/.exec(input.trim())
  return m ? m[1]! : null
}

/**
 * Is this zip in the site's service area?
 *
 * Returns `null` -- not `false` -- when the area is unconfigured or the zip is
 * unparseable. `leads.in_service_area` is nullable precisely so that "we never
 * checked" cannot be read as "outside the area", which would have the agent
 * decline a customer it should have booked.
 */
export function inServiceArea(
  zip: string | null | undefined,
  serviceAreaZips: readonly string[] | null | undefined,
): boolean | null {
  if (!serviceAreaZips || serviceAreaZips.length === 0) return null
  const z = normalizeZip(zip)
  if (z === null) return null
  return serviceAreaZips.some((s) => normalizeZip(s) === z)
}

// --- Money, spoken -----------------------------------------------------------

/**
 * Micros to a speakable dollar amount: 89_000_000n -> "eighty nine dollars".
 *
 * The agent must say the dispatch fee out loud and get an acknowledgement, so
 * this has to survive TTS. "$89.00" is read as "dollar eighty nine point zero
 * zero" by some voices; the words are unambiguous.
 */
export function speakUsdFromMicros(micros: bigint | null | undefined): string | null {
  if (micros === null || micros === undefined) return null
  const totalCents = micros / 10_000n
  const dollars = Number(totalCents / 100n)
  const cents = Number(totalCents % 100n)
  if (!Number.isFinite(dollars)) return null
  const d = `${dollars} dollar${dollars === 1 ? '' : 's'}`
  return cents === 0 ? d : `${d} and ${cents} cent${cents === 1 ? '' : 's'}`
}
