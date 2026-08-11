import { redirect } from 'next/navigation'

/**
 * Legacy discovery run URL. Runs still execute in the worker; operators view hits
 * on the market cell they belong to.
 */
export default async function LegacyDiscoveryRunRedirect({
  params,
}: {
  params: Promise<{ runId: string }>
}) {
  await params
  redirect('/markets')
}
