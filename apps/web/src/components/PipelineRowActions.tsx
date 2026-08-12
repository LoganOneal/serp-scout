'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { removePipelineItemAction } from '@/app/portfolio/actions'

export function PipelineRowActions({
  shortlistId,
  href,
  label,
  showOpen = true,
}: {
  shortlistId: number
  href: string
  label: string
  /** When false, only the remove control is shown (e.g. already on the market cell). */
  showOpen?: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const onRemove = () => {
    if (!window.confirm(`Remove “${label}” from the pipeline?\n\nThis only unsaves the shortlist item.`)) {
      return
    }
    setError(null)
    const fd = new FormData()
    fd.set('shortlistId', String(shortlistId))
    startTransition(async () => {
      const res = await removePipelineItemAction(fd)
      if (!res.ok) setError(res.error ?? 'Could not remove.')
      else router.refresh()
    })
  }

  return (
    <div className="row-actions">
      {showOpen && (
        <Link href={href} className="btn tiny primary">
          Open
        </Link>
      )}
      <button type="button" className="btn tiny danger" disabled={pending} onClick={onRemove}>
        Remove from pipeline
      </button>
      {error && (
        <div className="disabled-reason" style={{ fontSize: 11 }}>
          {error}
        </div>
      )}
    </div>
  )
}
