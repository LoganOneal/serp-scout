import { canonicalPageUrl, nameKey, normalizeEmail, officialCompanyDomain } from './domains.js'
import { editorChoiceSourceKey, sourceRef } from './source-keys.js'
import type { AttioSourceTarget } from './types.js'

export const HHT_SITE_ORIGIN = 'https://hotelhottubs.com'

export interface EditorsChoiceMembership {
  year?: number
  slugs: string[]
}

export interface EditorsChoiceProperty {
  id?: string
  slug: string
  name: string
  href?: string | null
  sourceUrl?: string | null
  bookingUrl?: string | null
}

export interface EditorsChoicePressRow {
  hotel_name?: string
  hotel_website?: string
  press_contact_page?: string
}

/** Scraped press-page contacts from `backlink_building/data/hotel-press-prospects-*.csv`. */
export interface EditorsChoiceProspectRow {
  hotel?: string
  domain?: string
  pr_email?: string
  pr_name?: string
  pr_title?: string
  pr_source_url?: string
  contact_page_url?: string
}

export function buildEditorsChoiceTargets(args: {
  membership: EditorsChoiceMembership
  properties: readonly EditorsChoiceProperty[]
  pressContacts?: readonly EditorsChoicePressRow[]
  pressProspects?: readonly EditorsChoiceProspectRow[]
}): { targets: AttioSourceTarget[]; skipped: Array<{ id: string; reason: string }> } {
  const bySlug = new Map(args.properties.filter((p) => p.slug).map((p) => [p.slug, p]))
  const pressByName = new Map<string, EditorsChoicePressRow>()
  for (const row of args.pressContacts ?? []) {
    const key = nameKey(row.hotel_name)
    if (key) pressByName.set(key, row)
  }
  const prospectByName = new Map<string, EditorsChoiceProspectRow>()
  const prospectByDomain = new Map<string, EditorsChoiceProspectRow>()
  for (const row of args.pressProspects ?? []) {
    const name = nameKey(row.hotel)
    if (name && !prospectByName.has(name)) prospectByName.set(name, row)
    const host = officialCompanyDomain(row.domain)?.domain
    if (host && !prospectByDomain.has(host)) prospectByDomain.set(host, row)
  }

  const targets: AttioSourceTarget[] = []
  const skipped: Array<{ id: string; reason: string }> = []

  for (const slug of args.membership.slugs) {
    const property = bySlug.get(slug)
    if (!property) {
      skipped.push({ id: slug, reason: 'slug_not_in_inventory' })
      continue
    }
    const press = pressByName.get(nameKey(property.name))
    const domain = officialCompanyDomain(press?.hotel_website ?? null)
    const prospect =
      prospectByName.get(nameKey(property.name)) ??
      (domain ? prospectByDomain.get(domain.domain) : undefined)
    const listingPath = property.href?.startsWith('/') ? property.href : `/${slug}`
    const hhtListingUrl = `${HHT_SITE_ORIGIN}${listingPath}`
    const pressPage =
      canonicalPageUrl(press?.press_contact_page ?? null) ??
      canonicalPageUrl(prospect?.pr_source_url ?? null) ??
      canonicalPageUrl(prospect?.contact_page_url ?? null)
    const email = normalizeEmail(prospect?.pr_email ?? null)

    targets.push({
      workstream: 'editors-choice',
      sourceKey: editorChoiceSourceKey(property.slug),
      sourceRef: sourceRef('hotel-hot-tubs', `content/editors-choice.json#${property.slug}`),
      companyName: property.name,
      domain: domain?.domain ?? null,
      companyWebsiteUrl: domain?.websiteUrl ?? null,
      contact: email
        ? { email, name: prospect?.pr_name || null, jobTitle: prospect?.pr_title || null }
        : null,
      noteTitle: `[hht-source:editor-choice:${property.slug}]`,
      noteBody: [
        `Editor's Choice hotel: ${property.name}`,
        `HHT listing: ${hhtListingUrl}`,
        domain ? `Official site: ${domain.websiteUrl}` : 'Official site: unknown',
        pressPage ? `Press page: ${pressPage}` : 'Press page: unknown',
        email ? `PR contact: ${prospect?.pr_name || email} <${email}>` : 'PR contact: none in hotel-press-prospects scrape.',
      ].join('\n'),
      sourceOwned: {
        source_key: editorChoiceSourceKey(property.slug),
        source_ref: sourceRef('hotel-hot-tubs', `content/editors-choice.json#${property.slug}`),
        hotel_website: domain?.websiteUrl ?? null,
        hht_listing_url: hhtListingUrl,
        press_media_page: pressPage,
      },
    })
  }

  return { targets, skipped }
}
