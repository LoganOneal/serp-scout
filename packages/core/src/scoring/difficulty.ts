import {
  refDomainCount,
  type ClassifiedResult,
  type ComponentName,
  type DifficultyResult,
  type ScoreComponent,
} from '../types.js'
import { slotDefenceKey } from './classify.js'
import {
  AUTHORITY_SATURATION_REF_DOMAINS,
  AUTHORITY_WALL_MIN_CTR_COVERAGE,
  COMMITTED_OPERATOR_DEDICATION,
  COMPONENT_WEIGHTS,
  CTR_CURVE,
  INTENT_LOCK_POSITION_FLOOR,
  LINK_QUALITY_DOFOLLOW_WEIGHT,
  LINK_QUALITY_SPAM_WEIGHT,
  PLATFORM_AUTHORITY_CONSTANT,
  SLOT_DEFENCE,
  SPAM_SCORE_FULL_DISCOUNT,
} from './priors.js'

const clamp01 = (n: number) => Math.min(1, Math.max(0, n))

/** CTR weight for a 1-based position, 0 beyond the curve. */
function ctr(position: number): number {
  return CTR_CURVE[position - 1] ?? 0
}

/**
 * Normalise a referring-main-domain count onto 0..1 on a log curve.
 * log so that 0 -> 10 refdomains matters far more than 400 -> 410; the
 * saturation ceiling is set for LOCAL service SERPs, not national ones, which is
 * the core reason Ahrefs KD misreads these pages.
 */
function normaliseAuthority(refDomains: number): number {
  const r = Math.max(0, refDomains)
  return clamp01(Math.log10(1 + r) / Math.log10(1 + AUTHORITY_SATURATION_REF_DOMAINS))
}

function unmeasured(name: ComponentName, note: string): ScoreComponent {
  return { value: null, weight: COMPONENT_WEIGHTS[name], measured: false, note }
}

