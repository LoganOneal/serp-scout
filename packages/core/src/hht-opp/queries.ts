/**
 * Strategy-based query expansion. Templates are parameterized; cities are not
 * hardcoded one-by-one. The discovery runner consumes a small batch of these.
 */

import type { HhtOppStrategy } from './types.js'

export const HHT_OPP_TOPICS = [
  'travel',
  'hotel',
  'hospitality',
  'honeymoon',
  'romantic travel',
  'luxury travel',
  'weekend getaway',
  'couples travel',
  'romantic getaway',
  'wellness travel',
  'ski destinations',
  'hotel amenities',
] as const

export const HHT_OPP_PHRASES = [
  'write for us',
  'contributors',
  'submit article',
  'pitch us',
  'guest post',
  'advertise',
  'sponsored post',
  'media kit',
  'partner with us',
  'work with us',
  'submit your story',
  'contribute a story',
  'contributors wanted',
  'editorial submissions',
  'advertise with us',
  'sponsored article',
  'link insertion',
  'branded content',
] as const

export const HHT_OPP_TOPIC_SERP = [
  'hotels with jacuzzi in room',
  'hotels with hot tub in room',
  'private hot tub hotels',
  'romantic hotels',
  'romantic weekend getaways',
  'honeymoon hotels',
  'jacuzzi suites',
  'whirlpool suites',
  'romantic hotels California',
  'hotels with private hot tubs Colorado',
] as const

export const HHT_OPP_DIRECTORY_SEEDS = [
  'travel blog directories',
  'luxury travel blog lists',
  'hotel blog lists',
  'honeymoon blogs',
  'romance travel sites',
  'hospitality publication directories',
  'travel magazines',
  'tourism publications',
  'destination blogs',
  'wedding travel blogs',
  'couple travel blogs',
] as const

export const HHT_OPP_PAID_GLOBAL = [
  '"travel blog" "sponsored post" "$"',
  '"travel" "guest post price"',
  '"hotel blog" advertising',
  '"travel magazine" media kit',
] as const

export const HHT_OPP_MENTION_QUERIES = [
  '"HotelHotTubs"',
  '"Hotel Hot Tubs"',
  '"hotelhottubs.com"',
  '"Hotel Hot Tubs" "Editor\'s Choice"',
] as const

export type HhtOppSearchStrategy = Extract<
  HhtOppStrategy,
  | 'direct_keyword_search'
  | 'topic_serp'
  | 'directory_mining'
  | 'paid_placement_language'
  | 'unlinked_mentions'
  | 'local_tourism'
  | 'creative_query'
>

export interface QueryTemplate {
  query: string
  strategy: HhtOppSearchStrategy
  family: string
}

/** Order for a small live batch. Do not fire the full template list. */
export const HHT_OPP_DISCOVERY_STRATEGY_ORDER: HhtOppSearchStrategy[] = [
  'direct_keyword_search',
  'paid_placement_language',
  'local_tourism',
  'directory_mining',
  'topic_serp',
  'unlinked_mentions',
]

const LOCATION_TOKENS = [
  'United States',
  'California',
  'Colorado',
  'Vermont',
  'New York',
  'Florida',
  'Texas',
  'Hawaii',
]

export function expandQueryTemplates(): QueryTemplate[] {
  const out: QueryTemplate[] = []
  const seen = new Set<string>()
  const add = (query: string, strategy: QueryTemplate['strategy'], family: string) => {
    const key = query.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    out.push({ query, strategy, family })
  }

  for (const topic of HHT_OPP_TOPICS) {
    for (const phrase of HHT_OPP_PHRASES) {
      add(`"${topic}" "${phrase}"`, 'direct_keyword_search', 'topic_phrase')
      add(`${topic} ${phrase}`, 'direct_keyword_search', 'topic_phrase_loose')
    }
  }

  for (const topic of ['travel', 'hotel', 'honeymoon']) {
    for (const location of LOCATION_TOKENS) {
      add(`"${topic}" "${location}" "write for us"`, 'local_tourism', 'topic_location')
      add(`"${location}" tourism "partner with us"`, 'local_tourism', 'tourism_board')
    }
  }

  for (const query of HHT_OPP_TOPIC_SERP) add(query, 'topic_serp', 'hht_topics')
  for (const query of HHT_OPP_DIRECTORY_SEEDS) add(query, 'directory_mining', 'directories')
  for (const query of HHT_OPP_PAID_GLOBAL) add(query, 'paid_placement_language', 'paid_global')
  for (const query of HHT_OPP_MENTION_QUERIES) add(query, 'unlinked_mentions', 'brand')

  return out
}

export function siteSearchQueries(domain: string): string[] {
  const terms = ['sponsored', 'advertise', 'guest post', 'link insertion', 'media kit', 'partnership', 'branded content']
  return terms.map((term) => `site:${domain} ${term.includes(' ') ? `"${term}"` : term}`)
}
