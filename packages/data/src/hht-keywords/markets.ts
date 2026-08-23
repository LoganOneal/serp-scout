import { LOCATION_CA } from '@rnr/core'
import type { HhtDestination } from './analysis.js'

/**
 * Canadian hotel markets added to the HHT research corpus.
 *
 * Province-qualified aliases are the discovery seeds. The bare city remains
 * eligible because Google can return it as the more common query wording.
 * Slugs include `ca` so similarly named US destinations cannot collide.
 */
const CANADIAN_MARKETS: ReadonlyArray<readonly [string, string, ...string[]]> = [
  ['toronto-on-ca', 'Toronto', 'Toronto ON', 'Toronto Ontario'],
  ['montreal-qc-ca', 'Montreal', 'Montreal QC', 'Montreal Quebec'],
  ['vancouver-bc-ca', 'Vancouver', 'Vancouver BC', 'Vancouver British Columbia'],
  ['calgary-ab-ca', 'Calgary', 'Calgary AB', 'Calgary Alberta'],
  ['edmonton-ab-ca', 'Edmonton', 'Edmonton AB', 'Edmonton Alberta'],
  ['ottawa-on-ca', 'Ottawa', 'Ottawa ON', 'Ottawa Ontario'],
  ['winnipeg-mb-ca', 'Winnipeg', 'Winnipeg MB', 'Winnipeg Manitoba'],
  ['quebec-city-qc-ca', 'Quebec City', 'Quebec City QC', 'Quebec City Quebec'],
  ['hamilton-on-ca', 'Hamilton', 'Hamilton ON', 'Hamilton Ontario'],
  ['kitchener-on-ca', 'Kitchener', 'Kitchener ON', 'Kitchener Ontario'],
  ['london-on-ca', 'London', 'London ON', 'London Ontario'],
  ['halifax-ns-ca', 'Halifax', 'Halifax NS', 'Halifax Nova Scotia'],
  ['oshawa-on-ca', 'Oshawa', 'Oshawa ON', 'Oshawa Ontario'],
  ['victoria-bc-ca', 'Victoria', 'Victoria BC', 'Victoria British Columbia'],
  ['windsor-on-ca', 'Windsor', 'Windsor ON', 'Windsor Ontario'],
  ['saskatoon-sk-ca', 'Saskatoon', 'Saskatoon SK', 'Saskatoon Saskatchewan'],
  ['regina-sk-ca', 'Regina', 'Regina SK', 'Regina Saskatchewan'],
  ['st-johns-nl-ca', "St. John's", "St. John's NL", "St. John's Newfoundland and Labrador"],
  ['kelowna-bc-ca', 'Kelowna', 'Kelowna BC', 'Kelowna British Columbia'],
  ['barrie-on-ca', 'Barrie', 'Barrie ON', 'Barrie Ontario'],
  ['sherbrooke-qc-ca', 'Sherbrooke', 'Sherbrooke QC', 'Sherbrooke Quebec'],
  ['guelph-on-ca', 'Guelph', 'Guelph ON', 'Guelph Ontario'],
  ['moncton-nb-ca', 'Moncton', 'Moncton NB', 'Moncton New Brunswick'],
  ['kingston-on-ca', 'Kingston', 'Kingston ON', 'Kingston Ontario'],
  ['niagara-falls-on-ca', 'Niagara Falls', 'Niagara Falls ON', 'Niagara Falls Ontario'],
]

export const HHT_CANADIAN_DESTINATIONS: readonly HhtDestination[] = CANADIAN_MARKETS.map(
  ([slug, label, ...aliases]): HhtDestination => ({
  slug,
  label,
  aliases,
  countryCode: 'CA',
  googleAdsGeoTarget: LOCATION_CA,
  volumeScope: 'ca/en',
  }),
)
