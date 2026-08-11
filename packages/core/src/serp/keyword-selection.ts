/**
 * Choosing which discovered keywords are worth buying a SERP for.
 *
 * ==================== DISCOVERY RETURNS EVERYTHING ====================
 * `generateKeywordIdeas` answers with what people search, which includes plenty
 * that no local contractor can sell against: jobs, salaries, licensing exams,
 * DIY how-tos, and pure information. Buying SERPs for those spends money to
 * discover that a market is full of YouTube.
 *
 * The filter is deliberately NARROW. Every exclusion below names a searcher who
 * cannot become a customer; anything merely unfamiliar is kept, because the
 * whole point of discovery is to surface phrases a template would never guess.
 * "jacuzzi bath remodel" and "tub to shower conversion" both look odd next to a
 * niche called Bathroom Remodeling, and both are real demand with real intent.
 * =====================================================================
 */

/** Searchers who are not buying a local service, whatever the volume. */
const NON_BUYER = [
  // Looking for work, not for a contractor.
  /\b(jobs?|hiring|salary|salaries|wage|career|apprentice(ship)?|employment|resume)\b/i,
  // Becoming one, not hiring one.
  /\b(license|licensing|certification|certified|exam|training|course|classes|school|degree)\b/i,
  // Doing it themselves.
  /\b(diy|do it yourself|how to|tutorial|step by step)\b/i,
  // Reading, not buying.
  /\b(meaning|definition|wikipedia|reddit|youtube|images?|pictures?|photos?)\b/i,
  // Selling to us, not buying from us.
  /\b(software|crm|leads? for|marketing for|seo for|insurance for)\b/i,
] as const

export interface SelectableKeyword {
  keyword: string
  avgMonthlySearches: number | null
}

export interface KeywordSelectionOptions {
  /** How many to keep. */
  limit: number
  /**
   * Volume below which a keyword is not worth a SERP.
   *
   * Not zero: Google Ads reports very low volume in wide buckets, and a "10"
   * is as likely to be noise as demand. But not high either -- a 30/mo query in
   * one city is a real customer a month for a service worth hundreds.
   */
  minVolume?: number
  /** Keywords to keep regardless of the filters, e.g. the niche's own head term. */
  alwaysInclude?: string[]
}

export interface KeywordSelection {
  keywords: string[]
  /** Kept, with the volume that justified it. Ordered as selected. */
  selected: SelectableKeyword[]
  /** Dropped, and why -- so an empty sweep is never a mystery. */
  rejected: Array<{ keyword: string; reason: 'non_buyer' | 'below_min_volume' | 'no_volume' | 'duplicate' }>
}

export const DEFAULT_MIN_KEYWORD_VOLUME = 20

const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ')

/** True when the phrase belongs to someone who will never hire a contractor. */
export function isNonBuyerKeyword(keyword: string): boolean {
  return NON_BUYER.some((re) => re.test(keyword))
}

/**
 * Pick the keywords worth measuring, highest demand first.
 *
 * Reports what it dropped and why. A sweep that comes back with three keywords
 * should be explainable without re-running it.
 */
export function selectKeywords(
  ideas: SelectableKeyword[],
  opts: KeywordSelectionOptions,
): KeywordSelection {
  const minVolume = opts.minVolume ?? DEFAULT_MIN_KEYWORD_VOLUME
  const always = new Set((opts.alwaysInclude ?? []).map(norm))

  const selected: SelectableKeyword[] = []
  const rejected: KeywordSelection['rejected'] = []
  const seen = new Set<string>()

  // Highest volume first, so `limit` keeps the biggest rather than the earliest.
  const ordered = [...ideas].sort(
    (a, b) => (b.avgMonthlySearches ?? -1) - (a.avgMonthlySearches ?? -1),
  )

  for (const idea of ordered) {
    const key = norm(idea.keyword)
    if (!key) continue
    if (seen.has(key)) {
      rejected.push({ keyword: idea.keyword, reason: 'duplicate' })
      continue
    }
    seen.add(key)

    const pinned = always.has(key)
    if (!pinned && isNonBuyerKeyword(idea.keyword)) {
      rejected.push({ keyword: idea.keyword, reason: 'non_buyer' })
      continue
    }
    if (!pinned && idea.avgMonthlySearches == null) {
      rejected.push({ keyword: idea.keyword, reason: 'no_volume' })
      continue
    }
    if (!pinned && (idea.avgMonthlySearches ?? 0) < minVolume) {
      rejected.push({ keyword: idea.keyword, reason: 'below_min_volume' })
      continue
    }
    selected.push(idea)
  }

  /**
   * Pinned keywords ride along even when discovery never returned them, so a
   * niche always measures its own head term and two runs of the same niche stay
   * comparable.
   */
  for (const pin of opts.alwaysInclude ?? []) {
    const key = norm(pin)
    if (!key || seen.has(key)) continue
    seen.add(key)
    selected.push({ keyword: pin, avgMonthlySearches: null })
  }

  return { keywords: selected.slice(0, opts.limit).map((s) => s.keyword), selected: selected.slice(0, opts.limit), rejected }
}
