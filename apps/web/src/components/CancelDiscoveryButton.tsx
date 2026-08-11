'use client'

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { cancelDiscoveryAction } from '@/app/research/reddit/actions'

export function CancelDiscoveryButton({ runId }: { runId: number }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => {
        if (!confirm(`Cancel discovery run #${runId}? Remaining pending jobs will be skipped.`)) {
          return
        }
        const fd = new FormData()
        fd.set('runId', String(runId))
        startTransition(async () => {
          await cancelDiscoveryAction(fd)
          router.refresh()
        })
      }}
    >
      {pending ? 'Cancelling…' : 'Cancel run'}
    </button>
  )
}
