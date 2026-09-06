import { allMatches, collapseWs, excerptAround, firstMatch, makeEvidence } from './evidence.js'
import type {
  HhtOppConfidence,
  HhtOppContactStatus,
  HhtOppEvidence,
  HhtOppPriceStatus,
  HhtOppPricingModel,
  HhtOppRequirementGroup,
} from './types.js'

export interface ExtractedRequirement {
  group: HhtOppRequirementGroup
  label: string
  requirementText: string
  sourceUrl: string
  sourceExcerpt: string
  dateChecked: string
  confidence: HhtOppConfidence
}

export interface ExtractedPrice {
  amount: number | null
  currency: string | null
  status: HhtOppPriceStatus
  pricingModel: HhtOppPricingModel
  included: string | null
  evidence: HhtOppEvidence | null
}

export interface ExtractedContact {
  email: string | null
  name: string | null
  role: string | null
  formUrl: string | null
  status: HhtOppContactStatus
  sourceUrl: string
  sourceExcerpt: string | null
}

const WORD_COUNT = /(?:minimum|at least|min(?:imum)?\.?)\s+(\d{3,5})\s+(?:words?)/i
const WORD_COUNT_RANGE = /(\d{3,5})\s*[–-]\s*(\d{3,5})\s+words/i
const WORD_COUNT_PLUS = /(\d{3,5})\+?\s+words/i
const ORIGINAL = /original(?:ly written)?|no previously published|must be unique/i
const AI_RULES = /(?:no |not )\s*ai[- ]generated|ai(?:-generated)? content (?:is )?(?:not |prohibited|banned)/i
const PITCH_FIRST = /pitch (?:us |your idea )?before|query first|send a pitch/i
const FULL_DRAFT = /submit (?:a )?(?:complete|full) (?:draft|article)/i
const NO_PROMO = /no promotional(?: copy| language| content)?|not a sales pitch/i
const FIRSTHAND = /first[- ]hand experience|must have visited|personal experience required/i
const IMAGES = /(?:original )?(?:photos?|photography|images?) (?:required|preferred|must)/i
const BIO = /author bio|short biography|headshot/i
const FORM = /submission form|use the form|submit via (?:the )?form/i
const SIGNUP = /create an account|register to submit|sign up to contribute/i
const TURNOVER = /(?:turnaround|review) (?:time|within)[^\n.]{0,40}/i

