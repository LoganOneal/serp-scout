import type { HhtPxGeographySeed, HhtPxGeoType } from './types.js'

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

function norm(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

const STATES: Array<[string, string]> = [
  ['Alabama', 'AL'], ['Alaska', 'AK'], ['Arizona', 'AZ'], ['Arkansas', 'AR'],
  ['California', 'CA'], ['Colorado', 'CO'], ['Connecticut', 'CT'], ['Delaware', 'DE'],
  ['Florida', 'FL'], ['Georgia', 'GA'], ['Hawaii', 'HI'], ['Idaho', 'ID'],
  ['Illinois', 'IL'], ['Indiana', 'IN'], ['Iowa', 'IA'], ['Kansas', 'KS'],
  ['Kentucky', 'KY'], ['Louisiana', 'LA'], ['Maine', 'ME'], ['Maryland', 'MD'],
  ['Massachusetts', 'MA'], ['Michigan', 'MI'], ['Minnesota', 'MN'], ['Mississippi', 'MS'],
  ['Missouri', 'MO'], ['Montana', 'MT'], ['Nebraska', 'NE'], ['Nevada', 'NV'],
  ['New Hampshire', 'NH'], ['New Jersey', 'NJ'], ['New Mexico', 'NM'], ['New York', 'NY'],
  ['North Carolina', 'NC'], ['North Dakota', 'ND'], ['Ohio', 'OH'], ['Oklahoma', 'OK'],
  ['Oregon', 'OR'], ['Pennsylvania', 'PA'], ['Rhode Island', 'RI'], ['South Carolina', 'SC'],
  ['South Dakota', 'SD'], ['Tennessee', 'TN'], ['Texas', 'TX'], ['Utah', 'UT'],
  ['Vermont', 'VT'], ['Virginia', 'VA'], ['Washington', 'WA'], ['West Virginia', 'WV'],
  ['Wisconsin', 'WI'], ['Wyoming', 'WY'], ['District of Columbia', 'DC'],
]

/** Cities already likely represented on Hotel Hot Tubs plus major leisure markets. */
const CITIES: Array<[string, string, string]> = [
  ['Asheville', 'NC', 'North Carolina'],
  ['Austin', 'TX', 'Texas'],
  ['Charleston', 'SC', 'South Carolina'],
  ['Savannah', 'GA', 'Georgia'],
  ['Nashville', 'TN', 'Tennessee'],
  ['New Orleans', 'LA', 'Louisiana'],
  ['Sedona', 'AZ', 'Arizona'],
  ['Scottsdale', 'AZ', 'Arizona'],
  ['Phoenix', 'AZ', 'Arizona'],
  ['Tucson', 'AZ', 'Arizona'],
  ['Santa Fe', 'NM', 'New Mexico'],
  ['Taos', 'NM', 'New Mexico'],
  ['Albuquerque', 'NM', 'New Mexico'],
  ['Napa', 'CA', 'California'],
  ['Sonoma', 'CA', 'California'],
  ['San Francisco', 'CA', 'California'],
  ['San Diego', 'CA', 'California'],
  ['Los Angeles', 'CA', 'California'],
  ['Palm Springs', 'CA', 'California'],
  ['Santa Barbara', 'CA', 'California'],
  ['Monterey', 'CA', 'California'],
  ['Carmel', 'CA', 'California'],
  ['South Lake Tahoe', 'CA', 'California'],
  ['Healdsburg', 'CA', 'California'],
  ['Calistoga', 'CA', 'California'],
  ['Denver', 'CO', 'Colorado'],
  ['Boulder', 'CO', 'Colorado'],
  ['Colorado Springs', 'CO', 'Colorado'],
  ['Aspen', 'CO', 'Colorado'],
  ['Vail', 'CO', 'Colorado'],
  ['Breckenridge', 'CO', 'Colorado'],
  ['Telluride', 'CO', 'Colorado'],
  ['Durango', 'CO', 'Colorado'],
  ['Steamboat Springs', 'CO', 'Colorado'],
  ['Park City', 'UT', 'Utah'],
  ['Salt Lake City', 'UT', 'Utah'],
  ['Moab', 'UT', 'Utah'],
  ['Las Vegas', 'NV', 'Nevada'],
  ['Reno', 'NV', 'Nevada'],
  ['Portland', 'OR', 'Oregon'],
  ['Bend', 'OR', 'Oregon'],
  ['Hood River', 'OR', 'Oregon'],
  ['Seattle', 'WA', 'Washington'],
  ['Spokane', 'WA', 'Washington'],
  ['Leavenworth', 'WA', 'Washington'],
  ['Boise', 'ID', 'Idaho'],
  ['Jackson', 'WY', 'Wyoming'],
  ['Bozeman', 'MT', 'Montana'],
  ['Whitefish', 'MT', 'Montana'],
  ['Missoula', 'MT', 'Montana'],
  ['Burlington', 'VT', 'Vermont'],
  ['Stowe', 'VT', 'Vermont'],
  ['Portland', 'ME', 'Maine'],
  ['Bar Harbor', 'ME', 'Maine'],
  ['Newport', 'RI', 'Rhode Island'],
  ['Provincetown', 'MA', 'Massachusetts'],
  ['Boston', 'MA', 'Massachusetts'],
  ['Cape May', 'NJ', 'New Jersey'],
  ['New York', 'NY', 'New York'],
  ['Niagara Falls', 'NY', 'New York'],
  ['Philadelphia', 'PA', 'Pennsylvania'],
  ['Pittsburgh', 'PA', 'Pennsylvania'],
  ['Gettysburg', 'PA', 'Pennsylvania'],
  ['Chicago', 'IL', 'Illinois'],
  ['Milwaukee', 'WI', 'Wisconsin'],
  ['Minneapolis', 'MN', 'Minnesota'],
  ['Detroit', 'MI', 'Michigan'],
  ['Traverse City', 'MI', 'Michigan'],
  ['Mackinac Island', 'MI', 'Michigan'],
  ['Cleveland', 'OH', 'Ohio'],
  ['Cincinnati', 'OH', 'Ohio'],
  ['Louisville', 'KY', 'Kentucky'],
  ['Indianapolis', 'IN', 'Indiana'],
  ['St. Louis', 'MO', 'Missouri'],
  ['Kansas City', 'MO', 'Missouri'],
  ['Dallas', 'TX', 'Texas'],
  ['Houston', 'TX', 'Texas'],
  ['San Antonio', 'TX', 'Texas'],
  ['Fort Worth', 'TX', 'Texas'],
  ['Fredericksburg', 'TX', 'Texas'],
  ['Miami', 'FL', 'Florida'],
  ['Key West', 'FL', 'Florida'],
  ['Orlando', 'FL', 'Florida'],
  ['Tampa', 'FL', 'Florida'],
  ['St. Petersburg', 'FL', 'Florida'],
  ['Naples', 'FL', 'Florida'],
  ['Fort Lauderdale', 'FL', 'Florida'],
  ['Sarasota', 'FL', 'Florida'],
  ['Atlanta', 'GA', 'Georgia'],
  ['Gatlinburg', 'TN', 'Tennessee'],
  ['Pigeon Forge', 'TN', 'Tennessee'],
  ['Knoxville', 'TN', 'Tennessee'],
  ['Memphis', 'TN', 'Tennessee'],
  ['Hot Springs', 'AR', 'Arkansas'],
  ['Virginia Beach', 'VA', 'Virginia'],
  ['Charlottesville', 'VA', 'Virginia'],
  ['Asheville', 'NC', 'North Carolina'],
  ['Outer Banks', 'NC', 'North Carolina'],
  ['Wilmington', 'NC', 'North Carolina'],
  ['Hilton Head', 'SC', 'South Carolina'],
  ['Myrtle Beach', 'SC', 'South Carolina'],
  ['Honolulu', 'HI', 'Hawaii'],
  ['Lahaina', 'HI', 'Hawaii'],
  ['Kailua-Kona', 'HI', 'Hawaii'],
  ['Anchorage', 'AK', 'Alaska'],
  ['Washington', 'DC', 'District of Columbia'],
]

const METROS: Array<[string, string, string]> = [
  ['Bay Area', 'CA', 'California'],
  ['Los Angeles Metro', 'CA', 'California'],
  ['New York Metro', 'NY', 'New York'],
  ['Chicago Metro', 'IL', 'Illinois'],
  ['Dallas-Fort Worth', 'TX', 'Texas'],
  ['Miami Metro', 'FL', 'Florida'],
  ['Boston Metro', 'MA', 'Massachusetts'],
  ['Washington DC Metro', 'DC', 'District of Columbia'],
  ['Denver Metro', 'CO', 'Colorado'],
  ['Phoenix Metro', 'AZ', 'Arizona'],
  ['Seattle Metro', 'WA', 'Washington'],
  ['Atlanta Metro', 'GA', 'Georgia'],
]

const REGIONS: Array<[string, string | null, string | null, string | null]> = [
  ['Napa Valley', 'CA', 'California', 'california/napa'],
  ['Sonoma County', 'CA', 'California', 'california/sonoma'],
  ['Poconos', 'PA', 'Pennsylvania', 'pennsylvania'],
  ['Smoky Mountains', 'TN', 'Tennessee', 'tennessee'],
  ['Florida Keys', 'FL', 'Florida', 'florida'],
  ['Lake Tahoe', 'CA', 'California', 'california'],
  ['Finger Lakes', 'NY', 'New York', 'new-york'],
  ['Hudson Valley', 'NY', 'New York', 'new-york'],
  ['Cape Cod', 'MA', 'Massachusetts', 'massachusetts'],
  ['Outer Banks', 'NC', 'North Carolina', 'north-carolina'],
  ['Wine Country', 'CA', 'California', 'california'],
  ['Catskills', 'NY', 'New York', 'new-york'],
  ['Blue Ridge Mountains', 'NC', 'North Carolina', 'north-carolina'],
  ['Ozarks', 'MO', 'Missouri', 'missouri'],
  ['Door County', 'WI', 'Wisconsin', 'wisconsin'],
  ['Berkshires', 'MA', 'Massachusetts', 'massachusetts'],
  ['Adirondacks', 'NY', 'New York', 'new-york'],
  ['Gulf Coast', 'FL', 'Florida', 'florida'],
  ['Pacific Northwest', null, null, null],
]

function queryNameFor(name: string, type: HhtPxGeoType, stateCode: string | null): string {
  if (type === 'state' && name === 'New York') return 'New York State'
  if (type === 'state' && name === 'Washington') return 'Washington State'
  if (type === 'city' && name === 'Portland' && stateCode === 'ME') return 'Portland Maine'
  if (type === 'city' && name === 'Portland' && stateCode === 'OR') return 'Portland Oregon'
  if (type === 'city' && name === 'Washington' && stateCode === 'DC') return 'Washington DC'
  if (type === 'city' && name === 'New York') return 'New York City'
  return name
}

function geo(args: {
  name: string
  type: HhtPxGeoType
  state: string | null
  stateCode: string | null
  parentNormalizedName: string | null
  hhtSlug: string | null
  priority: number
}): HhtPxGeographySeed {
  return {
    name: args.name,
    queryName: queryNameFor(args.name, args.type, args.stateCode),
    normalizedName: norm(args.name),
    state: args.state,
    stateCode: args.stateCode,
    type: args.type,
    parentNormalizedName: args.parentNormalizedName,
    hhtSlug: args.hhtSlug,
    hotelCount: null,
    privateHotTubCount: null,
    sharedHotTubCount: null,
    editorsChoiceCount: null,
    active: true,
    priority: args.priority,
  }
}

function uniqueGeographies(rows: HhtPxGeographySeed[]): HhtPxGeographySeed[] {
  const seen = new Set<string>()
  const out: HhtPxGeographySeed[] = []
  for (const row of rows) {
    const key = `${row.type}|${row.normalizedName}|${row.stateCode ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(row)
  }
  return out
}

export function hhtPxGeographyKey(row: Pick<HhtPxGeographySeed, 'type' | 'normalizedName' | 'stateCode'>): string {
  return `${row.type}:${row.normalizedName}:${row.stateCode ?? ''}`
}

export const HHT_PX_GEOGRAPHIES: readonly HhtPxGeographySeed[] = uniqueGeographies([
  ...STATES.map(([name, code]) =>
    geo({
      name,
      type: 'state',
      state: name,
      stateCode: code,
      parentNormalizedName: null,
      hhtSlug: slug(name),
      priority: 1,
    }),
  ),
  ...CITIES.map(([name, code, state]) =>
    geo({
      name,
      type: 'city',
      state,
      stateCode: code,
      parentNormalizedName: norm(state),
      hhtSlug: `${slug(state)}/${slug(name)}`,
      priority: 2,
    }),
  ),
  ...METROS.map(([name, code, state]) =>
    geo({
      name,
      type: 'metro',
      state,
      stateCode: code,
      parentNormalizedName: norm(state),
      hhtSlug: slug(state),
      priority: 4,
    }),
  ),
  ...REGIONS.map(([name, code, state, hhtSlug]) =>
    geo({
      name,
      type: 'destination_region',
      state,
      stateCode: code,
      parentNormalizedName: state ? norm(state) : null,
      hhtSlug,
      priority: 3,
    }),
  ),
])

export function initialHhtPxGeographies(): HhtPxGeographySeed[] {
  return HHT_PX_GEOGRAPHIES.filter((row) => row.type !== 'neighborhood')
}
