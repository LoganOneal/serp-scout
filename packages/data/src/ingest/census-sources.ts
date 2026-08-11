/**
 * US Census bulk files. All PUBLIC DOMAIN and all KEYLESS.
 *
 * Public domain matters commercially: SimpleMaps and GeoNames are CC BY, which
 * puts an attribution obligation on the face of a commercial UI. Census data
 * carries none.
 *
 * Keyless matters practically: the Census *API* (api.census.gov) now requires a
 * key on EVERY request and returns an 8,529-byte HTML "Missing Key" page under
 * HTTP 200 when it is absent -- verified 2026-08-02 at national, state, and
 * single-place scope. These www2.census.gov bulk files have no such requirement.
 * That is why the whole geography corpus comes from flat files and why median
 * household income (API-only) was dropped from the rent model rather than made a
 * prerequisite for ingest.
 *
 * Every URL below was verified to return HTTP 200 with real content on
 * 2026-08-02. Two of them differ from the obvious guess -- see the notes.
 */

export const CENSUS_SOURCES = {
  /** Gazetteer: place name, state, lat/lon, land area. ~19,475 incorporated places + CDPs. */
  gazetteerPlaces: {
    url: 'https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2024_Gazetteer/2024_Gaz_place_national.zip',
    fileInZip: /2024_Gaz_place_national\.txt$/i,
    cacheName: 'gaz_place_national.txt',
  },
  gazetteerCounties: {
    url: 'https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2024_Gazetteer/2024_Gaz_counties_national.zip',
    fileInZip: /2024_Gaz_counties_national\.txt$/i,
    cacheName: 'gaz_counties_national.txt',
  },
  gazetteerCbsa: {
    url: 'https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2024_Gazetteer/2024_Gaz_cbsa_national.zip',
    fileInZip: /2024_Gaz_cbsa_national\.txt$/i,
    cacheName: 'gaz_cbsa_national.txt',
  },

  /**
   * Sub-county population estimates, 2024 vintage.
   *
   * NOTE THE PATH: `.../2020-2024/cities/totals/sub-est2024.csv`. The obvious
   * `.../2020-2024/cities/sub-est2024.csv` (no `totals/`) returns 404.
   *
   * SUMLEV 162 = incorporated place, 050 = county, 040 = state. It contains
   * INCORPORATED PLACES ONLY -- no CDPs -- which is consistent with the ~19,475
   * figure and means unincorporated communities are out of scope by construction.
   * Names carry legal suffixes ("Abbeville city"), handled by cleanCensusName.
   */
  subCountyPopulation: {
    url: 'https://www2.census.gov/programs-surveys/popest/datasets/2020-2024/cities/totals/sub-est2024.csv',
    cacheName: 'sub-est2024.csv',
  },

  /**
   * CBSA population estimates, 2024 vintage.
   *
   * This file is why metro population is never computed by summing incorporated
   * places. Summing gave ~700k for Milwaukee against a real 1.57M metro, and any
   * "is the metro bigger than its city" threshold above ~1.15x then deleted most
   * metros worth scanning. Reading the official figure removes the problem at
   * source rather than tuning around it.
   *
   * Filter to rows where LSAD contains "Statistical Area" -- the file also
   * contains one row per component county ("County or equivalent").
   */
  cbsaPopulation: {
    url: 'https://www2.census.gov/programs-surveys/popest/datasets/2020-2024/metro/totals/cbsa-est2024-alldata.csv',
    cacheName: 'cbsa-est2024-alldata.csv',
  },

  /**
   * Place -> county mapping. Pipe-delimited, with a header.
   * Columns: STATE|STATEFP|COUNTYFP|COUNTYNAME|PLACEFP|PLACENS|PLACENAME|TYPE|CLASSFP|FUNCSTAT
   *
   * A place spanning multiple counties appears on multiple rows. See
   * parsePlaceCounty for how the primary county is chosen and why it is an
   * acknowledged approximation.
   */
  placeByCounty: {
    url: 'https://www2.census.gov/geo/docs/reference/codes2020/national_place_by_county2020.txt',
    cacheName: 'national_place_by_county2020.txt',
  },
} as const

/** USPS state code -> full name, for provider lookups which use full names. */
export const STATE_NAMES: Record<string, string> = {
  AL: 'Alabama',
  AK: 'Alaska',
  AZ: 'Arizona',
  AR: 'Arkansas',
  CA: 'California',
  CO: 'Colorado',
  CT: 'Connecticut',
  DE: 'Delaware',
  DC: 'District of Columbia',
  FL: 'Florida',
  GA: 'Georgia',
  HI: 'Hawaii',
  ID: 'Idaho',
  IL: 'Illinois',
  IN: 'Indiana',
  IA: 'Iowa',
  KS: 'Kansas',
  KY: 'Kentucky',
  LA: 'Louisiana',
  ME: 'Maine',
  MD: 'Maryland',
  MA: 'Massachusetts',
  MI: 'Michigan',
  MN: 'Minnesota',
  MS: 'Mississippi',
  MO: 'Missouri',
  MT: 'Montana',
  NE: 'Nebraska',
  NV: 'Nevada',
  NH: 'New Hampshire',
  NJ: 'New Jersey',
  NM: 'New Mexico',
  NY: 'New York',
  NC: 'North Carolina',
  ND: 'North Dakota',
  OH: 'Ohio',
  OK: 'Oklahoma',
  OR: 'Oregon',
  PA: 'Pennsylvania',
  RI: 'Rhode Island',
  SC: 'South Carolina',
  SD: 'South Dakota',
  TN: 'Tennessee',
  TX: 'Texas',
  UT: 'Utah',
  VT: 'Vermont',
  VA: 'Virginia',
  WA: 'Washington',
  WV: 'West Virginia',
  WI: 'Wisconsin',
  WY: 'Wyoming',
  PR: 'Puerto Rico',
}

/** FIPS state code -> USPS code. sub-est2024.csv keys on numeric FIPS. */
export const FIPS_TO_STATE: Record<string, string> = {
  '01': 'AL', '02': 'AK', '04': 'AZ', '05': 'AR', '06': 'CA', '08': 'CO', '09': 'CT',
  '10': 'DE', '11': 'DC', '12': 'FL', '13': 'GA', '15': 'HI', '16': 'ID', '17': 'IL',
  '18': 'IN', '19': 'IA', '20': 'KS', '21': 'KY', '22': 'LA', '23': 'ME', '24': 'MD',
  '25': 'MA', '26': 'MI', '27': 'MN', '28': 'MS', '29': 'MO', '30': 'MT', '31': 'NE',
  '32': 'NV', '33': 'NH', '34': 'NJ', '35': 'NM', '36': 'NY', '37': 'NC', '38': 'ND',
  '39': 'OH', '40': 'OK', '41': 'OR', '42': 'PA', '44': 'RI', '45': 'SC', '46': 'SD',
  '47': 'TN', '48': 'TX', '49': 'UT', '50': 'VT', '51': 'VA', '53': 'WA', '54': 'WV',
  '55': 'WI', '56': 'WY', '72': 'PR',
}
