import Link from 'next/link'
import { notFound } from 'next/navigation'
import type { KeywordVerdict } from '@rnr/core'
import {
  db,
  listClusterBoard,
  listKeywordBoard,
  loadCoverageMatrix,
  summariseSurfaceCoverage,
  loadDirectory,
  type DirectorySummary,
  queryOr,
  summariseCoverage,
  supplyOpportunityReport,
} from '@rnr/data'
import { PageHeader } from '@/components/shell/PageHeader'
import { StageTile } from '@/components/directories/StageTile'
import { NextAction } from '@/components/directories/NextAction'
import { ClusterBoard } from '@/components/directories/ClusterBoard'
import { CoverageMatrix } from '@/components/directories/CoverageMatrix'
import { ConquestBoard } from '@/components/directories/ConquestBoard'
import { NULL_DISPLAY, money, num } from '@/lib/format'

export const dynamic = 'force-dynamic'

const VERDICTS: KeywordVerdict[] = ['DEFEND', 'IMPROVE', 'BUILD', 'IGNORE', 'UNKNOWN']

/**
 * One directory: its pipeline, its keyword board, and its supply.
 *
 * ==================== UNKNOWN IS A TAB, NOT A HIDDEN BUCKET ====================
 * `listKeywordBoard`'s own comment: UNKNOWN sorts last rather than being hidden,
 * because "a bucket you cannot see is a coverage gap you will not fix". The
 * filter here therefore includes it as a peer of the real verdicts, and it is
 * the DEFAULT view whenever nothing else has any rows — which is exactly the
 * state a freshly expanded grid is in.
 * ==============================================================================
 */
