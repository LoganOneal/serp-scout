import type { DomainAuthority, MapPackSnapshot, SerpItem, SerpSnapshot } from '@rnr/core'
import { normaliseDomain } from '@rnr/core'
import { Rng } from './prng.js'

/**
 * Deterministic offline providers. Zero network, zero cost, always registered.
 *
 * These exist so the entire pipeline is runnable end-to-end for $0, and so the
 * e2e suite can assert `spend === 0` rather than trusting that nothing was
 * bought.
 *
 * ==================== WHY THEY SPAN ARCHETYPES ====================
 * The naive fixture generator produces ten plausible-looking results per SERP
 * with random link counts, which yields difficulty scores clustered in a narrow
 * band around the middle. Every ordering bug in the model survives that: if
 * every row scores 40-50, nothing reveals that the ranking between them is
 * wrong, and the results table looks populated and informative while being
 * useless.
 *
 * So the keyword hash selects an ARCHETYPE first -- soft / mixed / brutal /
 * dead -- and the generator builds a structurally different page for each. The
 * e2e suite then asserts real spread, which is the assertion that actually has
 * teeth.
 * =================================================================
 */

export type FixtureArchetype = 'soft' | 'mixed' | 'brutal' | 'dead'

const PLATFORM_POOL = [
  { domain: 'yelp.com', path: '/search?find_desc={niche}&find_loc={city}' },
  { domain: 'angi.com', path: '/companylist/us/{st}/{cityslug}/{nicheslug}.htm' },
  { domain: 'thumbtack.com', path: '/{st}/{cityslug}/{nicheslug}/' },
  { domain: 'bbb.org', path: '/us/{st}/{cityslug}/category/{nicheslug}' },
  { domain: 'yellowpages.com', path: '/{cityslug}-{st}/{nicheslug}' },
  { domain: 'homeadvisor.com', path: '/c.{nicheslug}.{cityslug}.{st}.-12053.html' },
  { domain: 'expertise.com', path: '/{st}/{cityslug}/{nicheslug}' },
  { domain: 'facebook.com', path: '/marketplace/{cityslug}/{nicheslug}/' },
  { domain: 'nextdoor.com', path: '/pages/{nicheslug}-{cityslug}-{st}/' },
  { domain: 'mapquest.com', path: '/us/{st}/{cityslug}/{nicheslug}' },
]

const GENERIC_LOCAL_NAMES = [
  'bobs',
  'premier',
  'allstar',
  'summit',
  'northside',
  'lakeside',
  'quality',
  'reliable',
  'apex',
  'heritage',
  'cornerstone',
  'bluesky',
]
const GENERIC_LOCAL_SUFFIXES = ['services', 'contracting', 'group', 'co', 'pros', 'and-sons']

const MEDIA_POOL = ['bobvila.com', 'homewyse.com', 'fixr.com', 'thisoldhouse.com', 'forbes.com']

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}
function squash(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '')
}

export interface FixtureContext {
  keyword: string
  locationCode: number
  localityName: string
  stateCode: string
  nicheNoun: string
  nicheEmdToken: string
}

/** The archetype is a pure function of the keyword, so it never drifts. */
export function archetypeFor(keyword: string): FixtureArchetype {
  const rng = new Rng(`archetype:${keyword}`)
  const roll = rng.float()
  // Weighted so the corpus looks like a real one: mostly mixed, a healthy
  // minority genuinely soft, some brutal, a few not-actually-local.
  if (roll < 0.28) return 'soft'
  if (roll < 0.72) return 'mixed'
  if (roll < 0.92) return 'brutal'
  return 'dead'
}

interface PlannedResult {
  domain: string
  url: string
  title: string
  isHomepage: boolean
  /** null means "this domain has no measurable link profile" -> unresolved. */
  refMainDomains: number | null
  nofollowShare: number
  spamScore: number | null
}

