'use client'

import { useState, useTransition } from 'react'
import { LEAD_DISPOSITIONS, dispositionLabel, type LeadDisposition } from '@rnr/core'

/**
 * Record what became of one lead.
 *
 * ==================== BLANK IS NOT "LOST" ====================
 * The empty option is labelled "not followed up" and CLEARS the row rather than
 * defaulting to a disposition. That distinction is the whole point of the table: a
 * close rate computed over leads nobody called would measure your follow-up discipline
 * and report it as market quality.
 * ============================================================
 */

export interface OutcomeCellData {
  leadId: number
  disposition: LeadDisposition | null
  /** Micros as a string -- bigint cannot cross the RSC boundary. */
  jobValueMicros: string | null
  recordedAt: string | null
}

export function OutcomeCell({
  siteId,
  outcome,
  onRecord,
}: {
  siteId: number
  outcome: OutcomeCellData
  onRecord: (fd: FormData) => Promise<{ ok: boolean; error?: string }>
}) {
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [pending, startTransition] = useTransition()

  const initialUsd =
    outcome.jobValueMicros === null
      ? ''
      : String(BigInt(outcome.jobValueMicros) / 1_000_000n)

  const submit = (fd: FormData) => {
    setError(null)
    setSaved(false)
    fd.set('leadId', String(outcome.leadId))
    fd.set('siteId', String(siteId))
    startTransition(async () => {
      const res = await onRecord(fd)
      if (!res.ok) setError(res.error ?? 'Could not save.')
      else setSaved(true)
    })
  }

  return (
    <form action={submit} className="outcome-cell">
      <select name="disposition" defaultValue={outcome.disposition ?? ''} disabled={pending}>
        {/* Not "unknown" -- clearing means nobody has followed up yet, and the row is
            deleted so the lead leaves the close-rate denominator entirely. */}
        <option value="">not followed up</option>
        {LEAD_DISPOSITIONS.map((d) => (
          <option key={d} value={d}>
            {dispositionLabel(d)}
          </option>
        ))}
      </select>

      <input
        name="jobValueUsd"
        defaultValue={initialUsd}
        placeholder="$ job"
        inputMode="numeric"
        disabled={pending}
        title="Booked job value in dollars. Leave blank if unknown — blank is recorded as unknown, not as a $0 job."
        style={{ width: 74 }}
      />

      <button type="submit" disabled={pending} title="Save outcome">
        {pending ? '…' : saved ? '✓' : 'save'}
      </button>

      {outcome.recordedAt !== null && !saved && (
        <span className="faint" style={{ fontSize: 10.5 }}>
          {outcome.recordedAt.slice(0, 10)}
        </span>
      )}
      {error && (
        <span className="null" style={{ fontSize: 10.5 }} title={error}>
          failed
        </span>
      )}
    </form>
  )
}
