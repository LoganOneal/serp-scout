import Link from 'next/link'
import { notFound } from 'next/navigation'
import {
  HOTEL_BL_RELATIONSHIP_TYPES,
  HOTEL_BL_SITE_CONTROL_TYPES,
} from '@rnr/core'
import { db, getHotelBlHotelDetail } from '@rnr/data'
import { HhtSectionTabs } from '@/components/hht/HhtSectionTabs'
import { NULL_DISPLAY, num } from '@/lib/format'
import {
  updateHotelBlClassificationAction,
  updateHotelBlRelationshipAction,
} from '../../actions'

export const dynamic = 'force-dynamic'

const label = (value: string | null | undefined): string => value?.replaceAll('_', ' ') ?? NULL_DISPLAY
const score = (value: number | null | undefined): string => value === null || value === undefined ? NULL_DISPLAY : value.toFixed(1)
const date = (value: Date | null | undefined): string => value ? new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' }).format(value) : NULL_DISPLAY

export default async function HotelDetailPage({ params }: { params: Promise<{ hotelId: string }> }) {
  const { hotelId: rawId } = await params
  const hotelId = Number(rawId)
  if (!Number.isInteger(hotelId) || hotelId <= 0) notFound()
  const detail = await getHotelBlHotelDetail(db(), hotelId)
  if (!detail) notFound()
  const { hotel, relationships, pages, contacts } = detail
  return (
    <div className="opp-workspace hht-bl-workspace hotel-bl-workspace">
      <header className="run-page-head hht-bl-head">
        <div>
          <Link href="/hotel-backlink-scout?view=hotels" className="hotel-bl-back">← Hotels</Link>
          <h1 className="page-title">{hotel.hotelName}</h1>
          <p className="page-desc">{[hotel.city, hotel.state, hotel.country].filter(Boolean).join(', ') || 'Location unavailable'}</p>
        </div>
      </header>
      <HhtSectionTabs active="hotel-backlink-scout" />

      <main className="hht-bl-view">
        <section className="hotel-bl-detail-grid" aria-label="Hotel information">
          <DetailCard title="Basic information">
            <dl><Fact term="Brand" value={hotel.manualBrandName ?? hotel.brandName} /><Fact term="HotelHotTubs listing" value={hotel.listingSourceUrl ?? hotel.existingHhtUrl} link /><Fact term="Listing matched" value={hotel.listingMatched === null ? null : hotel.listingMatched ? 'Yes' : 'No'} /><Fact term="Imported candidate" value={hotel.sourceUrl} link /><Fact term="Resolved candidate" value={hotel.candidateFinalUrl} link /><Fact term="Canonical hotel domain" value={hotel.canonicalPropertyDomain} mono /><Fact term="Review" value={hotel.needsReview ? 'Needs review' : 'No'} /></dl>
          </DetailCard>
          <DetailCard title="URL validation &amp; entity role">
            <dl><Fact term="Entity scope" value={hotel.sourceEntityScope} /><Fact term="Entity type" value={hotel.sourceEntityType} /><Fact term="Validation" value={hotel.urlValidationStatus} /><Fact term="Confidence" value={hotel.urlValidationConfidence === null ? null : `${Math.round(hotel.urlValidationConfidence * 100)}%`} /><Fact term="Reason" value={hotel.urlValidationReason} /><Fact term="Site control" value={hotel.manualSiteControlType ?? hotel.siteControlType} /></dl>
            <form action={updateHotelBlClassificationAction} className="hotel-bl-override-form">
              <input type="hidden" name="entity" value="hotel" /><input type="hidden" name="id" value={hotel.id} />
              <label><span>Manual override</span><select name="classification" defaultValue={hotel.manualSiteControlType ?? hotel.siteControlType}>{HOTEL_BL_SITE_CONTROL_TYPES.map((type) => <option key={type} value={type}>{label(type)}</option>)}</select></label><button type="submit">Save override</button>
            </form>
          </DetailCard>
        </section>

        <section className="hht-bl-section" aria-labelledby="hotel-relationships-heading">
          <div className="hht-bl-section-head"><div><h2 id="hotel-relationships-heading">Website relationships &amp; opportunities</h2><p>Hotel, locality, brand, manager, owner, and PR surfaces stay separate.</p></div></div>
          {relationships.length === 0 ? <div className="hht-bl-empty">No website relationships discovered.</div> : <div className="hht-bl-table-wrap"><table className="hht-bl-table"><thead><tr><th>Entity</th><th>Role</th><th>URL validation</th><th>Domain</th><th>Relationship</th><th className="num">Confidence</th><th>Site control</th><th>Crawl</th><th className="num">Feasibility</th><th className="num">Link value</th><th className="num">Content fit</th><th className="num">Effort</th><th className="num">Priority</th><th>Treatment</th><th>Status</th><th>Evidence</th><th>Override</th></tr></thead><tbody>{relationships.map((row) => <tr key={row.relationshipId}><td>{row.relationshipEntityName ?? row.entityName ?? NULL_DISPLAY}</td><td>{label(row.entityScope)} · {label(row.relationshipEntityType)}</td><td title={row.urlValidationReason ?? undefined}>{label(row.urlValidationStatus)}</td><td><Link href={`/hotel-backlink-scout/domains/${row.domainId}`} className="mono">{row.domain}</Link></td><td>{label(row.manualRelationshipType ?? row.relationshipType)}</td><td className="num">{Math.round(row.confidence * 100)}%</td><td>{label(row.manualSiteControlType ?? row.siteControlType)}</td><td>{label(row.crawlStatus)}</td><td className="num" title={JSON.stringify(row.feasibilityComponents)}>{score(row.feasibilityScore)}</td><td className="num" title={JSON.stringify(row.linkValueComponents)}>{score(row.linkValueScore)}</td><td className="num" title={JSON.stringify(row.contentFitComponents)}>{score(row.contentFitScore)}</td><td className="num">{score(row.effortScore)}</td><td className="num hht-bl-score-strong">{score(row.priorityScore)}</td><td>{label(row.manualRecommendedContentType ?? row.recommendedContentType)}</td><td>{label(row.status)}</td><td className="hht-bl-long-cell" title={row.evidence.join('\n')}>{row.urlValidationReason ?? row.reasoningSummary ?? row.evidence[0] ?? NULL_DISPLAY}</td><td><form action={updateHotelBlRelationshipAction} className="hotel-bl-inline-form"><input type="hidden" name="relationshipId" value={row.relationshipId} /><select name="relationship" defaultValue={row.manualRelationshipType ?? row.relationshipType} aria-label={`Relationship for ${row.domain}`}>{HOTEL_BL_RELATIONSHIP_TYPES.map((type) => <option key={type} value={type}>{label(type)}</option>)}</select><button type="submit">Save</button></form></td></tr>)}</tbody></table></div>}
        </section>

        <section className="hotel-bl-detail-grid">
          <DetailCard title="Discovered surfaces">
            {pages.length === 0 ? <p className="muted">No pages crawled yet.</p> : <ul className="hotel-bl-evidence-list">{pages.map((page) => <li key={page.id}><a href={page.url} target="_blank" rel="noreferrer">{page.title ?? page.url}</a><span>{label(page.pageType)} · {page.statusCode ?? NULL_DISPLAY} · {num(page.dofollowExternalPressLinkCount)} followed · {date(page.lastContentDate)}</span></li>)}</ul>}
          </DetailCard>
          <DetailCard title="Contacts">
            {contacts.length === 0 ? <p className="muted">No public business contacts found.</p> : <ul className="hotel-bl-evidence-list">{contacts.map((contact) => <li key={contact.id}><strong>{contact.name ?? contact.email ?? contact.phone ?? 'General contact'}</strong><span>{[contact.title, label(contact.contactType), contact.email, contact.phone].filter(Boolean).join(' · ')}</span><a href={contact.sourceUrl} target="_blank" rel="noreferrer">Evidence</a></li>)}</ul>}
          </DetailCard>
        </section>

        <details className="hotel-bl-raw-source"><summary>Raw source row</summary><pre>{JSON.stringify(hotel.rawSource, null, 2)}</pre></details>
      </main>
    </div>
  )
}

function DetailCard({ title, children }: { title: string; children: React.ReactNode }) { return <section className="hotel-bl-detail-card"><h2>{title}</h2>{children}</section> }
function Fact({ term, value, link = false, mono = false }: { term: string; value: string | null | undefined; link?: boolean; mono?: boolean }) { return <div><dt>{term}</dt><dd className={mono ? 'mono' : undefined}>{link && value ? <a href={value} target="_blank" rel="noreferrer">{value}</a> : label(value)}</dd></div> }
