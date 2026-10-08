import { HHT_SITE_NAME, HHT_SITE_URL } from './types.js'

export interface GuestPitchInput {
  domain: string
  publicationName?: string | null
  pitchUrl: string
  guidelineText?: string | null
}

export interface GuestPitch {
  subject: string
  angle: string
  body: string
}

const US_PLACES = new Set([
  'Alaska',
  'Arizona',
  'California',
  'Colorado',
  'Florida',
  'Hawaii',
  'Michigan',
  'Nevada',
  'New York',
  'Oregon',
  'Texas',
  'Utah',
  'Washington',
])

const PLACES = [
  'New Zealand',
  'United Kingdom',
  'New York',
  'California',
  'Washington',
  'Michigan',
  'Colorado',
  'Arizona',
  'Florida',
  'Hawaii',
  'Oregon',
  'Nevada',
  'Alaska',
  'Texas',
  'Utah',
  'Australia',
  'Thailand',
  'Scotland',
  'England',
  'Ireland',
  'Belize',
  'Canada',
  'Mexico',
  'Europe',
  'London',
]

/**
 * Skill step 4: a forced pitch for a site that already passed as Pursue.
 * The angle follows that site's audience, place, and stated requirements.
 */
export function writeGuestPitch(input: GuestPitchInput): GuestPitch {
  const name = publicationName(input.domain, input.publicationName)
  const text = input.guidelineText ?? ''
  const place = restrictedPlace(text)
  const kind = audience(text)
  const angle = buildAngle(name, kind, place, text)
  const requirements = requirementLines(text)
  const requirementBlock = requirements.length
    ? `\n\nFrom your guidelines:\n${requirements.map((line) => `• ${line}`).join('\n')}`
    : ''
  const body = [
    'Hello,',
    '',
    `I'm Claire at ${HHT_SITE_NAME} (${HHT_SITE_URL}). We are a commercial site that verifies room-level hotel amenities, including private hot tubs and Jacuzzi suites, across 6,000+ U.S. hotels.`,
    '',
    angle,
    '',
    `I read the contributor page at ${input.pitchUrl}.${requirementBlock}`,
    '',
    'Would you consider this as a guest contribution? I can send a full article that follows your rules. I will not claim a firsthand hotel stay, and I will not send images unless the rights are cleared.',
    '',
    'Thank you,',
    'Claire',
    HHT_SITE_NAME,
  ].join('\n')

  return { subject: subjectFor(name, kind, place), angle, body }
}

