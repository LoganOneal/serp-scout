import { MIN_OUTCOMES_FOR_RATE, realisedVsModelled, type LeadDisposition, type Verdict } from '@rnr/core'
import {
  countInvalidSignatures,
  db,
  getSiteDetail,
  getSiteStats,
  getVoiceQueueHealth,
  listCallsForSite,
  listLeadsForSite,
  loadWizardState,
  getSiteRealisedValue,
  listOutcomesForSite,
  promptIsCurrent,
  queryOr,
  recordingExists,
} from '@rnr/data'
import { CallRow, type CallRowData } from '@/components/CallRow'
import { ConnectionPanel } from '@/components/ConnectionPanel'
import { OutcomeCell } from '@/components/OutcomeCell'
import { SwitchAgentPanel } from '@/components/SwitchAgentPanel'
import { SetupWizard } from '@/components/SetupWizard'
import {
  adoptAgentAction,
  applyProvisioningAction,
  applySiteIntegrationAction,
  createRetellAgentAction,
  inspectProvisioningAction,
  listLiveAgentsAction,
  preflightSwitchAction,
  recheckAgentAction,
  recordLeadOutcomeAction,
  refetchRecordingAction,
  saveTelephonyAction,
  sendTestEventAction,
  switchAgentAction,
  switchBackAction,
} from '@/app/sites/actions'
import { NULL_DISPLAY, money, num, percent, verdictStyle } from '@/lib/format'

/**
 * The CRM half of a cell: calls, leads, outcomes, and the Retell/Twilio wiring.
 *
 * Extracted from the old /sites/[siteId] page so the cell page can compose it beneath the
 * research half rather than duplicating five hundred lines. A server component, so every
 * query below still runs on the server exactly as before.
 */
