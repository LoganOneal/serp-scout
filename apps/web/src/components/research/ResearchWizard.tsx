'use client'

import { useEffect, useMemo, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  enqueueMarketRedditAction,
  type MarketRedditScanResult,
} from '@/app/markets/actions'
import { startScanAction } from '@/app/actions'
import type { PickerOption } from '@/components/LocalityPicker'

export interface NicheOption {
  id: number
  slug: string
  label: string
  keywordNoun: string
}

type Step = 1 | 2 | 3 | 4

/**
 * Guided research: Place → Niche → Confirm → Result (same page as history).
 */
export function ResearchWizard({
  searchLocalities,
  niches,
  initialOpen = false,
  initialScanMode = false,
}: {
  searchLocalities: (q: string) => Promise<PickerOption[]>
  niches: NicheOption[]
  initialOpen?: boolean
  initialScanMode?: boolean
}) {
  const router = useRouter()
  const [open, setOpen] = useState(initialOpen)
  const [step, setStep] = useState<Step>(1)
  const [scanAll, setScanAll] = useState(initialScanMode)

  const [query, setQuery] = useState('')
  const [options, setOptions] = useState<PickerOption[]>([])
  const [place, setPlace] = useState<PickerOption | null>(null)
  const [openDrop, setOpenDrop] = useState(false)
  const [searching, setSearching] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  const seq = useRef(0)

  const [nicheFilter, setNicheFilter] = useState('')
  const [niche, setNiche] = useState<NicheOption | null>(null)

  const [pending, startTransition] = useTransition()
  const [result, setResult] = useState<MarketRedditScanResult | null>(null)
  const [scanResult, setScanResult] = useState<{
    ok: boolean
    runId?: number
    error?: string
  } | null>(null)

  const filteredNiches = useMemo(() => {
    const q = nicheFilter.trim().toLowerCase()
    if (!q) return niches
    return niches.filter(
      (n) =>
        n.label.toLowerCase().includes(q) ||
        n.keywordNoun.toLowerCase().includes(q) ||
        n.slug.includes(q),
    )
  }, [niches, nicheFilter])

  useEffect(() => {
    if (place && query === `${place.name}, ${place.stateCode}`) return
    const q = query.trim()
    if (q.length < 2) {
      setOptions([])
      setOpenDrop(false)
      return
    }
    const mine = ++seq.current
    setSearching(true)
    const timer = setTimeout(() => {
      void searchLocalities(q)
        .then((rows) => {
          if (mine !== seq.current) return
          setOptions(rows)
          setOpenDrop(true)
        })
        .finally(() => {
          if (mine === seq.current) setSearching(false)
        })
    }, 160)
    return () => clearTimeout(timer)
  }, [query, searchLocalities, place])

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpenDrop(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  const reset = () => {
    setStep(1)
    setPlace(null)
    setNiche(null)
    setQuery('')
    setNicheFilter('')
    setResult(null)
    setScanResult(null)
    setScanAll(false)
  }

  const start = () => {
    reset()
    setOpen(true)
  }

  const runCell = () => {
    if (!place || !niche) return
    const fd = new FormData()
    fd.set('localityId', String(place.id))
    fd.set('nicheId', String(niche.id))
    startTransition(async () => {
      const res = await enqueueMarketRedditAction(fd)
      setResult(res)
      setStep(4)
      if (res.ok) router.refresh()
    })
  }

  const runScan = () => {
    if (!place) return
    startTransition(async () => {
      const res = await startScanAction(place.id)
      setScanResult(res)
      setStep(4)
      if (res.ok) router.refresh()
    })
  }

  if (!open) {
    return (
      <div className="flex" style={{ marginBottom: 16, justifyContent: 'flex-end' }}>
        <button type="button" className="primary" onClick={start}>
          + New research
        </button>
      </div>
    )
  }

  return (
    <div className="card research-wizard" style={{ marginBottom: 20 }}>
      <div className="flex" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
        <div>
          <strong style={{ fontSize: 14 }}>New research</strong>
          <div className="faint" style={{ fontSize: 12, marginTop: 2 }}>
            Place → niche → run. One cell at a time.
          </div>
        </div>
        <button
          type="button"
          className="btn tiny"
          onClick={() => {
            setOpen(false)
            reset()
          }}
        >
          Close
        </button>
      </div>

      <div className="wizard-steps" aria-label="Progress">
        {([1, 2, 3, 4] as Step[]).map((s) => (
          <span
            key={s}
            className={`wizard-step${step === s ? ' active' : ''}${step > s ? ' done' : ''}`}
          >
            {s === 1 ? 'Place' : s === 2 ? 'Niche' : s === 3 ? 'Confirm' : 'Result'}
          </span>
        ))}
      </div>

      {step === 1 && (
        <div>
          <label className="sub" style={{ display: 'block', marginBottom: 6 }}>
            Where do you want to research?
          </label>
          <div className="picker" ref={boxRef} style={{ maxWidth: 480 }}>
            <input
              type="search"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setPlace(null)
              }}
              placeholder="City or metro (e.g. Houston)"
              autoFocus
            />
            {searching && (
              <div className="faint" style={{ fontSize: 12, marginTop: 4 }}>
                Searching…
              </div>
            )}
            {openDrop && options.length > 0 && (
              <div className="picker-results">
                {options.map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    className="picker-option"
                    disabled={!o.scannable}
                    onClick={() => {
                      setPlace(o)
                      setQuery(`${o.name}, ${o.stateCode}`)
                      setOpenDrop(false)
                    }}
                  >
                    {o.name}, {o.stateCode}
                    <div className="meta">
                      {o.kind}
                      {!o.scannable ? ' · not scannable' : ''}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="flex" style={{ marginTop: 14 }}>
            <button
              type="button"
              className="primary"
              disabled={!place || !place.scannable}
              onClick={() => setStep(2)}
            >
              Continue
            </button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div>
          <p className="sub" style={{ marginTop: 0 }}>
            Place: <strong>{place?.name}, {place?.stateCode}</strong>
          </p>
          <label className="inline" style={{ marginBottom: 10, fontSize: 13 }}>
            <input
              type="checkbox"
              checked={scanAll}
              onChange={(e) => setScanAll(e.target.checked)}
            />
            Score <strong>all</strong> seed niches in this place (locality scan) instead of one niche
          </label>

          {!scanAll && (
            <>
              <input
                type="search"
                placeholder="Filter niches…"
                value={nicheFilter}
                onChange={(e) => setNicheFilter(e.target.value)}
                style={{ maxWidth: 360, marginBottom: 8 }}
              />
              <div className="table-scroll" style={{ maxHeight: 260, overflow: 'auto' }}>
                <table>
                  <thead>
                    <tr>
                      <th>Niche</th>
                      <th>Keyword</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredNiches.map((n) => (
                      <tr
                        key={n.id}
                        onClick={() => setNiche(n)}
                        style={{
                          cursor: 'pointer',
                          background:
                            niche?.id === n.id
                              ? 'var(--accent-soft, #fff1eb)'
                              : undefined,
                        }}
                      >
                        <td>{n.label}</td>
                        <td className="mono" style={{ fontSize: 12 }}>
                          {n.keywordNoun}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          <div className="flex" style={{ marginTop: 14 }}>
            <button type="button" className="btn" onClick={() => setStep(1)}>
              Back
            </button>
            <button
              type="button"
              className="primary"
              disabled={scanAll ? !place : !niche}
              onClick={() => setStep(3)}
            >
              Continue
            </button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div>
          <div className="card" style={{ background: 'var(--surface-2)', marginBottom: 12 }}>
            {scanAll ? (
              <>
                <div style={{ fontSize: 15, fontWeight: 650 }}>
                  Score all niches in {place?.name}, {place?.stateCode}
                </div>
                <p className="sub" style={{ marginBottom: 0, marginTop: 6 }}>
                  Locality scan: every active seed niche is measured for this place. Cost depends on
                  niche count (~$0.004–0.006 each live).
                </p>
              </>
            ) : (
              <>
                <div style={{ fontSize: 15, fontWeight: 650 }}>
                  {niche?.label} · {place?.name}, {place?.stateCode}
                </div>
                <p className="sub" style={{ marginBottom: 0, marginTop: 6 }}>
                  Buys a <strong>buy-intent keyword cluster</strong> for this service (repair,
                  install, emergency, near me, related offerings) on <strong>desktop + mobile</strong>
                  . Geo uses this market’s location code — same local SERPs as searching from{' '}
                  {place?.name}, not a national SERP. Roughly <strong>20–48 SERPs</strong> (~$0.04–0.10
                  live) · $0 fixtures.
                </p>
              </>
            )}
          </div>
          <div className="flex">
            <button type="button" className="btn" onClick={() => setStep(2)} disabled={pending}>
              Back
            </button>
            <button
              type="button"
              className="primary"
              disabled={pending}
              onClick={() => (scanAll ? runScan() : runCell())}
            >
              {pending ? 'Queuing…' : scanAll ? 'Start locality scan' : 'Run research'}
            </button>
          </div>
        </div>
      )}

      {step === 4 && (
        <div>
          {result && (
            <div className={result.ok ? 'okbox' : 'stopbox'}>
              {result.error ?? result.detail}
              {result.ok && result.runId != null && (
                <div style={{ marginTop: 8, fontSize: 12 }}>
                  Discovery run #{result.runId}. History updates below after cron/worker drains jobs.
                </div>
              )}
            </div>
          )}
          {scanResult && (
            <div className={scanResult.ok ? 'okbox' : 'stopbox'}>
              {scanResult.error ??
                (scanResult.ok
                  ? `Locality scan #${scanResult.runId} queued. Open it from history when done.`
                  : 'Scan failed.')}
              {scanResult.ok && scanResult.runId != null && (
                <div style={{ marginTop: 8 }}>
                  <a href={`/scan/${scanResult.runId}`}>Open scan #{scanResult.runId}</a>
                </div>
              )}
            </div>
          )}
          <div className="flex" style={{ marginTop: 12 }}>
            {place && niche && !scanAll && (
              <a
                className="btn primary"
                href={`/markets/${place.slug}/${niche.slug}`}
              >
                Open market cell
              </a>
            )}
            <button
              type="button"
              className="btn"
              onClick={() => {
                reset()
                setOpen(false)
                router.refresh()
              }}
            >
              Done
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                reset()
                setOpen(true)
                setStep(1)
              }}
            >
              Research another
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
