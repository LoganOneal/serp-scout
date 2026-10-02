import type { FilterStatus, SiteType } from './types.js'

export interface FilterSignals {
  rootDomain: string
  siteType: SiteType
  onCompetitorList: boolean
  editorial: boolean
  linksToHht: boolean
  blocked: boolean
  contactedWithinCooldown: boolean
  declinedWithinCooldown: boolean
  sellsPlacements: boolean
  highOutboundLinks: boolean
  highSponsoredShare: boolean
  unrelatedTopicSpread: boolean
  trafficDownHard: boolean
  parasitePage: boolean
  hasContact: boolean
  contextualFit: boolean | null
}

export interface FilterDecision {
  status: FilterStatus
  reasons: string[]
}

const EXCLUDED_SITE_TYPES = new Set<SiteType>([
  'ota_booking',
  'competitor_directory',
  'forum_social_ugc',
  'marketplace',
  'search_engine',
  'hht',
  'hotel_property',
  'hotel_chain',
])

export function decideFilter(signals: FilterSignals): FilterDecision {
  const reasons: string[] = []
  if (signals.siteType === 'hht' || signals.rootDomain === 'hotelhottubs.com') reasons.push('hht')
  if (signals.siteType === 'competitor_directory' || signals.onCompetitorList) reasons.push('competitor')
  if (signals.siteType === 'ota_booking') reasons.push('ota')
  if (EXCLUDED_SITE_TYPES.has(signals.siteType) && signals.siteType !== 'hht') reasons.push(signals.siteType)
  if (!signals.editorial) reasons.push('non_editorial')
  if (signals.linksToHht) reasons.push('already_links')
  if (signals.blocked) reasons.push('blocked')
  if (signals.contactedWithinCooldown) reasons.push('recently_contacted')
  if (signals.declinedWithinCooldown) reasons.push('declined_cooldown')
  if (signals.parasitePage) reasons.push('parasite_seo')
  if (!signals.hasContact) reasons.push('no_contact')
  if (signals.contextualFit === false) reasons.push('contextual_fit')

  const farmSignals = [
    signals.sellsPlacements,
    signals.highOutboundLinks,
    signals.highSponsoredShare,
    signals.unrelatedTopicSpread,
    signals.trafficDownHard,
  ].filter(Boolean).length

  const hard = reasons.filter((reason) => reason !== 'non_editorial' || signals.siteType !== 'unknown')
  if (hard.length > 0) return { status: 'EXCLUDED', reasons: unique([...hard, ...(farmSignals ? ['link_farm_context'] : [])]) }
  if (farmSignals >= 2) return { status: 'EXCLUDED', reasons: ['link_farm'] }
  if (farmSignals === 1) return { status: 'REVIEW', reasons: ['link_farm'] }
  return { status: 'PASS', reasons: [] }
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}
