'use client'

import { useMemo, useState } from 'react'

/**
 * The page-1 SERP we already bought, for every keyword in this market.
 *
 * ==================== BOUGHT LONG AGO, NEVER SHOWN ====================
 * `discovery_jobs.raw_items` has held the complete provider payload for every
 * completed SERP since the sweep was written -- 3,460 of them -- and no product
 * surface read it. An operator asking "what did page 1 actually look like" had
 * to trust the derived counters, or open a live Google link and hope it served
 * the same page months later. It does not.
 *
 * Rendering it costs nothing: the page was paid for when the run executed.
 * =====================================================================
 */

export interface StoredSerpView {
  jobId: number
  runId: number
  keyword: string
  keywordVariant: string | null
  device: string
  depth: number | null
  measuredAt: string | null
  items: Array<Record<string, unknown>>
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const int = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null

/** Modules whose nested entries are worth listing individually. */
const EXPANDABLE = new Set([
  'local_pack',
  'perspectives',
  'discussions_and_forums',
  'people_also_ask',
  'top_stories',
])

interface FlatRow {
  rank: number | null
  type: string
  domain: string | null
  title: string | null
  url: string | null
  depthLevel: number
}

/** Flatten the payload into what the page looked like, top to bottom. */
function flatten(items: Array<Record<string, unknown>>): FlatRow[] {
  const out: FlatRow[] = []
  for (const item of items) {
    const type = str(item['type']) ?? 'unknown'
    out.push({
      rank: int(item['rank_absolute']),
      type,
      domain: str(item['domain']),
      title: str(item['title']),
      url: str(item['url']),
      depthLevel: 0,
    })
    const nested = item['items']
    if (!EXPANDABLE.has(type) || !Array.isArray(nested)) continue
    for (const el of nested) {
      if (el === null || typeof el !== 'object') continue
      const e = el as Record<string, unknown>
      out.push({
        rank: int(e['rank_absolute']),
        type: str(e['type']) ?? `${type}_element`,
        domain: str(e['domain']),
        title: str(e['title']) ?? str(e['question']),
        url: str(e['url']),
        depthLevel: 1,
      })
    }
  }
  return out
}

function formatWhen(iso: string | null): string {
  if (!iso) return 'unknown date'
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export function StoredSerpPanel(props: { serps: StoredSerpView[] }) {
  const [openJob, setOpenJob] = useState<number | null>(null)

  const sorted = useMemo(
    () =>
      [...props.serps].sort(
        (a, b) => a.keyword.localeCompare(b.keyword) || a.device.localeCompare(b.device),
      ),
    [props.serps],
  )

  if (sorted.length === 0) {
    return (
      <section className="sm-panel">
        <div className="sm-toolbar">
          <div className="sm-toolbar-title">Stored SERPs</div>
        </div>
        <div className="empty" style={{ padding: 20 }}>
          No stored SERP pages for this run. Pages are kept for every completed job — a run that
          failed or is still queued has nothing to show yet.
        </div>
      </section>
    )
  }

  return (
    <section className="sm-panel">
      <div className="sm-toolbar">
        <div className="sm-toolbar-title">
          Stored SERPs
          <span className="sm-count">{sorted.length}</span>
        </div>
        <div className="sm-toolbar-actions">
          <span className="faint" style={{ fontSize: 12 }}>
            The page as the provider returned it, kept from the run. Free to re-read.
          </span>
        </div>
      </div>

      <div className="stored-serp-list">
        {sorted.map((s) => {
          const open = openJob === s.jobId
          const rows = open ? flatten(s.items) : []
          const organic = s.items.filter((i) => str(i['type']) === 'organic').length
          return (
            <div key={s.jobId} className={`stored-serp${open ? ' is-open' : ''}`}>
              <button
                type="button"
                className="stored-serp-head"
                onClick={() => setOpenJob(open ? null : s.jobId)}
                aria-expanded={open}
              >
                <span className="stored-serp-kw">
                  {s.keyword}
                  {s.keywordVariant && s.keywordVariant !== 'primary' && (
                    <span className="sm-sub"> · {s.keywordVariant}</span>
                  )}
                </span>
                <span className="stored-serp-meta">
                  {s.device} · {organic} organic of {s.items.length} items
                  {s.depth != null && ` · depth ${s.depth}`} · run #{s.runId} ·{' '}
                  {formatWhen(s.measuredAt)}
                </span>
                <span className="stored-serp-caret">{open ? '▾' : '▸'}</span>
              </button>

              {open && (
                <div className="table-scroll">
                  <table className="sm-table stored-serp-table">
                    <thead>
                      <tr>
                        <th className="num">#</th>
                        <th>Type</th>
                        <th>Domain</th>
                        <th>Title</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r, i) => (
                        <tr
                          key={`${r.type}-${i}`}
                          className={r.depthLevel > 0 ? 'stored-serp-nested' : undefined}
                        >
                          <td className="num">{r.rank ?? '—'}</td>
                          <td>
                            <span className={`serp-type serp-type-${r.type.split('_')[0]}`}>
                              {r.type}
                            </span>
                          </td>
                          <td className="mono" style={{ fontSize: 12 }}>
                            {r.domain ?? '—'}
                          </td>
                          <td style={{ maxWidth: 460 }}>
                            {r.url ? (
                              <a href={r.url} target="_blank" rel="noopener noreferrer">
                                {r.title ?? r.url}
                              </a>
                            ) : (
                              (r.title ?? '—')
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}
