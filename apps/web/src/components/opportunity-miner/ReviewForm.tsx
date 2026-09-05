'use client'

import { useState } from 'react'
import { updateMinerReview } from '@/app/scout/opportunity-miner/actions'

export function ReviewForm({
  slug,
  status,
  notes,
  tags,
  scoreOverride,
}: {
  slug: string
  status: string
  notes: string
  tags: string[]
  scoreOverride: number | null
}) {
  const [msg, setMsg] = useState<string | null>(null)
  return (
    <form
      className="om-review"
      action={async (fd) => {
        const r = await updateMinerReview(fd)
        setMsg(r.ok ? 'Saved' : r.error ?? 'Failed')
      }}
    >
      <input type="hidden" name="slug" value={slug} />
      <label>
        Status
        <select name="status" defaultValue={status}>
          <option value="new">new</option>
          <option value="interesting">interesting</option>
          <option value="investigate">investigate</option>
          <option value="validated">validated</option>
          <option value="building">building</option>
          <option value="rejected">rejected</option>
        </select>
      </label>
      <label>
        Score override
        <input name="scoreOverride" type="number" step="0.1" defaultValue={scoreOverride ?? ''} placeholder="leave blank" />
      </label>
      <label>
        Tags (comma)
        <input name="tags" defaultValue={tags.join(', ')} placeholder="AI, SMB, vertical SaaS" />
      </label>
      <label>
        Notes
        <textarea name="notes" rows={4} defaultValue={notes} />
      </label>
      <button type="submit" className="btn primary">
        Save review
      </button>
      {msg && <p className="om-sub">{msg}</p>}
    </form>
  )
}
