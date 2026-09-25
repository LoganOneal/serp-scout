import { ATTIO_FOLLOWUP_BLOCKED, type AttioSequence, type AttioStatus } from './types.js'
import { addDays, isDueOnOrBefore } from './followups.js'
import { isAttioStatus } from './merge.js'

export const EMAIL_FLOW_PLACEHOLDER = /\{\{\s*([a-z0-9_]+)\s*\}\}/gi
export const EMAIL_FLOW_WAIT_DAYS = 2
export const EMAIL_FLOW_MAX_PER_DAY = 30

const CONTACT_COLUMNS = ['contact_1_date', 'contact_2_date', 'contact_3_date', 'contact_4_date'] as const

function hasPlaceholder(value: string): boolean {
  return /\{\{\s*[a-z0-9_]+\s*\}\}/i.test(value) || /\[[^\]\n]{2,80}\]/.test(value)
}

function filled(value: string | undefined): boolean {
  return Boolean(value && value.trim() && !hasPlaceholder(value))
}

const GENERIC_BLURB =
  /oceanfront rooms rather than treated as a separate amenity|stand out even among some of the other hotels we reviewed/i

export interface EmailFlowVars {
  first_name: string
  hotel_name: string
  hht_listing_url: string
  property_blurb?: string
  fact_to_verify?: string
}

export interface RenderedEmail {
  n: number
  subject: string
  body: string
}

export function renderEmailTemplate(args: {
  n: number
  subject: string
  body: string
  required: readonly string[]
  vars: EmailFlowVars
}): RenderedEmail {
  for (const key of args.required) {
    const value = args.vars[key as keyof EmailFlowVars]
    if (!filled(value)) {
      throw new Error(`Email ${args.n} is missing personalization: ${key}`)
    }
  }

  if (args.required.includes('property_blurb')) {
    const blurb = args.vars.property_blurb?.trim() ?? ''
    if (blurb.length < 80) {
      throw new Error('Email 1 property_blurb must be 1–2 specific sentences (too short).')
    }
    if (GENERIC_BLURB.test(blurb)) {
      throw new Error('Email 1 property_blurb reused the spec example. Write one for this hotel.')
    }
  }

  if (args.required.includes('fact_to_verify')) {
    const fact = args.vars.fact_to_verify?.trim() ?? ''
    if (fact.length < 20) {
      throw new Error('fact_to_verify must name a specific listing detail to confirm.')
    }
  }

  const subject = polishCopy(fill(args.subject, args.vars, args.n))
  const body = polishCopy(fill(args.body, args.vars, args.n))
  return { n: args.n, subject, body }
}

/** Drop a doubled article when the hotel name already starts with The. */
export function polishCopy(text: string): string {
  return text.replace(/\bthe The\b/g, 'The')
}

function fill(template: string, vars: EmailFlowVars, n: number): string {
  const out = template.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_match, key: string) => {
    const value = vars[key as keyof EmailFlowVars]
    if (!filled(value)) throw new Error(`Email ${n} still has unfilled {{${key}}}`)
    return value!.trim()
  })
  const leftover = out.match(/\[[^\]\n]{2,80}\]/g)
  if (leftover?.length) {
    throw new Error(`Email ${n} still has bracket placeholders: ${leftover.join(', ')}`)
  }
  return out
}

export function greetingName(firstName: string | null | undefined, hotelName: string): string {
  const name = firstName?.trim()
  if (name && !/^team$/i.test(name) && name.toLowerCase() !== hotelName.trim().toLowerCase()) return name
  return `${hotelName.trim()} team`
}

export type EmailQueueKind = 'follow_up' | 'new_sequence'

export interface EmailQueueLead {
  sourceKey: string
  sequence?: AttioSequence | null
  status?: string | null
  repliedAt?: string | null
  suppressOutreach?: boolean
  contact_1_date?: string | null
  contact_2_date?: string | null
  contact_3_date?: string | null
  contact_4_date?: string | null
}

export interface EmailQueueItem {
  sourceKey: string
  kind: EmailQueueKind
  n: number
  dueOn: string
  overdue: boolean
  sequence: AttioSequence | null
}

