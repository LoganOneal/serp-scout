'use client'

import { useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Periodically router.refresh() while `active` is true.
 * Used for discovery/scan jobs so operators don't hammer F5.
 */
export function useAutoRefresh(active: boolean, intervalMs = 4000) {
  const router = useRouter()
  const tick = useRef(0)

  useEffect(() => {
    if (!active) return
    // Immediate soft refresh when we first become active (e.g. just queued).
    const first = window.setTimeout(() => router.refresh(), 800)
    const id = window.setInterval(() => {
      tick.current += 1
      router.refresh()
    }, intervalMs)
    return () => {
      window.clearTimeout(first)
      window.clearInterval(id)
    }
  }, [active, intervalMs, router])
}