const PRICE = /(?:usd|us\$|\$)\s?(\d{2,5}(?:,\d{3})?(?:\.\d{2})?)|(?:(\d{2,5}(?:,\d{3})?(?:\.\d{2})?)\s*(?:usd|dollars))/i
const QUOTE = /contact (?:us )?for (?:pricing|rates|a quote)|pricing (?:available )?upon request|request a quote/i
const FREE = /free to submit|no fee|complimentary listing|no charge/i
const PUBLISHER_PAYS = /we pay (?:our )?(?:writers?|contributors?)|paid (?:for )?(?:your )?(?:work|article)/i
const ANNUAL = /per year|\/year|annual(?:ly)?/i
const MONTHLY = /per month|\/month|monthly/i

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi
const MAILTO = /mailto:([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/gi

const EDITORIAL_HINT = /editor|editorial|submit|contributor|guest|partnerships?|advertise|sponsor/i
const GUESSED_PREFIXES = /^(info|hello|hi|admin|support|webmaster|sales|noreply|no-reply)@/i

function requirement(
  group: HhtOppRequirementGroup,
  label: string,
  text: string,
  url: string,
  match: string,
  confidence: HhtOppConfidence,
  checkedAt: Date,
): ExtractedRequirement {
  return {
    group,
    label,
    requirementText: collapseWs(match),
    sourceUrl: url,
    sourceExcerpt: excerptAround(text, match),
    dateChecked: checkedAt.toISOString(),
    confidence,
  }
}

export function extractRequirements(
  url: string,
  text: string,
  checkedAt = new Date(),
): ExtractedRequirement[] {
  const rows: ExtractedRequirement[] = []
  const add = (
    group: HhtOppRequirementGroup,
    label: string,
    pattern: RegExp,
    confidence: HhtOppConfidence = 'HIGH',
  ) => {
    const match = text.match(pattern)
    if (match?.[0]) rows.push(requirement(group, label, text, url, match[0], confidence, checkedAt))
  }

  const range = text.match(WORD_COUNT_RANGE)
  if (range?.[0]) {
    rows.push(requirement('content', 'Word count', text, url, range[0], 'HIGH', checkedAt))
  } else {
    add('content', 'Word count', WORD_COUNT)
    if (!rows.some((r) => r.label === 'Word count')) add('content', 'Word count', WORD_COUNT_PLUS, 'MEDIUM')
  }

  add('content', 'Originality', ORIGINAL)
  add('content', 'AI-content rules', AI_RULES)
  add('content', 'Promotional restrictions', NO_PROMO)
  add('contributor', 'Firsthand experience', FIRSTHAND)
  add('contributor', 'Bio requirements', BIO)
  add('image', 'Photography', IMAGES)
  add('submission', 'Pitch first', PITCH_FIRST)
  add('submission', 'Complete draft', FULL_DRAFT)
  add('submission', 'Form', FORM)
  add('submission', 'Account signup', SIGNUP)
  add('submission', 'Turnaround', TURNOVER, 'MEDIUM')

  return dedupeRequirements(rows)
}

export function summarizeRequirements(rows: ExtractedRequirement[], limit = 6): string[] {
  const preferred = [
    'Businesses permitted',
    'Word count',
    'Pitch first',
    'Complete draft',
    'Photography',
    'Promotional restrictions',
    'Originality',
    'AI-content rules',
    'Form',
  ]
  const byLabel = new Map(rows.map((r) => [r.label, r.requirementText]))
  const out: string[] = []
  for (const label of preferred) {
    const text = byLabel.get(label)
    if (text) out.push(`${label}: ${text}`)
    if (out.length >= limit) return out
  }
  for (const row of rows) {
    if (out.length >= limit) break
    if (!out.some((line) => line.startsWith(`${row.label}:`))) out.push(`${row.label}: ${row.requirementText}`)
  }
  return out.slice(0, limit)
}

function dedupeRequirements(rows: ExtractedRequirement[]): ExtractedRequirement[] {
  const seen = new Set<string>()
  const out: ExtractedRequirement[] = []
  for (const row of rows) {
    const key = `${row.group}:${row.label}:${row.requirementText.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(row)
  }
  return out
}

export function extractPricing(url: string, text: string, checkedAt = new Date()): ExtractedPrice {
  if (FREE.test(text) && !PRICE.test(text)) {
    const match = text.match(FREE)
    return {
      amount: 0,
      currency: 'USD',
      status: 'FREE',
      pricingModel: 'one_time',
      included: null,
      evidence: match ? makeEvidence(url, text, match[0], 'HIGH', checkedAt) : null,
    }
  }

  if (PUBLISHER_PAYS.test(text) && !PRICE.test(text)) {
    const match = text.match(PUBLISHER_PAYS)
    return {
      amount: null,
      currency: null,
      status: 'PUBLISHER_PAYS',
      pricingModel: 'unspecified',
      included: null,
      evidence: match ? makeEvidence(url, text, match[0], 'HIGH', checkedAt) : null,
    }
  }

  const priceMatch = firstMatch(text, [PRICE])
  if (priceMatch) {
    const raw = (priceMatch[1] ?? priceMatch[2] ?? '').replace(/,/g, '')
    const amount = Number(raw)
    if (Number.isFinite(amount) && amount > 0) {
      const window = excerptAround(text, priceMatch[0], 80)
      const pricingModel: HhtOppPricingModel = ANNUAL.test(window)
        ? 'annual'
        : MONTHLY.test(window)
          ? 'monthly'
          : 'one_time'
      return {
        amount,
        currency: 'USD',
        status: 'FIXED',
        pricingModel,
        included: null,
        evidence: makeEvidence(url, text, priceMatch[0], 'HIGH', checkedAt),
      }
    }
  }

  if (QUOTE.test(text) || /advertise|sponsored|media kit|paid guest/i.test(text)) {
    const match = text.match(QUOTE) ?? text.match(/advertise|sponsored|media kit|paid guest/i)
    return {
      amount: null,
      currency: null,
      status: 'QUOTE_REQUIRED',
      pricingModel: 'unspecified',
      included: null,
      evidence: match ? makeEvidence(url, text, match[0], match[0].match(QUOTE) ? 'HIGH' : 'MEDIUM', checkedAt) : null,
    }
  }

  return {
    amount: null,
    currency: null,
    status: 'UNKNOWN',
    pricingModel: 'unspecified',
    included: null,
    evidence: null,
  }
}

export function formatPrice(price: ExtractedPrice): string {
  if (price.status === 'FREE') return 'Free'
  if (price.status === 'PUBLISHER_PAYS') return 'Publisher pays writer'
  if (price.status === 'FIXED' && price.amount != null) {
    const period = price.pricingModel === 'annual' ? ' / year' : price.pricingModel === 'monthly' ? ' / month' : ''
    return `$${price.amount}${period}`
  }
  if (price.status === 'QUOTE_REQUIRED') return 'Price unknown — contact publisher'
  return '—'
}

export function extractContacts(url: string, text: string, html?: string | null): ExtractedContact[] {
  const contacts: ExtractedContact[] = []
  const seen = new Set<string>()

  const mailto = html ? allMatches(html, [MAILTO]) : []
  for (const match of mailto) {
    const email = (match[1] ?? '').toLowerCase()
    if (!email || seen.has(email) || GUESSED_PREFIXES.test(email)) continue
    seen.add(email)
    contacts.push({
      email,
      name: null,
      role: EDITORIAL_HINT.test(email) ? 'editorial' : null,
      formUrl: null,
      status: 'VERIFIED_PUBLIC',
      sourceUrl: url,
      sourceExcerpt: `mailto:${email}`,
    })
  }

  const emails = text.match(EMAIL) ?? []
  for (const raw of emails) {
    const email = raw.toLowerCase()
    if (seen.has(email) || GUESSED_PREFIXES.test(email)) continue
    seen.add(email)
    const editorial = EDITORIAL_HINT.test(email) || EDITORIAL_HINT.test(excerptAround(text, raw, 40))
    contacts.push({
      email,
      name: null,
      role: editorial ? 'editorial' : null,
      formUrl: null,
      status: editorial ? 'VERIFIED_PUBLIC' : 'INFERRED',
      sourceUrl: url,
      sourceExcerpt: excerptAround(text, raw, 60),
    })
  }

  const form = text.match(FORM)
  if (form && /form/i.test(url)) {
    contacts.push({
      email: null,
      name: null,
      role: 'submission_form',
      formUrl: url,
      status: 'VERIFIED_PUBLIC',
      sourceUrl: url,
      sourceExcerpt: excerptAround(text, form[0]),
    })
  }

  return contacts
}

export function pickPrimaryContact(contacts: ExtractedContact[]): ExtractedContact | null {
  const rank = (c: ExtractedContact): number => {
    if (c.status === 'VERIFIED_PUBLIC' && c.email && EDITORIAL_HINT.test(c.email)) return 0
    if (c.status === 'VERIFIED_PUBLIC' && c.email) return 1
    if (c.status === 'VERIFIED_PUBLIC' && c.formUrl) return 2
    if (c.status === 'INFERRED' && c.email) return 3
    return 4
  }
  return [...contacts].sort((a, b) => rank(a) - rank(b))[0] ?? null
}
