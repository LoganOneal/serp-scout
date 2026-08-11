import 'server-only'
import type { Database } from '../db.js'
import type { VoiceJob } from '../schema.js'
import type { VoiceProviders } from '../providers/voice.js'
import { completeVoiceJob, failVoiceJob } from './jobs.js'
import { fetchRecording, markRecordingSkipped } from './recordings.js'
import { deliverLead } from './delivery.js'
import { getCallById, handleCallEvent } from './ingest.js'

/**
 * Execute one claimed voice job.
 *
 * The job has already been claimed and its attempt counter incremented, so every
 * exit from here must either complete or fail the row -- a job left `claimed`
 * shows a recording that never arrives with nothing on screen saying why.
 */
export async function runVoiceJob(
  db: Database,
  args: { job: VoiceJob; providers: VoiceProviders; log?: (m: string) => void },
): Promise<{ ok: boolean; detail: string }> {
  const { job, providers } = args
  const log = args.log ?? (() => {})

  try {
    switch (job.kind) {
      case 'fetch_recording': {
        if (job.callId === null) {
          await failVoiceJob(db, job, 'fetch_recording job has no call_id.')
          return { ok: false, detail: 'no call_id' }
        }
        const call = await getCallById(db, job.callId)
        if (call === null) {
          await failVoiceJob(db, job, `Call ${job.callId} no longer exists.`)
          return { ok: false, detail: 'call gone' }
        }
        if (call.recordingPath !== null) {
          // Already have it. A redelivered webhook can enqueue twice despite the
          // unique index if the first job already completed.
          await completeVoiceJob(db, job.id)
          return { ok: true, detail: 'already stored' }
        }
        /**
         * A simulated call's recording_url is synthetic (fixture.invalid), so a LIVE
         * download can only ever fail DNS -- five times, with backoff, then a red row
         * on the dashboard for something that was never real.
         *
         * In fixture mode the provider returns a genuine WAV, so the storage path
         * still gets exercised there. This branch only skips the case where the two
         * are mismatched.
         */
        if (call.simulated && providers.live) {
          await markRecordingSkipped(
            db,
            call.id,
            'Simulated call — no real recording exists upstream.',
          )
          await completeVoiceJob(db, job.id)
          return { ok: true, detail: 'skipped (simulated)' }
        }
        const res = await fetchRecording(db, { call, providers })
        if (!res.stored) {
          // A permanent reason (no URL at all) is already written to the call row;
          // failing the job records it in the queue too rather than looping.
          await failVoiceJob(db, job, res.reason ?? 'Recording not stored.')
          return { ok: false, detail: res.reason ?? 'not stored' }
        }
        await completeVoiceJob(db, job.id)
        log(`recording stored for call ${call.id} (${res.bytes} bytes)`)
        return { ok: true, detail: `${res.bytes} bytes` }
      }

      case 'deliver_lead': {
        if (job.leadId === null) {
          await failVoiceJob(db, job, 'deliver_lead job has no lead_id.')
          return { ok: false, detail: 'no lead_id' }
        }
        const res = await deliverLead(db, { leadId: job.leadId, providers })
        // Suppression is a final, correct outcome -- not a transient fault. Failing
        // the job would retry five times against a decision that will never change.
        if (!res.sent && !res.attempted && res.reason?.includes('suppressed')) {
          await completeVoiceJob(db, job.id)
          log(`lead ${job.leadId} suppressed (simulated call)`)
          return { ok: true, detail: 'suppressed' }
        }
        if (!res.sent) {
          // Not sent and not thrown means a configuration gap, not a transient
          // fault -- retrying a site with no alert number will never succeed, so
          // the attempts counter is allowed to burn down and leave the evidence.
          await failVoiceJob(db, job, res.reason ?? 'Lead not delivered.')
          return { ok: false, detail: res.reason ?? 'not sent' }
        }
        await completeVoiceJob(db, job.id)
        log(`lead ${job.leadId} delivered`)
        return { ok: true, detail: 'sent' }
      }

      case 'backfill_call': {
        if (job.callId === null) {
          await failVoiceJob(db, job, 'backfill_call job has no call_id.')
          return { ok: false, detail: 'no call_id' }
        }
        const call = await getCallById(db, job.callId)
        if (call === null) {
          await failVoiceJob(db, job, `Call ${job.callId} no longer exists.`)
          return { ok: false, detail: 'call gone' }
        }
        const fresh = await providers.getCall(call.retellCallId)
        if (fresh === null) {
          await failVoiceJob(db, job, 'Retell returned no call for backfill.')
          return { ok: false, detail: 'no upstream call' }
        }
        await handleCallEvent(db, { eventType: 'call_analyzed', parsed: fresh })
        await completeVoiceJob(db, job.id)
        return { ok: true, detail: 'backfilled' }
      }

      default: {
        await failVoiceJob(db, job, `Unknown job kind: ${String(job.kind)}`)
        return { ok: false, detail: 'unknown kind' }
      }
    }
  } catch (e) {
    const message = (e as Error).message ?? String(e)
    const { retrying } = await failVoiceJob(db, job, message)
    log(`job #${job.id} (${job.kind}) ${retrying ? 'will retry' : 'FAILED permanently'}: ${message}`)
    return { ok: false, detail: message }
  }
}