export interface EmailQueuePlan {
  today: string
  followUps: EmailQueueItem[]
  newSequences: EmailQueueItem[]
  selected: EmailQueueItem[]
  deferredNew: number
}

/**
 * Next step in the 4-touch sequence. Null when all four dates are filled.
 * n === 1 is a new first-touch. n >= 2 is a follow-up.
 */
export function nextSequenceStep(lead: EmailQueueLead): number | null {
  if (!lead.contact_1_date) return 1
  if (!lead.contact_2_date) return 2
  if (!lead.contact_3_date) return 3
  if (!lead.contact_4_date) return 4
  return null
}

export function lastContactDate(lead: EmailQueueLead): string | null {
  for (let i = CONTACT_COLUMNS.length - 1; i >= 0; i -= 1) {
    const value = lead[CONTACT_COLUMNS[i]!]
    if (value) return value.slice(0, 10)
  }
  return null
}

/** After a send today, the next follow-up is waitDays later — never stacked the same day. */
export function nextFollowupAfterSend(sentOn: string, waitDays = EMAIL_FLOW_WAIT_DAYS): string {
  return addDays(sentOn.slice(0, 10), waitDays)
}

function blocked(lead: EmailQueueLead): boolean {
  if (lead.suppressOutreach) return true
  if (lead.repliedAt) return true
  const status = isAttioStatus(lead.status) ? (lead.status as AttioStatus) : null
  return Boolean(status && ATTIO_FOLLOWUP_BLOCKED.has(status))
}

function sequenceRank(sequence: AttioSequence | null | undefined): number {
  if (sequence === 'Asked backlink') return 0
  if (sequence === 'Fact-check') return 1
  if (sequence === 'New contact') return 2
  return 3
}

function compareQueueItems(a: EmailQueueItem, b: EmailQueueItem): number {
  if (a.dueOn !== b.dueOn) return a.dueOn < b.dueOn ? -1 : 1
  const rank = sequenceRank(a.sequence) - sequenceRank(b.sequence)
  if (rank !== 0) return rank
  return a.sourceKey.localeCompare(b.sourceKey)
}

/**
 * Daily draft queue. Due follow-ups — including threads already past the 2-day
 * window — always fill the cap before any new first-touch. One email per lead
 * per day; the next step waits waitDays from that send.
 */
export function planDailyEmailQueue(args: {
  leads: readonly EmailQueueLead[]
  today: string
  maxEmailsPerDay?: number
  waitDays?: number
}): EmailQueuePlan {
  const today = args.today.slice(0, 10)
  const max = args.maxEmailsPerDay ?? EMAIL_FLOW_MAX_PER_DAY
  const waitDays = args.waitDays ?? EMAIL_FLOW_WAIT_DAYS
  const followUps: EmailQueueItem[] = []
  const newSequences: EmailQueueItem[] = []

  for (const lead of args.leads) {
    if (blocked(lead)) continue
    const n = nextSequenceStep(lead)
    if (!n) continue
    if (n === 1) {
      newSequences.push({
        sourceKey: lead.sourceKey,
        kind: 'new_sequence',
        n,
        dueOn: today,
        overdue: false,
        sequence: lead.sequence ?? 'New contact',
      })
      continue
    }
    const last = lastContactDate(lead)
    if (!last) continue
    const dueOn = addDays(last, waitDays)
    if (!isDueOnOrBefore(dueOn, today)) continue
    followUps.push({
      sourceKey: lead.sourceKey,
      kind: 'follow_up',
      n,
      dueOn,
      overdue: dueOn < today,
      sequence: lead.sequence ?? null,
    })
  }

  followUps.sort(compareQueueItems)
  newSequences.sort(compareQueueItems)

  const selected = followUps.slice(0, max)
  const remaining = Math.max(0, max - selected.length)
  selected.push(...newSequences.slice(0, remaining))

  return {
    today,
    followUps,
    newSequences,
    selected,
    deferredNew: Math.max(0, newSequences.length - remaining),
  }
}