function platformResult(
  ctx: FixtureContext,
  rng: Rng,
  used: Set<string>,
): PlannedResult {
  const pool = PLATFORM_POOL.filter((p) => !used.has(p.domain))
  const p = pool.length > 0 ? rng.pick(pool) : rng.pick(PLATFORM_POOL)
  used.add(p.domain)
  const path = p.path
    .replace('{niche}', encodeURIComponent(ctx.nicheNoun))
    .replace('{city}', encodeURIComponent(`${ctx.localityName}, ${ctx.stateCode}`))
    .replace(/\{cityslug\}/g, slug(ctx.localityName))
    .replace(/\{nicheslug\}/g, slug(ctx.nicheNoun))
    .replace(/\{st\}/g, ctx.stateCode.toLowerCase())
  return {
    domain: p.domain,
    url: `https://www.${p.domain}${path}`,
    title: `The 10 Best ${titleCase(ctx.nicheNoun)} in ${ctx.localityName}, ${ctx.stateCode}`,
    isHomepage: false,
    // Platforms have huge real profiles. Generated faithfully on purpose: the
    // platform authority discount must be doing the work, not the fixture.
    refMainDomains: rng.logInt(200_000, 4_000_000),
    nofollowShare: 0.18,
    spamScore: rng.int(2, 14),
  }
}

function exactMatchResult(ctx: FixtureContext, rng: Rng, strength: 'strong' | 'weak'): PlannedResult {
  const order = rng.bool()
  const domain = order
    ? `${squash(ctx.localityName)}${ctx.nicheEmdToken}.com`
    : `${ctx.nicheEmdToken}${squash(ctx.localityName)}.com`
  return {
    domain,
    url: `https://${domain}/`,
    title: `${ctx.localityName} ${titleCase(ctx.nicheNoun)} | Free Estimates`,
    isHomepage: true,
    refMainDomains: strength === 'strong' ? rng.logInt(150, 450) : rng.logInt(15, 90),
    nofollowShare: rng.float() * 0.2 + 0.15,
    spamScore: rng.int(2, 10),
  }
}

function genericLocalResult(ctx: FixtureContext, rng: Rng, used: Set<string>): PlannedResult {
  let domain = ''
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = `${rng.pick(GENERIC_LOCAL_NAMES)}${rng.pick(GENERIC_LOCAL_SUFFIXES).replace(/-/g, '')}.com`
    if (!used.has(candidate)) {
      domain = candidate
      break
    }
  }
  if (!domain) domain = `local${rng.int(1000, 9999)}services.com`
  used.add(domain)

  // Most small local sites have NO measurable link profile. Returning null here
  // rather than 0 is the whole point: the pipeline negative-caches them and the
  // scorer omits them instead of treating them as zero-authority jackpots.
  const measurable = rng.bool(0.55)
  return {
    domain,
    url: `https://${domain}/`,
    title: `${titleCase(domain.replace('.com', ''))} - Serving ${ctx.localityName} and Surrounding Areas`,
    isHomepage: true,
    refMainDomains: measurable ? rng.logInt(1, 40) : null,
    nofollowShare: rng.float() * 0.3 + 0.35,
    spamScore: measurable ? rng.int(4, 28) : null,
  }
}

function mediaResult(ctx: FixtureContext, rng: Rng, used: Set<string>): PlannedResult {
  const pool = MEDIA_POOL.filter((d) => !used.has(d))
  const domain = pool.length > 0 ? rng.pick(pool) : rng.pick(MEDIA_POOL)
  used.add(domain)
  return {
    domain,
    url: `https://www.${domain}/costs/${slug(ctx.nicheNoun)}-cost/`,
    title: `How Much Does ${titleCase(ctx.nicheNoun)} Cost in 2026?`,
    isHomepage: false,
    refMainDomains: rng.logInt(20_000, 400_000),
    nofollowShare: 0.2,
    spamScore: rng.int(2, 12),
  }
}

function titleCase(s: string): string {
  return s.replace(/\b[a-z]/g, (c) => c.toUpperCase())
}

