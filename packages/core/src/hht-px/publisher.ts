import type { HhtPxEvidenceState, HhtPxPageType, HhtPxPublisherLane, HhtPxQualification } from './types.js'
import { HHT_PX_COMPETITOR_DOMAINS, HHT_PX_EXCLUDED_DOMAINS, HHT_PX_HOTEL_CHAIN_DOMAINS, HHT_PX_OTA_DOMAINS } from './classify.js'
import { hhtPxRootDomain } from './urls.js'

/**
 * Known brands where a $50–100 article insertion is implausible.
 * Membership is the company, not a guess from the domain wording.
 */
export const HHT_PX_MAJOR_PUBLISHERS: ReadonlySet<string> = new Set([
  'cntraveler.com',
  'cntraveller.com',
  'travelandleisure.com',
  'usnews.com',
  'usatoday.com',
  'theknot.com',
  'weddingwire.com',
  'brides.com',
  'nytimes.com',
  'washingtonpost.com',
  'wsj.com',
  'forbes.com',
  'lonelyplanet.com',
  'nationalgeographic.com',
  'afar.com',
  'fodors.com',
  'frommers.com',
  'timeout.com',
  'people.com',
  'cosmopolitan.com',
  'vogue.com',
  'instyle.com',
  'elle.com',
  'harpersbazaar.com',
  'goodhousekeeping.com',
  'midwestliving.com',
  'southernliving.com',
  'countryliving.com',
  'parade.com',
  'elitedaily.com',
  'aaa.com',
  'npr.org',
  'bbc.com',
  'theguardian.com',
  'latimes.com',
  'chicagotribune.com',
  'usmagazine.com',
  'travelchannel.com',
  'condenast.com',
])

/** Official tourism organizations and lodging associations already identified as such. */
export const HHT_PX_EARNED_ORGANIZATIONS: ReadonlySet<string> = new Set([
  'historichotels.org',
  'selectregistry.com',
])

const UGC = new Set(['reddit.com', 'quora.com', 'lemon8-app.com'])

export interface PublisherInspection {
  title: string | null
  headings: string[]
  hrefs: string[]
  text: string
}

export interface PublisherAssessment {
  lane: HhtPxPublisherLane
  reason: string
  evidence: HhtPxEvidenceState
  signals: string[]
  qualification: HhtPxQualification
  qualificationReason: string
  insertionLocation: string | null
  readerBenefit: string | null
  contactUrl: string | null
  editorialScore: number | null
  feasibilityScore: number | null
  editorialCoverage: string
  feasibilityCoverage: string
  scoreDetail: string
}

export function inspectPublisherHtml(html: string): PublisherInspection {
  const withoutScripts = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
  const headings = [...withoutScripts.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)]
    .map((match) => stripTags(match[1] ?? ''))
    .filter(Boolean)
    .slice(0, 40)
  const hrefs = [...withoutScripts.matchAll(/\shref\s*=\s*["']([^"']+)["']/gi)]
    .map((match) => match[1] ?? '')
    .filter(Boolean)
    .slice(0, 250)
  const title = stripTags(withoutScripts.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '') || null
  return { title, headings, hrefs, text: stripTags(withoutScripts).slice(0, 24_000) }
}

