'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { NULL_DISPLAY, num } from '@/lib/format'
import {
  mapDiscoveryNicheAction,
  promoteHitAction,
  type PromoteActionResult,
} from '@/app/research/reddit/actions'

export interface HitView {
  id: number
  keyword: string
  redditUrl: string
  title: string | null
  subreddit: string | null
  sourceKind: string
  organicPosition: number | null
  packPosition: number | null
  commentable: boolean | null
  promotedTargetId: number | null
  localityName: string | null
  localitySlug: string | null
  stateCode: string | null
  population: number | null
  nicheId: number | null
  nicheSlug: string | null
  nicheLabel: string | null
  discoveryNicheId: number | null
  discoveryNicheLabel: string | null
}

export interface NicheOption {
  id: number
  slug: string
  label: string
}

export function DiscoveryHitsTable({
  runId,
  hits,
  niches,
}: {
  runId: number
  hits: HitView[]
  niches: NicheOption[]
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [messages, setMessages] = useState<Record<number, PromoteActionResult>>({})
  const [mapMsg, setMapMsg] = useState<string | null>(null)

  if (hits.length === 0) {
    return (
      <div className="empty">
        No Reddit hits yet. If the run is still pending/running, start{' '}
        <code>pnpm worker</code> and reload. Zero hits after <em>done</em> means page 1 had no
        Reddit for those keyword×geo cells.
      </div>
    )
  }

  return (
    <>
      {mapMsg && (
        <div className="okbox" style={{ marginBottom: 10 }}>
          {mapMsg}
        </div>
      )}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Locality</th>
              <th>Keyword</th>
              <th>Thread</th>
              <th>Source</th>
              <th className="num">Organic</th>
              <th className="num">Pack</th>
              <th>Commentable</th>
              <th>Market / niche</th>
              <th>Promote</th>
            </tr>
          </thead>
          <tbody>
            {hits.map((h) => {
              const mapped = h.nicheId !== null && h.localitySlug && h.nicheSlug
              const msg = messages[h.id]
              return (
                <tr key={h.id}>
                  <td style={{ fontSize: 12.5 }}>
                    {h.localityName ? (
                      <>
                        {h.localityName}
                        {h.stateCode ? `, ${h.stateCode}` : ''}
                        <div className="faint" style={{ fontSize: 10.5 }}>
                          pop {num(h.population)}
                        </div>
                      </>
                    ) : (
                      NULL_DISPLAY
                    )}
                  </td>
                  <td style={{ fontSize: 12 }} className="mono">
                    {h.keyword}
                  </td>
                  <td style={{ fontSize: 11.5, maxWidth: 220 }}>
                    <a href={h.redditUrl} target="_blank" rel="noreferrer">
                      {h.title ?? h.subreddit ?? h.redditUrl.slice(0, 40)}
                    </a>
                    {h.subreddit && (
                      <div className="faint" style={{ fontSize: 10.5 }}>
                        r/{h.subreddit}
                      </div>
                    )}
                  </td>
                  <td style={{ fontSize: 11 }}>
                    {h.sourceKind === 'discussions_and_forums' ? (
                      <span className="badge warn">discussions</span>
                    ) : (
                      <span className="badge">organic</span>
                    )}
                  </td>
                  <td className="num">
                    {h.organicPosition === null ? NULL_DISPLAY : `#${h.organicPosition}`}
                  </td>
                  <td className="num">
                    {h.packPosition === null ? NULL_DISPLAY : `#${h.packPosition}`}
                  </td>
                  <td style={{ fontSize: 11.5 }}>
                    {h.commentable === null ? (
                      <span className="null" title="Not probed yet (default: on promote)">
                        {NULL_DISPLAY}
                      </span>
                    ) : h.commentable ? (
                      <span className="badge go">open</span>
                    ) : (
                      <span className="badge stop">closed</span>
                    )}
                  </td>
                  <td style={{ fontSize: 11.5 }}>
                    {mapped ? (
                      <Link href={`/markets/${h.localitySlug}/${h.nicheSlug}`}>
                        {h.nicheLabel}
                      </Link>
                    ) : h.discoveryNicheId ? (
                      <form
                        onSubmit={(e) => {
                          e.preventDefault()
                          const fd = new FormData(e.currentTarget)
                          fd.set('runId', String(runId))
                          fd.set('discoveryNicheId', String(h.discoveryNicheId))
                          startTransition(async () => {
                            const res = await mapDiscoveryNicheAction(fd)
                            setMapMsg(
                              res.ok
                                ? `Mapped “${h.discoveryNicheLabel ?? 'niche'}”.`
                                : res.error ?? 'Map failed',
                            )
                            if (res.ok) router.refresh()
                          })
                        }}
                        className="flex"
                        style={{ gap: 4, flexWrap: 'wrap' }}
                      >
                        <select name="nicheId" required defaultValue="" style={{ fontSize: 11, maxWidth: 140 }}>
                          <option value="" disabled>
                            map niche…
                          </option>
                          {niches.map((n) => (
                            <option key={n.id} value={n.id}>
                              {n.label}
                            </option>
                          ))}
                        </select>
                        <button type="submit" disabled={pending} style={{ fontSize: 11 }}>
                          map
                        </button>
                      </form>
                    ) : (
                      <span className="faint">no niche row</span>
                    )}
                  </td>
                  <td style={{ fontSize: 11.5 }}>
                    {h.promotedTargetId ? (
                      mapped ? (
                        <Link href={`/markets/${h.localitySlug}/${h.nicheSlug}`}>
                          <span className="badge go">watching</span>
                        </Link>
                      ) : (
                        <span className="badge go">watching</span>
                      )
                    ) : (
                      <button
                        type="button"
                        className="primary"
                        disabled={pending || !h.nicheId}
                        title={
                          h.nicheId
                            ? 'Create market cell (if needed) and start SERP monitoring'
                            : 'Map niche first'
                        }
                        onClick={() => {
                          const fd = new FormData()
                          fd.set('hitId', String(h.id))
                          fd.set('runId', String(runId))
                          if (h.nicheId) fd.set('nicheId', String(h.nicheId))
                          startTransition(async () => {
                            const res = await promoteHitAction(fd)
                            setMessages((m) => ({ ...m, [h.id]: res }))
                            if (res.ok) router.refresh()
                          })
                        }}
                      >
                        promote
                      </button>
                    )}
                    {msg && (
                      <div
                        className={msg.ok ? 'faint' : 'disabled-reason'}
                        style={{ fontSize: 10.5, marginTop: 4, maxWidth: 160 }}
                      >
                        {msg.error ?? msg.warning ?? (msg.ok ? `ok · vol ${msg.volume ?? '—'}` : '')}
                      </div>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <p className="sub">
        Promote creates (or reuses) the market cell, upserts the keyword, and watches the thread
        post-only. Comment ordinal monitoring starts when you paste a comment permalink on the
        market page. Volume comes from Google Ads when live + OAuth is configured.
      </p>
    </>
  )
}