/** Build the ten-slot plan for an archetype. */
function planResults(ctx: FixtureContext, archetype: FixtureArchetype): PlannedResult[] {
  const rng = new Rng(`serp:${ctx.keyword}:${ctx.locationCode}`)
  const used = new Set<string>()
  const plan: PlannedResult[] = []

  switch (archetype) {
    case 'soft': {
      // Directories everywhere, one or two thin locals at the bottom. The market
      // this tool exists to find.
      const platformCount = rng.int(7, 8)
      for (let i = 0; i < platformCount; i++) plan.push(platformResult(ctx, rng, used))
      while (plan.length < 10) plan.push(genericLocalResult(ctx, rng, used))
      break
    }
    case 'mixed': {
      // A couple of committed operators sitting among directories.
      const committed = rng.int(1, 2)
      const platformCount = rng.int(5, 6)
      for (let i = 0; i < platformCount; i++) plan.push(platformResult(ctx, rng, used))
      for (let i = 0; i < committed; i++) plan.push(exactMatchResult(ctx, rng, 'weak'))
      while (plan.length < 10) plan.push(genericLocalResult(ctx, rng, used))
      // Shuffle so operators are not always at the same positions -- position is
      // what intentLock keys on, so fixing it would flatten that component.
      return rng.shuffle(plan).slice(0, 10)
    }
    case 'brutal': {
      // Exact-match operators holding the top, directories mopping up below.
      const operators = rng.int(4, 5)
      for (let i = 0; i < operators; i++) plan.push(exactMatchResult(ctx, rng, 'strong'))
      while (plan.length < 10) plan.push(platformResult(ctx, rng, used))
      break
    }
    case 'dead': {
      // NOT A LOCAL QUERY HERE. National media and marketplaces, no local
      // businesses, and (below) no local pack. Structurally this scores as the
      // easiest thing in the locality and is a guaranteed wasted build -- which
      // is exactly why the fixture set has to contain some.
      for (let i = 0; i < 4; i++) plan.push(mediaResult(ctx, rng, used))
      for (let i = 0; i < 3; i++) plan.push(platformResult(ctx, rng, used))
      while (plan.length < 10) plan.push(mediaResult(ctx, rng, used))
      break
    }
  }
  return plan.slice(0, 10)
}

// ---------------------------------------------------------------------------

export function fixtureOrganicSerp(ctx: FixtureContext): SerpSnapshot {
  const archetype = archetypeFor(ctx.keyword)
  const plan = planResults(ctx, archetype)
  const items: SerpItem[] = plan.map((p, i) => ({
    position: i + 1,
    domain: normaliseDomain(p.domain),
    url: p.url,
    title: p.title,
    description: null,
    isHomepage: p.isHomepage,
    breadcrumb: null,
  }))
  return {
    keyword: ctx.keyword,
    locationCode: ctx.locationCode,
    items,
    fetchedAt: new Date().toISOString(),
    source: 'fixture',
  }
}

/**
 * Discovery fixture: normalised organic snapshot + raw multi-type DFS items.
 *
 * Seed `discovery:${keyword}:${locationCode}`:
 *   ~15% ≥1 organic Reddit, ~10% discussions pack (Reddit+Quora mix), ~5% both.
 * Deterministic so e2e can assert hits without live DFS.
 */
export function fixtureOrganicSerpDetailed(
  ctx: FixtureContext,
  opts?: { device?: 'desktop' | 'mobile' },
): {
  snapshot: SerpSnapshot
  rawItems: Array<Record<string, unknown>>
} {
  const device = opts?.device ?? 'desktop'
  const snapshot = fixtureOrganicSerp(ctx)
  const rng = new Rng(`discovery:${ctx.keyword}:${ctx.locationCode}:${device}`)

  // Start from organic-only raw shapes matching scoring items.
  const rawItems: Array<Record<string, unknown>> = snapshot.items.map((it, i) => ({
    type: 'organic',
    rank_group: it.position,
    rank_absolute: i + 2, // leave room for a pack above
    domain: it.domain,
    url: it.url,
    title: it.title,
    description: it.description,
    breadcrumb: it.breadcrumb,
  }))

  const wantOrganicReddit = rng.float() < 0.2 // ~15% organic + share of both
  const wantPack = rng.float() < 0.15 // ~10% pack + share of both
  // Force a small both-rate by independent rolls (~3%); top up to ~5% when both missed.
  const forceBoth = !wantOrganicReddit && !wantPack && rng.float() < 0.05
  const organicReddit = wantOrganicReddit || forceBoth
  const pack = wantPack || forceBoth

  const postId = () => {
    // Base-36-ish deterministic post ids from the same seed stream.
    const n = rng.int(0x100000, 0xfffffff)
    return n.toString(36)
  }

  if (organicReddit) {
    const id = postId()
    const sub = rng.pick(['electricians', 'HVAC', 'HomeImprovement', 'plumbing', ctx.stateCode.toLowerCase() || 'local'])
    const pos = Math.min(snapshot.items.length, rng.int(2, 8))
    rawItems.splice(pos - 1, 0, {
      type: 'organic',
      rank_group: pos,
      rank_absolute: pos + 1,
      domain: 'www.reddit.com',
      url: `https://www.reddit.com/r/${sub}/comments/${id}/${slug(ctx.keyword)}/`,
      title: `${titleCase(ctx.nicheNoun || ctx.keyword)} recommendations in ${ctx.localityName}?`,
      description: null,
      breadcrumb: `reddit.com › r/${sub}`,
    })
    // Re-number rank_group for pure organic after insert would be ideal; extract
    // uses parseRedditPermalink + type=organic so positions on non-Reddit rows
    // stay usable for scoring path via snapshot (unchanged).
  }

  if (pack) {
    const n = rng.int(1, 3)
    const elements: Array<Record<string, unknown>> = []
    for (let i = 0; i < n; i++) {
      if (i > 0 && rng.bool(0.35)) {
        elements.push({
          type: 'discussions_and_forums_element',
          domain: 'www.quora.com',
          url: `https://www.quora.com/Who-is-a-good-${slug(ctx.keyword)}-in-${slug(ctx.localityName)}`,
          title: `Who is a good ${ctx.nicheNoun || ctx.keyword}?`,
        })
        continue
      }
      const id = postId()
      const sub = rng.pick(['local', 'Advice', ctx.localityName.replace(/\s+/g, '') || 'City', 'HomeImprovement'])
      elements.push({
        type: 'discussions_and_forums_element',
        domain: 'reddit.com',
        url: `https://www.reddit.com/r/${sub}/comments/${id}/need_${slug(ctx.keyword)}/`,
        title: `Need ${ctx.nicheNoun || ctx.keyword} near ${ctx.localityName}`,
      })
    }
    rawItems.unshift({
      type: 'discussions_and_forums',
      rank_group: 1,
      rank_absolute: 1,
      title: 'Discussions and forums',
      items: elements,
    })
  }

  return { snapshot, rawItems }
}

