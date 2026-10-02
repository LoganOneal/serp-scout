export type HhtPxSeedFamily =
  | 'regional_romantic'
  | 'from_city'
  | 'accommodation_guides'
  | 'amenity'
  | 'overnight_itinerary'
  | 'state_gap'

export interface HhtPxDiscoverySeed {
  phrase: string
  family: HhtPxSeedFamily
  geography: string
  pilot: boolean
}

const REGIONS = [
  'the Hudson Valley',
  'the Catskills',
  'the Finger Lakes',
  'the Poconos',
  'the Berkshires',
  'New England',
  'Lancaster PA',
  'Shenandoah Valley',
  'the Blue Ridge Mountains',
  'the Smoky Mountains',
  'the Ozarks',
  'Door County',
  'northern Michigan',
  'southern Indiana',
  'the Texas Hill Country',
  'the Oregon Coast',
  'the Olympic Peninsula',
  'northern California',
  'the California Central Coast',
  'the San Juan Islands',
  'the Adirondacks',
  'the White Mountains',
  'Cape Cod',
  'the Outer Banks',
  'Napa Valley',
  'Sonoma County',
  'Lake Tahoe',
  'the Florida Keys',
]

const CITIES = [
  'Boston',
  'New York City',
  'Philadelphia',
  'Washington DC',
  'Baltimore',
  'Pittsburgh',
  'Chicago',
  'Detroit',
  'Minneapolis',
  'Indianapolis',
  'Cincinnati',
  'Nashville',
  'Charlotte',
  'Atlanta',
  'Dallas',
  'Austin',
  'Denver',
  'Seattle',
  'Portland',
  'San Francisco',
  'Los Angeles',
  'Miami',
  'Houston',
  'Phoenix',
  'San Diego',
]

const STAY_DESTINATIONS = [
  'Asheville',
  'Cape Cod',
  'Newport RI',
  'Sedona',
  'Savannah',
  'Charleston SC',
  'Eureka Springs',
  'Galena IL',
  'Leavenworth WA',
  'Palm Springs',
  'Bar Harbor',
  'Stowe',
  'Woodstock NY',
  'Hot Springs AR',
  'Fredericksburg TX',
  'Cannon Beach',
  'Napa',
  'Santa Barbara',
  'Key West',
  'New Orleans',
]

const STATE_GAPS = [
  'Pennsylvania',
  'Massachusetts',
  'Vermont',
  'New Hampshire',
  'Maine',
  'Connecticut',
  'Rhode Island',
  'Maryland',
  'Minnesota',
  'South Carolina',
]

const PILOT_REGIONS = new Set(REGIONS.slice(0, 20))
const PILOT_CITIES = new Set(CITIES.slice(0, 20))
const PILOT_STAYS = new Set([
  'Asheville',
  'Cape Cod',
  'Newport RI',
  'Sedona',
  'Savannah',
  'Charleston SC',
  'Eureka Springs',
  'Galena IL',
  'Leavenworth WA',
  'Palm Springs',
])

function seed(phrase: string, family: HhtPxSeedFamily, geography: string, pilot: boolean): HhtPxDiscoverySeed {
  return { phrase, family, geography, pilot }
}

/** Curated discovery phrases. These are not multiplied across every geography. */
export function hhtPxDiscoverySeeds(): HhtPxDiscoverySeed[] {
  const rows: HhtPxDiscoverySeed[] = []
  for (const region of REGIONS) {
    const pilot = PILOT_REGIONS.has(region)
    rows.push(seed(`romantic getaways in ${region}`, 'regional_romantic', region, pilot))
    rows.push(seed(`romantic weekend getaways in ${region}`, 'regional_romantic', region, false))
    if (pilot) rows.push(seed(`secluded romantic getaways in ${region}`, 'regional_romantic', region, false))
  }
  for (const city of CITIES) {
    const pilot = PILOT_CITIES.has(city)
    rows.push(seed(`romantic getaways from ${city}`, 'from_city', city, pilot))
    rows.push(seed(`weekend getaways from ${city} for couples`, 'from_city', city, false))
    rows.push(seed(`romantic getaways near ${city}`, 'from_city', city, false))
  }
  for (const place of STAY_DESTINATIONS) {
    const pilot = PILOT_STAYS.has(place)
    rows.push(seed(`romantic hotels in ${place}`, 'accommodation_guides', place, pilot && place !== 'Cape Cod' && place !== 'Newport RI'))
    rows.push(seed(`romantic places to stay in ${place}`, 'accommodation_guides', place, false))
    if (place === 'Cape Cod') rows.push(seed('romantic inns in Cape Cod', 'accommodation_guides', place, true))
    if (place === 'Newport RI') rows.push(seed('romantic bed and breakfasts in Newport RI', 'accommodation_guides', place, true))
  }
  for (const place of STAY_DESTINATIONS.slice(0, 12)) {
    rows.push(seed(`hotels with private hot tubs in ${place}`, 'amenity', place, false))
    rows.push(seed(`romantic hotels with fireplaces in ${place}`, 'amenity', place, false))
  }
  for (const region of REGIONS.slice(0, 12)) {
    rows.push(seed(`romantic weekend in ${region}`, 'overnight_itinerary', region, false))
    rows.push(seed(`anniversary weekend in ${region}`, 'overnight_itinerary', region, false))
  }
  for (const state of STATE_GAPS) {
    rows.push(seed(`romantic getaways in ${state}`, 'state_gap', state, true))
  }
  const seen = new Set<string>()
  return rows.filter((row) => {
    const key = row.phrase.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
