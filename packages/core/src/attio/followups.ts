import { DEFAULT_FOLLOWUP_CADENCE, type FollowupCadence } from './types.js'
import { followupMarker } from './source-keys.js'

export function parseFollowupCadence(env: Record<string, string | undefined> = process.env): FollowupCadence {
  const first = Number(env.ATTIO_FOLLOWUP_FIRST_DAYS ?? DEFAULT_FOLLOWUP_CADENCE.firstDays)
  const second = Number(env.ATTIO_FOLLOWUP_SECOND_DAYS ?? DEFAULT_FOLLOWUP_CADENCE.secondDays)
  return {
    firstDays: Number.isFinite(first) && first > 0 ? first : DEFAULT_FOLLOWUP_CADENCE.firstDays,
    secondDays: Number.isFinite(second) && second > 0 ? second : DEFAULT_FOLLOWUP_CADENCE.secondDays,
  }
}

export function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

export function todayUtc(now = new Date()): string {
  return now.toISOString().slice(0, 10)
}

export function isDueOnOrBefore(nextFollowup: string | null | undefined, today = todayUtc()): boolean {
  if (!nextFollowup) return false
  return nextFollowup.slice(0, 10) <= today
}

export function nextFollowupNumber(existingMarkers: number[]): number {
  if (!existingMarkers.includes(1)) return 1
  if (!existingMarkers.includes(2)) return 2
  return 0
}

/** Prefer the CRM Next Follow-up date. If blank, derive from outreach + cadence. */
export function followupDueDate(args: {
  outreachDate: string | null
  nextFollowup: string | null
  existingNumbers: number[]
  cadence: FollowupCadence
}): string | null {
  if (args.nextFollowup) return args.nextFollowup.slice(0, 10)
  if (!args.outreachDate) return null
  const n = nextFollowupNumber(args.existingNumbers)
  if (n === 1) return addDays(args.outreachDate, args.cadence.firstDays)
  if (n === 2) return addDays(args.outreachDate, args.cadence.firstDays + args.cadence.secondDays)
  return null
}

export function followupTaskContent(args: {
  sourceKey: string
  n: number
  workstream: string
  companyName: string
  contactName?: string | null
  targetUrl?: string | null
  outreachDate?: string | null
  attioUrl?: string | null
}): string {
  const marker = followupMarker(args.sourceKey, args.n)
  return [
    `Follow-up #${args.n} for ${args.companyName} (${args.workstream}).`,
    args.contactName ? `Contact: ${args.contactName}` : 'Contact: unknown — do not invent one.',
    args.targetUrl ? `Target: ${args.targetUrl}` : null,
    args.outreachDate ? `Original outreach: ${args.outreachDate}` : null,
    args.attioUrl ? `Attio: ${args.attioUrl}` : null,
    'Do not send email automatically. Draft or send only after a human/agent reviews.',
    marker,
  ]
    .filter(Boolean)
    .join('\n')
}

export function parseIsoDate(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const match = value.trim().match(/^(\d{4}-\d{2}-\d{2})/)
  return match?.[1] ?? null
}
