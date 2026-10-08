export const PITCH_CALLS = [
  'PURSUE',
  'PAID_ONLY',
  'NEEDS_REVIEW',
  'SKIP_NOT_PUBLICATION',
  'SKIP_CLOSED',
  'SKIP_STAFF_ROLE',
  'SKIP_NO_COMPANIES',
  'SKIP_MISALIGNED',
  'SKIP_DEAD',
] as const

export type PitchCall = (typeof PITCH_CALLS)[number]

export interface PitchPage {
  url: string
  status: number | null
  text: string
  hasContact: boolean
}

export interface PitchJudgement {
  verdict: PitchCall
  pitchUrl: string
  quote: string
  notes: string
}

const CLOSED = /currently closed to new|closed to new|not currently accepting guest|not accepting guest|not accepting submission|currently not accepting submission|do not accept guest|don't accept guest|no longer accepting guest|applications are closed|check back in fall|temporarily closed to/i
const STAFF = /permanent contributors|creator team|staff writer|assigned topics|not for guest posts or sponsored/i
const NOT_PUB = /honeymoon registry|gift list contribution|start your registry|find a registry/i
const OPEN = /write for us|guest post|how to pitch|contributor guidelines|submit (?:a|an|your) (?:story|article|guest)|pitch us/i
const PROPERTY = /\b(?:check availability|our rooms|our suites|our cabins|book your stay|book now|nightly rates?|view rooms|reserve your (?:stay|room|cabin))\b/i
const SHOP = /\b(?:add to cart|shop now|buy now)\b/i
const TOURISM = /\b(?:official (?:tourism|travel|visitor)|plan your visit|visitor center|welcome to .+ tourism)\b/i
const POETRY = /submit up to \d+ poems|submitting your poem/i
const NO_CO = /do not accept[^.]{0,80}(?:brands?|businesses?|companies|agencies)|companies must use paid advertising/i
const PAID = /sponsored (?:post|content)|advertise with us|guest post(?:ing)? (?:fee|price|rate)/i

export function pitchCallPresentation(verdict: string | null | undefined): {
  label: string
  tone: 'go' | 'stop' | 'warn' | 'neutral'
  detail: string
} {
  switch (verdict) {
    case 'PURSUE':
      return { label: 'Pursue', tone: 'go', detail: 'Passed the guest-post check' }
    case 'PAID_ONLY':
      return { label: 'Paid only', tone: 'warn', detail: 'Companies are sent to a paid placement' }
    case 'NEEDS_REVIEW':
      return { label: 'Needs review', tone: 'warn', detail: 'The pitch page could not be confirmed' }
    case 'SKIP_CLOSED':
      return { label: "Don't pitch", tone: 'stop', detail: 'Not accepting submissions' }
    case 'SKIP_NOT_PUBLICATION':
      return { label: "Don't pitch", tone: 'stop', detail: 'Not a guest-post publication' }
    case 'SKIP_STAFF_ROLE':
      return { label: "Don't pitch", tone: 'stop', detail: 'Hiring staff, not a guest post' }
    case 'SKIP_NO_COMPANIES':
      return { label: "Don't pitch", tone: 'stop', detail: 'Companies are excluded' }
    case 'SKIP_MISALIGNED':
      return { label: "Don't pitch", tone: 'stop', detail: 'No workable HotelHotTubs piece' }
    case 'SKIP_DEAD':
      return { label: "Don't pitch", tone: 'stop', detail: 'Publication looks inactive' }
    default:
      return { label: 'Not evaluated', tone: 'neutral', detail: '' }
  }
}

