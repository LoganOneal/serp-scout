import { redirect } from 'next/navigation'

/**
 * Legacy top-level Reddit research route.
 * Reddit opportunities now live on each market cell: /markets/{locality}/{niche}#reddit
 * Batch CSV discovery is no longer a primary surface.
 */
export default function LegacyRedditResearchRedirect() {
  redirect('/markets')
}
