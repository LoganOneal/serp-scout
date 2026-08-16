import type { Fleet } from '@rnr/data'

/**
 * Every agent, who uses it, and what reaches it.
 *
 * The table is the easy part. The three lists underneath it are the point: they are the
 * states where this database and Retell disagree, and none of them is visible anywhere
 * else. A site can claim an agent no number reaches and look completely configured.
 */
export function AgentFleet({ fleet }: { fleet: Fleet }) {
  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Fleet</h3>
      <p className="sub" style={{ marginTop: 0 }}>
        One row per agent — versions collapsed, since <code>list-agents</code> returns one row
        per version and a picker of five agents would otherwise read as nine.
      </p>

      {fleet.degraded && (
        <div className="warnbox">
          <strong>Showing stored snapshots only.</strong> Retell could not be read:{' '}
          {fleet.degradedReason}. Sites and numbers cannot be cross-checked until it can.
        </div>
      )}

      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Agent</th>
              <th>Engine</th>
              <th>Version</th>
              <th>Audit</th>
              <th>Sites</th>
              <th>Numbers</th>
            </tr>
          </thead>
          <tbody>
            {fleet.rows.map((r) => {
              const failing = r.checks?.filter((c) => c.status === 'fail') ?? []
              return (
                <tr key={r.agent.agentId}>
                  <td>
                    {r.agent.agentName ?? '—'}
                    <div className="mono faint" style={{ fontSize: 11 }}>
                      {r.agent.agentId}
                    </div>
                  </td>
                  <td className="mono" style={{ fontSize: 11.5 }}>
                    {r.agent.responseEngineType}
                  </td>
                  <td className="mono" style={{ fontSize: 11.5 }}>
                    v{r.agent.version ?? '?'}
                    {/* Which version answers depends on whether the number pins one, so
                        both are shown rather than the newest alone. */}
                    {r.agent.publishedVersion === null ? (
                      <span className="badge warn" style={{ marginLeft: 6 }}>
                        never published
                      </span>
                    ) : r.agent.publishedVersion !== r.agent.version ? (
                      <span className="faint"> · published v{r.agent.publishedVersion}</span>
                    ) : null}
                  </td>
                  <td>
                    {r.checks === null ? (
                      <span className="badge unknown" title="Never pulled into this database.">
                        never read
                      </span>
                    ) : failing.length === 0 ? (
                      <span className="badge go">pass</span>
                    ) : (
                      <span className="badge stop" title={failing.map((c) => c.detail).join(' ')}>
                        {failing.length} failing
                      </span>
                    )}
                  </td>
                  <td>
                    {r.sites.length === 0 ? (
                      <span className="faint">—</span>
                    ) : (
                      r.sites.map((s) => (
                        <div key={s.siteId} style={{ fontSize: 12.5 }}>
                          <a href={`/sites/${s.siteId}`}>
                            {s.displayName ?? s.domain ?? `Site #${s.siteId}`}
                          </a>{' '}
                          <span className="faint">
                            {s.localityName} {s.stateCode} {s.nicheLabel}
                          </span>
                        </div>
                      ))
                    )}
                  </td>
                  <td className="mono" style={{ fontSize: 11.5 }}>
                    {r.numbers.length === 0 ? (
                      <span className="faint">—</span>
                    ) : (
                      r.numbers.map((n) => (
                        <div key={n.phoneNumber}>
                          {n.phoneNumber}
                          {n.inboundAgentVersion !== null && (
                            <span className="faint"> pinned {String(n.inboundAgentVersion)}</span>
                          )}
                        </div>
                      ))
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* --- The disagreements ------------------------------------------- */}

      {fleet.sitesWithNoNumber.length > 0 && (
        <div className="warnbox" style={{ marginTop: 14 }}>
          <strong>Bound to an agent, but no number reaches it.</strong> These look configured
          on their own page and cannot receive a call.
          <ul style={{ marginBottom: 0 }}>
            {fleet.sitesWithNoNumber.map((s) => (
              <li key={s.siteId}>
                <a href={`/sites/${s.siteId}`}>{s.displayName ?? s.domain ?? `Site #${s.siteId}`}</a>
                {s.trackingNumber === null
                  ? ' — no number recorded'
                  : s.retellNumberImportedAt === null
                    ? ` — ${s.trackingNumber} recorded but never imported into Retell`
                    : ` — ${s.trackingNumber} imported, but points at another agent`}
              </li>
            ))}
          </ul>
        </div>
      )}

      {fleet.orphanNumbers.length > 0 && (
        <div className="warnbox" style={{ marginTop: 14 }}>
          <strong>Numbers pointing at an agent this account does not list.</strong> Calls to
          these resolve to no site, so every lead lands unattributed.
          <ul style={{ marginBottom: 0 }}>
            {fleet.orphanNumbers.map((n) => (
              <li key={n.phoneNumber} className="mono">
                {n.phoneNumber} → {n.inboundAgentIds.join(', ') || 'no agent'}
              </li>
            ))}
          </ul>
        </div>
      )}

      {fleet.sitesWithUnknownAgent.length > 0 && (
        <div className="warnbox" style={{ marginTop: 14 }}>
          <strong>Sites naming an agent Retell does not have.</strong> A deleted agent, or an
          id typed by hand.
          <ul style={{ marginBottom: 0 }}>
            {fleet.sitesWithUnknownAgent.map((s) => (
              <li key={s.siteId}>
                <a href={`/sites/${s.siteId}`}>{s.displayName ?? s.domain ?? `Site #${s.siteId}`}</a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
