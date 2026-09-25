import type { AttioAttributeType } from '@rnr/core'

export function unwrapValue(raw: unknown): unknown {
  if (raw == null) return null
  if (Array.isArray(raw)) {
    if (raw.length === 0) return null
    return unwrapValue(raw[0])
  }
  if (typeof raw !== 'object') return raw
  const value = raw as Record<string, unknown>
  if (typeof value.value === 'string' || typeof value.value === 'number' || typeof value.value === 'boolean') {
    return value.value
  }
  if ('value' in value && Object.keys(value).length <= 3) return unwrapValue(value.value)
  if (typeof value.status === 'string') return value.status
  if (value.status && typeof value.status === 'object') {
    const inner = value.status as Record<string, unknown>
    if (typeof inner.title === 'string') return inner.title
    if (typeof inner.status === 'string') return inner.status
  }
  if (typeof value.title === 'string' && typeof value.domain !== 'string' && typeof value.email_address !== 'string') {
    return value.title
  }
  if (typeof value.option === 'string') return value.option
  if (value.option && typeof value.option === 'object') {
    const inner = value.option as Record<string, unknown>
    if (typeof inner.title === 'string') return inner.title
    if (typeof inner.option === 'string') return inner.option
  }
  if (typeof value.domain === 'string') return value.domain
  if (typeof value.email_address === 'string') return value.email_address
  if (typeof value.currency_value === 'number') return value.currency_value
  if (typeof value.target_record_id === 'string') return value.target_record_id
  if (typeof value.full_name === 'string') return value.full_name
  return raw
}

export function entryValuesMap(entry: { entry_values?: Record<string, unknown>; values?: Record<string, unknown> }): Record<string, unknown> {
  const source = entry.entry_values ?? entry.values ?? {}
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source)) out[key] = unwrapValue(value)
  return out
}

export function encodeValue(type: AttioAttributeType | 'email' | 'name' | 'domain' | 'record', value: unknown): unknown {
  if (type === 'record-reference' || type === 'record') {
    if (value == null || value === '' || (Array.isArray(value) && value.length === 0)) return []
    if (typeof value === 'string') return { target_object: 'people', target_record_id: value }
    return value
  }
  if (value == null || value === '') return undefined
  switch (type) {
    case 'text':
      return String(value)
    case 'checkbox':
      return Boolean(value)
    case 'date':
      return String(value).slice(0, 10)
    case 'status':
      return value
    case 'select':
      return value
    case 'currency':
      return { currency_value: Number(value), currency_code: 'USD' }
    case 'number':
      return Number(value)
    case 'record-reference':
    case 'record':
      if (typeof value === 'string') return { target_object: 'people', target_record_id: value }
      return value
    case 'domain':
      return String(value)
    case 'email':
      return String(value)
    case 'name':
      return splitName(String(value))
    default:
      return value
  }
}

export function splitName(full: string): { first_name: string; last_name: string; full_name: string } {
  const parts = full.trim().split(/\s+/)
  const first_name = parts[0] ?? full
  const last_name = parts.slice(1).join(' ')
  return { first_name, last_name, full_name: full.trim() }
}

export function encodeEntryValues(values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue
    if (key === 'status') out[key] = value
    else if (key === 'primary_contact') out[key] = encodeValue('record-reference', value)
    else if (key === 'price_quoted') out[key] = encodeValue('currency', value)
    else if (key === 'link_allowed' || key === 'suppress_outreach') out[key] = encodeValue('checkbox', value)
    else if ((key === 'press_media_page' || key === 'hotel_website') && (value === null || value === '')) {
      out[key] = ''
    }
    else if (
      key === 'serp_position' ||
      key === 'keyword_volume' ||
      key === 'authority_score' ||
      key === 'referring_domains' ||
      key === 'outbound_links'
    ) {
      out[key] = encodeValue('number', value)
    }
    else if (
      key === 'outreach_date' ||
      key === 'next_follow_up' ||
      key === 'contact_1_date' ||
      key === 'contact_2_date' ||
      key === 'contact_3_date' ||
      key === 'contact_4_date' ||
      key === 'replied_at'
    ) {
      out[key] = encodeValue('date', value)
    }
    else if (key === 'ask_type' || key === 'placement_type' || key === 'sequence') out[key] = encodeValue('select', value)
    else out[key] = encodeValue('text', value)
  }
  return out
}