export function assessHhtPxPublisher(input: {
  url: string
  domain?: string | null
  pageType?: HhtPxPageType | null
  title?: string | null
  geographyName?: string | null
  bestPosition?: number | null
  volume?: number | null
  inspection?: PublisherInspection | null
}): PublisherAssessment {
  const domain = (input.domain ?? hhtPxRootDomain(input.url) ?? '').toLowerCase()
  const path = urlPath(input.url)
  const inspection = input.inspection
  const blob = normalize(
    [input.title, inspection?.title, ...(inspection?.headings ?? []), inspection?.text].filter(Boolean).join(' '),
  )
  const signals: string[] = []

  const structural = structuralExclusion(input.url, path, domain)
  if (structural) return finish(structural, input, inspection, blob, signals)

  if (UGC.has(domain)) {
    return finish(excluded('observed', 'Forum or user-generated discussion.', ['ugc']), input, inspection, blob, signals)
  }
  if (HHT_PX_OTA_DOMAINS.has(domain) || HHT_PX_EXCLUDED_DOMAINS.has(domain)) {
    return finish(excluded('observed', 'Booking marketplace, social profile, or search page.', ['marketplace_or_social']), input, inspection, blob, signals)
  }
  if (HHT_PX_HOTEL_CHAIN_DOMAINS.has(domain)) {
    return finish(excluded('observed', 'Hotel chain site. The page exists to take bookings.', ['hotel_chain']), input, inspection, blob, signals)
  }
  if (HHT_PX_COMPETITOR_DOMAINS.has(domain)) {
    return finish(excluded('observed', 'Direct hotel hot-tub directory competing with HHT.', ['competitor']), input, inspection, blob, signals)
  }
  if (HHT_PX_MAJOR_PUBLISHERS.has(domain)) {
    return finish(
      excluded('observed', 'Major publication. A $50–100 insertion is implausible, and no rate was found.', ['major_publisher']),
      input,
      inspection,
      blob,
      signals,
    )
  }
  if (HHT_PX_EARNED_ORGANIZATIONS.has(domain)) {
    return finish(earned('observed', 'Known tourism or lodging association.', ['known_association']), input, inspection, blob, signals)
  }

  if (!inspection) {
    return finish(
      {
        lane: 'needs_review',
        evidence: 'unknown',
        reason: 'The article has not been fetched, so the publisher business model is unconfirmed.',
        signals: ['not_fetched'],
        qualification: 'needs_review',
        qualificationReason: 'Business model is unknown until the page is inspected.',
      },
      input,
      inspection,
      blob,
      signals,
    )
  }

  const contactUrl = findContactUrl(input.url, inspection.hrefs)
  if (contactUrl) signals.push('contact_route')
  const lodging = looksLikeLodgingOperator(blob, inspection.headings)
  const tourism = looksLikeTourismOrganization(blob, inspection.hrefs)
  const roundup = looksLikeStayRoundup(blob, inspection.headings)
  const firsthand = /\b(we stayed|i stayed|our trip|we spent the weekend|i visited)\b/.test(blob)
  const independent = looksLikeIndependentPublisher(blob) || (firsthand && !lodging)
  if (lodging) signals.push('lodging_operator')
  if (tourism) signals.push('tourism_organization')
  if (roundup) signals.push('stay_roundup')
  if (independent) signals.push('independent_publisher')
  if (firsthand) signals.push('firsthand')
  if (/\baffiliate\b/.test(blob)) signals.push('affiliate_disclosure')

  if (lodging && !roundup) {
    return finish(
      excluded('observed', 'Lodging operator. The page sells its own rooms, cabins, or rentals.', signals),
      input,
      inspection,
      blob,
      signals,
    )
  }
  if (tourism && !independent) {
    return finish(earned('observed', 'Official tourism, chamber, or destination organization.', signals), input, inspection, blob, signals)
  }
  const inferredPublisher = roundup && Boolean(contactUrl) && !lodging && !tourism
  if ((independent || inferredPublisher) && (roundup || overnightLanguage(blob))) {
    return finish(
      {
        lane: 'paid_outreach',
        evidence: independent ? 'observed' : 'inferred',
        reason: independent
          ? 'Independent publisher with an overnight-travel article. Affiliate links, when present, do not make this a booking marketplace.'
          : 'Stay roundup with a contact or about link. Classified as an independent publisher from the page, not from the domain name.',
        signals,
        qualification: 'needs_review',
        qualificationReason: '',
      },
      input,
      inspection,
      blob,
      signals,
    )
  }

  return finish(
    {
      lane: 'needs_review',
      evidence: 'unknown',
      reason: 'Fetched the page and could not confirm an independent publisher, a lodging operator, or a tourism organization.',
      signals,
      qualification: 'needs_review',
      qualificationReason: 'Publisher business model is uncertain from the fetched page.',
    },
    input,
    inspection,
    blob,
    signals,
  )
}

