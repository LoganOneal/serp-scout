/**
 * Pattern × entity expansion. Pure, deterministic, and capped.
 *
 * ==================== EVERY CAP IS REPORTED ====================
 * A truncated grid reads exactly like a complete one. `plan-step0-experiment.md`
 * §2 made the same rule for its profile crawl, and the run that ignored it
 * reported 212 domains on one pass and 419 on the next with identical inputs.
 *
 * So `ExpansionResult.dropped` and `.notes` are not diagnostics — they are part
 * of the answer, and the caller is expected to surface them. A space that hits a
 * cap has not been "expanded", it has been sampled.
 * ==============================================================
 */

import {
  type KeywordSpace,
  type SpaceEntity,
  normaliseKeyword,
  patternSlots,
} from './keyword-space.js'

export interface GeneratedKeyword {
  keyword: string
  keywordNorm: string
  /** Stored as `research_keywords.seed_key` — the pattern that made it. */
  seedKey: string
  patternLabel: string
  /** dimension -> entity slug. Traces a grid row back, and joins to rankings. */
  entities: Record<string, string>
}

export interface ExpansionResult {
  keywords: GeneratedKeyword[]
  /** Rows a cap prevented from existing. Non-zero means this is a sample. */
  dropped: number
  /** Human-readable, and meant for the screen rather than a log file. */
  notes: string[]
}

/** Total rows one space may generate before it is refusing rather than sampling. */
export const DEFAULT_MAX_KEYWORDS = 20_000

/** Rows one `pairwise: true` pattern may generate. */
export const DEFAULT_PAIRWISE_CAP = 2_000

export interface ExpandOptions {
  maxKeywords?: number
}

/**
 * Substitute one binding into a template.
 *
 * Ordinals matter: `{vendor}` and `{vendor:2}` are different slots over the same
 * dimension, so the key is `dimension:ordinal` throughout.
 */
function fill(template: string, bindings: Map<string, SpaceEntity>): string {
  return template.replace(/\{([a-z0-9_]+)(?::(\d+))?\}/gi, (whole, dim: string, ord?: string) => {
    const key = `${dim.toLowerCase()}:${ord ? Number(ord) : 1}`
    const entity = bindings.get(key)
    return entity ? entity.label : whole
  })
}

/**
 * Cartesian product over the slots of one pattern.
 *
 * Yields lazily so a cap stops the work rather than trimming the result after
 * a 14,280-row array already exists.
 */
function* combinations(
  slotKeys: string[],
  pools: Map<string, SpaceEntity[]>,
): Generator<Map<string, SpaceEntity>> {
  if (slotKeys.length === 0) {
    yield new Map()
    return
  }
  const idx = new Array<number>(slotKeys.length).fill(0)
  const lists = slotKeys.map((k) => pools.get(k) ?? [])
  if (lists.some((l) => l.length === 0)) return

  for (;;) {
    const binding = new Map<string, SpaceEntity>()
    for (let i = 0; i < slotKeys.length; i++) binding.set(slotKeys[i]!, lists[i]![idx[i]!]!)
    yield binding

    let carry = slotKeys.length - 1
    for (;;) {
      idx[carry] = idx[carry]! + 1
      if (idx[carry]! < lists[carry]!.length) break
      idx[carry] = 0
      carry -= 1
      if (carry < 0) return
    }
  }
}

/**
 * Expand a space into the keywords it targets.
 *
 * `entitiesByDimension` is supplied by the caller because @rnr/core does no IO —
 * localities come from `research_geos`, everything else from `research_entities`,
 * and neither table is visible from here.
 */
