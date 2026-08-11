'use client'

import { useState, useTransition } from 'react'

/**
 * Begin targeting a cell.
 *
 * The domain is optional on purpose: you start watching keywords and posting comments before
 * you register one, and requiring a placeholder would claim a name you had not bought --
 * `sites.domain` is unique, so a placeholder is worse than nothing.
 */
export function StartTargeting({
  localitySlug,
  nicheSlug,
  suggestedDomain,
  onStart,
}: {
  localitySlug: string
  nicheSlug: string
  suggestedDomain: string | null
  onStart: (fd: FormData) => Promise<{ ok: boolean; error?: string }>
}) {
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const submit = (fd: FormData) => {
    setError(null)
    fd.set('localitySlug', localitySlug)
    fd.set('nicheSlug', nicheSlug)
    startTransition(async () => {
      const res = await onStart(fd)
      if (!res.ok) setError(res.error ?? 'Could not start targeting this cell.')
    })
  }

  return (
    <form action={submit}>
      <div className="form-grid">
        <label>
          <span>Domain (optional)</span>
          <input name="domain" defaultValue={suggestedDomain ?? ''} placeholder="leave blank if not bought yet" autoComplete="off" />
          <em>{suggestedDomain ? 'Pre-filled from the shortlisted EMD. ' : ''}Blank is fine — add it later.</em>
        </label>
        <label>
          <span>Business name</span>
          <input name="displayName" placeholder="Old Pueblo HVAC" autoComplete="off" />
          <em>What the voice agent says out loud.</em>
        </label>
      </div>
      {error && <div className="disabled-reason">{error}</div>}
      <div className="flex" style={{ marginTop: 12 }}>
        <button className="primary" type="submit" disabled={pending}>
          {pending ? 'Starting…' : 'Start targeting this cell'}
        </button>
      </div>
    </form>
  )
}