export function judgePitchPages(domain: string, pages: PitchPage[]): PitchJudgement {
  const readable = pages.filter((page) => page.text.trim().length >= 40 && (page.status == null || page.status < 400))
  const guidelines = readable
    .filter((page) => /write-for-us|guest-post|contribute|submission|how-to-pitch|work-with|\/pitch\/?$/i.test(page.url))
    .sort((a, b) => scoreUrl(b.url) - scoreUrl(a.url))
  const home = readable.find((page) => {
    try { return new URL(page.url).pathname === '/' } catch { return false }
  }) ?? readable[0]
  const chosen = guidelines[0] ?? home

  if (!chosen) {
    if (isPlatform(domain) || isOperator(domain, '')) {
      return skip('SKIP_NOT_PUBLICATION', pages[0]?.url ?? `https://${domain}/`, domain, 'This site is not a guest-post publication.')
    }
    const attempted = pages[0]?.url ?? `https://${domain}/`
    return {
      verdict: 'NEEDS_REVIEW',
      pitchUrl: attempted,
      quote: pages[0] ? `${pages[0].status ?? 'unread'} ${attempted}` : attempted,
      notes: 'Could not read a page for this domain.',
    }
  }

  const text = chosen.text
  const closed = excerpt(text, CLOSED)
  const staff = excerpt(text, STAFF)
  const notPub = excerpt(text, NOT_PUB)
  const open = excerpt(text, OPEN)
  const hasGuidelines = guidelines.includes(chosen) || Boolean(open)

  if (notPub && !OPEN.test(text.slice(0, 2500))) {
    return skip('SKIP_NOT_PUBLICATION', chosen.url, notPub, 'The page is a registry or gift list.')
  }
  if (POETRY.test(text) && !OPEN.test(text)) {
    return skip('SKIP_MISALIGNED', chosen.url, excerpt(text, POETRY), 'Submissions on this page are poems.')
  }
  if (closed) {
    return skip('SKIP_CLOSED', chosen.url, closed, 'The page says submissions are closed.')
  }
  if (staff) {
    return skip('SKIP_STAFF_ROLE', chosen.url, staff, 'The page is recruiting permanent contributors.')
  }
  const noco = excerpt(text, NO_CO)
  const paid = excerpt(text, PAID)
  if (hasGuidelines && noco) {
    if (paid) {
      return {
        verdict: 'PAID_ONLY',
        pitchUrl: chosen.url,
        quote: `${noco} ${paid}`.trim().slice(0, 300),
        notes: 'Companies are excluded from editorial and pointed at a paid route.',
      }
    }
    return skip('SKIP_NO_COMPANIES', chosen.url, noco, 'The page excludes companies.')
  }
  if (isPlatform(domain)) {
    return skip('SKIP_NOT_PUBLICATION', chosen.url, domain, 'This domain is a platform, app, or reference site.')
  }
  if (!hasGuidelines && isOperator(domain, text)) {
    const quote = excerpt(text, PROPERTY) || excerpt(text, SHOP) || excerpt(text, TOURISM) || domain
    return skip('SKIP_NOT_PUBLICATION', chosen.url, quote, 'The site sells stays, products, or a destination, and no guest-post page was found.')
  }
  if (hasGuidelines && (open || /submit|pitch|guest post|write for/i.test(text))) {
    return {
      verdict: 'PURSUE',
      pitchUrl: chosen.url,
      quote: open || excerpt(text, /submit|pitch|guest post|write for/i),
      notes: '',
    }
  }
  return {
    verdict: 'NEEDS_REVIEW',
    pitchUrl: chosen.url,
    quote: '',
    notes: 'No guest-post or write-for-us page was found, so this has not passed.',
  }
}

function skip(verdict: PitchCall, pitchUrl: string, quote: string, notes: string): PitchJudgement {
  return { verdict, pitchUrl, quote, notes }
}

function isOperator(domain: string, text: string): boolean {
  const host = domain.toLowerCase().replace(/^www\./, '')
  if (/(cabin|lodges?|inn|resort|rental|hottub|hot-tub|jacuzzi|pools?|tubs?|suites|manor)/.test(host)) return true
  if (host.endsWith('.travel') || host.startsWith('visit')) return true
  return PROPERTY.test(text) || SHOP.test(text) || TOURISM.test(text)
}

function isPlatform(domain: string): boolean {
  const host = domain.toLowerCase().replace(/^www\./, '')
  if (host.endsWith('.gov') || host.endsWith('.gov.uk') || host.endsWith('.edu') || host.endsWith('.app')) return true
  return ['wikipedia.org', 'medium.com', 'lemon8-app.com'].includes(host)
}

function scoreUrl(url: string): number {
  if (/write-for-us|how-to-pitch|guest-post-guidelines/i.test(url)) return 8
  if (/guest-post|submission|contribute|\/pitch\/?$/i.test(url)) return 5
  return 0
}

function excerpt(text: string, pattern: RegExp): string {
  const match = pattern.exec(text)
  if (!match) return ''
  const from = Math.max(0, match.index - 40)
  const to = Math.min(text.length, match.index + match[0].length + 140)
  return text.slice(from, to).replace(/\s+/g, ' ').trim().slice(0, 300)
}
