'use client'

import { useState, useTransition } from 'react'
import {
  importResearchCatalogAction,
  type CatalogImportResult,
} from '@/app/markets/actions'

/** Read file as base64 (preserves UTF-16 LE Google Ads Excel exports). */
async function fileToBase64(f: File): Promise<string> {
  const buf = await f.arrayBuffer()
  const bytes = new Uint8Array(buf)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

/** Import-first catalog under Market research — no SERP spend. */
export function ResearchCatalogImport() {
  const [kwText, setKwText] = useState('')
  const [geoText, setGeoText] = useState('')
  const [kwName, setKwName] = useState('keywords.tsv')
  const [geoName, setGeoName] = useState('geographies.csv')
  const [kwBase64, setKwBase64] = useState<string | null>(null)
  const [geoBase64, setGeoBase64] = useState<string | null>(null)
  const [result, setResult] = useState<CatalogImportResult | null>(null)
  const [pending, startTransition] = useTransition()

  const run = (kind: 'keywords' | 'geos') => {
    const fd = new FormData()
    fd.set('kind', kind)
    fd.set('filename', kind === 'keywords' ? kwName : geoName)
    const b64 = kind === 'keywords' ? kwBase64 : geoBase64
    const text = kind === 'keywords' ? kwText : geoText
    if (b64) {
      fd.set('base64', b64)
    } else {
      fd.set('text', text)
    }
    startTransition(async () => setResult(await importResearchCatalogAction(fd)))
  }

  const canKw = kwBase64 !== null || kwText.trim() !== ''
  const canGeo = geoBase64 !== null || geoText.trim() !== ''

  return (
    <div className="card" id="import">
      <h3 style={{ marginTop: 0 }}>Import research catalog</h3>
      <p className="sub" style={{ marginTop: 0 }}>
        Import Google Ads keyword stats and home-service geographies <strong>without spending</strong>.
        Excel UTF-16 exports are supported via file upload. After import, use{' '}
        <a href="#catalog">Research catalog</a> below to pick a keyword × geo and run local SERP
        research.
      </p>

      <div className="flex" style={{ gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div style={{ flex: '1 1 320px' }}>
          <label className="sub">Google Ads Saved Keywords Stats (TSV)</label>
          <input
            type="file"
            accept=".csv,.tsv,text/csv,text/tab-separated-values,text/plain"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) {
                setKwName(f.name)
                // Prefer bytes so UTF-16 LE survives (f.text() mangles it).
                void fileToBase64(f).then((b64) => {
                  setKwBase64(b64)
                  setKwText(`(uploaded ${f.name}, ${f.size} bytes)`)
                })
              }
            }}
          />
          <textarea
            value={kwText}
            onChange={(e) => {
              setKwText(e.target.value)
              setKwBase64(null)
            }}
            rows={5}
            className="mono"
            style={{ width: '100%', fontSize: 11, marginTop: 6 }}
            placeholder="Paste Google Ads Saved Keywords Stats export, or upload file…"
          />
          <button
            type="button"
            className="primary"
            style={{ marginTop: 8 }}
            disabled={pending || !canKw}
            onClick={() => run('keywords')}
          >
            Import keywords
          </button>
        </div>
        <div style={{ flex: '1 1 320px' }}>
          <label className="sub">Home-service geographies CSV</label>
          <input
            type="file"
            accept=".csv,text/csv,text/plain"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) {
                setGeoName(f.name)
                void fileToBase64(f).then((b64) => {
                  setGeoBase64(b64)
                  setGeoText(`(uploaded ${f.name}, ${f.size} bytes)`)
                })
              }
            }}
          />
          <textarea
            value={geoText}
            onChange={(e) => {
              setGeoText(e.target.value)
              setGeoBase64(null)
            }}
            rows={5}
            className="mono"
            style={{ width: '100%', fontSize: 11, marginTop: 6 }}
            placeholder="Paste home_service_geographies CSV, or upload file…"
          />
          <button
            type="button"
            className="primary"
            style={{ marginTop: 8 }}
            disabled={pending || !canGeo}
            onClick={() => run('geos')}
          >
            Import geographies
          </button>
        </div>
      </div>

      {result && (
        <div className={result.ok ? 'okbox' : 'stopbox'} style={{ marginTop: 12 }}>
          {result.error ?? result.detail}
          {result.skipped && result.skipped.length > 0 && (
            <ul style={{ margin: '6px 0 0', fontSize: 12 }}>
              {result.skipped.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
