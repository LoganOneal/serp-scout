'use client'

import { JobsInFlightBanner } from '@/components/DiscoveryRunStatus'

/** Auto-refreshing banner for locality scan pages. */
export function ScanProgressBanner({
  status,
}: {
  status: string
}) {
  const active = status === 'pending' || status === 'claimed' || status === 'running'
  return (
    <JobsInFlightBanner
      active={active}
      detail={
        active
          ? `Scan is ${status}. This page refreshes automatically. If it stays pending, start pnpm worker.`
          : undefined
      }
    />
  )
}