function finish(
  base: {
    lane: HhtPxPublisherLane
    evidence: HhtPxEvidenceState
    reason: string
    signals: string[]
    qualification: HhtPxQualification
    qualificationReason: string
  },
  input: {
    url: string
    geographyName?: string | null
    bestPosition?: number | null
    volume?: number | null
    title?: string | null
  },
  inspection: PublisherInspection | null | undefined,
  blob: string,
  extraSignals: string[],
): PublisherAssessment {
  const signals = [...base.signals, ...extraSignals.filter((signal) => !base.signals.includes(signal))]
  const contactUrl = inspection ? findContactUrl(input.url, inspection.hrefs) : null
  if (base.lane !== 'paid_outreach') {
    return {
      lane: base.lane,
      reason: base.reason,
      evidence: base.evidence,
      signals,
      qualification: base.lane === 'excluded' ? 'excluded' : base.lane === 'earned_partnership' ? 'downgraded' : 'needs_review',
      qualificationReason: base.qualificationReason || base.reason,
      insertionLocation: null,
      readerBenefit: null,
      contactUrl,
      editorialScore: null,
      feasibilityScore: null,
      editorialCoverage: 'not scored; outside the paid-outreach list',
      feasibilityCoverage: 'not scored; outside the paid-outreach list',
      scoreDetail: 'Scores apply only after a page stays on the paid-outreach list.',
    }
  }

  const article = qualifyPaidArticle({
    blob,
    headings: inspection?.headings ?? [],
    geographyName: input.geographyName ?? null,
    contactUrl,
    signals,
  })
  const scores = scorePaidArticle({
    blob,
    headings: inspection?.headings ?? [],
    geographyName: input.geographyName ?? null,
    bestPosition: input.bestPosition ?? null,
    volume: input.volume ?? null,
    contactUrl,
    insertionLocation: article.insertionLocation,
    signals,
  })
  return {
    lane: 'paid_outreach',
    reason: base.reason,
    evidence: base.evidence,
    signals,
    qualification: article.qualification,
    qualificationReason: article.qualificationReason,
    insertionLocation: article.insertionLocation,
    readerBenefit: article.readerBenefit,
    contactUrl,
    editorialScore: scores.editorialScore,
    feasibilityScore: scores.feasibilityScore,
    editorialCoverage: scores.editorialCoverage,
    feasibilityCoverage: scores.feasibilityCoverage,
    scoreDetail: scores.detail,
  }
}

function qualifyPaidArticle(input: {
  blob: string
  headings: string[]
  geographyName: string | null
  contactUrl: string | null
  signals: string[]
}): {
  qualification: HhtPxQualification
  qualificationReason: string
  insertionLocation: string | null
  readerBenefit: string | null
} {
  const insertion = insertionHeading(input.headings, input.blob)
  const geo = input.geographyName?.trim() || 'this destination'
  const benefit = insertion
    ? `In “${insertion}”, HHT’s ${geo} guide would add a list of hotels that marks private hot tubs separately from shared facilities.`
    : null

  if (/\bbabymoon\b/.test(input.blob)) {
    return {
      qualification: 'downgraded',
      qualificationReason: 'Babymoon article. Out of scope for this campaign.',
      insertionLocation: insertion,
      readerBenefit: null,
    }
  }
  if (!overnightLanguage(input.blob)) {
    return {
      qualification: 'downgraded',
      qualificationReason: 'No overnight accommodation section. Activity, dining, or day-trip content does not give HHT a reader job.',
      insertionLocation: insertion,
      readerBenefit: null,
    }
  }
  if (singlePropertyReview(input.blob, input.headings) && !input.signals.includes('stay_roundup')) {
    return {
      qualification: 'downgraded',
      qualificationReason: 'Single-property stay. A comparison guide competes with the property the article is recommending.',
      insertionLocation: insertion,
      readerBenefit: null,
    }
  }
  if (internationalHeavy(input.blob) && !usTravelLanguage(input.blob, input.geographyName)) {
    return {
      qualification: 'downgraded',
      qualificationReason: 'The article is mostly international and has little US destination content for an HHT guide.',
      insertionLocation: insertion,
      readerBenefit: null,
    }
  }
  if (!insertion || !benefit) {
    return {
      qualification: 'needs_review',
      qualificationReason: 'The page is an independent publisher, but no heading or section shows where an HHT destination guide would help the reader.',
      insertionLocation: null,
      readerBenefit: null,
    }
  }
  if (!input.contactUrl) {
    return {
      qualification: 'needs_review',
      qualificationReason: 'A stay section was found, but the fetched page has no contact, about, or partnership link.',
      insertionLocation: insertion,
      readerBenefit: benefit,
    }
  }
  return {
    qualification: 'outreach_ready',
    qualificationReason: `Independent stay article with a contact route. Suggested insertion: “${insertion}”.`,
    insertionLocation: insertion,
    readerBenefit: benefit,
  }
}

