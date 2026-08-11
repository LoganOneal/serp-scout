'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { SITE_STATUSES, type SiteStatus } from '@rnr/core'
import {
  dropMarketAction,
  setMarketStatusAction,
} from '@/app/markets/actions'

/**
 * Per-row controls on the Markets list: open, change status, drop.
 */
export function MarketRowActions({
  siteId,
  status,
  href,
  label,
}: {
  siteId: number
  status: string
  href: string
  label: string
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const onStatus = (next: string) => {
    setError(null)
    const fd = new FormData()
    fd.set('siteId', String(siteId))
    fd.set('status', next)
    startTransition(async () => {
      const res = await setMarketStatusAction(fd)
      if (!res.ok) setError(res.error ?? 'Could not update status.')
      else router.refresh()
    })
  }

  const onDrop = () => {
    if (
      !window.confirm(
        `Drop market “${label}”?\n\nIt leaves the active list (status → dropped). History is kept; you can re-target the cell later.`,
      )
    ) {
      return
    }
    setError(null)
    const fd = new FormData()
    fd.set('siteId', String(siteId))
    fd.set('confirm', 'drop')
    startTransition(async () => {
      const res = await dropMarketAction(fd)
      if (!res.ok) setError(res.error ?? 'Could not drop market.')
      else router.refresh()
    })
  }

  return (
    <div className="row-actions" onClick={(e) => e.stopPropagation()}>
      <Link href={href} className="btn tiny">
        Open
      </Link>
      <select
        className="row-actions-select"
        value={status}
        disabled={pending}
        aria-label={`Status for ${label}`}
        onChange={(e) => onStatus(e.target.value)}
      >
        {SITE_STATUSES.filter((s) => s !== 'dropped' || status === 'dropped').map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
      {status !== 'dropped' && (
        <button type="button" className="btn tiny danger" disabled={pending} onClick={onDrop}>
          Drop
        </button>
      )}
      {error && (
        <div className="disabled-reason" style={{ fontSize: 11, marginTop: 4 }}>
          {error}
        </div>
      )}
    </div>
  )
}

export type { SiteStatus }
