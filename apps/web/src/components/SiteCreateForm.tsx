'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { kindLabel, num } from '@/lib/format'
import type { PickerOption } from '@/components/LocalityPicker'

/**
 * The create-site form.
 *
 * Locality uses the same SERVER-SIDE type-ahead as LocalityPicker -- the corpus is
 * ~570KB and must not reach the browser, and a client-side cap silently made 168 of
 * 12,673 cities selectable last time. Reused rather than reinvented for that reason.
 */

export interface NicheOption {
  id: number
  label: string
  slug: string
}

export interface ShortlistOption {
  id: number
  emdDomain: string
  localityId: number
  nicheId: number
  localityName: string
  stateCode: string
  nicheLabel: string
  verdictAtSave: string
}

const DAYS = [
  ['mon', 'Mon'],
  ['tue', 'Tue'],
  ['wed', 'Wed'],
  ['thu', 'Thu'],
  ['fri', 'Fri'],
  ['sat', 'Sat'],
  ['sun', 'Sun'],
] as const

const TIMEZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Phoenix',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
]

export function SiteCreateForm({
  searchLocalities,
  niches,
  shortlist,
  onCreate,
}: {
  searchLocalities: (q: string) => Promise<PickerOption[]>
  niches: NicheOption[]
  shortlist: ShortlistOption[]
  onCreate: (fd: FormData) => Promise<{ ok: boolean; siteId?: number; error?: string }>
}) {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  // Locality type-ahead
  const [query, setQuery] = useState('')
  const [options, setOptions] = useState<PickerOption[]>([])
  const [locality, setLocality] = useState<PickerOption | null>(null)
  const [listOpen, setListOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  const seq = useRef(0)

  const [nicheId, setNicheId] = useState<string>('')
  const [shortlistId, setShortlistId] = useState<string>('')

  useEffect(() => {
    if (locality && query === `${locality.name}, ${locality.stateCode}`) return
    const q = query.trim()
    if (q.length < 2) {
      setOptions([])
      setListOpen(false)
      return
    }
    const mine = ++seq.current
    const timer = setTimeout(() => {
      void searchLocalities(q).then((rows) => {
        // Drop out-of-order responses: a slow earlier query must not overwrite a
        // fast later one.
        if (mine !== seq.current) return
        setOptions(rows)
        setListOpen(true)
      })
    }, 160)
    return () => clearTimeout(timer)
  }, [query, searchLocalities, locality])

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setListOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  /**
   * Picking a shortlist row fills locality and niche from it.
   *
   * Those must match the row, because the whole point of the link is comparing
   * actual calls against what the model predicted for THAT cell. Letting them
   * diverge would produce a predicted-vs-actual panel comparing two different
   * markets.
   */
  const onPickShortlist = (value: string) => {
    setShortlistId(value)
    const row = shortlist.find((s) => String(s.id) === value)
    if (!row) return
    setNicheId(String(row.nicheId))
    setLocality({
      id: row.localityId,
      slug: '',
      kind: 'city',
      name: row.localityName,
      stateCode: row.stateCode,
      population: null,
      scannable: true,
      unmatchedReason: null,
    })
    setQuery(`${row.localityName}, ${row.stateCode}`)
  }

  const submit = (fd: FormData) => {
    setError(null)
    if (locality === null) {
      setError('Pick a locality from the list — typing a name is not enough.')
      return
    }
    if (nicheId === '') {
      setError('Pick a niche.')
      return
    }
    fd.set('localityId', String(locality.id))
    fd.set('nicheId', nicheId)
    if (shortlistId !== '') fd.set('shortlistItemId', shortlistId)

    startTransition(async () => {
      const res = await onCreate(fd)
      if (!res.ok) {
        setError(res.error ?? 'Could not create the site.')
        return
      }
      window.location.href = `/sites/${res.siteId}`
    })
  }

  if (!open) {
    return (
      <button className="primary" onClick={() => setOpen(true)}>
        Add a site
      </button>
    )
  }

  return (
    <form action={submit} className="card">
      <h3 style={{ marginTop: 0 }}>Add a site</h3>

      <div className="form-grid">
        <label>
          <span>Domain</span>
          <input name="domain" placeholder="kenoshaair.com" required autoComplete="off" />
          <em>The domain you bought. Scheme and www are stripped.</em>
        </label>

        <label>
          <span>Business name</span>
          <input name="displayName" placeholder="Kenosha Air" autoComplete="off" />
          <em>What the agent says out loud. Blank becomes “our office”.</em>
        </label>

        <label>
          <span>From a shortlisted cell</span>
          <select value={shortlistId} onChange={(e) => onPickShortlist(e.target.value)}>
            <option value="">Not from a scan</option>
            {shortlist.map((s) => (
              <option key={s.id} value={s.id}>
                {s.emdDomain} — {s.localityName}, {s.stateCode} · {s.nicheLabel}
              </option>
            ))}
          </select>
          <em>
            Links this site to the prediction frozen at save time, which is what lets real
            call volume falsify the rent model.
          </em>
        </label>

        <div className="picker" ref={boxRef}>
          <label>
            <span>Locality</span>
            <input
              type="search"
              placeholder="Kenosha, Wisconsin"
              value={query}
              autoComplete="off"
              onChange={(e) => {
                setQuery(e.target.value)
                setLocality(null)
              }}
            />
          </label>
          {listOpen && (
            <div className="picker-results">
              {options.length === 0 && <div className="picker-hint">No match.</div>}
              {options.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  className="picker-option"
                  onClick={() => {
                    setLocality(o)
                    setQuery(`${o.name}, ${o.stateCode}`)
                    setListOpen(false)
                  }}
                >
                  <span>
                    {o.name}, {o.stateCode}
                  </span>{' '}
                  <span className="meta">
                    {kindLabel(o.kind)} · pop {num(o.population)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        <label>
          <span>Niche</span>
          <select value={nicheId} onChange={(e) => setNicheId(e.target.value)} required>
            <option value="">Pick one…</option>
            {niches.map((n) => (
              <option key={n.id} value={n.id}>
                {n.label}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>Status</span>
          <select name="status" defaultValue="parked">
            <option value="parked">parked</option>
            <option value="building">building</option>
            <option value="live">live</option>
            <option value="rented">rented</option>
          </select>
        </label>

        <label>
          <span>Timezone</span>
          <select name="timezone" defaultValue="America/Chicago">
            {TIMEZONES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <em>The agent's idea of “right now”. Wrong here routes a 2am emergency to Tuesday.</em>
        </label>

        <label>
          <span>Purchased</span>
          <input type="date" name="purchasedAt" />
        </label>

        <label>
          <span>Service area zips</span>
          <input name="serviceAreaZips" placeholder="53140, 53142, 53143" autoComplete="off" />
          <em>Blank means unknown, and every lead's in-area check stays null rather than false.</em>
        </label>

        <label>
          <span>Diagnostic fee (USD)</span>
          <input type="number" name="dispatchFeeUsd" min="0" step="1" placeholder="89" />
          <em>Spoken aloud before booking. Blank means the agent never mentions one.</em>
        </label>

        <label>
          <span>On-call number</span>
          <input name="onCallNumber" placeholder="(414) 555-0199" autoComplete="off" />
          <em>Emergency transfers and the Twilio disaster-recovery fallback.</em>
        </label>

        <label>
          <span>Lead alert number</span>
          <input name="leadAlertNumber" placeholder="(414) 555-0177" autoComplete="off" />
          <em>Where new-lead texts go. Falls back to the on-call number.</em>
        </label>
      </div>

      <fieldset className="hours">
        <legend>Business hours</legend>
        <p className="sub" style={{ marginTop: 0 }}>
          An unchecked day is <strong>closed</strong>, never “open all day”. With no day
          checked the agent says it cannot confirm hours rather than inventing them.
        </p>
        {DAYS.map(([key, label]) => (
          <div key={key} className="hours-row">
            <label className="inline">
              <input
                type="checkbox"
                name={`hours_${key}_enabled`}
                defaultChecked={key !== 'sun'}
              />
              <span>{label}</span>
            </label>
            <input
              type="time"
              name={`hours_${key}_open`}
              defaultValue={key === 'sat' ? '09:00' : '08:00'}
            />
            <span className="dim">to</span>
            <input
              type="time"
              name={`hours_${key}_close`}
              defaultValue={key === 'sat' ? '13:00' : '17:00'}
            />
          </div>
        ))}
      </fieldset>

      <label className="full">
        <span>Notes</span>
        <textarea name="notes" rows={2} />
      </label>

      {error && <div className="disabled-reason">{error}</div>}

      <div className="flex" style={{ marginTop: 12 }}>
        <button className="primary" type="submit" disabled={pending}>
          {pending ? 'Creating…' : 'Create site'}
        </button>
        <button type="button" onClick={() => setOpen(false)} disabled={pending}>
          Cancel
        </button>
      </div>
    </form>
  )
}
