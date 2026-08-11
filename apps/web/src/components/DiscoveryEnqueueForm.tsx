'use client'

import { useState, useTransition } from 'react'
import {
  enqueueDiscoveryAction,
  previewDiscoveryAction,
  type PreviewResult,
} from '@/app/research/reddit/actions'

/**
 * CSV import + preview/enqueue for Reddit SERP discovery.
 * Nav label is "Reddit opportunities" — never "Keyword research".
 */
export function DiscoveryEnqueueForm() {
  const [nichesCsv, setNichesCsv] = useState('')
  const [geosCsv, setGeosCsv] = useState('')
  const [budgetCapCents, setBudgetCapCents] = useState('500')
  const [label, setLabel] = useState('')
  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [pending, startTransition] = useTransition()

  const fdFromState = () => {
    const fd = new FormData()
    fd.set('nichesCsv', nichesCsv)
    fd.set('geosCsv', geosCsv)
    fd.set('budgetCapCents', budgetCapCents)
    if (label.trim()) fd.set('label', label.trim())
    fd.set('commentabilityMode', 'on_promote')
    return fd
  }

  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Start a discovery run</h3>
      <p className="sub" style={{ marginTop: 0 }}>
        Import your top home-service niches (two keyword variants each) and top US geos by
        population. We buy a SERP for each keyword × resolved geo and list Reddit threads on page
        1 — organic rank and Discussions pack separately. Keywords are used{' '}
        <strong>verbatim</strong> with the geo&apos;s location code (not{' '}
        <code>{'{city} {niche}'}</code> like locality scan).
      </p>

      <div className="flex" style={{ gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 320px' }}>
          <label className="sub" style={{ display: 'block', marginBottom: 4 }}>
            Niches CSV
          </label>
          <input
            type="file"
            accept=".csv,text/csv,text/plain"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void f.text().then(setNichesCsv)
            }}
          />
          <textarea
            value={nichesCsv}
            onChange={(e) => setNichesCsv(e.target.value)}
            rows={6}
            placeholder={'Niche,Keyword Primary,Keyword Near Me\nElectrician,electrician,electrician near me'}
            className="mono"
            style={{ width: '100%', fontSize: 11.5, marginTop: 6 }}
          />
        </div>
        <div style={{ flex: '1 1 320px' }}>
          <label className="sub" style={{ display: 'block', marginBottom: 4 }}>
            Geographies CSV
          </label>
          <input
            type="file"
            accept=".csv,text/csv,text/plain"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void f.text().then(setGeosCsv)
            }}
          />
          <textarea
            value={geosCsv}
            onChange={(e) => setGeosCsv(e.target.value)}
            rows={6}
            placeholder={'City,State,Population\nTucson,AZ,542629\nKenosha,WI,99500'}
            className="mono"
            style={{ width: '100%', fontSize: 11.5, marginTop: 6 }}
          />
        </div>
      </div>

      <div className="flex" style={{ marginTop: 12, gap: 12, flexWrap: 'wrap' }}>
        <label className="sub">
          Label{' '}
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="optional"
            style={{ width: 160, marginLeft: 6 }}
          />
        </label>
        <label className="sub">
          Budget cap (cents){' '}
          <input
            value={budgetCapCents}
            onChange={(e) => setBudgetCapCents(e.target.value)}
            className="mono"
            style={{ width: 80, marginLeft: 6 }}
          />
        </label>
        <span className="faint" style={{ fontSize: 12, alignSelf: 'center' }}>
          Default $5.00 · full 10×2×100 grid ≈ $4 live
        </span>
      </div>

      <div className="flex" style={{ marginTop: 12, gap: 8 }}>
        <button
          type="button"
          disabled={pending || nichesCsv.trim() === '' || geosCsv.trim() === ''}
          onClick={() =>
            startTransition(async () => setPreview(await previewDiscoveryAction(fdFromState())))
          }
        >
          {pending ? 'Working…' : 'Preview'}
        </button>
        <button
          type="button"
          className="primary"
          disabled={pending || nichesCsv.trim() === '' || geosCsv.trim() === ''}
          onClick={() =>
            startTransition(async () => {
              const res = await enqueueDiscoveryAction(fdFromState())
              // redirect on success; only errors return
              if (!res.ok) setPreview(res)
            })
          }
        >
          {pending ? 'Enqueueing…' : 'Enqueue run'}
        </button>
      </div>

      {preview && (
        <div className={preview.ok ? 'okbox' : 'stopbox'} style={{ marginTop: 12 }}>
          {preview.error ?? preview.detail}
          {preview.ok && (
            <ul style={{ margin: '8px 0 0', fontSize: 12.5 }}>
              <li>
                Jobs: <strong>{preview.jobCount}</strong> (cap {preview.hardCap})
              </li>
              <li>
                Geos: {preview.geoResolved} resolved
                {(preview.geoUnresolved ?? 0) + (preview.geoUnscannableSource ?? 0) > 0 && (
                  <>
                    , {preview.geoUnresolved} unresolved
                    {(preview.geoUnscannableSource ?? 0) > 0 &&
                      `, ${preview.geoUnscannableSource} unscannable source`}
                  </>
                )}
              </li>
              <li>
                Est. cost: <strong>{preview.estimatedCostUsd}</strong> of budget{' '}
                {preview.budgetCapUsd}
                {preview.usedFixtures && (
                  <>
                    {' '}
                    · <span className="badge warn">fixtures ($0)</span>
                  </>
                )}
              </li>
            </ul>
          )}
          {preview.nicheSkipped && preview.nicheSkipped.length > 0 && (
            <div style={{ marginTop: 8, fontSize: 12 }}>
              <strong>Niche rows skipped:</strong>
              <ul style={{ margin: '4px 0 0' }}>
                {preview.nicheSkipped.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </div>
          )}
          {preview.geoSkipped && preview.geoSkipped.length > 0 && (
            <div style={{ marginTop: 8, fontSize: 12 }}>
              <strong>Geo rows skipped:</strong>
              <ul style={{ margin: '4px 0 0' }}>
                {preview.geoSkipped.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
