/**
 * Expand a seed niche into a buy-intent keyword cluster for local SERP research.
 *
 * Keywords stay **city-free**: geo is applied via DataForSEO `location_code`
 * (and optionally device/os), which is how you approximate SERPs seen by someone
 * physically in that market. Appending "tucson" to the query is a different
 * intent (people typing the city name) and is intentionally not the default.
 *
 * Pure. No IO.
 */

export interface ServiceIntentNicheInput {
  slug: string
  label: string
  keywordNoun: string
  category?: string | null
}

/** Cap so one market cell cannot enqueue an unbounded grid. */
export const MAX_SERVICE_INTENT_KEYWORDS = 24

/**
 * Deduped, order-stable keyword list for market-cell research.
 * Includes near-me variants for core commercial heads.
 */
export function expandServiceIntentKeywords(
  niche: ServiceIntentNicheInput,
  opts?: { max?: number },
): string[] {
  const max = opts?.max ?? MAX_SERVICE_INTENT_KEYWORDS
  const noun = niche.keywordNoun.trim().toLowerCase().replace(/\s+/g, ' ')
  if (noun === '') return []

  const slug = niche.slug.toLowerCase()
  const raw =
    slug === 'hvac-repair' || noun.includes('hvac')
      ? hvacIntentKeywords()
      : genericServiceIntentKeywords(noun, niche.category ?? null)

  return dedupeKeywords(raw).slice(0, max)
}

function hvacIntentKeywords(): string[] {
  // Priority commercial heads first (with near-me), then broader service set.
  // Order matters: expandServiceIntentKeywords slices to MAX.
  return [
    'hvac repair',
    'hvac repair near me',
    'ac repair',
    'ac repair near me',
    'furnace repair',
    'furnace repair near me',
    'hvac service',
    'hvac service near me',
    'hvac contractor',
    'hvac contractor near me',
    'hvac company',
    'air conditioning repair',
    'air conditioner repair',
    'central air repair',
    'heating repair',
    'heat pump repair',
    'ac installation',
    'furnace installation',
    'hvac installation',
    'ac replacement',
    'furnace replacement',
    'emergency ac repair',
    'emergency ac repair near me',
    'emergency hvac repair',
    'ac not cooling',
    'furnace not heating',
    'thermostat installation',
    'duct cleaning',
    'mini split installation',
  ]
}

/**
 * Generic local-service cluster from a seed noun.
 * e.g. "plumber" → plumber, plumbing repair, emergency plumber, install patterns.
 */
function genericServiceIntentKeywords(noun: string, category: string | null): string[] {
  const heads = new Set<string>([noun])

  // If noun already ends with a service verb, keep related phrasings light.
  const isRepairish = /\b(repair|service|cleaning|removal|control|installers?|contractors?)\b/i.test(
    noun,
  )

  heads.add(`${noun} near me`)
  heads.add(`best ${noun}`)
  heads.add(`emergency ${noun}`)
  heads.add(`${noun} cost`)
  heads.add(`${noun} company`)
  heads.add(`${noun} contractor`)

  if (!isRepairish) {
    heads.add(`${noun} repair`)
    heads.add(`${noun} repair near me`)
    heads.add(`${noun} installation`)
    heads.add(`${noun} installers`)
    heads.add(`${noun} service`)
    heads.add(`${noun} service near me`)
  } else {
    // noun is already "x repair" / "x service"
    const stem = noun
      .replace(/\s+(repair|service|company|contractor|installers?)\s*$/i, '')
      .trim()
    if (stem && stem !== noun) {
      /**
       * ============ THE BARE STEM IS NOT THE SERVICE ============
       * This used to add `stem` on its own. Stripping the verb off
       * "foundation repair" yields "foundation" -- makeup, nonprofits, the
       * concept -- and that query carried 2,900 searches/mo in Seattle, 73% of
       * the niche's apparent local demand. "concrete", "tree", "solar" and
       * "septic" were generated the same way.
       *
       * Everything below keeps a service word, so the intent survives. Only the
       * naked noun is dropped.
       * ==========================================================
       */
      heads.add(`${stem} near me`)
      heads.add(`${stem} company`)
      heads.add(`${stem} contractor`)
      heads.add(`emergency ${stem}`)
      heads.add(`${stem} installation`)
      heads.add(`${stem} replacement`)
    }
    heads.add(`${noun} near me`)
    heads.add(`emergency ${noun}`)
  }

  // Category-tinted extras
  if (category === 'restoration' || category === 'emergency') {
    heads.add(`24 hour ${noun}`)
    heads.add(`${noun} emergency`)
  }
  if (category === 'remodel' || category === 'exterior') {
    heads.add(`${noun} cost`)
    heads.add(`${noun} quotes`)
  }

  return [...heads]
}

/** Append "near me" for selected commercial heads (not already ending in near me). */
function withNearMe(heads: string[], nearMeFor: string[]): string[] {
  const out = [...heads]
  const set = new Set(heads.map((h) => h.toLowerCase()))
  for (const h of nearMeFor) {
    const nm = `${h} near me`
    if (!set.has(nm.toLowerCase()) && !h.toLowerCase().endsWith('near me')) {
      out.push(nm)
      set.add(nm.toLowerCase())
    }
  }
  return out
}

function dedupeKeywords(raw: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const r of raw) {
    const k = r.trim().toLowerCase().replace(/\s+/g, ' ')
    if (k === '' || seen.has(k)) continue
    seen.add(k)
    out.push(k)
  }
  return out
}