export function expandKeywordSpace(
  space: KeywordSpace,
  entitiesByDimension: Record<string, SpaceEntity[]>,
  opts: ExpandOptions = {},
): ExpansionResult {
  const maxKeywords = opts.maxKeywords ?? DEFAULT_MAX_KEYWORDS
  const pairwiseCap = space.pairwiseCap ?? DEFAULT_PAIRWISE_CAP

  const keywords: GeneratedKeyword[] = []
  const notes: string[] = []
  const seen = new Set<string>()
  let dropped = 0

  for (const pattern of space.patterns) {
    const slots = patternSlots(pattern.template)
    const slotKeys = [...new Set(slots.map((s) => `${s.dimension}:${s.ordinal}`))]

    // Build one pool per slot. Repeated dimensions share a source list.
    const pools = new Map<string, SpaceEntity[]>()
    let missingDimension = false
    for (const s of slots) {
      const pool = entitiesByDimension[s.dimension]
      if (!pool || pool.length === 0) {
        notes.push(
          `pattern "${pattern.label}" produced nothing: dimension "${s.dimension}" has no active entities`,
        )
        missingDimension = true
        break
      }
      const limit = space.dimensions[s.dimension]?.limit
      pools.set(`${s.dimension}:${s.ordinal}`, limit ? pool.slice(0, limit) : pool)
    }
    if (missingDimension) continue

    const isPairwise = slots.some((s) => s.ordinal > 1)
    if (isPairwise && !pattern.pairwise) {
      // validateKeywordSpace already reports this; expansion refuses rather than
      // silently emitting a product the operator did not ask for.
      notes.push(`pattern "${pattern.label}" skipped: repeated dimension without pairwise: true`)
      continue
    }

    let emittedForPattern = 0
    for (const binding of combinations(slotKeys, pools)) {
      /**
       * Pairwise emits ONE direction only.
       *
       * "bpc-157 vs tb-500" and "tb-500 vs bpc-157" are the same question and
       * Google treats them as near-duplicates, so both directions double the
       * grid for no new coverage. Stated here because it IS a coverage decision:
       * whichever direction the entity list orders first is the one that gets a
       * page.
       */
      if (isPairwise) {
        const first = binding.get(slotKeys[0]!)
        const second = binding.get(slotKeys[1]!)
        if (!first || !second) continue
        if (first.slug === second.slug) continue
        const pool = pools.get(slotKeys[0]!) ?? []
        if (pool.findIndex((e) => e.slug === first.slug) >= pool.findIndex((e) => e.slug === second.slug)) {
          continue
        }
        if (emittedForPattern >= pairwiseCap) {
          dropped += 1
          continue
        }
      }

      if (keywords.length >= maxKeywords) {
        dropped += 1
        continue
      }

      const keyword = fill(pattern.template, binding)
      const keywordNorm = normaliseKeyword(keyword)
      if (!keywordNorm || seen.has(keywordNorm)) continue
      seen.add(keywordNorm)

      const entities: Record<string, string> = {}
      for (const [key, entity] of binding) {
        const [dim, ord] = key.split(':')
        entities[ord === '1' ? dim! : key] = entity.slug
      }

      keywords.push({
        keyword: keywordNorm,
        keywordNorm,
        seedKey: pattern.label,
        patternLabel: pattern.label,
        entities,
      })
      emittedForPattern += 1
    }

    if (isPairwise && emittedForPattern >= pairwiseCap) {
      notes.push(
        `pattern "${pattern.label}" hit the pairwise cap at ${pairwiseCap} — this pattern is sampled, not expanded`,
      )
    }
  }

  if (keywords.length >= maxKeywords) {
    notes.push(
      `space hit the ${maxKeywords}-keyword ceiling. ${dropped} row(s) were never generated — ` +
        `this is a sample of the space, not the space`,
    )
  }

  return { keywords, dropped, notes }
}

/**
 * Match a keyword we already rank for back onto the entities that produced it.
 *
 * ==================== BOUNDARY-SAFE, NEVER BARE SUBSTRING ====================
 * `plan-step0-experiment.md` §1.2: the citation-hub probe counted the locality
 * token `wi` as a match for every `wiki*` domain and inflated its own result
 * with a wiki-spam network.
 *
 * Here the cost of the same bug is an under-report in the other direction — a
 * keyword wrongly attributed to an entity looks like coverage we do not have,
 * and coverage we think we have is a page we never build.
 * ===========================================================================
 */
export function matchEntities(keywordNorm: string, entities: SpaceEntity[]): SpaceEntity[] {
  const hay = ` ${keywordNorm} `
  const out: SpaceEntity[] = []
  for (const entity of entities) {
    const forms = [entity.label, ...entity.aliases]
    for (const form of forms) {
      const needle = normaliseKeyword(form)
      if (!needle) continue
      // Word-boundary on both sides. Hyphens and digits count as word characters
      // here because "bpc-157" must not match inside "bpc-1570".
      if (hay.includes(` ${needle} `) || new RegExp(`(^|\\s)${escapeRe(needle)}($|\\s)`).test(hay)) {
        out.push(entity)
        break
      }
    }
  }
  return out
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