export default async function DirectoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ domain: string }>
  searchParams: Promise<{ verdict?: string; view?: string }>
}) {
  const { domain } = await params
  const sp = await searchParams
  const requested = sp.verdict
  const coverageView = sp.view === 'list' ? 'list' : 'board'

  /**
   * ==================== A FAILED QUERY IS NOT A MISSING SITE ====================
   * `queryOr` swallows a timeout and returns its fallback. With `null` as the
   * fallback that made an 8-second deadline render as `notFound()` — the page
   * told the operator this directory does not exist, when in fact the database
   * had not answered yet. That is the same unmeasured-as-zero conflation the
   * whole system is built to avoid, wearing an HTTP status code.
   *
   * The sentinel keeps the two apart: 'unavailable' means we could not look,
   * `null` means we looked and it is not there.
   * =============================================================================
   */
  const dir = await queryOr<DirectorySummary | null | 'unavailable'>(
    'loadDirectory',
    () => loadDirectory(db(), domain),
    'unavailable',
  )

  if (dir === 'unavailable') {
    return (
      <>
        <PageHeader
          title={domain}
          breadcrumb={
            <Link href="/directories" className="sm-link">
              ← Directories
            </Link>
          }
        />
        <div className="stopbox">
          The database did not answer within the query deadline, so this page cannot say
          anything about {domain} — including whether it exists. Reload; if it persists, the
          pooler or the connection is the problem, not this site.
        </div>
      </>
    )
  }

  if (!dir) notFound()

  const verdict = VERDICTS.includes(requested as KeywordVerdict)
    ? (requested as KeywordVerdict)
    : null

  const board = await queryOr(
    'listKeywordBoard',
    () => listKeywordBoard(db(), dir.siteId, { ...(verdict ? { verdicts: [verdict] } : {}), limit: 100 }),
    [],
  )
  const clusters = await queryOr(
    'listClusterBoard',
    () => listClusterBoard(db(), dir.siteId, { limit: 60 }),
    [],
  )
  const matrix = await queryOr(
    'loadCoverageMatrix',
    () => loadCoverageMatrix(db(), dir.siteId, { limit: 60 }),
    [],
  )
  const surfaceStats = await queryOr(
    'summariseSurfaceCoverage',
    () => summariseSurfaceCoverage(db(), dir.siteId),
    null,
  )
  const coverage = await queryOr('summariseCoverage', () => summariseCoverage(db(), dir.siteId), null)
  const opportunity = await queryOr(
    'supplyOpportunityReport',
    () => supplyOpportunityReport(db(), dir.siteId),
    null,
  )

  return (
    <>
      <PageHeader
        title={dir.domain}
        description={
          `${dir.status} · ${dir.patternCount} pattern(s)` +
          (dir.audienceScope ? ` · demand at ${dir.audienceScope}` : '') +
          (dir.geoMode ? ` · ${dir.geoMode.replace(/_/g, ' ')}` : '')
        }
        breadcrumb={
          <Link href="/directories" className="sm-link">
            ← Directories
          </Link>
        }
      />

      <div className="funnel-strip">
        {dir.stages.map((s) => (
          <StageTile key={s.key} stage={s} />
        ))}
      </div>

      <NextAction action={dir.nextAction} decided={dir.decided} keywords={dir.keywords} />

      {/* ---- SERP coverage: the conquest board ------------------------------ */}
      <section className="sm-panel" style={{ marginTop: 24 }}>
        <div className="sm-toolbar">
          <div className="sm-toolbar-title">Territory</div>
          <div className="sm-toolbar-meta" style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
            <span
              title="A SERP is a board: an AI Overview, a forums pack, images, video and People Also Ask sit above or beside the ten blue links. Each is a slot you either hold or do not. Ordered by demand — never by how much you hold."
            >
              {surfaceStats
                ? `${num(surfaceStats.clustersMeasured)}/${num(surfaceStats.clusters)} scouted`
                : 'not scouted'}
            </span>
            <span className="view-switch">
              <Link
                href={`/directories/${dir.domain}`}
                className={coverageView === 'board' ? 'active' : ''}
              >
                Board
              </Link>
              <Link
                href={`/directories/${dir.domain}?view=list`}
                className={coverageView === 'list' ? 'active' : ''}
              >
                List
              </Link>
            </span>
          </div>
        </div>
        {coverageView === 'board' ? (
          <ConquestBoard rows={matrix} />
        ) : (
          <CoverageMatrix rows={matrix} />
        )}
      </section>

      {/* ---- Clusters: the unit of work ------------------------------------- */}
      <section className="sm-panel" style={{ marginTop: 24 }}>
        <div className="sm-toolbar">
          <div className="sm-toolbar-title">Clusters</div>
          <div className="sm-toolbar-meta">{num(clusters.length)} shown · one cluster is one page</div>
        </div>
        <div className="sm-panel-hint">
          A cluster is the set of keywords one page serves, so it — not the keyword — is the unit a
          verdict, a value and a queue position belong to. Ranked on <strong>vol (max)</strong>, a
          lower bound; <span className="dim">sum</span> is an upper bound and is never sorted on,
          because near-identical phrasings share one pool of demand and summing them inflated three
          cities in this import by 4.5×, 7.3× and 11.2×.
        </div>
        <ClusterBoard rows={clusters} />
      </section>

      {/* ---- Keyword board -------------------------------------------------- */}
      <section className="sm-panel" style={{ marginTop: 24 }}>
        <div className="sm-toolbar">
          <div className="sm-toolbar-title">Keywords</div>
          <div className="sm-toolbar-meta">
            {num(dir.keywords)} total · {num(dir.decided)} decided
          </div>
        </div>

        <div className="portfolio-views">
          <Link
            href={`/directories/${dir.domain}`}
            className={verdict === null ? 'seg active' : 'seg'}
          >
            All
          </Link>
          {VERDICTS.map((v) => (
            <Link
              key={v}
              href={`/directories/${dir.domain}?verdict=${v}`}
              className={verdict === v ? 'seg active' : 'seg'}
              title={
                v === 'UNKNOWN'
                  ? 'A signal the decision needed was never measured. Not a judgement about the keyword.'
                  : undefined
              }
            >
              {v} <span className="opp-tab-badge">{num(dir.byVerdict[v])}</span>
            </Link>
          ))}
        </div>

        {board.length === 0 ? (
          <div className="empty">No keywords in this view.</div>
        ) : (
          <div className="sm-table-wrap">
            <table className="sm-table">
              <thead>
                <tr>
                  <th>Keyword</th>
                  <th>Verdict</th>
                  <th className="sm-mono">Volume</th>
                  <th className="sm-mono">Position</th>
                  <th className="sm-mono">Difficulty</th>
                  <th className="sm-mono">Value / mo</th>
                  <th>Why</th>
                </tr>
              </thead>
              <tbody>
                {board.map((r) => (
                  <tr key={r.id}>
                    <td className="sm-kw-cell">{r.keyword}</td>
                    <td>
                      <span className={`sm-verdict sm-verdict-${(r.verdict ?? 'unknown').toLowerCase()}`}>
                        {r.verdict ?? 'UNKNOWN'}
                      </span>
                    </td>
                    {/*
                      Every measured cell renders null as an em dash, never 0.
                      `volumeScope` is in the title because 2,400/mo US-national
                      and 2,400/mo in one city are not the same fact.
                    */}
                    <td className="sm-mono" title={r.volumeScope ?? 'scope not recorded'}>
                      {r.volume === null ? <span className="null">{NULL_DISPLAY}</span> : num(r.volume)}
                    </td>
                    <td className="sm-mono">
                      {r.position === null ? (
                        <span className="null">{NULL_DISPLAY}</span>
                      ) : (
                        `#${r.position}`
                      )}
                    </td>
                    <td className="sm-mono">
                      {r.difficulty === null ? (
                        <span className="null">{NULL_DISPLAY}</span>
                      ) : (
                        r.difficulty
                      )}
                    </td>
                    <td className="sm-mono">
                      {r.monthlyValueMicros === null ? (
                        <span className="null" title="Order value, commission or conversion is unset. Never a fallback number.">
                          {NULL_DISPLAY}
                        </span>
                      ) : (
                        money(String(r.monthlyValueMicros))
                      )}
                    </td>
                    <td className="sm-sub">{r.verdictReason ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ---- Supply ---------------------------------------------------------- */}
      <section className="sm-panel" style={{ marginTop: 24 }}>
        <div className="sm-toolbar">
          <div className="sm-toolbar-title">Supply</div>
          <div className="sm-toolbar-meta">
            {dir.supplySources === 0
              ? 'no feed connected'
              : `${num(dir.supplyItems)} available listing(s)`}
          </div>
        </div>

        {dir.supplySources === 0 ? (
          <div className="sm-panel-hint">
            No supply feed connected, so every keyword is UNKNOWN supply and nothing is gated on
            it. That is the safe state, not a clean bill of health — this site cannot currently
            tell whether it is building pages into empty inventory.
          </div>
        ) : (
          <>
            <div className="stats">
              <div className="stat">
                <div className="stat-label">Markets with supply</div>
                <div className="stat-value">{num(coverage?.entitiesWithSupply ?? null)}</div>
              </div>
              <div className="stat">
                <div className="stat-label">Measured zero</div>
                <div className="stat-value">{num(coverage?.entitiesMeasuredZero ?? null)}</div>
              </div>
              <div className="stat">
                <div className="stat-label" title="Contribute to NO market's coverage. UNKNOWN, never zero.">
                  Unresolved suppliers
                </div>
                <div className="stat-value">{num(dir.unresolvedSuppliers)}</div>
              </div>
            </div>

            {opportunity && (
              <>
                <div className="section-label" style={{ marginTop: 18 }}>
                  Supply × demand
                </div>
                <div className="funnel-strip">
                  {(
                    [
                      ['BUILD_FIRST', 'Build first', 'Demand exists and we can fulfil it'],
                      ['SUPPLY_GAP', 'Supply gap', 'Real demand we cannot fulfil. Do not build, do not bid'],
                      ['KEYWORD_GAP', 'Keyword gap', 'Inventory nobody can find. The supply risk is already gone'],
                      ['UNKNOWN', 'Unknown', 'A signal was never measured. Never read as a zero'],
                    ] as const
                  ).map(([cell, label, hint]) => (
                    <div key={cell} className="funnel-tile" title={hint}>
                      <span className="funnel-label">{label}</span>
                      <span className="funnel-value">{num(opportunity.byCell[cell])}</span>
                      <span className="stage-detail">{hint}</span>
                    </div>
                  ))}
                </div>

                {opportunity.notes.map((n, i) => (
                  <div key={i} className="sm-panel-hint">
                    {n}
                  </div>
                ))}
              </>
            )}
          </>
        )}
      </section>

      {/* ---- Everything else that hangs off this site ------------------------ */}
      <section className="quick-grid" style={{ marginTop: 24 }}>
        <div className="quick-card">
          <div className="quick-card-title">Paid search</div>
          <div className="quick-card-desc">
            {dir.adsPlans === 0
              ? 'No plans. Break-even is computed per keyword from measured economics; nothing here can launch.'
              : `${num(dir.adsPlans)} plan(s). Nothing launches without four independent conditions.`}
          </div>
          <code className="mono quick-card-cta">ads-plan.mts build {dir.domain}</code>
        </div>

        <div className="quick-card">
          <div className="quick-card-title">Link outreach</div>
          <div className="quick-card-desc">
            {dir.linkRuns === 0
              ? 'No mining runs. Prospects are gated on organic traffic first — authority is manufacturable, ranking is not.'
              : `${num(dir.linkRuns)} run(s). Nothing here sends email.`}
          </div>
          <code className="mono quick-card-cta">link-outreach.mts mine --site={dir.domain}</code>
        </div>

        <div className="quick-card">
          <div className="quick-card-title">Economics</div>
          <div className="quick-card-desc">
            Commission per vendor, order value per entity, conversion from recorded observations.
            Unset stays null rather than becoming a plausible guess.
          </div>
          <code className="mono quick-card-cta">economics.mts show {dir.domain}</code>
        </div>
      </section>
    </>
  )
}