export function fixtureMapPack(ctx: FixtureContext): MapPackSnapshot {
  const archetype = archetypeFor(ctx.keyword)
  const rng = new Rng(`maps:${ctx.keyword}:${ctx.locationCode}`)
  // A 'dead' keyword has NO local pack. That, plus no local business in the top
  // 10, is what fires the not_a_local_query blocker.
  const entryCount = archetype === 'dead' ? 0 : rng.int(3, 3)
  const domains: string[] = []
  if (archetype !== 'dead') {
    const used = new Set<string>()
    for (let i = 0; i < entryCount; i++) {
      // One pack entry typically has no website at all.
      if (i === entryCount - 1 && rng.bool(0.4)) continue
      domains.push(normaliseDomain(genericLocalResult(ctx, rng, used).domain))
    }
  }
  return {
    keyword: ctx.keyword,
    locationCode: ctx.locationCode,
    hasLocalPack: entryCount > 0,
    entryCount,
    domains: [...new Set(domains)],
    fetchedAt: new Date().toISOString(),
    source: 'fixture',
  }
}

/**
 * Link data for a batch of domains.
 *
 * Deliberately returns NOTHING for a substantial share of small local domains --
 * that is the realistic case and it is what exercises the omit-and-renormalise
 * path plus the negative cache. A fixture that answered for every domain would
 * make `weightCovered` permanently 1.0 in tests and the measurement-honesty code
 * would never run.
 */
export function fixtureBulkBacklinks(targets: string[]): {
  authorities: Map<string, DomainAuthority>
  unresolved: string[]
} {
  const authorities = new Map<string, DomainAuthority>()
  const unresolved: string[] = []

  for (const raw of targets) {
    const target = normaliseDomain(raw)
    if (!target) continue
    const rng = new Rng(`authority:${target}`)

    const isPlatformish =
      PLATFORM_POOL.some((p) => target === p.domain) || MEDIA_POOL.includes(target)

    if (!isPlatformish && !rng.bool(0.62)) {
      // No data. Not zero -- unresolved, and negative-cached by the caller.
      unresolved.push(target)
      continue
    }

    const refMain = isPlatformish ? rng.logInt(20_000, 4_000_000) : rng.logInt(1, 420)
    const refTotal = Math.round(refMain * (1 + rng.float() * 0.5))
    const nofollowShare = isPlatformish ? 0.18 : rng.float() * 0.35 + 0.2

    authorities.set(target, {
      target,
      rank: Math.min(1000, Math.round(Math.log10(1 + refMain) * 160)),
      referringDomains: refTotal,
      referringDomainsNofollow: Math.round(refTotal * nofollowShare),
      referringMainDomains: refMain,
      spamScore: rng.int(1, 32),
      sources: ['ranks', 'refdomains', 'spam'],
    })
  }

  return { authorities, unresolved }
}
