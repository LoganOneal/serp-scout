'use client'

import { useState, useTransition } from 'react'

/**
 * The connection panel.
 *
 * Shows the exact URLs to paste into Retell and Twilio, and -- the part that
 * matters -- lets you prove the ingest path works without waiting for a real
 * caller. "Send test event" posts a SIGNED fixture call at our own endpoints, so a
 * wrong RETELL_API_KEY, a wrong PUBLIC_BASE_URL, or a broken handler surfaces here
 * instead of as a dashboard that quietly stays empty.
 */

export interface ConnectionInfo {
  siteId: number
  trackingNumber: string | null
  retellAgentId: string | null
  onCallNumber: string | null
  leadAlertNumber: string | null
  firstWebhookAt: string | null
  lastWebhookAt: string | null
  retellNumberImportedAt: string | null
  inboundUrl: string
  eventsUrl: string
  toolUrl: string
  failoverUrl: string
  baseUrlConfigured: boolean
  apiKeyConfigured: boolean
  invalidSignatureCount: number
  promptCurrent: boolean | null
}

export function ConnectionPanel({
  info,
  onTest,
  onSaveTelephony,
}: {
  info: ConnectionInfo
  onTest: (siteId: number, scenario: string) => Promise<{ ok: boolean; detail: string }>
  onSaveTelephony: (fd: FormData) => Promise<{ ok: boolean; error?: string }>
}) {
  const [result, setResult] = useState<{ ok: boolean; detail: string } | null>(null)
  const [scenario, setScenario] = useState('urgent_no_heat')
  const [pending, startTransition] = useTransition()
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const run = () => {
    setResult(null)
    startTransition(async () => setResult(await onTest(info.siteId, scenario)))
  }

  const save = (fd: FormData) => {
    setSaveError(null)
    setSaved(false)
    fd.set('siteId', String(info.siteId))
    startTransition(async () => {
      const res = await onSaveTelephony(fd)
      if (!res.ok) setSaveError(res.error ?? 'Could not save.')
      else setSaved(true)
    })
  }

  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Connection</h3>

      {/* --- Editable numbers ------------------------------------------- */}
      <form action={save} className="form-grid" style={{ marginBottom: 18 }}>
        <label>
          <span>Tracking number</span>
          <input
            name="trackingNumber"
            defaultValue={info.trackingNumber ?? ''}
            placeholder="(520) 369-4399"
            autoComplete="off"
          />
          <em>
            The number callers dial. Saving here <strong>records</strong> it — it does not
            attach it to the Twilio trunk or import it into Retell. Only{' '}
            <code>pnpm sites:provision</code> does that, because it changes live call routing.
          </em>
        </label>

        <label>
          <span>Retell agent ID</span>
          <input
            name="retellAgentId"
            defaultValue={info.retellAgentId ?? ''}
            placeholder="agent_…"
            autoComplete="off"
            className="mono"
          />
          <em>Blank falls back to RETELL_AGENT_ID.</em>
        </label>

        <label>
          <span>On-call number</span>
          <input
            name="onCallNumber"
            defaultValue={info.onCallNumber ?? ''}
            placeholder="(917) 251-3510"
            autoComplete="off"
          />
          <em>Emergency transfers, and the Twilio disaster-recovery fallback dials this.</em>
        </label>

        <label>
          <span>Lead alert number</span>
          <input
            name="leadAlertNumber"
            defaultValue={info.leadAlertNumber ?? ''}
            placeholder="(917) 251-3510"
            autoComplete="off"
          />
          <em>Where new-lead texts go. Falls back to the on-call number.</em>
        </label>
        <div className="flex" style={{ alignItems: 'center', gridColumn: '1 / -1' }}>
          <button className="primary" type="submit" disabled={pending}>
            {pending ? 'Saving…' : 'Save numbers'}
          </button>
          {saved && <span className="badge go">saved</span>}
          {info.trackingNumber !== null && info.retellNumberImportedAt === null && (
            <span
              className="badge warn"
              title="Recorded here, but not attached to the Twilio trunk or imported into Retell. Run pnpm sites:provision."
            >
              recorded, not provisioned
            </span>
          )}
        </div>
      </form>

      {saveError && <div className="disabled-reason">{saveError}</div>}

      {/* Tracking number and agent id are edited above, so they are not repeated
          here. What follows is EVIDENCE rather than configuration: things only Retell
          or the provisioning script can tell us. */}
      <div className="kv">
        <span>Number imported to Retell</span>
        <span>
          {info.retellNumberImportedAt === null ? (
            <span className="badge unknown" title="pnpm sites:provision has not run for this number.">
              never
            </span>
          ) : (
            <span className="mono">{info.retellNumberImportedAt.slice(0, 16).replace('T', ' ')}</span>
          )}
        </span>

        <span>First webhook</span>
        <span>
          {info.firstWebhookAt === null ? (
            <span className="badge stop">never received</span>
          ) : (
            <span className="mono">{info.firstWebhookAt.slice(0, 16).replace('T', ' ')}</span>
          )}
        </span>

        <span>Last webhook</span>
        <span className="mono">
          {info.lastWebhookAt === null ? '—' : info.lastWebhookAt.slice(0, 16).replace('T', ' ')}
        </span>

        <span>Prompt in Retell</span>
        <span>
          {info.promptCurrent === null ? (
            <span className="badge unknown" title="Never pushed from this repo.">
              unknown
            </span>
          ) : info.promptCurrent ? (
            <span className="badge go">matches this repo</span>
          ) : (
            <span className="badge warn" title="The prompt in @rnr/core changed since it was last pushed.">
              stale
            </span>
          )}
        </span>
      </div>

      {info.invalidSignatureCount > 0 && (
        <div className="warnbox" style={{ marginTop: 12 }}>
          <strong>
            {info.invalidSignatureCount} webhook
            {info.invalidSignatureCount === 1 ? '' : 's'} failed signature verification.
          </strong>{' '}
          Those payloads were stored but not applied, so nothing is lost — fix{' '}
          <code>RETELL_API_KEY</code> and they can be replayed. If the key is correct, someone
          is probing the endpoint.
        </div>
      )}

      <h4>Paste these</h4>
      <p className="sub" style={{ marginTop: 0 }}>
        {info.baseUrlConfigured ? (
          <>
            One inbound URL serves every site — resolution is by dialled number, so there is
            nothing per-number to configure.
          </>
        ) : (
          <strong>
            PUBLIC_BASE_URL is not set, so these are placeholders. In development, point it at
            an ngrok or cloudflared tunnel.
          </strong>
        )}
      </p>

      <div className="urls">
        <Url label="Retell → Phone number → Inbound Webhook URL" value={info.inboundUrl} />
        <Url label="Retell → Agent → Webhook URL" value={info.eventsUrl} />
        <Url label="Retell → save_lead custom function URL" value={info.toolUrl} />
        <Url label="Twilio → Trunk → Disaster Recovery URL" value={info.failoverUrl} />
      </div>

      <h4>Prove it works</h4>
      <p className="sub" style={{ marginTop: 0 }}>
        Posts a signed fixture call at our own endpoints — inbound, started, two{' '}
        <code>save_lead</code> calls, ended, analyzed. No Retell account and no phone needed.
      </p>
      <div className="flex">
        <select value={scenario} onChange={(e) => setScenario(e.target.value)}>
          <option value="urgent_no_heat">urgent no heat</option>
          <option value="booked">booked</option>
          <option value="gas_emergency">gas emergency</option>
          <option value="out_of_area">out of area</option>
          <option value="abandoned">abandoned (no lead)</option>
          <option value="voicemail">voicemail</option>
        </select>
        <button onClick={run} disabled={pending || !info.apiKeyConfigured}>
          {pending ? 'Sending…' : 'Send test event'}
        </button>
      </div>

      {!info.apiKeyConfigured && (
        <div className="disabled-reason">
          RETELL_API_KEY is not set. The ingest routes verify every payload and have no bypass
          flag, so a signed test event cannot be produced without it.
        </div>
      )}

      {result && (
        <div className={result.ok ? 'okbox' : 'disabled-reason'} style={{ marginTop: 10 }}>
          {result.detail}
        </div>
      )}
    </div>
  )
}

function Url({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="url-row">
      <div className="url-label">{label}</div>
      <div className="flex">
        <code className="url-value">{value}</code>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(value).then(() => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            })
          }}
        >
          {copied ? 'copied' : 'copy'}
        </button>
      </div>
    </div>
  )
}
