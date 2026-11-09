import Link from 'next/link'
import { db, listDirectories, queryOr } from '@rnr/data'
import { PageHeader } from '@/components/shell/PageHeader'
import { StageTile } from '@/components/directories/StageTile'
import { NextAction } from '@/components/directories/NextAction'

export const dynamic = 'force-dynamic'

/**
 * Directories — affiliate sites that earn per referred purchase.
 *
 * ==================== WHY THIS IS NOT ON /portfolio ====================
 * /portfolio lists (locality, niche) cells. A directory site has BOTH set to
 * NULL by construction — that was the whole point of migration 0022 — so it can
 * never appear there, and /sites/[siteId] is no better because it resolves a
 * site id to its locality+niche pair and redirects.
 *
 * Until now that meant every directory feature was CLI-only and the sites were
 * invisible in the product. An operator opening /portfolio to find
 * hotelhottubs.com found nothing, and nothing on screen explained why.
 * ======================================================================
 *
 * It IS under Portfolio in the nav, because the nav's boundary is whether you
 * are still deciding, and a directory you own is decided.
 */
export default async function DirectoriesPage() {
  const directories = await queryOr('listDirectories', () => listDirectories(db()), [])

  return (
    <>
      <PageHeader
        title="Directories"
        description="Affiliate sites that earn per referred purchase, across many markets or none."
      />

      {directories.length === 0 && (
        <div className="empty">
          No directory sites yet. <code className="mono">affiliate-research.mts seed</code> creates
          them from the seeds, or <code className="mono">upsertAffiliateSite</code> adds one.
        </div>
      )}

      {directories.map((d) => (
        <section key={d.siteId} className="card" style={{ marginBottom: 20 }}>
          <div className="page-header-row" style={{ marginBottom: 4 }}>
            <div>
              <h2 className="metric-heading" style={{ margin: 0 }}>
                <Link href={`/directories/${d.domain}`} className="sm-link">
                  {d.domain}
                </Link>
              </h2>
              <div className="sm-sub">
                {d.displayName ? `${d.displayName} · ` : ''}
                {d.status}
                {d.audienceScope ? ` · demand measured at ${d.audienceScope}` : ''}
                {d.geoMode ? ` · geography ${d.geoMode.replace(/_/g, ' ')}` : ''}
              </div>
            </div>
            <div className="page-header-actions">
              <Link href={`/directories/${d.domain}`} className="btn">
                Open
              </Link>
            </div>
          </div>

          {/*
            The pipeline, before the numbers. A directory's board is mostly em
            dashes until several free stages have run, and a table of em dashes
            cannot say WHICH stage is missing or why.
          */}
          <div className="funnel-strip" style={{ marginTop: 16 }}>
            {d.stages.map((s) => (
              <StageTile key={s.key} stage={s} />
            ))}
          </div>

          <NextAction action={d.nextAction} decided={d.decided} keywords={d.keywords} />
        </section>
      ))}
    </>
  )
}
