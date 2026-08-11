'use client'

import { useState } from 'react'
import { NULL_DISPLAY } from '@/lib/format'

/**
 * One call, expandable to its transcript.
 *
 * The recording cell is the rule this codebase runs on, applied to a play button:
 * a NULL `recordingPath` renders the REASON it is missing, never a control that
 * 404s when clicked. A broken player reads as a broken app; "queued, not fetched
 * yet" reads as what it is.
 */

export interface CallRowData {
  id: number
  startedAt: string | null
  fromNumber: string | null
  durationMs: number | null
  disconnectionReason: string | null
  userSentiment: string | null
  ingestState: string
  hasRecording: boolean
  recordingMissingReason: string | null
  transcript: string | null
  latencyE2eP50Ms: number | null
  latencyE2eP95Ms: number | null
  lead: {
    id: number
    name: string | null
    phone: string | null
    isEmergency: boolean | null
    qualified: boolean | null
  } | null
}

export function CallRow({
  call,
  onRefetch,
}: {
  call: CallRowData
  onRefetch: (callId: number) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const abandoned = call.durationMs !== null && call.durationMs < 10_000

  return (
    <>
      <tr className={call.lead?.isEmergency === true ? 'row-emergency' : undefined}>
        <td className="mono" style={{ fontSize: 11.5 }}>
          {call.startedAt === null ? NULL_DISPLAY : call.startedAt.slice(5, 16).replace('T', ' ')}
        </td>
        <td className="mono" style={{ fontSize: 11.5 }}>
          {call.fromNumber ?? NULL_DISPLAY}
        </td>
        <td className="num">
          {call.durationMs === null ? (
            <span className="null">{NULL_DISPLAY}</span>
          ) : (
            <span className={abandoned ? 'warn-text' : undefined}>
              {formatDuration(call.durationMs)}
            </span>
          )}
        </td>
        <td>
          {call.lead === null ? (
            abandoned ? (
              <span className="badge stop" title="Caller hung up before anything was captured.">
                abandoned
              </span>
            ) : (
              <span className="badge unknown" title="Call happened but no lead was saved.">
                no lead
              </span>
            )
          ) : call.lead.isEmergency === true ? (
            <span className="badge stop">EMERGENCY</span>
          ) : call.lead.qualified === true ? (
            <span className="badge go">qualified</span>
          ) : call.lead.qualified === false ? (
            <span className="badge warn">not qualified</span>
          ) : (
            // null, not false: the call did not get far enough to tell. Rendering
            // this as "not qualified" would claim a judgement nobody made.
            <span className="badge unknown" title="Never established — not the same as rejected.">
              incomplete
            </span>
          )}
        </td>
        <td>
          {call.lead?.name ?? <span className="null">{NULL_DISPLAY}</span>}
          {call.lead?.phone && (
            <div className="faint mono" style={{ fontSize: 11 }}>
              {call.lead.phone}
            </div>
          )}
        </td>
        <td className="num">
          {call.latencyE2eP95Ms === null ? (
            <span className="null">{NULL_DISPLAY}</span>
          ) : (
            <span title={`p50 ${call.latencyE2eP50Ms ?? '—'}ms`}>{call.latencyE2eP95Ms}ms</span>
          )}
        </td>
        <td>
          {call.hasRecording ? (
            <RecordingPlayer callId={call.id} onRefetch={onRefetch} />
          ) : (
            <RecordingMissing
              callId={call.id}
              reason={call.recordingMissingReason}
              ingestState={call.ingestState}
              onRefetch={onRefetch}
            />
          )}
        </td>
        <td>
          {call.transcript && (
            <button type="button" onClick={() => setOpen((v) => !v)}>
              {open ? 'hide' : 'transcript'}
            </button>
          )}
        </td>
      </tr>
      {open && call.transcript && (
        <tr>
          <td colSpan={8}>
            <pre className="transcript">{call.transcript}</pre>
            {call.disconnectionReason && (
              <p className="faint" style={{ fontSize: 11.5, margin: '6px 0 0' }}>
                Ended: <span className="mono">{call.disconnectionReason}</span>
              </p>
            )}
          </td>
        </tr>
      )}
    </>
  )
}

/**
 * Play control that degrades to a reason + retry if the audio element errors.
 * preload="metadata" so the duration is not 0:00 before first play.
 */
function RecordingPlayer({
  callId,
  onRefetch,
}: {
  callId: number
  onRefetch: (callId: number) => Promise<void>
}) {
  const [failed, setFailed] = useState(false)
  if (failed) {
    return (
      <RecordingMissing
        callId={callId}
        reason="Player could not load audio from storage. Retry fetch or hard-refresh."
        ingestState="analyzed"
        onRefetch={async (id) => {
          setFailed(false)
          await onRefetch(id)
        }}
      />
    )
  }
  return (
    <audio
      controls
      preload="metadata"
      src={`/api/recordings/${callId}`}
      className="player"
      onError={() => setFailed(true)}
    />
  )
}

function RecordingMissing({
  callId,
  reason,
  ingestState,
  onRefetch,
}: {
  callId: number
  reason: string | null
  ingestState: string
  onRefetch: (callId: number) => Promise<void>
}) {
  const [busy, setBusy] = useState(false)

  // Not yet analyzed: the recording genuinely does not exist upstream yet, so
  // offering a refetch would queue a job guaranteed to fail.
  if (ingestState !== 'analyzed') {
    return (
      <span className="faint" style={{ fontSize: 11.5 }}>
        awaiting analysis
      </span>
    )
  }

  return (
    <span className="flex" style={{ gap: 6, alignItems: 'center' }}>
      <span
        className="null"
        style={{ fontSize: 11.5, maxWidth: 160 }}
        title={reason ?? 'Queued but not fetched yet. Is the worker / cron running?'}
      >
        {reason === null ? 'not fetched' : reason.slice(0, 48) + (reason.length > 48 ? '…' : '')}
      </span>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setBusy(true)
          void onRefetch(callId).finally(() => setBusy(false))
        }}
      >
        {busy ? '…' : 'retry'}
      </button>
    </span>
  )
}

function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return m === 0 ? `${s}s` : `${m}m ${String(s).padStart(2, '0')}s`
}
