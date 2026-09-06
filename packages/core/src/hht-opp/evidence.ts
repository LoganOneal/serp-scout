import type { HhtOppConfidence, HhtOppEvidence } from './types.js'

export function excerptAround(text: string, match: string, radius = 140): string {
  const lower = text.toLowerCase()
  const needle = match.toLowerCase()
  const idx = lower.indexOf(needle)
  if (idx < 0) return match.slice(0, radius * 2)
  const start = Math.max(0, idx - radius)
  const end = Math.min(text.length, idx + match.length + radius)
  return text.slice(start, end).replace(/\s+/g, ' ').trim()
}

export function makeEvidence(
  sourceUrl: string,
  text: string,
  match: string,
  confidence: HhtOppConfidence,
  checkedAt: Date = new Date(),
): HhtOppEvidence {
  return {
    sourceUrl,
    sourceExcerpt: excerptAround(text, match),
    checkedAt: checkedAt.toISOString(),
    confidence,
  }
}

export function firstMatch(text: string, patterns: RegExp[]): RegExpMatchArray | null {
  for (const pattern of patterns) {
    const match = text.match(pattern)
    if (match) return match
  }
  return null
}

export function allMatches(text: string, patterns: RegExp[]): RegExpMatchArray[] {
  const found: RegExpMatchArray[] = []
  for (const pattern of patterns) {
    const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`
    const global = new RegExp(pattern.source, flags)
    for (const match of text.matchAll(global)) found.push(match)
  }
  return found
}

export function collapseWs(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}
