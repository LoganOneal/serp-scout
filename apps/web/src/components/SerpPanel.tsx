'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { NULL_DISPLAY, num } from '@/lib/format'

/**
 * SERP monitoring for a cell.
 *
 * ==================== WHAT THE THREE STATES MEAN ON SCREEN ====================
 * The whole feature turns on distinguishing "we looked and it is gone" from "we could not
 * look", so the UI never renders them the same way:
 *
 *   #4          measured, ranking there
 *   not ranking measured, and the thread is not in the top 100 -- the signal you asked for
 *   —           NOT measured. Blocked, truncated, or the check never ran.
 *
 * Reddit answers 403 to server IPs, so the em dash will be common. Showing it as "gone"
 * would page you about a deletion that never happened.
 * ==========================================================================
 */

export interface SerpKeywordRow {
  id: number
  keyword: string
  volume: number | null
  difficulty: number | null
  semrushPosition: number | null
  targetCount: number
  lastCheckedAt: string | null
}

export interface SerpTargetRowView {
  id: number
  keyword: string
  url: string
  label: string | null
  commentPermalink: string | null
  nextCheckAt: string
  lastCheckedAt: string | null
  serpPosition: number | null
  /** Discussions pack position when present. */
  serpPackPosition: number | null
  serpSourceKind: string | null
  serpMeasured: boolean
  commentRank: number | null
  commentPresent: boolean | null
  error: string | null
  regressions: Array<{ kind: string; message: string; severity: string }>
}

