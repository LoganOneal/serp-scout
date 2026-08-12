'use client'

import { useActionState, useRef, useState } from 'react'
import { useFormStatus } from 'react-dom'
import { startEnrichRun, type StartEnrichState } from '@/app/scout/domains/actions'
import {
  DEFAULT_PAID_OPTIONS,
  EnrichOptionsModal,
  type PaidOptionsValue,
} from '@/components/domains/EnrichOptionsModal'

export interface GeoOption {
  locationCode: number
  label: string
}

function SubmitButton({ onOpen }: { onOpen: () => void }) {
  const { pending } = useFormStatus()
  return (
    <button type="button" className="btn primary" disabled={pending} onClick={onOpen}>
      {pending ? 'Starting…' : 'Run domain search…'}
    </button>
  )
}

/**
 * Start one ENRICH MODE run.
 *
 * Cost is shown as a fixed figure rather than a per-domain estimate because it
 * genuinely is fixed: Stage 1 is a single Maps request at $0.002 regardless of
 * how many businesses come back, and every stage after it runs on free public
 * services (DNS, HTTP, RDAP, Wayback).
 */
export function StartEnrichForm({ geos }: { geos: GeoOption[] }) {
  const [state, action] = useActionState<StartEnrichState | null, FormData>(startEnrichRun, null)
  const [locationCode, setLocationCode] = useState<string>(
    geos[0] ? String(geos[0].locationCode) : '',
  )
  const [modalOpen, setModalOpen] = useState(false)
  const [paid, setPaid] = useState<PaidOptionsValue>(DEFAULT_PAID_OPTIONS)
  const formRef = useRef<HTMLFormElement>(null)
  const [niche, setNiche] = useState('plumber')

  const selected = geos.find((g) => String(g.locationCode) === locationCode)

  return (
    <form ref={formRef} action={action} className="enrich-start">
      <div className="enrich-start-fields">
        <label className="enrich-field">
          <span className="enrich-field-label">Niche</span>
          <input
            name="niche"
            className="sm-filter-input"
            placeholder="plumber"
            value={niche}
            onChange={(e) => setNiche(e.target.value)}
            required
          />
        </label>

        <label className="enrich-field">
          <span className="enrich-field-label">Market</span>
          {geos.length > 0 ? (
            <select
              name="locationCode"
              className="sm-filter-input"
              value={locationCode}
              onChange={(e) => setLocationCode(e.target.value)}
            >
              {geos.map((g) => (
                <option key={g.locationCode} value={g.locationCode}>
                  {g.label}
                </option>
              ))}
            </select>
          ) : (
            <input
              name="locationCode"
              className="sm-filter-input"
              placeholder="DataForSEO location code"
              inputMode="numeric"
              required
            />
          )}
        </label>

        <label className="enrich-field enrich-field-narrow">
          <span className="enrich-field-label">Max businesses</span>
          <input
            name="maxResults"
            className="sm-filter-input"
            type="number"
            min={1}
            max={700}
            defaultValue={200}
          />
        </label>

        <input type="hidden" name="locality" value={selected?.label ?? ''} />
        {/* Written from the modal, so a paid stage can only be on deliberately. */}
        <input type="hidden" name="checkSpam" value={paid.checkSpam ? '1' : '0'} />
        <input type="hidden" name="checkRankings" value={paid.checkRankings ? '1' : '0'} />
        <input type="hidden" name="maxRankingLookups" value={paid.maxRankingLookups} />
        <input type="hidden" name="checkAuthority" value={paid.checkAuthority ? '1' : '0'} />
        <input type="hidden" name="renderUnknown" value={paid.renderUnknown ? '1' : '0'} />

        <div className="enrich-field enrich-field-submit">
          <SubmitButton onOpen={() => setModalOpen(true)} />
        </div>
      </div>

      <div className="enrich-start-note">
        <span className="badge ok">$0.002</span>
        <span>
          One Maps request buys the business list. Triage (DNS, HTTP, RDAP, Wayback) is free, so
          cost does not scale with market size.
        </span>
      </div>

      {state && (
        <div className={`enrich-start-result ${state.ok ? 'ok' : 'err'}`}>{state.message}</div>
      )}

      <EnrichOptionsModal
        open={modalOpen}
        niche={niche || 'niche'}
        locality={selected?.label ?? 'this market'}
        onClose={() => setModalOpen(false)}
        onConfirm={(v) => {
          setPaid(v)
          setModalOpen(false)
          // Let the hidden inputs take the new values before submitting.
          requestAnimationFrame(() => formRef.current?.requestSubmit())
        }}
      />
    </form>
  )
}
