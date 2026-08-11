'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { SITE_STATUSES } from '@rnr/core'
import { dropMarketAction, updateMarketAction } from '@/app/markets/actions'

/**
 * Edit / drop a targeted market on the cell page.
 */
export function MarketManagePanel({
  siteId,
  domain,
  displayName,
  status,
  notes,
  label,
}: {
  siteId: number
  domain: string | null
  displayName: string | null
  status: string
  notes: string | null
  label: string
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [open, setOpen] = useState(false)

  const save = (fd: FormData) => {
    setMsg(null)
    fd.set('siteId', String(siteId))
    startTransition(async () => {
      const res = await updateMarketAction(fd)
      if (res.ok) {
        setMsg({ ok: true, text: 'Saved.' })
        router.refresh()
      } else {
        setMsg({ ok: false, text: res.error ?? 'Save failed.' })
      }
    })
  }

  const onDrop = () => {
    if (
      !window.confirm(
        `Drop market “${label}”?\n\nStatus becomes dropped and it leaves the Markets list. History is kept.`,
      )
    ) {
      return
    }
    setMsg(null)
    const fd = new FormData()
    fd.set('siteId', String(siteId))
    fd.set('confirm', 'drop')
    startTransition(async () => {
      const res = await dropMarketAction(fd)
      if (res.ok) {
        router.push('/markets')
        router.refresh()
      } else {
        setMsg({ ok: false, text: res.error ?? 'Could not drop market.' })
      }
    })
  }

  return (
    <div className="card market-manage">
      <div className="flex" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 style={{ margin: 0 }}>Manage market</h3>
        <button type="button" className="btn tiny" onClick={() => setOpen((v) => !v)}>
          {open ? 'Hide' : 'Edit'}
        </button>
      </div>
      <p className="sub" style={{ marginTop: 6, marginBottom: 0 }}>
        Change domain, name, status, or notes. Drop removes it from the active portfolio without
        deleting call history.
      </p>

      {open && (
        <form action={save} style={{ marginTop: 14 }}>
          <div className="form-grid">
            <label>
              <span>Domain</span>
              <input
                name="domain"
                defaultValue={domain ?? ''}
                placeholder="optional — e.g. phoenixhvac.com"
                autoComplete="off"
              />
            </label>
            <label>
              <span>Business name</span>
              <input
                name="displayName"
                defaultValue={displayName ?? ''}
                placeholder="What the agent says"
                autoComplete="off"
              />
            </label>
            <label>
              <span>Status</span>
              <select name="status" defaultValue={status}>
                {SITE_STATUSES.filter((s) => s !== 'dropped').map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
                {status === 'dropped' && <option value="dropped">dropped</option>}
              </select>
            </label>
            <label style={{ gridColumn: '1 / -1' }}>
              <span>Notes</span>
              <textarea name="notes" rows={2} defaultValue={notes ?? ''} placeholder="Internal notes" />
            </label>
          </div>
          <div className="flex" style={{ marginTop: 12, gap: 8, flexWrap: 'wrap' }}>
            <button type="submit" className="primary" disabled={pending}>
              {pending ? 'Saving…' : 'Save changes'}
            </button>
            <button type="button" className="btn danger" disabled={pending} onClick={onDrop}>
              Drop market
            </button>
          </div>
          {msg && (
            <div className={msg.ok ? 'okbox' : 'stopbox'} style={{ marginTop: 10 }}>
              {msg.text}
            </div>
          )}
        </form>
      )}

      {!open && (
        <div className="flex" style={{ marginTop: 10, gap: 8 }}>
          <button type="button" className="btn tiny" onClick={() => setOpen(true)}>
            Edit domain / status
          </button>
          <button type="button" className="btn tiny danger" disabled={pending} onClick={onDrop}>
            Drop market
          </button>
        </div>
      )}
    </div>
  )
}
