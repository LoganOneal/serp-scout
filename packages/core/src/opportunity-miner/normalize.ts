export function normalizeKeyword(raw: string): string {
  return raw
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9+]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function omSlugify(raw: string): string {
  const s = normalizeKeyword(raw).replace(/\s+/g, '-')
  return s.slice(0, 80) || 'market'
}

export function tokenize(raw: string): string[] {
  return normalizeKeyword(raw)
    .split(' ')
    .map((t) => (t.length > 4 && t.endsWith('s') ? t.slice(0, -1) : t))
    .filter((t) => t.length > 1 && !STOP.has(t))
}

const STOP = new Set([
  'a',
  'an',
  'the',
  'for',
  'to',
  'of',
  'and',
  'or',
  'in',
  'on',
  'with',
  'from',
  'by',
  'at',
  'is',
  'best',
  'top',
  'online',
  'free',
  'how',
  'what',
  'why',
  'when',
  'where',
  'that',
  'this',
  'your',
  'my',
  'vs',
  'versus',
])

export function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1
  const sa = new Set(a)
  const sb = new Set(b)
  let inter = 0
  for (const t of sa) if (sb.has(t)) inter += 1
  const union = sa.size + sb.size - inter
  return union === 0 ? 0 : inter / union
}

export function tokenSortKey(raw: string): string {
  return tokenize(raw).slice().sort().join(' ')
}

/** Conservative near-duplicate: same tokens ignoring order, or high Jaccard. */
export function areSemanticDuplicates(a: string, b: string): boolean {
  const ka = tokenSortKey(a)
  const kb = tokenSortKey(b)
  if (ka && ka === kb) return true
  return jaccard(tokenize(a), tokenize(b)) >= 0.85
}

export function parseTrendSeries(trend: string | null | undefined): number[] {
  if (!trend) return []
  return trend
    .split(',')
    .map((p) => Number(p.trim()))
    .filter((n) => Number.isFinite(n))
}

export function growthFromSeries(values: number[], months: number): number | null {
  if (values.length < months + 1) return null
  const recent = values.slice(-months)
  const prior = values.slice(-months * 2, -months)
  if (prior.length === 0) return null
  const recentAvg = average(recent)
  const priorAvg = average(prior)
  if (priorAvg <= 0) return recentAvg > 0 ? 1 : 0
  return (recentAvg - priorAvg) / priorAvg
}

export function cagrFromSeries(values: number[], months: number): number | null {
  if (values.length < months + 1) return null
  const start = average(values.slice(0, Math.min(3, values.length)))
  const end = average(values.slice(-3))
  if (start <= 0 || end <= 0) return null
  const years = months / 12
  if (years <= 0) return null
  return Math.pow(end / start, 1 / years) - 1
}

export function average(xs: number[]): number {
  if (xs.length === 0) return 0
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!
}

export function weightedAverage(pairs: Array<{ value: number; weight: number }>): number | null {
  let num = 0
  let den = 0
  for (const p of pairs) {
    if (!Number.isFinite(p.value) || !Number.isFinite(p.weight) || p.weight <= 0) continue
    num += p.value * p.weight
    den += p.weight
  }
  return den === 0 ? null : num / den
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

export function scale01(n: number | null, lo: number, hi: number): number {
  if (n === null || !Number.isFinite(n)) return 0
  if (hi <= lo) return 0
  return clamp((n - lo) / (hi - lo), 0, 1)
}

export function hostFromDomain(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0]!
    .split('?')[0]!
}
