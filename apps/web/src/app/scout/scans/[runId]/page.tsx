import { notFound } from 'next/navigation'
import { formatMicrosUsd } from '@rnr/core'
import { db, getRun, getRunResults, reconcileSpend } from '@rnr/data'
import { AvailabilityBadge, DifficultyCell, Nullable, VerdictBadge } from '@/components/Bits'
import { SaveButton } from '@/components/SaveButton'
import { ScanProgressBanner } from '@/components/ScanProgressBanner'
import { saveToShortlistAction } from '@/app/actions'
import { money, num } from '@/lib/format'

export const dynamic = 'force-dynamic'

export default async function ScanPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId: runIdRaw } = await params
  const runId = Number(runIdRaw)
  if (!Number.isFinite(runId)) notFound()

  const database = db()
  const found = await getRun(database, runId)
  if (!found) notFound()
  const { run, locality } = found

  // Sequential. See the note on /markets: concurrent queries against the transaction pooler
  // are what made every database-backed page hang for 300 seconds. No fallback here -- both
  // of these are the page's subject, so a failure should surface as an error, fast.
  const rows = await getRunResults(database, runId)
  const spend = await reconcileSpend(database, runId)

  const inProgress = run.status === 'pending' || run.status === 'claimed' || run.status === 'running'

  return (
    <div className="wrap">
      {/*
        A fixture run announces itself HERE, from the run's own persisted flag --
        not from the current environment. A synthetic market that stops being
        labelled the moment an env var changes is indistinguishable from a real
        one, in a tool people buy domains from.
      */}
      {run.usedFixtures && (
        <div className="fixture-banner" style={{ margin: '0 -20px 20px', borderRadius: 6 }}>
          ⚠ FIXTURE DATA — every SERP below is synthetic, generated deterministically from the
          keyword. These markets do not exist. Nothing here was measured against Google.
        </div>
      )}

      <h2>
        {locality.name}, {locality.stateCode}{' '}
        <span className="pill" style={{ fontSize: 12, verticalAlign: 'middle' }}>
          {locality.kind}
        </span>
      </h2>
      <p className="sub">
        pop {num(locality.population)} · provider location {locality.providerLocationCode} (
        {locality.providerLocationName}) · matched via{' '}
        <code>{locality.resolutionMethod ?? 'n/a'}</code>
      </p>

      <div className="flex" style={{ marginBottom: 18 }}>
        <span className={`badge ${run.status === 'done' ? 'go' : inProgress ? 'warn' : 'stop'}`}>
          {run.status}
        </span>
        <span className="dim stat">
          spend {formatMicrosUsd(run.spendMicros, { precision: 4 })} of{' '}
          {formatMicrosUsd(run.budgetCapMicros, { precision: 2 })} cap
        </span>
        {!spend.matches && (
          <span className="badge stop" title="Run total does not equal the sum of its ledger rows">
            ledger mismatch
          </span>
        )}
        <span className="faint" style={{ fontSize: 12 }}>
          {spend.lineItems} ledger entries
        </span>
      </div>

      {run.error && <div className="stopbox">{run.error}</div>}

      <ScanProgressBanner status={run.status} />

      {rows.length === 0 ? (
        <div className="empty">No niches scored yet.</div>
      ) : (
        <>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Niche</th>
                  <th>
                    Difficulty <span className="faint">/ coverage</span>
                  </th>
                  <th>Verdict</th>
                  <th className="num">Searches</th>
                  <th className="num">Rent /mo</th>
                  <th className="num">Slots open</th>
                  <th>EMD</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.scanTargetId}>
                    <td>
                      <a href={`/scout/scans/${runId}/${r.scanTargetId}`}>{r.nicheLabel}</a>
                      <div className="faint mono" style={{ fontSize: 11 }}>
                        {r.keyword}
                      </div>
                    </td>
                    <td>
                      <DifficultyCell difficulty={r.difficulty} weightCovered={r.weightCovered} />
                    </td>
                    <td>
                      <VerdictBadge verdict={r.verdict} />
                      {r.blockerCount > 0 && (
                        <span className="faint" style={{ fontSize: 11, marginLeft: 6 }}>
                          {r.blockerCount} blocker{r.blockerCount === 1 ? '' : 's'}
                        </span>
                      )}
                    </td>
                    {/* "est" on every volume figure, at the point of display. */}
                    <td className="num" title="Estimated from population, not measured">
                      <Nullable value={r.volumeEst} />
                      {r.volumeEst !== null && (
                        <span className="faint" title="Population × niche prior, not Google Ads">
                          {' '}
                          modelled
                        </span>
                      )}
                    </td>
                    <td className="num" title="Modelled from estimated volume and niche priors">
                      {r.rentMicros === null ? (
                        <span className="null">—</span>
                      ) : (
                        money(r.rentMicros.toString())
                      )}
                    </td>
                    <td className="num" title={`${r.platformHeldSlots} held by platforms/directories`}>
                      {r.slotsOpen}
                      <span className="faint">/10</span>
                    </td>
                    <td>
                      <div className="mono" style={{ fontSize: 11.5 }}>
                        {r.emdDomain}
                      </div>
                      <AvailabilityBadge available={r.emdAvailable} />
                      {!r.linkDataMeasured && (
                        <span
                          className="badge unknown"
                          style={{ marginLeft: 4 }}
                          title="No referring-domain data was measured for any real defender. A SERP we could not measure is not a soft SERP — this blocks the 30-day band."
                        >
                          no link data
                        </span>
                      )}
                    </td>
                    <td>
                      <SaveButton
                        scanTargetId={r.scanTargetId}
                        runId={runId}
                        saved={r.saved}
                        onSave={saveToShortlistAction}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="sub" style={{ marginTop: 14 }}>
            Sorted easiest SERP first — competition only. Difficulty, verdict, demand and rent are{' '}
            <strong>four independent numbers</strong> and are deliberately not blended: a brutal SERP
            worth $2,400/mo and an empty one worth nothing are different facts, and one combined
            score would destroy your ability to filter for either. Rows that could not be scored show{' '}
            <span className="null">—</span> and sort last, never first.
          </p>
        </>
      )}
    </div>
  )
}