export async function SiteDashboard({ siteId }: { siteId: number }) {
  const database = db()
  const detail = await getSiteDetail(database, siteId)
  if (detail === null) return null

  /**
   * ==================== SEQUENTIAL, AND EACH WITH A DEADLINE ====================
   * This was the widest fan-out in the app: five concurrent queries, then two more, then one
   * storage check per call row. Concurrent queries against the transaction pooler are what
   * took production down -- zero bytes returned, killed at 300 seconds, nothing logged.
   *
   * Sequential is a few hundred milliseconds slower and cannot hang. Each query keeps the
   * fallback it already had, so a query that misses its deadline renders as NOT MEASURED
   * rather than as zero calls or an empty lead list -- which on this page would read as
   * "this market produced nothing".
   * ============================================================================
   */
  const stats = await queryOr('getSiteStats', () => getSiteStats(database, siteId), null)
  const callRows = await queryOr('listCallsForSite', () => listCallsForSite(database, siteId), [])
  const leadRows = await queryOr('listLeadsForSite', () => listLeadsForSite(database, siteId), [])
  const queue = await queryOr('getVoiceQueueHealth', () => getVoiceQueueHealth(database), null)
  const invalidSigs = await queryOr('countInvalidSignatures', () => countInvalidSignatures(database), 0)
  const outcomes = await queryOr(
    'listOutcomesForSite',
    () => listOutcomesForSite(database, siteId),
    new Map(),
  )
  const realised = await queryOr(
    'getSiteRealisedValue',
    () => getSiteRealisedValue(database, siteId),
    null,
  )
  // Derived from stored state on every render, so it cannot claim a step is done that
  // has since been undone. Null only if the site vanished between queries.
  const wizard = await queryOr('loadWizardState', () => loadWizardState(database, siteId), null)

  const { site } = detail
  const base = (process.env['PUBLIC_BASE_URL'] ?? 'https://YOUR-TUNNEL-HERE').replace(/\/$/, '')
  const notConnected = site.firstWebhookAt === null

  /**
   * ==================== TRUST PATH+BYTES; VERIFY SOFTLY ====================
   * Previously we required a live HEAD/stat to succeed before showing the player.
   * When that check timed out (queryOr 8s) or blob head flaked, every call rendered
   * "recording missing" even though `/api/recordings/:id` would stream fine -- which
   * is exactly the false negative the user just hit (call stored 7.7MB WAV, UI said no).
   *
   * Rule now:
   *   - recording_path set + recording_bytes > 0  → show player (API is source of truth)
   *   - soft exists check may confirm or warn; timeout does NOT hide the player
   *   - audio onError in CallRow handles truly missing bytes without a silent 0:00
   * =======================================================================
   */
  let onDisk: Array<boolean | null> = callRows.map(() => null)
  try {
    onDisk = await Promise.all(
      callRows.map(async ({ call }) => {
        if (call.recordingPath === null) return false
        try {
          return await recordingExists(call.recordingPath)
        } catch {
          return null // unknown — do not treat as missing
        }
      }),
    )
  } catch {
    onDisk = callRows.map(() => null)
  }

  const calls: CallRowData[] = callRows.map(({ call, lead }, i) => {
    const claimed =
      call.recordingPath !== null &&
      call.recordingBytes !== null &&
      call.recordingBytes > 0
    const exists = onDisk[i]
    // Show player if DB claims bytes, unless the store explicitly said absent.
    const hasRecording = claimed ? exists !== false : exists === true
    const missingReason =
      call.recordingPath !== null && exists === false
        ? 'Stored path, but audio is not in object storage. Check BLOB_READ_WRITE_TOKEN / RECORDINGS_DIR, then retry.'
        : call.recordingMissingReason

    return {
      id: call.id,
      startedAt: call.startedAt?.toISOString() ?? null,
      fromNumber: call.fromNumber,
      durationMs: call.durationMs,
      disconnectionReason: call.disconnectionReason,
      userSentiment: call.userSentiment,
      ingestState: call.ingestState,
      hasRecording,
      recordingMissingReason: missingReason,
      transcript: call.transcript,
      latencyE2eP50Ms: call.latencyE2eP50Ms,
      latencyE2eP95Ms: call.latencyE2eP95Ms,
      lead:
        lead === null
          ? null
          : {
              id: lead.id,
              name: lead.name,
              phone: lead.phone,
              isEmergency: lead.isEmergency,
              qualified: lead.qualified,
            },
    }
  })

  return (
    <>
      {/*
        THE MOST IMPORTANT ELEMENT ON THE PAGE.

        Without it, a number whose webhook URL was never configured shows `0 calls`
        -- identical to a site nobody has called -- while real customers ring
        through and vanish. This is the repo's founding bug (a button that silently
        did nothing) in a new costume, so it gets a permanent banner rather than a
        subtle badge.
      */}
      {notConnected && (
        <div className="stopbox">
          <strong>Retell has never contacted this site.</strong>{' '}
          {site.trackingNumber === null ? (
            <>
              No tracking number is attached yet, so there is nothing to receive. Run{' '}
              <code>pnpm sites:provision {site.domain} --number +1…</code> when you are ready.
            </>
          ) : (
            <>
              A number is attached, so <strong>calls may be arriving and going unrecorded.</strong>{' '}
              Check the inbound webhook URL below, then use <em>Send test event</em> to prove the
              path end to end. Every count on this page is an em dash until a webhook arrives —
              they are not zeros.
            </>
          )}
        </div>
      )}

      {/* --- KPI row ------------------------------------------------------- */}
      <div className="stats">
        <Stat label="Calls 30d" value={notConnected ? null : stats?.calls ?? null} />
        <Stat
          label="Answered ≥10s"
          value={notConnected ? null : stats?.answered ?? null}
          hint="Calls that lasted long enough for a conversation to start."
        />
        <Stat
          label="Abandoned <10s"
          value={notConnected ? null : stats?.abandonedUnder10s ?? null}
          hint="The greeting-quality signal. A rising number means the open is too slow or too obviously synthetic."
          tone={
            stats && stats.calls > 0 && stats.abandonedUnder10s / stats.calls > 0.05
              ? 'bad'
              : undefined
          }
        />
        <Stat label="Leads 30d" value={notConnected ? null : stats?.leads ?? null} />
        <Stat
          label="Qualified"
          value={notConnected ? null : stats?.qualifiedLeads ?? null}
          hint="Contact plus a problem, in area, and the caller can authorise work."
        />
        <Stat
          label="Emergencies"
          value={notConnected ? null : (stats?.emergencies ?? null)}
          hint="Em dash means urgency was never established on any lead — which is not the same as none."
          tone={stats?.emergencies ? 'bad' : undefined}
        />
        <Stat
          label="Cost / lead"
          text={
            stats?.costPerLeadMicros == null
              ? null
              : money(stats.costPerLeadMicros, { decimals: 2 })
          }
          hint="Undefined with no leads — not $0.00, which would read as the cheapest site you own."
        />
        <Stat
          label="e2e p50"
          text={stats?.latencyP50Ms == null ? null : `${num(stats.latencyP50Ms)}ms`}
          hint="Median turn latency, as Retell measured it."
        />
        <Stat
          label="e2e p95"
          text={stats?.latencyP95Ms == null ? null : `${num(stats.latencyP95Ms)}ms`}
          hint="The tail. This is what callers notice; target under 1,200ms."
          tone={stats?.latencyP95Ms != null && stats.latencyP95Ms > 1200 ? 'bad' : undefined}
        />
      </div>

      {/* --- Predicted vs actual ------------------------------------------ */}
      {detail.prediction !== null && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Predicted vs actual</h3>
          <p className="sub" style={{ marginTop: 0 }}>
            What the model said <strong>when you saved this cell</strong>, against what the phone
            actually did. This is the comparison the research side could never make: ranking was
            only ever a proxy, and calls are the outcome.
          </p>
          <div className="kv">
            <span>Verdict at save</span>
            <span>
              <span className={`badge ${verdictStyle(detail.prediction.verdictAtSave as Verdict).tone}`}>
                {verdictStyle(detail.prediction.verdictAtSave as Verdict).label}
              </span>
            </span>
            <span>Difficulty at save</span>
            <span>
              {detail.prediction.difficultyAtSave === null ? (
                <span className="null">{NULL_DISPLAY}</span>
              ) : (
                detail.prediction.difficultyAtSave
              )}{' '}
              <span className="faint">
                (scored on {percent(detail.prediction.weightCoveredAtSave)} of signals)
              </span>
            </span>
            <span>Modelled rent</span>
            <span>
              {detail.prediction.modelledRentMicros === null ? (
                <span
                  className="null"
                  title="The scan could not model a rent for this cell. Not zero — there is no prediction here to falsify."
                >
                  {NULL_DISPLAY}
                </span>
              ) : (
                <>
                  {money(detail.prediction.modelledRentMicros, { decimals: 0 })}
                  <span className="faint" style={{ fontSize: 11 }}> /mo, modelled</span>
                </>
              )}
            </span>

            <span>Realised vs modelled</span>
            <span>
              {(() => {
                const cmp = realisedVsModelled({
                  modelledRentMicros:
                    detail.prediction.modelledRentMicros === null
                      ? null
                      : BigInt(detail.prediction.modelledRentMicros),
                  realisedMonthlyValueMicros: realised?.monthlyValueMicros ?? null,
                })
                if (cmp.ratio === null) {
                  return (
                    <span className="null" title={cmp.note}>
                      {NULL_DISPLAY}
                    </span>
                  )
                }
                return (
                  <>
                    <strong>{cmp.ratio.toFixed(2)}×</strong>{' '}
                    <span className="faint" style={{ fontSize: 11 }}>
                      {cmp.note}
                    </span>
                  </>
                )
              })()}
            </span>

            <span>EMD considered</span>
            <span className="mono">{detail.prediction.emdDomain}</span>
            <span>Actual leads 30d</span>
            <span>{notConnected ? <span className="null">{NULL_DISPLAY}</span> : num(stats?.leads ?? 0)}</span>
            <span>Actual cost / lead</span>
            <span>
              {stats?.costPerLeadMicros == null ? (
                <span className="null">{NULL_DISPLAY}</span>
              ) : (
                money(stats.costPerLeadMicros, { decimals: 2 })
              )}
            </span>

          </div>

          <p className="faint" style={{ fontSize: 12, marginBottom: 0 }}>
            One site is an anecdote. These feed the calibration report once enough sites have
            run — the same n-based caution as the verdict bands. Realised revenue is in the
            <strong> Lead outcomes</strong> card below.
          </p>
        </div>
      )}


      {/* --- Lead outcomes ------------------------------------------------- */}
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Lead outcomes</h3>
        <p className="sub" style={{ marginTop: 0 }}>
          The only place a real dollar figure enters this system. Modelled rent multiplies an
          estimated search volume by a prior; a booked job with a value is the one thing that
          can say whether that prior is right.
        </p>

        <div className="stats">
          <Stat
            label="Leads"
            value={realised?.leads ?? null}
            hint="Every lead in the last 30 days, whether or not anyone followed up."
          />
          <Stat
            label="Followed up"
            text={
              realised == null || realised.coverage === null
                ? null
                : `${realised.recorded} of ${realised.leads}`
            }
            hint="Coverage. A close rate over 3 of 40 leads is not the same claim as over 40 of 40."
          />
          <Stat
            label="Close rate"
            text={realised?.rate == null ? null : percent(realised.rate)}
            hint={`Booked ÷ real opportunities, spam and duplicates excluded. Em dash below ${MIN_OUTCOMES_FOR_RATE} recorded outcomes — a rate off two data points is not a rate.`}
          />
          <Stat
            label="Booked"
            value={realised?.won ?? null}
            hint="A quote is not a sale, so only 'booked' counts."
          />
          <Stat
            label="Realised / month"
            text={
              realised?.monthlyValueMicros == null
                ? null
                : money(realised.monthlyValueMicros.toString(), { decimals: 0 })
            }
            hint="Em dash means no outcomes recorded — unknown, which is not $0. A zero here would read as a failed prediction rather than an unmeasured one."
          />
          <Stat
            label="Value / opportunity"
            text={
              realised?.valuePerOpportunityMicros == null
                ? null
                : money(realised.valuePerOpportunityMicros.toString(), { decimals: 0 })
            }
            hint="What one real lead has actually been worth here."
          />
        </div>

        {realised != null && realised.wonWithoutValue > 0 && (
          <div className="warnbox">
            <strong>
              {realised.wonWithoutValue} booked job
              {realised.wonWithoutValue === 1 ? '' : 's'}{' '}
              {realised.wonWithoutValue === 1 ? 'has' : 'have'} no value recorded.
            </strong>{' '}
            Realised revenue above is therefore a <strong>floor</strong>, not a total — a booked
            job with an unknown value is counted as won but contributes nothing to the sum,
            because treating it as $0 would understate the site for a bookkeeping reason.
          </div>
        )}

        {realised != null && realised.recorded === 0 && realised.leads > 0 && (
          <p className="sub" style={{ marginBottom: 0 }}>
            Nothing followed up yet. Set a disposition on the leads below — leaving one blank
            keeps it out of the close rate entirely, which is deliberate: an untouched lead is
            not a lost one.
          </p>
        )}
      </div>

      {/* --- Calls -------------------------------------------------------- */}
      <h3>Calls</h3>
      {calls.length === 0 ? (
        <div className="empty">
          {notConnected
            ? 'No webhook has ever arrived, so this is not "no calls" — it is "no data". Wire the inbound URL below.'
            : 'No calls recorded yet. This IS a measured zero: Retell has contacted this site, so the path works.'}
        </div>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>From</th>
                <th className="num">Length</th>
                <th>Outcome</th>
                <th>Caller</th>
                <th className="num">p95</th>
                <th>Recording</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {calls.map((c) => (
                <CallRow key={c.id} call={c} onRefetch={refetchRecordingAction} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* --- Leads -------------------------------------------------------- */}
      <h3>Leads</h3>
      {leadRows.length === 0 ? (
        <div className="empty">No leads yet.</div>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Phone</th>
                <th>Address</th>
                <th>Problem</th>
                <th>System</th>
                <th>Urgency</th>
                <th>In area</th>
                <th>Owner</th>
                <th>Outcome</th>
                <th>Captured</th>
              </tr>
            </thead>
            <tbody>
              {leadRows.map((l) => (
                <tr key={l.id} className={l.isEmergency === true ? 'row-emergency' : undefined}>
                  <td>{l.name ?? <span className="null">{NULL_DISPLAY}</span>}</td>
                  <td className="mono" style={{ fontSize: 11.5 }}>
                    {l.phone ?? <span className="null">{NULL_DISPLAY}</span>}
                  </td>
                  <td style={{ fontSize: 12 }}>
                    {[l.addressLine, l.city, l.zip].filter(Boolean).join(', ') || (
                      <span className="null">{NULL_DISPLAY}</span>
                    )}
                  </td>
                  <td style={{ fontSize: 12, maxWidth: 260 }}>
                    {l.problem ?? <span className="null">{NULL_DISPLAY}</span>}
                  </td>
                  <td style={{ fontSize: 12 }}>
                    {l.systemType?.replace(/_/g, ' ') ?? <span className="null">{NULL_DISPLAY}</span>}
                    {l.systemAgeYears !== null && (
                      <span className="faint"> ~{l.systemAgeYears}y</span>
                    )}
                  </td>
                  {/* Three states each, and none of the nulls may read as a "no". */}
                  <td>
                    <TriState
                      value={l.isEmergency}
                      trueLabel="EMERGENCY"
                      falseLabel="routine"
                      nullLabel="never asked"
                      nullTitle="The agent did not establish urgency. NOT the same as routine — this is what a no-heat call in January looks like when the prompt drifts."
                      trueTone="stop"
                    />
                  </td>
                  <td>
                    <TriState
                      value={l.inServiceArea}
                      trueLabel="yes"
                      falseLabel="OUTSIDE"
                      nullLabel="unchecked"
                      nullTitle="No zip captured, or no service area configured. An unvalidated zip is not an in-area zip."
                      falseTone="warn"
                    />
                  </td>
                  <td>
                    <TriState
                      value={l.isOwner}
                      trueLabel="owner"
                      falseLabel="RENTER"
                      nullLabel="unknown"
                      nullTitle="Never established. Unknown does not block; a known renter cannot authorise work."
                      falseTone="warn"
                    />
                  </td>
                  <td>
                    <OutcomeCell
                      siteId={siteId}
                      outcome={{
                        leadId: l.id,
                        disposition: (outcomes.get(l.id)?.disposition as LeadDisposition) ?? null,
                        jobValueMicros: outcomes.get(l.id)?.jobValueMicros?.toString() ?? null,
                        recordedAt: outcomes.get(l.id)?.recordedAt?.toISOString() ?? null,
                      }}
                      onRecord={recordLeadOutcomeAction}
                    />
                  </td>
                  <td className="faint" style={{ fontSize: 11 }}>
                    {l.capturedFields.length} field{l.capturedFields.length === 1 ? '' : 's'}
                    <div>via {l.capturedVia}</div>
                    {l.reconcileConflict !== null && (
                      <span
                        className="badge warn"
                        title="Post-call analysis disagreed with what the agent confirmed mid-call. The mid-call value was kept. A recurring conflict on one field is a prompt bug."
                      >
                        conflict
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* --- Form entries ------------------------------------------------- */}
      <h3>Form entries</h3>
      <div className="empty">
        Not implemented yet. When the site&rsquo;s contact form is wired up, submissions land in
        the same <code>leads</code> table with <code>source = &apos;form&apos;</code> — which is
        why that column exists now. Deliberately <strong>not</strong> shown as a zeroed chart: a
        zero would claim there were no submissions.
      </div>

      {/* --- Setup ------------------------------------------------------- */}
      {wizard !== null && !wizard.complete && (
        <SetupWizard
          view={{
            siteId: wizard.siteId,
            agentId: wizard.agentId,
            agentName: wizard.agentName,
            responseEngineType: wizard.responseEngineType,
            steps: wizard.steps,
            currentStepId: wizard.currentStepId,
            complete: wizard.complete,
          }}
          trackingNumber={site.trackingNumber}
          toolUrl={`${base}/api/retell/tool/save-lead`}
          onList={listLiveAgentsAction}
          onAdopt={adoptAgentAction}
          onApplyIntegration={applySiteIntegrationAction}
          onRecheck={recheckAgentAction}
          onInspectProvisioning={inspectProvisioningAction}
          onApplyProvisioning={applyProvisioningAction}
        />
      )}

      {/* --- Connection --------------------------------------------------- */}
      <ConnectionPanel
        info={{
          siteId,
          trackingNumber: site.trackingNumber,
          retellAgentId: site.retellAgentId,
          onCallNumber: site.onCallNumber,
          leadAlertNumber: site.leadAlertNumber,
          firstWebhookAt: site.firstWebhookAt?.toISOString() ?? null,
          lastWebhookAt: site.lastWebhookAt?.toISOString() ?? null,
          retellNumberImportedAt: site.retellNumberImportedAt?.toISOString() ?? null,
          inboundUrl: `${base}/api/retell/inbound`,
          eventsUrl: `${base}/api/retell/events`,
          toolUrl: `${base}/api/retell/tool/save-lead`,
          failoverUrl: `${base}/api/twilio/failover`,
          baseUrlConfigured: Boolean(process.env['PUBLIC_BASE_URL']),
          apiKeyConfigured: Boolean(process.env['RETELL_API_KEY']),
          invalidSignatureCount: invalidSigs,
          promptCurrent: promptIsCurrent(site),
          nicheSlug: detail.nicheSlug,
          nicheLabel: detail.nicheLabel,
        }}
        onTest={sendTestEventAction}
        onSaveTelephony={saveTelephonyAction}
        onCreateAgent={createRetellAgentAction}
      />

      {/* Only once an agent is bound — switching from nothing is just binding, and the
          create/adopt path above already covers that. */}
      {site.retellAgentId !== null && (
        <SwitchAgentPanel
          siteId={siteId}
          currentAgentId={site.retellAgentId}
          previousAgentId={site.previousRetellAgentId}
          onList={listLiveAgentsAction}
          onPreflight={preflightSwitchAction}
          onSwitch={switchAgentAction}
          onSwitchBack={switchBackAction}
        />
      )}

      {/* --- Queue health ------------------------------------------------- */}
      {queue !== null && (queue.pending > 0 || queue.failed > 0) && (
        <div className={queue.failed > 0 ? 'warnbox' : 'card'}>
          <strong>Voice job queue:</strong> {queue.pending} pending, {queue.claimed} running,{' '}
          {queue.failed} failed.
          {queue.pending > 0 && (
            <>
              {' '}
              Pending jobs only move while <code>pnpm worker</code> is running.
            </>
          )}
          {queue.failures.length > 0 && (
            <ul style={{ marginBottom: 0 }}>
              {queue.failures.map((f) => (
                <li key={f.id} style={{ fontSize: 12 }}>
                  <span className="mono">{f.kind}</span>
                  {f.callId !== null && <> call #{f.callId}</>}: {f.lastError}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------

/** A stat tile. `null` renders an em dash with a reason, never a 0. */
function Stat({
  label,
  value,
  text,
  hint,
  tone,
}: {
  label: string
  value?: number | null
  text?: string | null
  hint?: string
  tone?: 'bad'
}) {
  const display =
    text !== undefined ? text : value === null || value === undefined ? null : num(value)
  return (
    <div className="stat" title={hint}>
      <span className="stat-label">{label}</span>
      <span className={`stat-value ${tone === 'bad' ? 'bad' : ''}`}>
        {display === null ? <span className="null">{NULL_DISPLAY}</span> : display}
      </span>
    </div>
  )
}

/**
 * A nullable boolean, where the null must never read as the false.
 *
 * Used for is_emergency, in_service_area and is_owner -- the three columns where a
 * null rendered as a "no" is an actual operational failure rather than a cosmetic
 * one.
 */
function TriState({
  value,
  trueLabel,
  falseLabel,
  nullLabel,
  nullTitle,
  trueTone = 'go',
  falseTone = 'neutral',
}: {
  value: boolean | null
  trueLabel: string
  falseLabel: string
  nullLabel: string
  nullTitle: string
  trueTone?: string
  falseTone?: string
}) {
  if (value === true) return <span className={`badge ${trueTone}`}>{trueLabel}</span>
  if (value === false) return <span className={`badge ${falseTone}`}>{falseLabel}</span>
  return (
    <span className="badge unknown" title={nullTitle}>
      {nullLabel}
    </span>
  )
}

function statusTone(status: string): string {
  if (status === 'rented' || status === 'live') return 'go'
  if (status === 'building') return 'warn'
  if (status === 'dropped') return 'stop'
  return 'neutral'
}
