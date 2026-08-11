import { COUNTY_ROLLUP_DOMINANT_PLACE_SHARE, METRO_VS_CITY_MIN_RATIO } from '../scoring/priors.js'

/**
 * Deciding which counties and metros are worth creating as scannable localities.
 */

export interface MemberPlace {
  name: string
  population: number | null
}

export interface CountyRollupDecision {
  create: boolean
  reason: string
  dominantPlace: string | null
  dominantShare: number | null
}

/**
 * Should this county exist as its own scannable locality?
 *
 * ==================== THE 95% RULE, AND WHY IT LOOKS WRONG ===================
 * Independent cities are simultaneously places AND county-equivalents: all 38 of
 * Virginia's, plus Baltimore, St. Louis, Carson City, and the District of
 * Columbia. Census lists `Richmond city` as a place and ALSO as a county
 * equivalent named `Richmond city`.
 *
 * Roll that up naively and you get two localities -- city "Richmond" and county
 * "Richmond city" -- scanning the identical SERP and competing for the same
 * shortlist. Worse, the county one can NEVER resolve, because the provider
 * carries Richmond as type City, and a county lookup that only accepts type
 * County (correctly) refuses to match it. The result is a permanent population
 * of unresolvable duplicates -- 23 of them -- that look like a resolver bug and
 * are not.
 *
 * A population-share test catches every one of them generically, with no
 * hardcoded state list to maintain and no special-casing when the next
 * consolidation happens. If one place IS the county, the county row adds nothing.
 * ============================================================================
 */
/**
 * Census marks an independent city, when it appears as a COUNTY-equivalent, by
 * naming it with a trailing LOWERCASE " city" -- "Richmond city", "Baltimore
 * city", "St. Louis city". Alaska uses " City and Borough" / " Municipality".
 *
 * This is exact and needs no population arithmetic, so it is checked first.
 * Case-sensitivity matters for the same reason it does in names.ts: Nevada's
 * county is "Carson City" with a capital C, and that is a real (consolidated)
 * county-equivalent caught by the population rule below instead.
 */
function isIndependentCityCountyName(countyName: string): boolean {
  return (
    countyName.endsWith(' city') ||
    countyName.endsWith(' City and Borough') ||
    countyName.endsWith(' Municipality')
  )
}

export function shouldRollUpCounty(args: {
  countyName: string
  countyPopulation: number | null
  members: MemberPlace[]
}): CountyRollupDecision {
  const { countyName, countyPopulation, members } = args

  // Rule A -- the exact structural marker. No population needed.
  if (isIndependentCityCountyName(countyName)) {
    return {
      create: false,
      reason: `Census names this county-equivalent "${countyName}", which is how an independent city is marked. It is the same market as the place of the same name, and its county row could never resolve (the provider carries it as type City).`,
      dominantPlace: countyName,
      dominantShare: 1,
    }
  }

  if (countyPopulation === null || countyPopulation <= 0) {
    return {
      create: false,
      reason: 'County population unknown; cannot verify it is not an independent city.',
      dominantPlace: null,
      dominantShare: null,
    }
  }

  // Rule B -- the population share, over MEMBERS THAT PLAUSIBLY BELONG HERE.
  //
  // A place can span several counties (Dothan city is in Dale, Henry AND Houston
  // County, Alabama) and the place->county file gives no population split. Any
  // single-county attribution is therefore approximate, and when it is wrong the
  // place's FULL population lands on a county it barely occupies: Dothan read as
  // 143% of Dale County, and Huntsville as 194% of Limestone County.
  //
  // A share above 1.0 is arithmetically impossible for a place genuinely inside
  // its county, so it is proof of misattribution rather than evidence of an
  // independent city. Such members are DISCARDED instead of being allowed to
  // delete a real county -- 185 counties were being dropped this way, most of
  // them legitimate.
  let dominant: MemberPlace | null = null
  let misattributed = 0
  for (const m of members) {
    if (m.population === null) continue
    if (m.population > countyPopulation) {
      misattributed++
      continue
    }
    if (dominant === null || m.population > (dominant.population ?? 0)) dominant = m
  }

  if (dominant === null && misattributed > 0) {
    return {
      create: true,
      reason: `All ${misattributed} member place(s) have populations exceeding the county's, which means they span multiple counties and were misattributed here. Treated as a normal county.`,
      dominantPlace: null,
      dominantShare: null,
    }
  }

  if (dominant === null || dominant.population === null) {
    return {
      create: true,
      reason: 'No member place population available; treated as a normal county.',
      dominantPlace: null,
      dominantShare: null,
    }
  }

  const share = dominant.population / countyPopulation
  if (share >= COUNTY_ROLLUP_DOMINANT_PLACE_SHARE) {
    return {
      create: false,
      reason: `"${dominant.name}" is ${(share * 100).toFixed(1)}% of the county -- this is an independent city or consolidated government, not a distinct market. Its county row would scan the same SERP and could never resolve (the provider carries it as type City).`,
      dominantPlace: dominant.name,
      dominantShare: share,
    }
  }

  return {
    create: true,
    reason: `Largest place "${dominant.name}" is ${(share * 100).toFixed(1)}% of the county.`,
    dominantPlace: dominant.name,
    dominantShare: share,
  }
}

export interface MetroRollupDecision {
  create: boolean
  reason: string
  ratio: number | null
}

/**
 * Should this metro exist separately from its anchor city?
 *
 * The threshold is deliberately LOW. An earlier version computed metro
 * population by summing incorporated places, which produced ~700k for Milwaukee
 * against a real 1.57M metro -- so any threshold above about 1.15x deleted most
 * metros worth scanning. Metro population now comes from the official CBSA
 * estimates file (cbsa-est2024-alldata.csv), so the undercount is gone and this
 * is only a backstop against a genuinely redundant metro row.
 */
export function shouldCreateMetro(args: {
  metroPopulation: number | null
  anchorCityPopulation: number | null
}): MetroRollupDecision {
  const { metroPopulation, anchorCityPopulation } = args
  if (metroPopulation === null || metroPopulation <= 0) {
    return { create: false, reason: 'Metro population unknown.', ratio: null }
  }
  if (anchorCityPopulation === null || anchorCityPopulation <= 0) {
    return { create: true, reason: 'No anchor city population to compare against.', ratio: null }
  }
  const ratio = metroPopulation / anchorCityPopulation
  if (ratio < METRO_VS_CITY_MIN_RATIO) {
    return {
      create: false,
      reason: `Metro is only ${ratio.toFixed(2)}x its anchor city -- effectively the same market.`,
      ratio,
    }
  }
  return { create: true, reason: `Metro is ${ratio.toFixed(2)}x its anchor city.`, ratio }
}