function scorePaidArticle(input: {
  blob: string
  headings: string[]
  geographyName: string | null
  bestPosition: number | null
  volume: number | null
  contactUrl: string | null
  insertionLocation: string | null
  signals: string[]
}): {
  editorialScore: number
  feasibilityScore: number
  editorialCoverage: string
  feasibilityCoverage: string
  detail: string
} {
  const topic = topicFit(input.blob, input.geographyName)
  const insertion = input.insertionLocation ? 25 : looksLikeStayRoundup(input.blob, input.headings) ? 12 : 0
  const firsthand = /\b(we stayed|i stayed|our trip|we spent|i visited|we visited)\b/.test(input.blob)
  const author = /\b(written by|about the author|meet the author)\b/.test(input.blob)
  const credibility = (firsthand ? 15 : 0) + (author ? 10 : 0)
  const rankingKnown = input.bestPosition != null || input.volume != null
  const ranking = !rankingKnown ? null : input.bestPosition != null && input.bestPosition <= 5 ? 15 : input.bestPosition != null && input.bestPosition <= 10 ? 11 : input.volume != null ? 8 : 4

  const editorialParts = [
    { weight: 35, value: topic, name: 'topic' },
    { weight: 25, value: insertion, name: 'insertion' },
    { weight: 25, value: credibility, name: 'credibility' },
    { weight: 15, value: ranking, name: 'ranking' },
  ]
  const editorialScore = provisionalScore(editorialParts)

  const contact = input.contactUrl ? ( /contact|advertise|sponsor|media-kit|partner|work-with/i.test(input.contactUrl) && !/\/about/i.test(input.contactUrl) ? 30 : 18) : null
  const openness = /\b(advertise|sponsorship|media kit|work with me|collaborations?|partner with)\b/.test(input.blob)
    ? 25
    : input.signals.includes('affiliate_disclosure')
      ? 12
      : null
  const conflict = input.signals.includes('lodging_operator') ? 8 : 25
  const pricePlausibility = 14

  const feasibilityParts = [
    { weight: 30, value: contact, name: 'contact' },
    { weight: 25, value: openness, name: 'openness' },
    { weight: 25, value: conflict, name: 'conflict' },
    { weight: 20, value: pricePlausibility, name: 'price_plausibility' },
  ]
  const feasibilityScore = provisionalScore(feasibilityParts)
  const editorialMissing = editorialParts.filter((part) => part.value == null).map((part) => part.name)
  const feasibilityMissing = feasibilityParts.filter((part) => part.value == null).map((part) => part.name)
  return {
    editorialScore,
    feasibilityScore,
    editorialCoverage: editorialMissing.length ? `provisional; missing ${editorialMissing.join(', ')}` : 'all four components observed or inferred',
    feasibilityCoverage: feasibilityMissing.length ? `provisional; missing ${feasibilityMissing.join(', ')}` : 'all four components observed or inferred',
    detail: [
      `topic ${topic}/35`,
      `insertion ${insertion}/25`,
      `credibility ${credibility}/25 (${firsthand ? 'firsthand' : 'no firsthand'}; ${author ? 'author' : 'no author byline'})`,
      ranking == null ? 'ranking unknown' : `ranking ${ranking}/15`,
      contact == null ? 'contact unknown' : `contact ${contact}/30`,
      openness == null ? 'sponsorship unknown' : `openness ${openness}/25`,
      `conflict ${conflict}/25`,
      'price plausibility 14/20 inferred for an independent site; no published rate and no claim that they accept $50–100',
    ].join('; '),
  }
}

function topicFit(blob: string, geographyName: string | null): number {
  const overnight = overnightLanguage(blob)
  const geo = geographyName ? blob.includes(normalize(geographyName)) : false
  if (overnight && geo) return 32
  if (overnight) return 22
  if (geo) return 12
  return 6
}

function insertionHeading(headings: string[], blob: string): string | null {
  const heading = headings.find((item) =>
    /where to stay|places to stay|where we stayed|best stays|romantic stays|hotels|inns|bed and breakfast|accommodation|getaways/i.test(item),
  )
  if (heading) return heading.slice(0, 180)
  if (/where to stay|places to stay|best hotels|romantic hotels|romantic inns/i.test(blob)) {
    return 'body mention of where to stay'
  }
  return null
}

function looksLikeLodgingOperator(blob: string, headings: string[]): boolean {
  const booking = /\b(book now|check availability|reserve your|book direct|book a room|book this cabin|book your stay)\b/.test(blob)
  const ownInventory = /\b(our rooms|our suites|our cabins|our cottages|guest rooms|nightly rate|check-in time)\b/.test(blob)
  const headingBooking = headings.some((heading) => /rooms|suites|book|reservations|availability/i.test(heading))
  return (booking && ownInventory) || (booking && headingBooking && !looksLikeStayRoundup(blob, headings))
}

function looksLikeTourismOrganization(blob: string, hrefs: string[]): boolean {
  const copy = /\b(visitors bureau|convention and visitors|destination marketing organization|official travel|chamber of commerce|plan your visit)\b/.test(blob)
  const gov = hrefs.some((href) => /\.gov(\/|$)/i.test(href))
  return copy || gov
}

