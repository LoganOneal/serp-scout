'use client'

import { useTransition } from 'react'

export function SaveButton({
  scanTargetId,
  runId,
  saved,
  onSave,
}: {
  scanTargetId: number
  runId: number
  saved: boolean
  onSave: (scanTargetId: number, runId: number) => Promise<void>
}) {
  const [pending, start] = useTransition()
  if (saved) {
    return (
      <span className="pill" title="Already on your Sites to Build list">
        saved
      </span>
    )
  }
  return (
    <button
      className="tiny"
      disabled={pending}
      onClick={() => start(async () => void (await onSave(scanTargetId, runId)))}
      title="Freezes the current difficulty and verdict on the shortlist item, so calibration compares against what the model said at decision time"
    >
      {pending ? '…' : 'save'}
    </button>
  )
}
