import 'server-only'
import { and, ilike, inArray, or, sql } from 'drizzle-orm'
import type { HhtOppImageRights } from '@rnr/core'
import type { Database } from '../db.js'
import { hotelBlHotels } from '../schema.js'

export interface HhtAssetSuggestion {
  label: string
  url: string
  city: string | null
  state: string | null
  imageRights: HhtOppImageRights
  reason: string
}

const STATE_NAMES: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
  colorado: 'CO', connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA',
  hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA',
  kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD',
  massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS',
  missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH',
  'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC',
  'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA',
  'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN',
  texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA',
  'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
}

function mentionedStates(text: string): string[] {
  const lower = text.toLowerCase()
  const found: string[] = []
  for (const [name, code] of Object.entries(STATE_NAMES)) {
    if (lower.includes(name)) found.push(code)
  }
  return found
}

function hhtUrl(pathOrUrl: string): string {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl
  const path = pathOrUrl.startsWith('/') ? pathOrUrl : `/${pathOrUrl}`
  return `https://hotelhottubs.com${path}`
}

export async function suggestHhtAssets(
  db: Database,
  args: { text: string; opportunityUrl: string },
): Promise<HhtAssetSuggestion[]> {
  const states = mentionedStates(args.text)
  const cityMatch = args.text.match(/\b(?:in|near|around)\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)/)
  const city = cityMatch?.[1] ?? null
  const assets: HhtAssetSuggestion[] = [
    {
      label: 'HotelHotTubs.com — verified in-room hot tub hotels',
      url: 'https://hotelhottubs.com',
      city: null,
      state: null,
      imageRights: 'UNKNOWN',
      reason: 'Primary destination. Image rights require review unless a specific owned asset is attached.',
    },
  ]

  if (/vermont/i.test(args.text)) {
    assets.push({
      label: 'Vermont hotels with private hot tubs',
      url: 'https://hotelhottubs.com/vermont',
      city: null,
      state: 'VT',
      imageRights: 'UNKNOWN',
      reason: 'Destination page suggested from the publisher brief. Image rights require review.',
    })
  }

  if (states.length === 0 && !city) {
    void args.opportunityUrl
    return assets
  }

  const where = []
  if (states.length) where.push(inArray(hotelBlHotels.state, states))
  if (city) where.push(ilike(hotelBlHotels.city, `%${city}%`))

  try {
    const hotels = await db
      .select({
        hotelName: hotelBlHotels.hotelName,
        city: hotelBlHotels.city,
        state: hotelBlHotels.state,
        existingHhtUrl: hotelBlHotels.existingHhtUrl,
      })
      .from(hotelBlHotels)
      .where(and(sql`${hotelBlHotels.existingHhtUrl} is not null`, or(...where)))
      .limit(5)
    for (const row of hotels) {
      if (!row.existingHhtUrl) continue
      assets.push({
        label: [row.hotelName, row.city, row.state].filter(Boolean).join(', '),
        url: hhtUrl(row.existingHhtUrl),
        city: row.city,
        state: row.state,
        imageRights: 'UNKNOWN',
        reason: 'Matched HotelHotTubs inventory for a location named in the brief. Image rights require review.',
      })
    }
  } catch {
    // Inventory table may not exist yet.
  }

  void args.opportunityUrl
  return assets.slice(0, 6)
}
