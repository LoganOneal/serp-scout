'use client'

import { useTransition } from 'react'
import type { BuildState } from '@rnr/core'

const STATES: BuildState[] = ['watching', 'building', 'ranking', 'rented']

export function StateSelect({
  itemId,
  state,
  onChange,
}: {
  itemId: number
  state: BuildState
  onChange: (itemId: number, state: BuildState) => Promise<void>
}) {
  const [pending, start] = useTransition()
  return (
    <select
      value={state}
      disabled={pending}
      onChange={(e) => {
        const next = e.target.value as BuildState
        start(async () => void (await onChange(itemId, next)))
      }}
      style={{
        background: 'var(--surface-2)',
        border: '1px solid var(--border)',
        color: 'var(--text)',
        borderRadius: 6,
        padding: '4px 8px',
        fontSize: 12,
      }}
      title="Moving to 'building' starts the clock that outcome checks (day 7/14/30/60/90) measure against"
    >
      {STATES.map((s) => (
        <option key={s} value={s}>
          {s}
        </option>
      ))}
    </select>
  )
}

export function RemoveButton({
  itemId,
  onRemove,
}: {
  itemId: number
  onRemove: (itemId: number) => Promise<void>
}) {
  const [pending, start] = useTransition()
  return (
    <button
      className="tiny"
      disabled={pending}
      onClick={() => start(async () => void (await onRemove(itemId)))}
    >
      {pending ? '…' : 'remove'}
    </button>
  )
}
