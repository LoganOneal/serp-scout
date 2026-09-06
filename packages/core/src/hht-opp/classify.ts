import { excerptAround, firstMatch, makeEvidence } from './evidence.js'
import type {
  HhtOppEvidence,
  HhtOppInventedType,
  HhtOppLinkType,
  HhtOppSeoRisk,
  HhtOppType,
} from './types.js'

export interface ClassifiedOpportunity {
  type: HhtOppType
  inventedType: HhtOppInventedType | null
  why: string
  evidence: HhtOppEvidence
  opportunityUrl: string
}

export interface PageSignalInput {
  url: string
  title: string | null
  text: string
  html?: string | null
}

const TYPE_PATTERNS: Array<{
  type: HhtOppType
  patterns: RegExp[]
  why: string
}> = [
  {
    type: 'unlinked_mention',
    patterns: [
      /\bhotel\s*hot\s*tubs\b/i,
      /\bhotelhottubs(?:\.com)?\b/i,
    ],
    why: 'Page mentions HotelHotTubs without a confirmed outbound link.',
  },
  {
    type: 'paid_link_insertion',
    patterns: [
      /link insertion/i,
      /insert (?:a |your )?link/i,
      /add (?:a |your )?link to an existing (?:article|post)/i,
    ],
    why: 'Publisher offers insertion into an existing article.',
  },
  {
    type: 'sponsored_content',
    patterns: [
      /sponsored (?:post|content|article)/i,
      /advertorial/i,
      /branded content/i,
      /native advertising/i,
    ],
    why: 'Publisher sells sponsored or advertorial placement.',
  },
  {
    type: 'paid_guest_post',
    patterns: [
      /paid guest post/i,
      /sponsored guest post/i,
      /guest post(?:ing)? (?:rate|price|package|fee)/i,
      /charge[sd]? .* (?:to )?(?:publish|guest post)/i,
    ],
    why: 'Publisher explicitly charges to publish a contributed article.',
  },
  {
    type: 'editorial_guest',
    patterns: [
      /write for us/i,
      /guest contribut(?:or|ion)/i,
      /become a contributor/i,
      /submit (?:an? )?(?:article|story|pitch)/i,
      /freelance pitch/i,
      /contribute a story/i,
      /contributors wanted/i,
      /pitch us/i,
      /editorial submissions/i,
      /guest post(?:ing)? guidelines/i,
      /guest blog/i,
    ],
    why: 'Publisher accepts editorial guest contributions.',
  },
  {
    type: 'directory_listing',
    patterns: [
      /submit (?:your )?(?:listing|website|site)/i,
      /add your (?:business|hotel|website)/i,
      /resource directory/i,
      /travel directory/i,
      /hotel directory/i,
      /business directory/i,
    ],
    why: 'Site offers a directory or listing submission.',
  },
  {
    type: 'resource_page',
    patterns: [
      /useful (?:hotel|travel|planning) resources/i,
      /best travel websites/i,
      /romantic travel resources/i,
      /hotel booking resources/i,
      /recommended (?:resources|tools|websites)/i,
    ],
    why: 'Page is a curated resource list that could include HotelHotTubs.',
  },
  {
    type: 'expert_source',
    patterns: [
      /expert commentary/i,
      /quote (?:a |an )?(?:expert|source)/i,
      /hospitality experts/i,
      /travel expert/i,
      /contribute a quote/i,
      /expert sources?/i,
    ],
    why: 'Site accepts expert commentary or sourced quotes.',
  },
  {
    type: 'hotel_tourism_partnership',
    patterns: [
      /partner with us/i,
      /become a partner/i,
      /tourism (?:partner|board)/i,
      /destination marketing/i,
      /convention and visitors/i,
      /cvb\b/i,
    ],
    why: 'Organization may partner with travel or hotel research brands.',
  },
  {
    type: 'data_pr',
    patterns: [
      /submit (?:a )?tip/i,
      /press (?:inquir|contact)/i,
      /story idea/i,
      /original research/i,
    ],
    why: 'Publication may cite original hotel-amenity research.',
  },
  {
    type: 'existing_article',
    patterns: [
      /hotels? with (?:a )?(?:hot tub|jacuzzi|whirlpool)/i,
      /romantic hotels?/i,
      /honeymoon hotels?/i,
      /weekend getaways?/i,
      /jacuzzi suites?/i,
      /private hot tubs?/i,
    ],
    why: 'Existing article is topically relevant for a citation or insertion.',
  },
]

const PAID_LANGUAGE = /sponsored|paid guest|advertorial|media kit|advertise|advertising|link insertion|branded content|contributor package/i

