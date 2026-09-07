'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Work starts in Scout. This is a client page on purpose: Next 15.5.x 500s a
 * server-only `/` that only calls `redirect()` with
 * `Expected clientReferenceManifest to be defined`.
 */
export default function Home() {
  const router = useRouter()
  useEffect(() => {
    router.replace('/scout')
  }, [router])
  return <p className="page-desc">Opening Scout…</p>
}