function looksLikeStayRoundup(blob: string, headings: string[]): boolean {
  const numbered = headings.filter((heading) => /^\d+[\).\s]|best |top \d+/i.test(heading)).length >= 3
  const stayWords = (blob.match(/\b(hotel|inn|resort|bed and breakfast|b&b)\b/g) ?? []).length
  return numbered || stayWords >= 6 || /\b(best|top)\s+\d*\s*(romantic )?(hotels|inns|getaways|places to stay)\b/.test(blob)
}

function looksLikeIndependentPublisher(blob: string): boolean {
  return /\b(written by|about the author|affiliate disclosure|this post may contain affiliate|i'm |i am a travel|we traveled|my travel blog)\b/.test(blob)
}

function overnightLanguage(blob: string): boolean {
  return /\b(hotel|inn|resort|overnight|where to stay|places to stay|bed and breakfast|b&b|cabin|lodge|accommodation)\b/.test(blob)
}

function singlePropertyReview(blob: string, headings: string[]): boolean {
  const stayWords = (blob.match(/\b(hotel|inn|resort)\b/g) ?? []).length
  return stayWords > 0 && stayWords < 4 && headings.length > 0 && headings.length < 6 && /\b(we stayed|our stay|hosted)\b/.test(blob)
}

function usTravelLanguage(blob: string, geographyName: string | null): boolean {
  if (geographyName && blob.includes(normalize(geographyName))) return true
  return /\b(united states|u\.s\.|usa)\b/.test(blob)
}

function internationalHeavy(blob: string): boolean {
  const hits = blob.match(/\b(paris|london|bali|italy|france|greece|japan|mexico|europe|thailand|portugal)\b/g) ?? []
  return hits.length >= 3
}

function structuralExclusion(
  url: string,
  path: string,
  domain: string,
): { lane: 'excluded'; evidence: 'observed'; reason: string; signals: string[]; qualification: 'excluded'; qualificationReason: string } | null {
  if (path.endsWith('.pdf')) return excluded('observed', 'PDF file, not an article page.', ['pdf'])
  if (path === '/' || path === '/index.html') return excluded('observed', 'Homepage, not an article.', ['homepage'])
  if (UGC.has(domain) || /\/(comments|forum)\//.test(path)) return excluded('observed', 'Forum or user-generated discussion.', ['ugc'])
  if (/[?&](s|q|query)=/.test(url) && /\/search/.test(path)) return excluded('observed', 'Search results page.', ['search_page'])
  return null
}

function excluded<E extends HhtPxEvidenceState>(
  evidence: E,
  reason: string,
  signals: string[],
): { lane: 'excluded'; evidence: E; reason: string; signals: string[]; qualification: 'excluded'; qualificationReason: string } {
  return { lane: 'excluded', evidence, reason, signals, qualification: 'excluded', qualificationReason: reason }
}

function earned(
  evidence: HhtPxEvidenceState,
  reason: string,
  signals: string[],
): { lane: 'earned_partnership'; evidence: HhtPxEvidenceState; reason: string; signals: string[]; qualification: 'downgraded'; qualificationReason: string } {
  return {
    lane: 'earned_partnership',
    evidence,
    reason,
    signals,
    qualification: 'downgraded',
    qualificationReason: 'Tourism or association page. Keep for an earned mention, not the paid list.',
  }
}

function findContactUrl(pageUrl: string, hrefs: string[]): string | null {
  const usable = hrefs.filter((href) => !href.startsWith('#') && !/\.(?:css|js|png|jpe?g|svg|webp|gif|woff2?)(?:\?|$)/i.test(href))
  const preferred = usable.find((href) => /contact|advertise|media-kit|mediakit|work-with|collaborat|partner/i.test(href))
  const about = usable.find((href) => /\/about\/?$/i.test(href) || /about-us/i.test(href))
  const raw = preferred ?? about
  if (!raw) return null
  try {
    return new URL(raw, pageUrl).toString()
  } catch {
    return null
  }
}

/** Missing components count as zero and stay in the denominator, so the score stays provisional. */
function provisionalScore(parts: Array<{ weight: number; value: number | null }>): number {
  const weight = parts.reduce((sum, part) => sum + part.weight, 0)
  if (weight <= 0) return 0
  const value = parts.reduce((sum, part) => sum + (part.value ?? 0), 0)
  return Math.round(Math.max(0, Math.min(100, (value / weight) * 100)))
}

function urlPath(url: string): string {
  try {
    return new URL(url).pathname.toLowerCase()
  } catch {
    return ''
  }
}

function stripTags(value: string): string {
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim()
}
