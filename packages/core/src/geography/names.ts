/**
 * Turning Census place names into names a SERP provider will recognise.
 *
 * Every rule here was discovered empirically against 19,475 real Census places,
 * and every one of them silently loses real cities when it is missing or wrong.
 * "Silently" is the operative word: an unresolved locality is simply excluded
 * from scanning, so a bad rule here shows up as "no data for half the country"
 * rather than as an error.
 */

/**
 * Census legal suffixes, stripped only when they appear in LOWERCASE.
 *
 * ===================== THE CASE SENSITIVITY IS THE POINT =====================
 * Census publishes Virginia's independent cities as `Richmond city` and
 * `Virginia Beach city` -- lowercase `city` is a legal-status suffix, not part of
 * the name. But `Kansas City`, `Boise City`, `Oklahoma City`, `Salt Lake City`
 * and `Iowa City` all carry a CAPITALISED `City` that IS part of the name.
 *
 * Case-insensitive stripping turns Kansas City into "Kansas" -- which then
 * resolves to the state of Kansas -- and Boise City, Oklahoma into "Boise",
 * which resolves to Boise, IDAHO. A statewide or wrong-state SERP comes back
 * perfectly well-formed, and nothing downstream can tell.
 * =============================================================================
 */
/**
 * ORDER MATTERS -- longest first, because the first match wins.
 *
 * "Juneau city and borough" ends with " borough", so a short-first list strips
 * only that and leaves "Juneau city and". Same for Utah's "Kearns metro
 * township", which becomes "Kearns metro" unless " metro township" is tried
 * before " township".
 */
const LOWERCASE_LEGAL_SUFFIXES = [
  ' city and borough',
  ' municipality and borough',
  ' metro township',
  ' charter township',
  ' municipality',
  ' plantation',
  ' township',
  ' village',
  ' borough',
  ' city',
  ' town',
  ' CDP',
] as const

/**
 * States where "Town" is a LEGAL municipal form rather than part of the name.
 *
 * Census writes Massachusetts places as "Weymouth Town city", "Barnstable Town
 * city", "Amherst Town city" -- eleven of them over 25k. Stripping the lowercase
 * " city" leaves "Weymouth Town", but the provider carries plain "Weymouth".
 *
 * Restricted to New England on purpose. A blanket " Town" strip would turn
 * Boys Town, Nebraska into "Boys".
 */
const NEW_ENGLAND_TOWN_STATES = new Set(['MA', 'CT', 'RI', 'NH', 'VT', 'ME'])

/** Strip a trailing legal " Town"/" Township", New England only. */
export function stripNewEnglandTown(name: string, stateCode: string | undefined): string {
  if (!stateCode || !NEW_ENGLAND_TOWN_STATES.has(stateCode.toUpperCase())) return name
  const stripped = name.replace(/\s+(Town|Township)$/, '').trim()
  return stripped.length > 0 ? stripped : name
}

/**
 * Consolidated city-counties. A CLOSED SET, expressed as an alias table.
 *
 * WHY NOT A RULE: the obvious generalisation is "split on the hyphen and take
 * the first part". That rule destroys Winston-Salem, Wilkes-Barre, Bethel-Tate,
 * Ho-Ho-Kus and dozens of other legitimately hyphenated names. There are only a
 * dozen of these; a table is correct and a rule is not.
 *
 * ==================== KEYED ON NAME **AND STATE**, NOT NAME ==================
 * `Boise City` is the consolidated city-county in IDAHO. There is also a Boise
 * City in OKLAHOMA -- population ~1,100, an entirely unrelated place. A
 * name-only alias table maps both to "Boise", so Oklahoma's Boise City resolves
 * to Boise, IDAHO and returns a well-formed SERP for a city 1,000 miles away.
 * Same class of bug as case-insensitive suffix stripping, same silence.
 * ============================================================================
 */
export const CONSOLIDATED_ALIASES: Record<string, string> = {
  'indianapolis city (balance)|in': 'Indianapolis',
  'nashville-davidson metropolitan government (balance)|tn': 'Nashville',
  'nashville-davidson|tn': 'Nashville',
  'louisville/jefferson county metro government (balance)|ky': 'Louisville',
  'louisville/jefferson county|ky': 'Louisville',
  'lexington-fayette urban county|ky': 'Lexington',
  'lexington-fayette|ky': 'Lexington',
  'augusta-richmond county consolidated government (balance)|ga': 'Augusta',
  'augusta-richmond county|ga': 'Augusta',
  'macon-bibb county|ga': 'Macon',
  'athens-clarke county unified government (balance)|ga': 'Athens',
  'athens-clarke county|ga': 'Athens',
  'urban honolulu|hi': 'Honolulu',
  'honolulu county|hi': 'Honolulu',
  'boise city|id': 'Boise',
  'butte-silver bow (balance)|mt': 'Butte',
  'butte-silver bow|mt': 'Butte',
  'anaconda-deer lodge county|mt': 'Anaconda',
  'hartsville/trousdale county|tn': 'Hartsville',
  'carson city|nv': 'Carson City',
}

function aliasFor(name: string, stateCode: string | undefined): string | undefined {
  if (!stateCode) return undefined
  return CONSOLIDATED_ALIASES[`${name.toLowerCase()}|${stateCode.toLowerCase()}`]
}

/**
 * Strip one trailing lowercase legal suffix. Case-SENSITIVE by design -- see the
 * comment on LOWERCASE_LEGAL_SUFFIXES.
 */
