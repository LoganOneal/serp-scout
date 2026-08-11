import type { LocalityKind } from '../types.js'

/**
 * Slugs. The ONLY natural key for a locality.
 *
 * ======================= WHY NOT (kind, state, name) =======================
 * It looks unique and it is not. The gazetteer contains two Wilmingtons in
 * Illinois, three Oakwoods in Ohio, and 17 name collisions in total. A unique
 * index on (kind, state, name) looks perfectly reasonable in a migration and
 * REJECTS REAL PLACES at insert time -- it broke the first ingest of this
 * corpus outright.
 * ===========================================================================
 */

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[.'’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export interface SluggableLocality {
  kind: LocalityKind
  name: string
  stateCode: string
  /** Place FIPS, county FIPS, or CBSA code -- the disambiguator. */
  fips: string
}

function baseSlug(l: SluggableLocality): string {
  const name = slugify(l.name)
  const state = l.stateCode.toLowerCase()
  return l.kind === 'city' ? `${name}-${state}` : `${name}-${state}-${l.kind}`
}

/**
 * Assign a unique slug to every locality, disambiguating collisions by FIPS.
 *
 * IMPORTANT: when a base slug collides, the FIPS suffix is appended to EVERY
 * member of the collision, not just to the losers. Appending only to the
 * duplicates would make which Wilmington gets the bare `wilmington-il` depend on
 * row order -- so a re-ingest, or a change in the source file's sort, silently
 * moves saved shortlist items and outcome history onto a different city.
 */
export function assignSlugs<T extends SluggableLocality>(
  localities: T[],
): Array<T & { slug: string }> {
  const byBase = new Map<string, T[]>()
  for (const l of localities) {
    const base = baseSlug(l)
    const list = byBase.get(base)
    if (list) list.push(l)
    else byBase.set(base, [l])
  }

  const out: Array<T & { slug: string }> = []
  for (const [base, members] of byBase) {
    if (members.length === 1) {
      out.push({ ...members[0]!, slug: base })
      continue
    }
    for (const m of members) {
      out.push({ ...m, slug: `${base}-${m.fips}` })
    }
  }
  return out
}