function publicationName(domain: string, raw?: string | null): string {
  const parts = (raw ?? '')
    .split(/\s+[|\-–—]\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
  const useful = parts.find((part) => !/^(home|write for us|guest post|contribute|submissions)$/i.test(part) && !/^write for\b/i.test(part))
  const name = (useful ?? '').replace(/^write for\s+/i, '').trim()
  if (name && name.length <= 80) return name
  return domain
}

function audience(text: string): 'family' | 'company' | 'narrative' | 'occasion' | 'general' {
  if (/\b(family travel|traveling with (?:kids|children)|with kids|for parents|family-friendly)\b/i.test(text)) return 'family'
  if (/\b(our tours|tour operator|book (?:a |your )?tour|our (?:hotel|resort|lodge|cabins)|we offer (?:tours|stays|packages))\b/i.test(text)) return 'company'
  if (/\b(first[- ]person|personal (?:story|essay|experience)|narrative essay|travel diary)\b/i.test(text)) return 'narrative'
  if (/\b(solo female|women travelers|for women|girls who travel)\b/i.test(text)) return 'occasion'
  return 'general'
}

function restrictedPlace(text: string): { name: string; inDataset: boolean } | null {
  const window = text.slice(0, 5000)
  for (const place of PLACES) {
    const escaped = place.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const restricted = new RegExp(
      `\\b(?:only|exclusively|limited to|must be about|focused on|we only publish|articles about|posts about|stories about)\\b[^.]{0,80}\\b${escaped}\\b|\\b${escaped}\\b[^.]{0,40}\\bonly\\b`,
      'i',
    )
    if (restricted.test(window)) return { name: place, inDataset: US_PLACES.has(place) }
  }
  return null
}

function wordCount(text: string): { label: string; raw: string } | null {
  const match = text.match(/\b(\d{3,4})(?:\s*(?:-|–|to)\s*(\d{3,4}))?\s+words\b/i)
  if (!match) return null
  const low = Number(match[1])
  const high = match[2] ? Number(match[2]) : low
  if (low < 300 || high < 300 || high > 8000) return null
  const label = match[2]
    ? `${low.toLocaleString('en-US')}–${high.toLocaleString('en-US')}`
    : low.toLocaleString('en-US')
  return { label, raw: match[1].replace(/\s+/g, ' ') + (match[2] ? `-${match[2]}` : '') }
}

function wordNote(text: string): string {
  const count = wordCount(text)
  return count ? ` I would keep it inside your ${count.label}-word range.` : ''
}

function buildAngle(
  name: string,
  kind: 'family' | 'company' | 'narrative' | 'occasion' | 'general',
  place: { name: string; inDataset: boolean } | null,
  text: string,
): string {
  const words = wordNote(text)
  if (kind === 'family') {
    return `For ${name}, I would write a data-backed list for a family weekend: U.S. hotels where the room itself has a private hot tub, counted from HotelHotTubs.com’s check of 6,000+ properties.${words}`
  }
  if (kind === 'company' && place?.inDataset) {
    return `For ${name}, I would write a piece that complements your ${place.name} stays: which ${place.name} hotels put a private hot tub in the room, from HotelHotTubs.com’s room-level check of 6,000+ U.S. hotels.${words}`
  }
  if (kind === 'company' && place) {
    return `For ${name}, I would write a piece that complements your ${place.name} stays by showing how U.S. travelers verify a private hot tub room before they book, using HotelHotTubs.com’s check of 6,000+ hotels.${words}`
  }
  if (kind === 'company') {
    return `For ${name}, I would write a piece that complements what you already offer: how travelers confirm a private hot tub or Jacuzzi suite is actually in the room, using HotelHotTubs.com’s check of 6,000+ U.S. hotels.${words}`
  }
  if (kind === 'narrative') {
    return `For ${name}, I would write a first-person account of one finding in the HotelHotTubs.com dataset: how often a “hot tub in room” listing and the room itself disagree.${words}`
  }
  if (kind === 'occasion') {
    return `For ${name}, I would write for a couples’ or friends’ trip: which U.S. hotels put a private hot tub in the room, from our check of 6,000+ properties.${words}`
  }
  if (place?.inDataset) {
    return `For ${name}, I would write a ${place.name} slice of HotelHotTubs.com’s check of 6,000+ U.S. hotels: which ${place.name} stays list a private hot tub or Jacuzzi suite in the room.${words}`
  }
  if (place) {
    return `For ${name}, I would write for readers planning around ${place.name}: what HotelHotTubs.com’s check of 6,000+ U.S. hotels shows about private hot tub rooms, since that is the inventory we can actually verify.${words}`
  }
  return `For ${name}, I would write a reported piece on how many U.S. hotels actually put a private hot tub in the room, using HotelHotTubs.com’s check of 6,000+ properties.${words}`
}

function subjectFor(
  name: string,
  kind: 'family' | 'company' | 'narrative' | 'occasion' | 'general',
  place: { name: string; inDataset: boolean } | null,
): string {
  if (kind === 'family') return `Guest post for ${name}: family weekends with a private hot tub`
  if (kind === 'narrative') return `Guest post for ${name}: what the hot tub listings get wrong`
  if (kind === 'occasion') return `Guest post for ${name}: a trip with a private hot tub`
  if (place) return `Guest post for ${name}: private hot tub rooms and ${place.name}`
  if (kind === 'company') return `Guest post for ${name}: a piece alongside what you offer`
  return `Guest post for ${name}: private hot tub rooms in U.S. hotels`
}

function requirementLines(text: string): string[] {
  const lines: string[] = []
  const words = wordCount(text)
  if (words) lines.push(`Word count: ${words.raw} words`)
  if (/\boriginal\b/i.test(text)) lines.push('Original work')
  const images = text.match(/\b(\d+)\s+(?:original\s+)?(?:images|photos|pictures)\b/i)
  if (images) lines.push(`${images[1]} images`)
  if (/dofollow/i.test(text)) lines.push('Dofollow link mentioned')
  else if (/nofollow/i.test(text)) lines.push('Nofollow link mentioned')
  if (/author bio/i.test(text)) lines.push('Author bio')
  if (/no ai|not ai-generated|ai-generated/i.test(text)) lines.push('No AI-generated copy')
  return lines.slice(0, 4)
}
