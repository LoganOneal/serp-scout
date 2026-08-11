import Link from 'next/link'
import type { Verdict } from '@rnr/core'
import { db, listShortlistedUntargeted, queryOr } from '@rnr/data'
import { PipelineRowActions } from '@/components/PipelineRowActions'
import { PageHeader } from '@/components/shell/PageHeader'
import { NULL_DISPLAY, verdictStyle } from '@/lib/format'

export const dynamic = 'force-dynamic'

/**
 * Saved niche × locality candidates that are not yet targeted.
 * Research → Pipeline → Markets (operate).
 */
export default async function PipelinePage() {
  const rows = await queryOr(
    'listShortlistedUntargeted',
    () => listShortlistedUntargeted(db()),
    [],
  )

  return (
    <div>
      <PageHeader
        title="Pipeline"
        description="Saved opportunities waiting to be targeted. Open a cell to start targeting, or remove it from the pipeline."
        actions={
          <Link href="/research" className="btn primary">
            Do research
          </Link>
        }
      />

      {rows.length === 0 ? (
        <div className="card empty" style={{ padding: 28 }}>
          Nothing in the pipeline yet.
          <div style={{ marginTop: 10, fontSize: 13 }}>
            <Link href="/research/scan">Scan a locality</Link> and shortlist a cell, then it appears
            here until you start targeting.
          </div>
        </div>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Market</th>
                <th>Verdict</th>
                <th className="num">Diff</th>
                <th>Domain</th>
                <th>Saved</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((u) => {
                const v = verdictStyle(u.verdictAtSave as Verdict)
                const href = `/markets/${u.localitySlug}/${u.nicheSlug}`
                const label = `${u.localityName}, ${u.stateCode} · ${u.nicheLabel}`
                return (
                  <tr key={u.shortlistId}>
                    <td>
                      <Link href={href}>
                        {u.localityName}, {u.stateCode} · {u.nicheLabel}
                      </Link>
                    </td>
                    <td>
                      <span className={`badge ${v.tone}`}>{v.label}</span>
                    </td>
                    <td className="num">
                      {u.difficultyAtSave === null ? NULL_DISPLAY : u.difficultyAtSave}
                    </td>
                    <td className="mono" style={{ fontSize: 12 }}>
                      {u.emdDomain ?? '—'}
                    </td>
                    <td className="mono faint" style={{ fontSize: 11 }}>
                      {u.savedAt.toISOString().slice(0, 10)}
                    </td>
                    <td>
                      <PipelineRowActions
                        shortlistId={u.shortlistId}
                        href={href}
                        label={label}
                      />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