export function SerpPanel({
  siteId,
  keywords,
  targets,
  onImport,
  onAddTarget,
  onRemoveKeyword,
}: {
  siteId: number
  keywords: SerpKeywordRow[]
  targets: SerpTargetRowView[]
  onImport: (fd: FormData) => Promise<{ ok: boolean; detail: string; skipped?: string[] }>
  onAddTarget: (fd: FormData) => Promise<{ ok: boolean; error?: string }>
  onRemoveKeyword?: (fd: FormData) => Promise<{ ok: boolean; error?: string }>
}) {
  const router = useRouter()
  const [importResult, setImportResult] = useState<{
    ok: boolean
    detail: string
    skipped?: string[]
  } | null>(null)
  const [addError, setAddError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const [csv, setCsv] = useState('')

  const doImport = (fd: FormData) => {
    setImportResult(null)
    fd.set('siteId', String(siteId))
    startTransition(async () => {
      setImportResult(await onImport(fd))
      router.refresh()
    })
  }

  const doAdd = (fd: FormData) => {
    setAddError(null)
    fd.set('siteId', String(siteId))
    startTransition(async () => {
      const res = await onAddTarget(fd)
      if (!res.ok) setAddError(res.error ?? 'Could not add that target.')
      else router.refresh()
    })
  }

  const doRemove = (keywordId: number, keyword: string) => {
    if (!onRemoveKeyword) return
    if (!window.confirm(`Remove keyword “${keyword}” from monitoring?`)) return
    setAddError(null)
    const fd = new FormData()
    fd.set('keywordId', String(keywordId))
    fd.set('siteId', String(siteId))
    startTransition(async () => {
      const res = await onRemoveKeyword(fd)
      if (!res.ok) setAddError(res.error ?? 'Could not remove keyword.')
      else router.refresh()
    })
  }

  const allRegressions = targets.flatMap((t) => t.regressions)

  return (
    <>
      <h3>SERP monitoring</h3>

      {allRegressions.length > 0 && (
        <div className="stopbox">
          <strong>
            {allRegressions.length} regression{allRegressions.length === 1 ? '' : 's'} since the
            previous check.
          </strong>
          <ul style={{ margin: '6px 0 0' }}>
            {allRegressions.map((r, i) => (
              <li key={i} style={{ fontSize: 12.5 }}>
                {r.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* --- Import keywords ---------------------------------------------- */}
      <div className="card">
        <h4 style={{ marginTop: 0 }}>Import keywords</h4>
        <p className="sub" style={{ marginTop: 0 }}>
          Paste or upload a keyword CSV (Semrush-shaped headers work: <code>Keyword</code>,{' '}
          <code>Search Volume</code>, or API codes <code>Ph</code>/<code>Nq</code>). Only a
          keyword column is required. Search volume can also be filled from{' '}
          <strong>Google Ads</strong> when promoting discovery hits (not DataForSEO).{' '}
          <strong>Every skipped row is reported</strong> — a silent partial import is how you
          end up watching 40 of 300 keywords and believing you cover them all.
        </p>

        <form action={doImport}>
          <div className="flex" style={{ marginBottom: 8 }}>
            <input
              type="file"
              accept=".csv,text/csv,text/plain"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void f.text().then(setCsv)
              }}
            />
          </div>
          <textarea
            name="csv"
            value={csv}
            onChange={(e) => setCsv(e.target.value)}
            rows={4}
            placeholder="Keyword,Position,Search Volume,Keyword Difficulty,CPC,URL"
            className="mono"
            style={{ width: '100%', fontSize: 11.5 }}
          />
          <div className="flex" style={{ marginTop: 8 }}>
            <button className="primary" type="submit" disabled={pending || csv.trim() === ''}>
              {pending ? 'Importing…' : 'Import'}
            </button>
            <button type="button" onClick={() => setCsv('')} disabled={pending || csv === ''}>
              Clear
            </button>
          </div>
        </form>

        {importResult && (
          <div className={importResult.ok ? 'okbox' : 'stopbox'} style={{ marginTop: 10 }}>
            {importResult.detail}
            {importResult.skipped && importResult.skipped.length > 0 && (
              <ul style={{ margin: '6px 0 0' }}>
                {importResult.skipped.map((s, i) => (
                  <li key={i} style={{ fontSize: 12 }}>
                    {s}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {/* --- Keywords ----------------------------------------------------- */}
      {keywords.length > 0 && (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Keyword</th>
                <th className="num">Volume</th>
                <th className="num">KD</th>
                <th className="num">Semrush pos</th>
                <th className="num">Watching</th>
                <th>Add a Reddit thread</th>
                {onRemoveKeyword && <th></th>}
              </tr>
            </thead>
            <tbody>
              {keywords.map((k) => (
                <tr key={k.id}>
                  <td style={{ fontSize: 12.5 }}>{k.keyword}</td>
                  {/* Nulls are em dashes: an export that omitted volume did not report zero
                      searches. Same rule as difficulty on the research side. */}
                  <td className="num">{k.volume === null ? <Dash /> : num(k.volume)}</td>
                  <td className="num">{k.difficulty === null ? <Dash /> : k.difficulty}</td>
                  <td className="num">
                    {k.semrushPosition === null ? <Dash title="Not reported in the export." /> : k.semrushPosition}
                  </td>
                  <td className="num">{k.targetCount === 0 ? <Dash /> : k.targetCount}</td>
                  <td>
                    <form action={doAdd} className="outcome-cell">
                      <input type="hidden" name="keywordId" value={k.id} />
                      <input
                        name="permalink"
                        placeholder="paste your comment permalink"
                        style={{ width: 240, fontSize: 11.5 }}
                        disabled={pending}
                      />
                      <button type="submit" disabled={pending}>
                        add
                      </button>
                    </form>
                  </td>
                  {onRemoveKeyword && (
                    <td>
                      <button
                        type="button"
                        className="btn tiny danger"
                        disabled={pending}
                        onClick={() => doRemove(k.id, k.keyword)}
                      >
                        Remove
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {addError && <div className="disabled-reason">{addError}</div>}

      {/* --- Monitored targets -------------------------------------------- */}
      <h4>Monitored threads</h4>
      {targets.length === 0 ? (
        <div className="empty">
          Nothing monitored yet. Import keywords and paste a Reddit thread URL (post-only is
          fine — add your comment permalink later when you engage), or promote a hit from
          discovery research.
        </div>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Keyword</th>
                <th>Thread</th>
                <th className="num">Thread rank</th>
                <th className="num">Our comment</th>
                <th>Last checked</th>
                <th>Next</th>
              </tr>
            </thead>
            <tbody>
              {targets.map((t) => (
                <tr key={t.id} className={t.regressions.length > 0 ? 'row-emergency' : undefined}>
                  <td style={{ fontSize: 12.5 }}>{t.keyword}</td>
                  <td style={{ fontSize: 11.5 }}>
                    <a href={t.commentPermalink ?? t.url} target="_blank" rel="noreferrer">
                      {t.label ?? 'thread'}
                    </a>
                    {t.commentPermalink === null && (
                      <div className="faint" style={{ fontSize: 10.5 }}>
                        post only — paste comment permalink when you engage
                      </div>
                    )}
                  </td>

                  {/* Organic and/or Discussions pack — never collapse pack-only into "not ranking". */}
                  <td className="num">{threadRankCell(t)}</td>

                  <td className="num">
                    {t.commentPresent === null ? (
                      <Dash
                        title={
                          t.error ??
                          'Could not measure. Reddit blocks server IPs, so this is common — it does NOT mean the comment is gone.'
                        }
                      />
                    ) : t.commentPresent === false ? (
                      <span className="badge stop" title="A complete thread was loaded and the comment was not in it.">
                        gone
                      </span>
                    ) : (
                      <>#{t.commentRank ?? '?'}</>
                    )}
                  </td>

                  <td className="mono faint" style={{ fontSize: 11 }}>
                    {t.lastCheckedAt === null ? 'never' : t.lastCheckedAt.slice(0, 16).replace('T', ' ')}
                  </td>
                  <td className="mono faint" style={{ fontSize: 11 }}>
                    {t.nextCheckAt.slice(0, 16).replace('T', ' ')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="sub">
        A comment ordinal is <strong>as Reddit returns it under its default sort</strong>, not
        what every visitor sees — Reddit personalises and collapses low-score comments. And an
        em dash means <strong>not measured</strong>, never <em>gone</em>: Reddit blocks
        datacenter IPs, so unmeasured checks are expected and deliberately raise no alert.
      </p>
    </>
  )
}

function Dash({ title }: { title?: string }) {
  return (
    <span className="null" title={title ?? 'Not measured.'}>
      {NULL_DISPLAY}
    </span>
  )
}

/** Organic #N, Discussions #P, both, not ranking, or unmeasured. */
function threadRankCell(t: SerpTargetRowView) {
  if (!t.serpMeasured) {
    return <Dash title={t.error ?? 'The SERP was not measured on the last check.'} />
  }
  const organic = t.serpPosition
  const pack = t.serpPackPosition
  if (organic === null && pack === null) {
    return (
      <span
        className="badge stop"
        title="Checked: not in organic results or the Discussions and Forums pack."
      >
        not ranking
      </span>
    )
  }
  if (organic !== null && pack !== null) {
    return (
      <span title="Organic rank · Discussions pack position">
        #{organic} · Disc #{pack}
      </span>
    )
  }
  if (organic !== null) return <>#{organic}</>
  return (
    <span className="badge warn" title="In the Discussions and Forums pack only (not organic).">
      Discussions #{pack}
    </span>
  )
}
