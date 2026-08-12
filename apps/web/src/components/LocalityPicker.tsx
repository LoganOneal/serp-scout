'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { kindLabel, num } from '@/lib/format'

/**
 * Locality picker with SERVER-SIDE type-ahead.
 *
 * The corpus never reaches the browser. ~13,500 resolvable localities is roughly
 * 570KB of JSON, and the obvious workaround -- a client-side list capped at N --
 * silently made 168 of 12,673 cities selectable last time. The failure looked
 * like "search doesn't find anything", which reads as missing data rather than as
 * a cap, and the project's own worked example (Kenosha, pop. 99,500) was among
 * the cities you could not select.
 */

export interface PickerOption {
  id: number
  slug: string
  kind: string
  name: string
  stateCode: string
  population: number | null
  scannable: boolean
  unmatchedReason: string | null
}

export function LocalityPicker({
  search,
  onStart,
}: {
  search: (q: string) => Promise<PickerOption[]>
  onStart: (localityId: number) => Promise<{ ok: boolean; runId?: number; error?: string }>
}) {
  const [query, setQuery] = useState('')
  const [options, setOptions] = useState<PickerOption[]>([])
  const [selected, setSelected] = useState<PickerOption | null>(null)
  const [open, setOpen] = useState(false)
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const boxRef = useRef<HTMLDivElement>(null)
  const seq = useRef(0)

  useEffect(() => {
    if (selected && query === labelFor(selected)) return
    const q = query.trim()
    if (q.length < 2) {
      setOptions([])
      setOpen(false)
      return
    }
    const mine = ++seq.current
    setSearching(true)
    const timer = setTimeout(() => {
      void search(q)
        .then((rows) => {
          // Drop out-of-order responses so a slow earlier query cannot overwrite
          // a fast later one.
          if (mine !== seq.current) return
          setOptions(rows)
          setOpen(true)
        })
        .finally(() => {
          if (mine === seq.current) setSearching(false)
        })
    }, 160)
    return () => clearTimeout(timer)
  }, [query, search, selected])

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  const submit = () => {
    if (!selected) return
    setError(null)
    startTransition(async () => {
      const result = await onStart(selected.id)
      if (!result.ok) {
        setError(result.error ?? 'Could not start the scan.')
        return
      }
      window.location.href = `/scout/scans/${result.runId}`
    })
  }

  // THE DISABLED REASON. A dead button with no explanation is indistinguishable
  // from a broken app, so every reason the button cannot be pressed is stated.
  const disabledReason: string | null = selected
    ? selected.scannable
      ? null
      : `${labelFor(selected)} has no provider location code, so it cannot be scanned. ` +
        (selected.unmatchedReason ?? '')
    : query.trim().length < 2
      ? 'Type at least two characters, then pick a locality from the list.'
      : 'Pick a locality from the list — typing a name is not enough, the scan needs a specific place.'

  return (
    <div>
      <div className="picker" ref={boxRef}>
        <input
          type="search"
          placeholder="Kenosha, Wisconsin"
          value={query}
          autoComplete="off"
          onChange={(e) => {
            setQuery(e.target.value)
            setSelected(null)
            setError(null)
          }}
          onFocus={() => {
            if (options.length > 0) setOpen(true)
          }}
        />
        {open && (
          <div className="picker-results">
            {searching && options.length === 0 && (
              <div className="picker-hint">Searching…</div>
            )}
            {!searching && options.length === 0 && (
              <div className="picker-hint">
                No locality matches “{query.trim()}”. Try just the city name — the first word has to
                start the name, and anything after it is matched anywhere (“Knoxville”, “Knoxville
                TN” and “Knoxville, Tennessee” all work).
              </div>
            )}
            {options.map((o) => (
              <button
                key={o.id}
                type="button"
                className="picker-option"
                onClick={() => {
                  setSelected(o)
                  setQuery(labelFor(o))
                  setOpen(false)
                }}
              >
                <span>{labelFor(o)}</span>{' '}
                <span className="meta">
                  {kindLabel(o.kind)} · pop {num(o.population)}
                  {!o.scannable && ' · not scannable'}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex" style={{ marginTop: 14 }}>
        <button
          className="primary"
          onClick={submit}
          disabled={!selected || !selected.scannable || pending}
        >
          {pending ? 'Starting…' : 'Scan every niche here'}
        </button>
        {selected?.scannable && (
          <span className="dim" style={{ fontSize: 12.5 }}>
            Queues one scan across all active niches, easiest SERP first.
          </span>
        )}
      </div>

      {disabledReason && <div className="disabled-reason">{disabledReason}</div>}
      {error && <div className="disabled-reason">{error}</div>}
    </div>
  )
}

function labelFor(o: PickerOption): string {
  return `${o.name}, ${o.stateCode}`
}
