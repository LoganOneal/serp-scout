import {
  HOTEL_BL_CONTENT_TYPES,
  HOTEL_BL_ENTITY_SCOPES,
  HOTEL_BL_RELATIONSHIP_TYPES,
  type HotelBlContentType,
  type HotelBlEntityScope,
  type HotelBlRelationshipType,
} from '@rnr/core'
import { db, listHotelBlOpportunities, type HotelBlOpportunityFilters } from '@rnr/data'

export const dynamic = 'force-dynamic'

function numeric(value: string | null): number | undefined {
  if (!value) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(0, Math.min(100, parsed)) : undefined
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  const text = value instanceof Date ? value.toISOString() : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams
  const relationship = params.get('relationship')
  const contentType = params.get('contentType')
  const sort = params.get('sort')
  const direction = params.get('direction')
  const entityScope = params.get('entityScope')
  const filters: HotelBlOpportunityFilters = {
    minimumPriority: numeric(params.get('minimumPriority')),
    minimumFeasibility: numeric(params.get('minimumFeasibility')),
    minimumLinkValue: numeric(params.get('minimumLinkValue')),
    independentOnly: params.get('independentOnly') === '1',
    chainOnly: params.get('chainOnly') === '1',
    hasPressPage: params.get('hasPressPage') === '1',
    hasFollowedPressLinks: params.get('hasFollowedPressLinks') === '1',
    hasPrContact: params.get('hasPrContact') === '1',
    relationshipType: HOTEL_BL_RELATIONSHIP_TYPES.includes(relationship as HotelBlRelationshipType)
      ? (relationship as HotelBlRelationshipType)
      : undefined,
    entityScope: HOTEL_BL_ENTITY_SCOPES.includes(entityScope as HotelBlEntityScope)
      ? (entityScope as HotelBlEntityScope)
      : undefined,
    state: params.get('state') || undefined,
    city: params.get('city') || undefined,
    contentType: HOTEL_BL_CONTENT_TYPES.includes(contentType as HotelBlContentType)
      ? (contentType as HotelBlContentType)
      : undefined,
    crawlStatus: params.get('crawlStatus') || undefined,
    sort: ['priority', 'feasibility', 'link_value', 'effort', 'hotel', 'state'].includes(sort ?? '')
      ? (sort as HotelBlOpportunityFilters['sort'])
      : undefined,
    direction: direction === 'asc' || direction === 'desc' ? direction : undefined,
  }
  const rows = await listHotelBlOpportunities(db(), filters, 20_000)
  const headers = [
    'Priority', 'Hotel', 'City', 'State', 'Brand', 'Target entity', 'Entity scope', 'Entity type',
    'Relationship', 'URL validation', 'Validation confidence', 'Validation reason',
    'Target domain', 'Site control', 'Feasibility', 'Link value', 'Content fit', 'Effort',
    'Press page', 'Existing press links', 'Followed press links', 'Latest press activity',
    'PR contact', 'Contact channel', 'PR name', 'PR title', 'PR email', 'PR phone',
    'PR contact type', 'PR source URL', 'Contact page URL', 'Press kit',
    'Authority score', 'Organic traffic', 'Referring domains',
    'Recommended content', 'Recommended target page', 'Recommended pitch', 'Reasoning', 'Status',
  ]
  const body = [
    headers,
    ...rows.map((row) => [
      row.priorityScore,
      row.hotelName,
      row.city,
      row.state,
      row.brandName,
      row.targetEntity,
      row.entityScope,
      row.entityType,
      row.relationshipType,
      row.urlValidationStatus,
      row.urlValidationConfidence,
      row.urlValidationReason,
      row.domain,
      row.siteControlType,
      row.feasibilityScore,
      row.linkValueScore,
      row.contentFitScore,
      row.effortScore,
      row.hasPressPage,
      row.externalPressLinkCount,
      row.dofollowExternalPressLinkCount,
      row.latestPressDate,
      row.hasPrContact,
      row.contactChannel,
      row.prName,
      row.prTitle,
      row.prEmail,
      row.prPhone,
      row.prContactType,
      row.prSourceUrl,
      row.contactPageUrl,
      row.hasPressKit,
      row.authorityScore,
      row.organicTraffic,
      row.referringDomains,
      row.manualRecommendedContentType ?? row.recommendedContentType,
      row.recommendedTargetPage,
      row.recommendedPitchAngle,
      row.reasoningSummary,
      row.status,
    ]),
  ].map((row) => row.map(csvCell).join(',')).join('\r\n')
  const filename = `hotel-backlink-opportunities-${new Date().toISOString().slice(0, 10)}.csv`
  return new Response(`\uFEFF${body}`, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
    },
  })
}