const DOFOLLOW = /\bdofollow\b/i
const NOFOLLOW = /\bnofollow\b/i
const SPONSORED_REL = /\brel=["']?sponsored|\bsponsored attribute|\bno.?follow.*sponsored/i
const BIO_LINK = /author bio(?:graphy)? link|bio link|byline link/i
const CONTEXTUAL = /contextual (?:back)?link|in.?content link|one (?:dofollow )?link in the (?:body|article)/i
const PROHIBITED = /no (?:back)?links? (?:allowed|permitted)|links? (?:are )?not allowed|we do not accept links/i

const HIGH_RISK = [
  /buy (?:cheap )?(?:dofollow )?seo links?/i,
  /casino|crypto|cbd|payday loan|sportsbook/i,
  /private blog network|\bpbn\b/i,
  /dozens of sponsored posts? (?:a|per) day/i,
  /sell(?:s|ing)? (?:guest posts?|backlinks?)/i,
]

const MEDIUM_RISK = [
  /sponsored post/i,
  /paid guest post/i,
  /link insertion/i,
  /media kit/i,
]

const URL_TYPE_HINTS: Array<{ type: HhtOppType; pattern: RegExp; why: string }> = [
  { type: 'editorial_guest', pattern: /write-for-us|contribute|guest-post|submissions?/i, why: 'URL path is an editorial contribution page.' },
  { type: 'sponsored_content', pattern: /advertise|advertising|media-kit|sponsorship|sponsored/i, why: 'URL path is an advertising or media-kit page.' },
  { type: 'hotel_tourism_partnership', pattern: /partners?|partnerships?|work-with-us/i, why: 'URL path is a partnership page.' },
  { type: 'directory_listing', pattern: /submit-listing|add-your|directory/i, why: 'URL path is a listing or directory submission page.' },
]

export function classifyOpportunityTypes(page: PageSignalInput, checkedAt = new Date()): ClassifiedOpportunity[] {
  const text = `${page.title ?? ''}\n${page.text}`
  const found: ClassifiedOpportunity[] = []
  const seen = new Set<HhtOppType>()

  for (const hint of URL_TYPE_HINTS) {
    const match = page.url.match(hint.pattern)
    if (!match?.[0] || seen.has(hint.type)) continue
    seen.add(hint.type)
    found.push({
      type: hint.type,
      inventedType: null,
      why: hint.why,
      opportunityUrl: page.url,
      evidence: makeEvidence(page.url, page.url, match[0], 'HIGH', checkedAt),
    })
  }

  for (const rule of TYPE_PATTERNS) {
    const match = firstMatch(text, rule.patterns)
    if (!match?.[0] || seen.has(rule.type)) continue
    seen.add(rule.type)
    found.push({
      type: rule.type,
      inventedType: null,
      why: rule.why,
      opportunityUrl: page.url,
      evidence: makeEvidence(page.url, text, match[0], 'HIGH', checkedAt),
    })
  }

  if (found.length === 0 && PAID_LANGUAGE.test(text)) {
    const match = text.match(PAID_LANGUAGE)
    found.push({
      type: 'sponsored_content',
      inventedType: null,
      why: 'Paid-placement language is present; package type is not more specific.',
      opportunityUrl: page.url,
      evidence: makeEvidence(page.url, text, match?.[0] ?? 'sponsored', 'MEDIUM', checkedAt),
    })
  }

  return found
}

export function classifyLinkType(text: string): { linkType: HhtOppLinkType; evidence: string | null } {
  if (PROHIBITED.test(text)) return { linkType: 'prohibited', evidence: excerptAround(text, 'not allowed') }
  const sponsored = SPONSORED_REL.test(text) || /\bsponsored\b/i.test(text) && /link/i.test(text)
  const nofollow = NOFOLLOW.test(text)
  const dofollow = DOFOLLOW.test(text)
  const bio = BIO_LINK.test(text)
  const contextual = CONTEXTUAL.test(text) || (!bio && (dofollow || nofollow || sponsored))

  if (bio && nofollow) return { linkType: 'bio_nofollow', evidence: excerptAround(text, 'bio') }
  if (bio && dofollow) return { linkType: 'bio_dofollow', evidence: excerptAround(text, 'bio') }
  if (/directory|listing/i.test(text) && nofollow) return { linkType: 'directory_nofollow', evidence: excerptAround(text, 'nofollow') }
  if (/directory|listing/i.test(text) && dofollow) return { linkType: 'directory_dofollow', evidence: excerptAround(text, 'dofollow') }
  if (contextual && sponsored) return { linkType: 'contextual_sponsored', evidence: excerptAround(text, 'sponsored') }
  if (contextual && nofollow) return { linkType: 'contextual_nofollow', evidence: excerptAround(text, 'nofollow') }
  if (contextual && dofollow) return { linkType: 'contextual_dofollow', evidence: excerptAround(text, 'dofollow') }
  return { linkType: 'unknown', evidence: null }
}

export function classifySeoRisk(input: {
  text: string
  title?: string | null
  outboundCommercialDensity?: number | null
  organicTraffic?: number | null
}): { risk: HhtOppSeoRisk; reasons: string[] } {
  const blob = `${input.title ?? ''}\n${input.text}`
  const reasons: string[] = []

  for (const pattern of HIGH_RISK) {
    const match = blob.match(pattern)
    if (match) reasons.push(`High-risk language: “${match[0]}”`)
  }
  if ((input.outboundCommercialDensity ?? 0) >= 0.35) {
    reasons.push('High density of outbound commercial links in the sampled pages.')
  }
  if (input.organicTraffic === 0) {
    reasons.push('Measured organic traffic is zero.')
  }

  if (reasons.length >= 1 && HIGH_RISK.some((p) => p.test(blob))) {
    return { risk: 'HIGH', reasons }
  }
  if (reasons.length > 0) return { risk: 'HIGH', reasons }

  const mediumHits = MEDIUM_RISK.filter((p) => p.test(blob))
  if (mediumHits.length > 0) {
    return {
      risk: 'MEDIUM',
      reasons: mediumHits.map((p) => `Paid-placement language: “${blob.match(p)?.[0]}”`),
    }
  }
  return { risk: 'LOW', reasons: ['No high-risk sale-of-links language detected in crawled text.'] }
}

export const NAV_PATH_HINTS = [
  'write-for-us',
  'write-for-me',
  'contribute',
  'contributor',
  'guest-post',
  'guest-posts',
  'submissions',
  'submit',
  'advertise',
  'advertising',
  'media-kit',
  'mediakit',
  'sponsorship',
  'sponsored',
  'partners',
  'partnership',
  'work-with-us',
  'collaborate',
  'press',
  'editorial',
  'guidelines',
  'contact',
  'about',
] as const

export function looksLikeOpportunityPath(href: string): boolean {
  const lower = href.toLowerCase()
  return NAV_PATH_HINTS.some((hint) => lower.includes(hint))
}
