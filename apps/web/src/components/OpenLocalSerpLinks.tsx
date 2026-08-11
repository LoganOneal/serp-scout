'use client'

import { buildLocalSerpLinks } from '@rnr/core'

export type OpenLocalSerpLinksProps = {
  /** Exact query we measured (e.g. "roofing"). */
  query: string
  /** Market city name (e.g. "Phoenix"). */
  city: string
  /** State postal or full name. */
  state?: string | null
  /**
   * Google's own geotarget name (DataForSEO `location_name`). Pass it when the
   * row has it — city+state is reconstructed guesswork that Google rejects
   * outright for markets like "New York City", leaving the operator looking at
   * a SERP for wherever THEY are.
   */
  canonicalLocation?: string | null
  /**
   * Locality as a person types it ("new york city"). Appended to the query so
   * the link is local because of the words, not only because of the uule --
   * see buildLocalSerpLinks for why the uule alone was not enough.
   */
  queryModifier?: string | null
  /** Optional coords for pin-level UULE (rare). */
  lat?: number | null
  lon?: number | null
  /** Compact inline (table cell) vs stacked. */
  compact?: boolean
  /** Highlight which device we measured. */
  measuredDevice?: 'desktop' | 'mobile' | null
  className?: string
}

/**
 * Desktop + Mobile Google SERP links geo-located via UULE so an operator can
 * verify DataForSEO snapshots against what a person in that market would see.
 */
export function OpenLocalSerpLinks(props: OpenLocalSerpLinksProps) {
  const links = buildLocalSerpLinks({
    query: props.query,
    city: props.city,
    state: props.state,
    canonicalName: props.canonicalLocation,
    queryModifier: props.queryModifier,
    lat: props.lat,
    lon: props.lon,
  })

  if (!props.query.trim() || !props.city.trim()) {
    return <span className="faint">—</span>
  }

  const searchedDiffers = links.query.toLowerCase() !== props.query.trim().toLowerCase()
  const titleBase =
    (searchedDiffers ? `Searches “${links.query}” (we measured “${props.query}” at this location code). ` : '') +
    `${links.howTo}` +
    (links.canonicalLocation ? ` · UULE: ${links.canonicalLocation}` : '')

  if (props.compact) {
    return (
      <span className={`serp-verify-links${props.className ? ` ${props.className}` : ''}`}>
        <a
          className={`btn tiny${props.measuredDevice === 'desktop' ? ' is-measured' : ''}`}
          href={links.desktopUrl}
          target="_blank"
          rel="noopener noreferrer"
          title={`Desktop SERP · ${titleBase}`}
          onClick={(e) => e.stopPropagation()}
        >
          Desktop
        </a>
        <a
          className={`btn tiny${props.measuredDevice === 'mobile' ? ' is-measured' : ''}`}
          href={links.mobileUrl}
          target="_blank"
          rel="noopener noreferrer"
          title={`Mobile SERP · open on phone or DevTools device mode · ${titleBase}`}
          onClick={(e) => e.stopPropagation()}
        >
          Mobile
        </a>
      </span>
    )
  }

  return (
    <div className={`serp-verify${props.className ? ` ${props.className}` : ''}`}>
      <div className="serp-verify-actions">
        <a
          className={`btn tiny${props.measuredDevice === 'desktop' ? ' is-measured' : ''}`}
          href={links.desktopUrl}
          target="_blank"
          rel="noopener noreferrer"
          title={titleBase}
        >
          Open desktop SERP
        </a>
        <a
          className={`btn tiny${props.measuredDevice === 'mobile' ? ' is-measured' : ''}`}
          href={links.mobileUrl}
          target="_blank"
          rel="noopener noreferrer"
          title={`Open on phone or DevTools device mode · ${titleBase}`}
        >
          Open mobile SERP
        </a>
      </div>
      <p className="serp-verify-hint faint">
        Local Google via <code>uule</code>
        {links.canonicalLocation ? (
          <>
            {' '}
            · <span className="mono">{links.canonicalLocation}</span>
          </>
        ) : null}
        . Prefer a private window. Mobile layout needs a phone UA / device mode.
      </p>
    </div>
  )
}
