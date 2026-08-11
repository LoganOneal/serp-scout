import { permanentRedirect } from 'next/navigation'

/**
 * Retired. The list of sites became the list of markets, because a site is now one facet of a
 * locality+niche cell rather than the thing itself.
 */
export default function SitesPage(): never {
  permanentRedirect('/markets')
}
