import { canonicalCompanyDomain, canonicalPageUrl, extractExplicitEmail, normalizeEmail } from './domains.js'
import { guestPostSourceKey, sourceNoteTitle, sourceRef } from './source-keys.js'
import type { AttioSourceTarget } from './types.js'

export const GUEST_POST_TYPES = new Set(['editorial_guest', 'paid_guest_post'])

export interface GuestPostOpportunityRow {
  id: number
  rootDomain: string
  displayName?: string | null
  opportunityType: string
  eligibility: string
  opportunityUrl: string
  relevantArticleUrl?: string | null
  pitchAngle?: string | null
  whyItMatters?: string | null
  priceAmount?: number | null
  priceStatus?: string | null
  linkType?: string | null
  contactEmail?: string | null
  contactName?: string | null
  contactRole?: string | null
  authorityScore?: number | null
  outboundLinks?: number | null
  serpKeyword?: string | null
  serpPosition?: number | null
  keywordVolume?: number | null
}

export interface GuestPostCsvRow {
  website_url?: string
  conditions?: string
  submission_page?: string
}

export function linkAllowedFromText(text: string | null | undefined): boolean | null {
  if (!text) return null
  if (/do not accept|not currently accepting|no (?:follow )?links|we are not currently accepting/i.test(text)) {
    return false
  }
  if (/author bio|author box|one link|dofollow|include a link/i.test(text)) return true
  return null
}

export function buildGuestPostTargets(args: {
  opportunities: readonly GuestPostOpportunityRow[]
  csvRows?: readonly GuestPostCsvRow[]
}): { targets: AttioSourceTarget[]; skipped: Array<{ id: string; reason: string }> } {
  const targets: AttioSourceTarget[] = []
  const skipped: Array<{ id: string; reason: string }> = []
  const seen = new Set<string>()

  for (const row of args.opportunities) {
    if (!GUEST_POST_TYPES.has(row.opportunityType)) {
      skipped.push({ id: String(row.id), reason: `type_${row.opportunityType}` })
      continue
    }
    if (row.eligibility === 'FAIL') {
      skipped.push({ id: String(row.id), reason: 'eligibility_fail' })
      continue
    }
    const guidelines = canonicalPageUrl(row.opportunityUrl)
    const domain = canonicalCompanyDomain(row.rootDomain)
    const identity = `opp-${row.id}`
    const key = guestPostSourceKey(identity)
    seen.add((domain?.domain ?? row.rootDomain).toLowerCase())
    const email = normalizeEmail(row.contactEmail)
    targets.push({
      workstream: 'guest-posts',
      sourceKey: key,
      sourceRef: sourceRef('serp-scout', `hht_opp_opportunities#${row.id}`),
      companyName: row.displayName || domain?.domain || row.rootDomain,
      domain: domain?.domain ?? null,
      companyWebsiteUrl: domain?.websiteUrl ?? null,
      contact: email ? { email, name: row.contactName, jobTitle: row.contactRole } : null,
      noteTitle: sourceNoteTitle(key),
      noteBody: [
        `Type: ${row.opportunityType}`,
        `Eligibility: ${row.eligibility}`,
        guidelines ? `Guidelines: ${guidelines}` : null,
        row.pitchAngle ? `Pitch: ${row.pitchAngle}` : null,
        row.whyItMatters ? row.whyItMatters : null,
        row.priceStatus ? `Price: ${row.priceStatus}${row.priceAmount != null ? ` ${row.priceAmount}` : ''}` : null,
        row.authorityScore != null ? `Semrush authority: ${row.authorityScore}` : null,
        row.outboundLinks != null ? `Outbound links: ${row.outboundLinks}` : null,
        row.serpKeyword ? `SERP: "${row.serpKeyword}"` : null,
        row.serpPosition != null ? `SERP position: ${row.serpPosition}` : null,
      ]
        .filter(Boolean)
        .join('\n'),
      sourceOwned: {
        source_key: key,
        source_ref: sourceRef('serp-scout', `hht_opp_opportunities#${row.id}`),
        guidelines_url: guidelines,
        target_page_url: canonicalPageUrl(row.relevantArticleUrl) ?? guidelines,
        pitch_topic: row.pitchAngle ?? null,
        link_allowed: row.linkType?.includes('dofollow') ? true : null,
        authority_score: row.authorityScore ?? null,
        outbound_links: row.outboundLinks ?? null,
        eligibility: row.eligibility,
        serp_keyword: row.serpKeyword ?? null,
        serp_position: row.serpPosition ?? null,
        keyword_volume: row.keywordVolume ?? null,
      },
    })
  }

  for (const [index, row] of (args.csvRows ?? []).entries()) {
    const site = canonicalCompanyDomain(row.website_url)
    const guidelines = canonicalPageUrl(row.submission_page || row.website_url)
    if (!site) {
      skipped.push({ id: `csv-${index}`, reason: 'missing_domain' })
      continue
    }
    if (seen.has(site.domain)) continue
    seen.add(site.domain)
    const identity = `${site.domain}:${guidelines ?? index}`
    const key = guestPostSourceKey(identity)
    const email = extractExplicitEmail(row.conditions ?? '')
    const allowed = linkAllowedFromText(row.conditions ?? '')
    if (/not currently accepting|we are not currently accepting/i.test(row.conditions ?? '')) {
      skipped.push({ id: site.domain, reason: 'not_accepting' })
      continue
    }
    targets.push({
      workstream: 'guest-posts',
      sourceKey: key,
      sourceRef: sourceRef('serp-scout', `config/attio/guest-post-submission-rules.csv#${site.domain}`),
      companyName: site.domain,
      domain: site.domain,
      companyWebsiteUrl: site.websiteUrl,
      contact: email ? { email } : null,
      noteTitle: sourceNoteTitle(key),
      noteBody: [
        guidelines ? `Guidelines: ${guidelines}` : null,
        row.conditions ? `Guidelines excerpt: ${row.conditions.slice(0, 800)}` : null,
      ]
        .filter(Boolean)
        .join('\n'),
      sourceOwned: {
        source_key: key,
        source_ref: sourceRef('serp-scout', `config/attio/guest-post-submission-rules.csv#${site.domain}`),
        guidelines_url: guidelines,
        target_page_url: guidelines,
        pitch_topic: null,
        link_allowed: allowed,
      },
    })
  }

  return { targets, skipped }
}
