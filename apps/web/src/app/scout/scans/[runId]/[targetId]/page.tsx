import { notFound } from 'next/navigation'
import {
  COMPONENT_WEIGHTS,
  refDomainCount,
  type Blocker,
  type ClassifiedResult,
  type ComponentName,
  type Gate,
  type ScoreComponent,
} from '@rnr/core'
import { db, getScanTargetDetail } from '@rnr/data'
import { AvailabilityBadge, DifficultyCell, VerdictBadge } from '@/components/Bits'
import { NULL_DISPLAY, money, num, percent, verdictStyle } from '@/lib/format'

export const dynamic = 'force-dynamic'

const COMPONENT_LABELS: Record<ComponentName, string> = {
  authorityWall: 'Authority wall',
  slotDefence: 'Slot defence',
  intentLock: 'Intent lock',
  linkQuality: 'Link quality',
}

const COMPONENT_MEANING: Record<ComponentName, string> = {
  authorityWall:
    'CTR-weighted link strength of the defenders. Platform domains contribute a fixed low constant (0.12) rather than their real profile — a Yelp page is not defending this query.',
  slotDefence:
    'What KIND of result holds each slot. The component no commercial difficulty metric models, and the one that decides a local build.',
  intentLock: 'Has anyone built a city+niche-dedicated asset here, and how highly does it rank?',
  linkQuality:
    'Dofollow ratio and spam score of the top-5 non-platform defenders, scaled by how much link mass they actually have.',
}

