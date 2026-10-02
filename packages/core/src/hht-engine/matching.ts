import type { HhtInventoryPage } from './types.js'

export type MatchRule = 'city' | 'state' | 'collection' | 'editors_choice' | 'homepage'

export interface TargetMatch {
  targetHhtUrl: string
  secondaryHhtUrl: string | null
  matchRule: MatchRule
  matchConfidence: number
  weakTargetMatch: boolean
  noHhtCityPage: boolean
}

const COLLECTION_TERMS: Array<{ collection: string; terms: string[] }> = [
  { collection: 'romantic', terms: ['romantic', 'couples', 'honeymoon'] },
  { collection: 'budget', terms: ['cheap', 'budget', 'affordable'] },
  { collection: 'motels', terms: ['motel'] },
  { collection: 'suites', terms: ['suite', 'suites'] },
  { collection: 'whirlpool suites', terms: ['whirlpool'] },
  { collection: 'private outdoor', terms: ['outdoor', 'private hot tub', 'private outdoor'] },
]

export function matchHhtTarget(text: string, pages: HhtInventoryPage[]): TargetMatch {
  const haystack = text.toLowerCase()
  const homepage = pages.find((page) => page.pageType === 'homepage')?.url ?? 'https://www.hotelhottubs.com/'
  const city = pages
    .filter((page) => page.pageType === 'city' && page.city)
    .sort((a, b) => (b.city?.length ?? 0) - (a.city?.length ?? 0))
    .find((page) => haystack.includes(page.city!.toLowerCase()))
  const collection = COLLECTION_TERMS.find((entry) => entry.terms.some((term) => haystack.includes(term)))
  const collectionPage = collection
    ? pages.find((page) => page.pageType === 'collection' && page.collection === collection.collection)
    : undefined

  if (city) {
    return {
      targetHhtUrl: city.url,
      secondaryHhtUrl: collectionPage?.url ?? null,
      matchRule: 'city',
      matchConfidence: 0.95,
      weakTargetMatch: false,
      noHhtCityPage: false,
    }
  }

  const namedCityMissing = looksLikeCityQuery(haystack) && !city
  const state = pages.find(
    (page) => page.pageType === 'state' && page.state && haystack.includes(page.state.toLowerCase()),
  )
  if (state) {
    return {
      targetHhtUrl: state.url,
      secondaryHhtUrl: collectionPage?.url ?? null,
      matchRule: 'state',
      matchConfidence: 0.8,
      weakTargetMatch: false,
      noHhtCityPage: namedCityMissing,
    }
  }
  if (collectionPage) {
    return {
      targetHhtUrl: collectionPage.url,
      secondaryHhtUrl: null,
      matchRule: 'collection',
      matchConfidence: 0.7,
      weakTargetMatch: false,
      noHhtCityPage: namedCityMissing,
    }
  }
  if (/\bbest\b|\btop\b|\blist\b/.test(haystack)) {
    const editors = pages.find((page) => page.pageType === 'editors_choice')
    if (editors) {
      return {
        targetHhtUrl: editors.url,
        secondaryHhtUrl: null,
        matchRule: 'editors_choice',
        matchConfidence: 0.55,
        weakTargetMatch: false,
        noHhtCityPage: namedCityMissing,
      }
    }
  }
  return {
    targetHhtUrl: homepage,
    secondaryHhtUrl: null,
    matchRule: 'homepage',
    matchConfidence: 0.2,
    weakTargetMatch: true,
    noHhtCityPage: namedCityMissing,
  }
}

function looksLikeCityQuery(text: string): boolean {
  return /\b(in|near)\s+[a-z]/.test(text)
}