function measured(name: ComponentName, value: number, note: string | null = null): ScoreComponent {
  return { value: clamp01(value), weight: COMPONENT_WEIGHTS[name], measured: true, note }
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

/**
 * CTR-weighted link strength of the defenders.
 *
 * Platforms contribute PLATFORM_AUTHORITY_CONSTANT regardless of their real
 * profile. Non-platforms contribute their normalised refdomain count -- and if
 * that count was never measured, the result is EXCLUDED from both numerator and
 * denominator rather than counted as zero.
 *
 * That exclusion is the whole point. Zero referring domains is the strongest
 * "beatable" signal this model has; rendering a missing measurement as 0 turns
 * every unknown domain into a jackpot and every unscannable SERP into a
 * recommendation.
 */
function computeAuthorityWall(results: ClassifiedResult[]): ScoreComponent {
  let weightedSum = 0
  let weightUsed = 0
  let weightTotal = 0
  let skipped = 0

  for (const r of results) {
    const w = ctr(r.item.position)
    if (w === 0) continue
    weightTotal += w

    if (r.isPlatform) {
      weightedSum += w * PLATFORM_AUTHORITY_CONSTANT
      weightUsed += w
      continue
    }
    const rd = refDomainCount(r.authority)
    if (rd === null) {
      skipped++
      continue // UNMEASURED -- omitted, never zeroed.
    }
    weightedSum += w * normaliseAuthority(rd)
    weightUsed += w
  }

  if (weightUsed === 0) {
    return unmeasured('authorityWall', 'No link data for any ranking result.')
  }

  // Platforms are always evaluable (they use a constant), so weightUsed > 0
  // proves nothing about whether we measured the REAL defenders. Require that
  // the evaluated results account for a meaningful share of the page's clicks.
  // See AUTHORITY_WALL_MIN_CTR_COVERAGE -- without this, a page held by five
  // exact-match operators we could not measure scores as wide open.
  const ctrCoverage = weightTotal === 0 ? 0 : weightUsed / weightTotal
  if (ctrCoverage < AUTHORITY_WALL_MIN_CTR_COVERAGE) {
    return unmeasured(
      'authorityWall',
      `Link data covered only ${Math.round(ctrCoverage * 100)}% of the page's click weight (need ${Math.round(
        AUTHORITY_WALL_MIN_CTR_COVERAGE * 100,
      )}%). The results actually defending this query were not measured.`,
    )
  }

  const note =
    skipped > 0
      ? `${skipped} of ${results.length} results had no link measurement and were omitted, not counted as zero. Covers ${Math.round(ctrCoverage * 100)}% of the page's click weight.`
      : null
  return measured('authorityWall', weightedSum / weightUsed, note)
}

/**
 * What KIND of result holds each slot. This is the component no commercial
 * difficulty metric models, and it is the one that decides a local build: a
 * directory listing, a Facebook page or a "10 Best Plumbers" listicle is real
 * estate that no local operator has claimed.
 *
 * Always measurable -- it needs only the SERP itself, no purchased link data.
 */
function computeSlotDefence(results: ClassifiedResult[]): ScoreComponent {
  let weightedSum = 0
  let weightUsed = 0
  for (const r of results) {
    const w = ctr(r.item.position)
    if (w === 0) continue
    const key = slotDefenceKey(r)
    const defence = SLOT_DEFENCE[key] ?? SLOT_DEFENCE['unknown']!
    weightedSum += w * defence
    weightUsed += w
  }
  if (weightUsed === 0) return unmeasured('slotDefence', 'No results in the top 10.')
  return measured('slotDefence', weightedSum / weightUsed)
}

/**
 * Has anyone built a city+niche-dedicated asset here at all?
 *
 * Uses the CTR-weighted maximum rather than the mean: one exact-match operator
 * at #1 locks the intent even if slots 2-10 are all directories, and averaging
 * would wash that out. Position matters, so the max is scaled by how much
 * traffic that slot commands relative to #1.
 */
function computeIntentLock(results: ClassifiedResult[]): ScoreComponent {
  if (results.length === 0) return unmeasured('intentLock', 'No results in the top 10.')
  const top = CTR_CURVE[0]!
  let best = 0
  for (const r of results) {
    const w = ctr(r.item.position)
    if (w === 0) continue
    // Scale so a #1 exact match reads ~0.95 while the same domain at #8 reads
    // ~0.25. An exact-match operator buried at the bottom of the page has not
    // locked the intent; one at the top has.
    const positional = INTENT_LOCK_POSITION_FLOOR + (1 - INTENT_LOCK_POSITION_FLOOR) * (w / top)
    best = Math.max(best, r.dedication * positional)
  }
  return measured('intentLock', best)
}

/**
 * How DANGEROUS the top-5 non-platform defenders' link profiles actually are.
 *
 * Borrowed from Semrush KD: 300 nofollow citations is not the defensive asset
 * that 300 editorial dofollow links is, and a raw refdomain count cannot tell
 * them apart. Spam score INVERTS -- a high-spam defender is likely to be
 * discounted by Google, so it makes the SERP easier.
 *
 * IMPORTANT: the quality factor SCALES the defender's normalised authority, it
 * does not stand alone. An earlier version averaged dofollow ratio and spam
 * score directly, which scored a 25-referring-domain local business with clean
 * links at ~0.71 "hard" -- because its links, though almost nonexistent, were
 * of good quality. Quality without quantity is not a defence. Multiplying by
 * normalised authority makes this component read as "are these defenders'
 * links real AND numerous enough to matter", which is the question that
 * decides a build.
 */
function computeLinkQuality(results: ClassifiedResult[]): ScoreComponent {
  const candidates = results.filter((r) => !r.isPlatform && r.item.position <= 5)

  const effective: number[] = []
  let sawDofollow = false
  let sawSpam = false

  for (const r of candidates) {
    const a = r.authority
    if (!a) continue
    const rd = refDomainCount(a)
    if (rd === null) continue // No authority to scale -- omit, don't zero.

    // Sub-renormalisation: the omit-don't-zero rule applies WITHIN the
    // component too. A defender with a dofollow ratio but no spam score is
    // scored purely on dofollow, not half-penalised by the missing number.
    let qSum = 0
    let qWeight = 0
    const total = a.referringDomains
    const nofollow = a.referringDomainsNofollow
    if (total !== null && total > 0 && nofollow !== null) {
      qSum += LINK_QUALITY_DOFOLLOW_WEIGHT * clamp01(1 - nofollow / total)
      qWeight += LINK_QUALITY_DOFOLLOW_WEIGHT
      sawDofollow = true
    }
    if (a.spamScore !== null) {
      const spamEase = clamp01(a.spamScore / SPAM_SCORE_FULL_DISCOUNT)
      qSum += LINK_QUALITY_SPAM_WEIGHT * (1 - spamEase)
      qWeight += LINK_QUALITY_SPAM_WEIGHT
      sawSpam = true
    }
    if (qWeight === 0) continue // Neither quality signal available for this one.

    effective.push(normaliseAuthority(rd) * (qSum / qWeight))
  }

  if (effective.length === 0) {
    return unmeasured(
      'linkQuality',
      'No dofollow ratio or spam score measured for any top-5 non-platform result.',
    )
  }

  const note = !sawDofollow
    ? 'Scored on spam score only; no dofollow ratio available.'
    : !sawSpam
      ? 'Scored on dofollow ratio only; no spam score available.'
      : null
  return measured('linkQuality', mean(effective), note)
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 0 ? ((s[mid - 1]! + s[mid]!) / 2) : s[mid]!
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export interface DifficultyInput {
  results: ClassifiedResult[]
  /** From the map pack call. Needed for the "not actually a local query" blocker. */
  hasLocalPack: boolean
}

export function scoreDifficulty(input: DifficultyInput): DifficultyResult {
  const results = [...input.results]
    .filter((r) => r.item.position >= 1 && r.item.position <= CTR_CURVE.length)
    .sort((a, b) => a.item.position - b.item.position)

  const components: Record<ComponentName, ScoreComponent> = {
    authorityWall: computeAuthorityWall(results),
    slotDefence: computeSlotDefence(results),
    intentLock: computeIntentLock(results),
    linkQuality: computeLinkQuality(results),
  }

  // Omit-and-renormalise. An unmeasured component contributes to NEITHER the
  // numerator nor the denominator, so difficulty is the honest score over the
  // signals we actually have, and `weightCovered` says how much that was.
  let numerator = 0
  let denominator = 0
  for (const c of Object.values(components)) {
    if (!c.measured || c.value === null) continue
    numerator += c.weight * c.value
    denominator += c.weight
  }

  const totalWeight = Object.values(COMPONENT_WEIGHTS).reduce((a, b) => a + b, 0)
  const weightCovered = denominator / totalWeight

  // Nothing measured => null, NOT 0. A 0 would sort to the top of an
  // easiest-first table and read as the best opportunity on the page.
  const difficulty = denominator === 0 ? null : Math.round(100 * (numerator / denominator))

  const nonPlatform = results.filter((r) => !r.isPlatform)
  const nonPlatformRefDomains = nonPlatform
    .map((r) => refDomainCount(r.authority))
    .filter((n): n is number => n !== null)

  const platformHeldSlots = results.filter((r) => r.isPlatform).length
  const top5 = results.filter((r) => r.item.position <= 5)

  return {
    difficulty,
    weightCovered,
    components,
    platformHeldSlots,
    /**
     * Slots not held by a committed local operator. Platforms plus low-dedication
     * results: real estate a local build can realistically take.
     */
    slotsOpen: results.filter((r) => r.isPlatform || r.dedication < COMMITTED_OPERATOR_DEDICATION)
      .length,
    medianNonPlatformRefDomains: median(nonPlatformRefDomains),
    minNonPlatformRefDomains:
      nonPlatformRefDomains.length > 0 ? Math.min(...nonPlatformRefDomains) : null,
    pos1NonPlatformRefDomains:
      refDomainCount(results.find((r) => r.item.position === 1 && !r.isPlatform)?.authority ?? null),
    exactMatchHomepagesTop5: top5.filter((r) => r.isExactMatch && r.item.isHomepage).length,
    localBusinessesTop5Dedicated: top5.filter(
      (r) => r.domainClass === 'local_business' && r.dedication >= COMMITTED_OPERATOR_DEDICATION,
    ).length,
    hasLocalBusinessTop10: results.some((r) => r.domainClass === 'local_business'),
    /** Any non-platform result with a real link measurement. Gates the 30-day band. */
    linkDataMeasured: nonPlatformRefDomains.length > 0,
  }
}