export default async function DetailPage({
  params,
}: {
  params: Promise<{ runId: string; targetId: string }>
}) {
  const { runId, targetId: targetIdRaw } = await params
  const targetId = Number(targetIdRaw)
  if (!Number.isFinite(targetId)) notFound()

  const found = await getScanTargetDetail(db(), targetId)
  if (!found) notFound()
  const { target, niche, locality, run } = found

  const components = target.components as Record<ComponentName, ScoreComponent>
  const blockers = (target.blockers ?? []) as Blocker[]
  const gates = (target.gates ?? []) as Gate[]
  const results = (target.results ?? []) as ClassifiedResult[]
  const mapPack = target.mapPack as { hasLocalPack?: boolean; entryCount?: number } | null
  const vs = verdictStyle(target.verdict)

  return (
    <div className="wrap">
      {run.usedFixtures && (
        <div className="fixture-banner" style={{ margin: '0 -20px 20px', borderRadius: 6 }}>
          ⚠ FIXTURE DATA — this SERP is synthetic. It does not exist.
        </div>
      )}

      <p className="sub" style={{ marginTop: 16 }}>
        <a href={`/scout/scans/${runId}`}>
          ← {locality.name}, {locality.stateCode}
        </a>
      </p>
      <h2>{niche.label}</h2>
      <p className="sub mono">{target.keyword}</p>

      {/* --- Headline ----------------------------------------------------- */}
      <div className="card">
        <div className="flex" style={{ marginBottom: 12 }}>
          <div style={{ minWidth: 200 }}>
            <div className="faint" style={{ fontSize: 11, textTransform: 'uppercase' }}>
              SERP difficulty
            </div>
            <DifficultyCell
              difficulty={target.difficulty}
              weightCovered={target.weightCovered}
            />
          </div>
          <div>
            <div className="faint" style={{ fontSize: 11, textTransform: 'uppercase' }}>
              EMD verdict
            </div>
            <VerdictBadge verdict={target.verdict} />
          </div>
          <div className="spacer" />
          <div style={{ textAlign: 'right' }}>
            <div className="faint" style={{ fontSize: 11, textTransform: 'uppercase' }}>
              Demand (estimated)
            </div>
            <div className="stat">
              {target.volumeEst === null
                ? NULL_DISPLAY
                : `${num(target.volumeEst)}/mo modelled (pop × prior, not Google Ads)`}
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div className="faint" style={{ fontSize: 11, textTransform: 'uppercase' }}>
              Rent (modelled)
            </div>
            <div className="stat">
              {target.rentMicros === null ? NULL_DISPLAY : `${money(target.rentMicros.toString())}/mo`}
            </div>
          </div>
        </div>
        <p className="dim" style={{ margin: 0, fontSize: 12.5 }}>
          {vs.meaning}
        </p>
      </div>

      {/* --- Components, INCLUDING the unmeasured ones --------------------- */}
      <h3>Scoring components</h3>
      <p className="sub">
        Scored on {percent(target.weightCovered)} of total signal weight. Unmeasured components are{' '}
        <strong>omitted and the weights renormalised</strong> — never counted as zero. Zero referring
        domains is the strongest &ldquo;beatable&rdquo; signal there is, so rendering a missing
        measurement as 0 would turn every unknown domain into a jackpot.
      </p>
      <div className="card">
        {(Object.keys(COMPONENT_WEIGHTS) as ComponentName[]).map((name) => {
          const c = components[name]
          if (!c) return null
          return (
            <div
              key={name}
              className={`component-row ${c.measured ? '' : 'unmeasured'}`}
              style={{ gridTemplateColumns: '160px 90px 1fr' }}
            >
              <div>
                <strong>{COMPONENT_LABELS[name]}</strong>
                <div className="faint mono" style={{ fontSize: 11 }}>
                  weight {c.weight.toFixed(2)}
                </div>
              </div>
              <div className="mono">
                {c.measured && c.value !== null ? (
                  c.value.toFixed(3)
                ) : (
                  <span className="badge unknown">not measured</span>
                )}
              </div>
              <div className="dim" style={{ fontSize: 12.5 }}>
                {COMPONENT_MEANING[name]}
                {c.note && (
                  <div className="component-note" style={{ marginTop: 4, paddingLeft: 0 }}>
                    ⓘ {c.note}
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* --- Verdict blockers, each NAMED --------------------------------- */}
      <h3>Why this verdict</h3>
      {blockers.length === 0 ? (
        <div className="card">
          <p style={{ margin: 0 }}>
            No blockers. Every 30-day gate passed, including a <strong>confirmed-available</strong>{' '}
            domain and <strong>actually-measured</strong> link data.
          </p>
        </div>
      ) : (
        <div className="card">
          {blockers.map((b, i) => (
            <div className="blocker" key={`${b.code}-${i}`}>
              <div>{b.message}</div>
              <code>
                {b.code}
                {b.threshold ? ` · ${b.threshold}` : ''}
              </code>
            </div>
          ))}
        </div>
      )}

      {/* --- All seven gates ---------------------------------------------- */}
      <h3>The 30-day gates</h3>
      <p className="sub">
        All must pass. Note the deliberate asymmetry: elsewhere an unmeasured signal is dropped
        leniently, but here <strong>missing evidence fails the gate</strong>. This is the only band
        that says &ldquo;go buy this domain&rdquo;, so it has to be earned by evidence rather than
        granted by the absence of contrary evidence.
      </p>
      <div className="card">
        {gates.map((g) => (
          <div className={`gate ${g.passed === true ? 'pass' : 'fail'}`} key={g.code}>
            <span className="gate-mark">{g.passed === true ? '✓' : '✗'}</span>
            <span>
              <strong>{g.label}</strong>
              <div className="dim" style={{ fontSize: 12.5 }}>
                {g.detail}
              </div>
            </span>
          </div>
        ))}
      </div>

      {/* --- The domain --------------------------------------------------- */}
      <h3>Exact-match domain</h3>
      <div className="card">
        <dl className="kv">
          <dt>Domain</dt>
          <dd className="mono">{target.emdDomain}</dd>
          <dt>Availability</dt>
          <dd>
            <AvailabilityBadge
              available={target.emdAvailable}
              detail={target.emdAvailabilityDetail}
            />{' '}
            <span className="faint" style={{ fontSize: 12 }}>
              via {target.emdAvailabilityMethod ?? 'n/a'}
            </span>
          </dd>
          <dt>Detail</dt>
          <dd className="dim" style={{ fontSize: 12.5 }}>
            {target.emdAvailabilityDetail ?? NULL_DISPLAY}
          </dd>
          <dt>Local pack</dt>
          <dd>
            {mapPack?.hasLocalPack ? (
              <>
                present · {mapPack.entryCount} entries
              </>
            ) : (
              <span className="badge stop">absent</span>
            )}
          </dd>
        </dl>
      </div>

      {/* --- THE ACTUAL TEN RESULTS -------------------------------------- */}
      <h3>The actual results</h3>
      <p className="sub">
        This is what makes the score auditable instead of a black box. Platform rows show{' '}
        <code>0.12</code> as their contributed authority regardless of their real link profile — see
        the note below the table.
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th className="num">#</th>
              <th>Domain</th>
              <th>Class</th>
              <th>Page type</th>
              <th className="num">Ref. main domains</th>
              <th className="num">DA rank</th>
              <th className="num">Dofollow</th>
              <th className="num">Spam</th>
              <th className="num">Dedication</th>
            </tr>
          </thead>
          <tbody>
            {results.map((r) => {
              const a = r.authority
              const rd = refDomainCount(a)
              const dofollow =
                a && a.referringDomains !== null && a.referringDomains > 0 && a.referringDomainsNofollow !== null
                  ? 1 - a.referringDomainsNofollow / a.referringDomains
                  : null
              return (
                <tr key={`${r.item.position}-${r.item.domain}`}>
                  <td className="num">{r.item.position}</td>
                  <td>
                    <span className="mono" style={{ fontSize: 12 }}>
                      {r.item.domain}
                    </span>
                    {r.isExactMatch && (
                      <span className="badge stop" style={{ marginLeft: 5 }}>
                        exact match
                      </span>
                    )}
                    <div className="faint" style={{ fontSize: 11, maxWidth: 320 }}>
                      {r.item.title.slice(0, 90)}
                    </div>
                  </td>
                  <td>
                    <span className="pill">{r.domainClass}</span>
                  </td>
                  <td className="dim">{r.pageType}</td>
                  <td className="num">
                    {r.isPlatform ? (
                      <span
                        className="faint"
                        title="Platform: contributes the fixed 0.12 authority constant, not its real link profile"
                      >
                        n/a
                      </span>
                    ) : rd === null ? (
                      <span className="null">{NULL_DISPLAY}</span>
                    ) : (
                      num(rd)
                    )}
                  </td>
                  <td className="num">
                    {a?.rank === null || a?.rank === undefined ? (
                      <span className="null">{NULL_DISPLAY}</span>
                    ) : (
                      a.rank
                    )}
                  </td>
                  <td className="num">
                    {dofollow === null ? (
                      <span className="null">{NULL_DISPLAY}</span>
                    ) : (
                      percent(dofollow)
                    )}
                  </td>
                  <td className="num">
                    {a?.spamScore === null || a?.spamScore === undefined ? (
                      <span className="null">{NULL_DISPLAY}</span>
                    ) : (
                      a.spamScore
                    )}
                  </td>
                  <td className="num">{r.dedication.toFixed(2)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <p className="sub" style={{ marginTop: 12 }}>
        <strong>Why platforms show n/a:</strong> Yelp has roughly 4 million referring domains. Fed
        through the same curve as a local plumber it scores ~1.0 and single-handedly walls off the
        page — so every directory-stuffed SERP, which is to say every genuinely winnable market,
        would read as unwinnable. A directory page ranks on generic domain power applied to a
        template; nobody there is defending this query. It contributes a fixed <code>0.12</code>{' '}
        instead. Rows showing <span className="null">{NULL_DISPLAY}</span> were{' '}
        <strong>not measured</strong> and were omitted from the score, not counted as zero.
      </p>
    </div>
  )
}