export function stripLegalSuffix(name: string): string {
  for (const suffix of LOWERCASE_LEGAL_SUFFIXES) {
    if (name.endsWith(suffix)) {
      const stripped = name.slice(0, -suffix.length).trim()
      // Never strip down to nothing.
      if (stripped.length > 0) return stripped
    }
  }
  return name
}

/**
 * `San Buenaventura (Ventura)` -> `['Ventura', 'San Buenaventura']`.
 *
 * The parenthetical goes FIRST because the provider carries this place as
 * "Ventura" -- the parenthetical is the common name and the bare name is the
 * legal one. Both are returned so neither ordering assumption is load-bearing.
 */
export function expandParenthetical(name: string): string[] {
  const m = /^(.+?)\s*\(([^)]+)\)\s*$/.exec(name)
  if (!m) return [name]
  const outer = m[1]!.trim()
  const inner = m[2]!.trim()
  // `(balance)` and `(part)` are Census bookkeeping, not alternative names.
  if (/^(balance|part|pt\.?)$/i.test(inner)) return [outer]
  return [inner, outer]
}

/**
 * Full cleanup of one raw Census place name into a display/lookup name.
 *
 * ORDER MATTERS: the legal suffix comes off BEFORE the parenthetical is
 * expanded. Census writes `San Buenaventura (Ventura) city` -- with the suffix
 * still attached the parenthetical is not at the end of the string, so a
 * paren-first implementation silently fails to see it and the place resolves
 * under its legal name, which the provider does not carry.
 */
export function cleanCensusName(raw: string, stateCode?: string): string {
  const trimmed = raw.trim()
  const direct = aliasFor(trimmed, stateCode)
  if (direct) return direct

  const desuffixed = stripLegalSuffix(trimmed)
  const afterSuffix = aliasFor(desuffixed, stateCode)
  if (afterSuffix) return afterSuffix

  const [primary] = expandParenthetical(desuffixed)
  const candidate = primary ?? desuffixed
  const afterParen = aliasFor(candidate, stateCode)
  if (afterParen) return afterParen

  return stripNewEnglandTown(stripLegalSuffix(candidate), stateCode)
}

/**
 * Every name form worth trying against the provider, most likely first.
 * Deduplicated, order preserved.
 */
export function nameCandidates(raw: string, stateCode?: string): string[] {
  const out: string[] = []
  const push = (s: string) => {
    const v = s.trim()
    if (v && !out.includes(v)) out.push(v)
  }

  const trimmed = raw.trim()
  const direct = aliasFor(trimmed, stateCode)
  if (direct) push(direct)

  const desuffixed = stripLegalSuffix(trimmed)
  const afterSuffix = aliasFor(desuffixed, stateCode)
  if (afterSuffix) push(afterSuffix)

  for (const variant of expandParenthetical(desuffixed)) {
    const variantAlias = aliasFor(variant, stateCode)
    if (variantAlias) push(variantAlias)
    const bare = stripLegalSuffix(variant)
    // Both forms, most-stripped first. Adding a variant is always safe -- a
    // candidate only counts when it matches the provider exactly -- whereas
    // REPLACING a name risks "Boys Town" becoming "Boys".
    for (const abbrev of abbreviationVariants(stripNewEnglandTown(bare, stateCode))) push(abbrev)
    for (const abbrev of abbreviationVariants(bare)) push(abbrev)
    for (const abbrev of abbreviationVariants(variant)) push(abbrev)
  }
  push(desuffixed)
  push(trimmed)
  return out
}

/**
 * Abbreviation variants, BOTH directions.
 *
 * Census writes "St. Paul city"; the provider carries "Saint Paul,Minnesota".
 * Neither side is consistent -- some provider rows use "St." and some use
 * "Saint" -- so both spellings are generated and tried rather than guessing which
 * is canonical.
 *
 * This single rule recovers St. Paul (pop 307,465), the only US city over 250k
 * that failed to resolve, plus St. Louis, St. Petersburg, St. Cloud, Mount
 * Vernon, Fort Worth and roughly two dozen more in the 25k-250k band.
 */
export function abbreviationVariants(name: string): string[] {
  const out = new Set<string>([name])
  const rules: Array<[RegExp, string]> = [
    [/\bSt\.\s+/g, 'Saint '],
    [/\bSaint\s+/g, 'St. '],
    [/\bSte\.\s+/g, 'Sainte '],
    [/\bSainte\s+/g, 'Ste. '],
    [/\bMt\.\s+/g, 'Mount '],
    [/\bMount\s+/g, 'Mt. '],
    [/\bFt\.\s+/g, 'Fort '],
    [/\bFort\s+/g, 'Ft. '],
  ]
  for (const [pattern, replacement] of rules) {
    if (pattern.test(name)) out.add(name.replace(pattern, replacement))
  }
  // "St." with no following space, and the bare "St" form some sources use.
  if (/\bSt\.\s/.test(name)) out.add(name.replace(/\bSt\.\s/g, 'St '))
  return [...out]
}

/** Drop the trailing " County"/" Parish"/" Borough" from a county name. */
export function bareCountyName(countyName: string): string {
  return countyName
    .replace(/\s+(County|Parish|Borough|Census Area|Municipality|City and Borough)$/i, '')
    .trim()
}

/** Normalise for comparison: lowercase, collapse whitespace, strip punctuation. */
export function normaliseForLookup(s: string): string {
  return s
    .toLowerCase()
    .replace(/[.'’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}
