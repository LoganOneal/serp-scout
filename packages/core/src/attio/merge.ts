import { ATTIO_FOLLOWUP_BLOCKED, ATTIO_STATUSES, type AttioStatus } from './types.js'

const STATUS_RANK = new Map<AttioStatus, number>(ATTIO_STATUSES.map((status, index) => [status, index]))

export function isAttioStatus(value: unknown): value is AttioStatus {
  return typeof value === 'string' && (ATTIO_STATUSES as readonly string[]).includes(value)
}

/**
 * Source-data syncs never move status backwards. New records start at New.
 * Existing CRM status always wins.
 */
export function nextStatus(current: AttioStatus | null | undefined, incoming: AttioStatus | null | undefined): AttioStatus {
  if (!incoming && !current) return 'New'
  if (!incoming) return current ?? 'New'
  if (!current) return incoming
  if (STATUS_RANK.get(incoming)! < STATUS_RANK.get(current)!) return current
  return current
}

export function shouldSkipFollowup(status: AttioStatus | null | undefined): boolean {
  return !status || status !== 'Contacted' || ATTIO_FOLLOWUP_BLOCKED.has(status)
}

export function isBlank(value: unknown): boolean {
  if (value == null) return true
  if (typeof value === 'string') return value.trim() === ''
  if (Array.isArray(value)) return value.length === 0
  return false
}

/**
 * Source-owned fields may update. CRM-owned fields keep the Attio value when
 * the source is blank or missing. A blank source value never erases Attio.
 */
export function mergeField(args: {
  owner: 'source' | 'crm'
  current: unknown
  incoming: unknown
}): { value: unknown; skipped: boolean; reason?: string } {
  const { owner, current, incoming } = args
  if (owner === 'crm') {
    if (!isBlank(current)) return { value: current, skipped: true, reason: 'crm_owned_preserved' }
    if (isBlank(incoming)) return { value: current ?? null, skipped: true, reason: 'blank_source_ignored' }
    return { value: incoming, skipped: false }
  }
  if (isBlank(incoming)) {
    if (!isBlank(current)) return { value: current, skipped: true, reason: 'blank_source_ignored' }
    return { value: null, skipped: true, reason: 'blank_source_ignored' }
  }
  if (incoming === current) return { value: current, skipped: true, reason: 'unchanged' }
  return { value: incoming, skipped: false }
}

export function mergeEntryValues(args: {
  existing: Record<string, unknown> | null
  sourceOwned: Record<string, unknown>
  crmOwned?: Record<string, unknown>
  isCreate: boolean
}): { values: Record<string, unknown>; skipped: string[]; updated: string[] } {
  const existing = args.existing ?? {}
  const values: Record<string, unknown> = {}
  const skipped: string[] = []
  const updated: string[] = []

  const apply = (owner: 'source' | 'crm', incoming: Record<string, unknown>) => {
    for (const [key, next] of Object.entries(incoming)) {
      const merged = mergeField({ owner, current: existing[key], incoming: next })
      if (merged.value !== undefined) values[key] = merged.value
      if (merged.skipped) skipped.push(`${key}:${merged.reason}`)
      else updated.push(key)
    }
  }

  apply('source', args.sourceOwned)
  if (args.crmOwned) apply('crm', args.crmOwned)

  if (args.isCreate) {
    values.status = 'New'
    updated.push('status')
  } else {
    const status = nextStatus(
      isAttioStatus(existing.status) ? existing.status : null,
      isAttioStatus(args.crmOwned?.status) ? args.crmOwned.status : null,
    )
    values.status = existing.status ?? status
    if (existing.status) skipped.push('status:attio_authoritative')
  }

  return { values, skipped, updated }
}
