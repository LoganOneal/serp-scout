'use client'

import { useState } from 'react'
import { buildKeywordPlannerVerify } from '@rnr/core'

/**
 * Measured volume + optional Planner link for spot-check.
 *
 * Production volume is from DataForSEO Keywords Data (Google Ads metrics) scoped
 * to the market location_code — not map pack (listings only) and not population.
 * Planner link remains for optional manual verification.
 */
export function VolumeSourceLink({
  volume,
  keyword,
  volumeSource,
  volumeGeoTarget,
  geoCriteriaId,
  /** When true, only Planner link + copy (no volume numeral). */
  linkOnly = false,
  compact = false,
}: {
  volume: number | null
  keyword: string
  volumeSource?: string | null
  volumeGeoTarget?: string | null
  geoCriteriaId?: number | null
  linkOnly?: boolean
  compact?: boolean
}) {
  const [copied, setCopied] = useState(false)
  const verify = buildKeywordPlannerVerify({
    keyword,
    volumeGeoTarget,
    geoCriteriaId,
  })

  const volText =
    volume == null ? '—' : volume >= 1000 ? `${Math.round(volume / 100) / 10}k` : String(volume)

  const sourceLabel =
    volumeSource === 'dataforseo_google_ads' || volumeSource === 'dataforseo'
      ? 'DataForSEO (local)'
      : volumeSource === 'google_ads'
        ? 'Google Ads'
        : volumeSource === 'fixture'
          ? 'fixture'
          : volumeSource === 'skipped'
            ? 'skipped'
            : volumeSource ?? null

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(verify.copyText)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      /* ignore */
    }
  }

  if (linkOnly) {
    if (!keyword) return <span className="faint">—</span>
    return (
      <span className="vol-source-actions" title={verify.howTo}>
        <a
          href={verify.href}
          target="_blank"
          rel="noreferrer"
          className="vol-source-link"
          title={verify.title}
          onClick={(e) => e.stopPropagation()}
        >
          Planner ↗
        </a>
        <button
          type="button"
          className="btn tiny"
          style={{ padding: '2px 6px', fontSize: 10.5 }}
          onClick={(e) => {
            e.stopPropagation()
            void copy()
          }}
          title="Copy exact query and geo criteria id"
        >
          {copied ? '✓' : 'Copy'}
        </button>
      </span>
    )
  }

  if (compact) {
    return (
      <span className="vol-source" title={verify.howTo}>
        <span className="num">{volText}</span>
        {sourceLabel === 'Google Ads' && keyword && (
          <>
            {' '}
            <a
              href={verify.href}
              target="_blank"
              rel="noreferrer"
              className="vol-source-link"
              title={verify.title}
              onClick={(e) => e.stopPropagation()}
            >
              Ads ↗
            </a>
          </>
        )}
      </span>
    )
  }

  return (
    <div className="vol-source-block" title={verify.howTo}>
      <div className="vol-source-row">
        <strong className="num" style={{ fontSize: 14 }}>
          {volume == null ? '—' : volume.toLocaleString()}
        </strong>
        {sourceLabel && (
          <span className="faint" style={{ fontSize: 11 }}>
            {sourceLabel}
            {verify.geoCriteriaId != null && (
              <> · geo {verify.geoCriteriaId === 2840 ? 'US' : verify.geoCriteriaId}</>
            )}
          </span>
        )}
      </div>
      {keyword && (
        <div className="vol-source-actions">
          <a
            href={verify.href}
            target="_blank"
            rel="noreferrer"
            className="btn tiny"
            title={verify.title}
          >
            Keyword Planner ↗
          </a>
          <button type="button" className="btn tiny" onClick={copy} title="Copy exact query (+ geo id)">
            {copied ? 'Copied' : 'Copy query'}
          </button>
        </div>
      )}
      {keyword && (
        <div className="faint mono" style={{ fontSize: 10.5, marginTop: 4 }}>
          paste: {keyword}
          {verify.geoCriteriaId != null && verify.geoCriteriaId !== 2840
            ? ` · set Location ≈ criteria ${verify.geoCriteriaId}`
            : verify.geoCriteriaId === 2840
              ? ' · Location: United States'
              : ''}
        </div>
      )}
    </div>
  )
}
