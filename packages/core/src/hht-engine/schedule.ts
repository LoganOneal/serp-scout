export interface FrontierKeyword {
  id: number
  priorityScore: number
  cluster: string | null
  city: string | null
  sourceType: string
  scanned: boolean
}

/**
 * Reserve a share of pulls for new clusters, new cities, and publisher-keyword
 * expansions. The rest take the highest priority_score.
 */
export function pickFrontierKeyword<T extends FrontierKeyword>(
  keywords: T[],
  exploreShare: number,
  pullIndex: number,
): T | null {
  if (keywords.length === 0) return null
  const explore = keywords.filter((keyword) => !keyword.scanned || keyword.sourceType === 'publisher_keyword')
  const useExplore = explore.length > 0 && pullIndex % Math.max(1, Math.round(1 / Math.max(exploreShare, 0.01))) === 0
  const pool = useExplore ? explore : keywords
  return [...pool].sort((a, b) => b.priorityScore - a.priorityScore)[0] ?? null
}

export function cacheFresh(checkedAt: Date | null, now: Date, maxAgeDays: number): boolean {
  if (!checkedAt) return false
  return now.getTime() - checkedAt.getTime() < maxAgeDays * 24 * 60 * 60 * 1000
}

export interface CrmLeadPayload {
  publisherExternalId: string
  opportunityExternalId: string
  publisher: { domain: string; displayName: string | null; siteType: string; semrushAuthorityScore: number | null }
  opportunity: { type: string; status: string; primary: boolean }
  pages: Array<{ url: string; title: string | null; position: number | null; keyword: string | null }>
  hht: { targetHhtUrl: string | null; secondaryHhtUrl: string | null; matchRule: string | null; weakTargetMatch: boolean }
  contact: { method: string | null; name: string | null; role: string | null; email: string | null; formUrl: string | null }
  filters: { status: string | null; reasons: string[] }
  draft: { subject: string | null; body: string | null; templateId: string | null }
  provenance: { discoveredAt: string; sourceKeyword: string | null }
}

export function notificationForGads(state: 'GADS_AUTH_FAILURE' | 'GADS_RATE_LIMITED' | 'GADS_RUNNING', credential: string): string | null {
  if (state === 'GADS_AUTH_FAILURE') {
    return `Google Ads authorization failed for ${credential}. Reissue that credential. Keyword planning is paused; Semrush and local stages keep running.`
  }
  if (state === 'GADS_RATE_LIMITED') {
    return 'Google Ads keyword planning has been rate-limited. Ideas stay queued and other stages keep running.'
  }
  if (state === 'GADS_RUNNING') return 'Google Ads keyword planning is running again.'
  return null
}
