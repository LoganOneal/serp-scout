import { notFound, permanentRedirect } from 'next/navigation'
import { cellPathForSite, db } from '@rnr/data'

/**
 * Retired in favour of the cell URL.
 *
 * Old links keep working: a site id resolves to its locality+niche pair and redirects there.
 * The cell URL is stable across the whole lifecycle, which a site id never was -- drop a cell
 * and re-target it and the id changes while the market does not.
 */
export default async function SiteByIdPage({
  params,
}: {
  params: Promise<{ siteId: string }>
}): Promise<never> {
  const { siteId } = await params
  const id = Number(siteId)
  if (!Number.isInteger(id) || id <= 0) notFound()

  const path = await cellPathForSite(db(), id)
  if (path === null) notFound()
  permanentRedirect(path)
}
