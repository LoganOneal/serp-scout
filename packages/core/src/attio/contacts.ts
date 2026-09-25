import { nameKey } from './domains.js'
import { isAttioStatus, mergeField } from './merge.js'
import type { AttioSequence, AttioStatus } from './types.js'
import { ATTIO_SEQUENCES } from './types.js'

const PRE_CONTACTED: ReadonlySet<AttioStatus> = new Set([
  'New',
  'Researching',
  'Contact Found',
  'Ready to Contact',
])

const PRE_REPLIED: ReadonlySet<AttioStatus> = new Set([
  'New',
  'Researching',
  'Contact Found',
  'Ready to Contact',
  'Contacted',
])

export const CONTACT_DATE_FIELDS = [
  'contact_1_date',
  'contact_2_date',
  'contact_3_date',
  'contact_4_date',
] as const

export type ContactDateField = (typeof CONTACT_DATE_FIELDS)[number]

export const GENERIC_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'yahoo.co.uk',
  'hotmail.com',
  'outlook.com',
  'live.com',
  'icloud.com',
  'me.com',
  'aol.com',
  'msn.com',
  'proton.me',
  'protonmail.com',
])

/** First outbound Editor's Choice template, inferred from the sent body. */
export type FirstTouchKind = 'asked_backlink' | 'no_backlink'

export interface GmailOutreachRow {
  email: string
  outbound: string[]
  inbound: string | null
  hotelHints?: string[]
  hhtSlugs?: string[]
  firstTouch?: FirstTouchKind
}

export interface OutreachLead {
  entryId: string
  sourceKey: string
  workstream: string
  personEmails: string[]
  companyDomains: string[]
  names?: string[]
}

export interface OutreachMatch {
  lead: OutreachLead
  row: GmailOutreachRow
  via: 'email' | 'domain' | 'slug'
  emails: string[]
}

export function normalizeIsoDate(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const match = value.trim().match(/^(\d{4}-\d{2}-\d{2})/)
  return match?.[1] ?? null
}

export function contactDatesFromOutbound(outbound: readonly string[]): Record<ContactDateField, string | null> {
  const dates = [...new Set(outbound.map(normalizeIsoDate).filter((d): d is string => Boolean(d)))].sort()
  return {
    contact_1_date: dates[0] ?? null,
    contact_2_date: dates[1] ?? null,
    contact_3_date: dates[2] ?? null,
    contact_4_date: dates[3] ?? null,
  }
}

export function emailDomain(email: string | null | undefined): string | null {
  if (!email) return null
  const at = email.trim().toLowerCase().lastIndexOf('@')
  if (at < 1) return null
  const domain = email.trim().toLowerCase().slice(at + 1)
  return domain.includes('.') ? domain : null
}

export function isGenericEmailDomain(domain: string | null | undefined): boolean {
  return Boolean(domain && GENERIC_EMAIL_DOMAINS.has(domain))
}

const HINT_STOP = /\b(and|the|hotel|hotels|inn|spa|resort|casino|lodge|at|by|of|feature|team)\b/g

export function compactHint(value: string | null | undefined): string {
  return nameKey(value).replace(HINT_STOP, ' ').replace(/\s+/g, '')
}

export function extractHotelFromSubject(subject: string | null | undefined): string | null {
  if (!subject?.trim()) return null
  const stripped = decodeEntities(subject).replace(/^(re|fw|fwd):\s*/gi, '').trim()
  const update = stripped.match(/update\s+(.+?)(?:'s|’s|'|’)\s+feature/i)
  if (update?.[1]?.trim()) return cleanHotelName(update[1])
  const forFeature = stripped.match(/(?:quick question about )?our feature for\s+(.+)$/i)
  if (forFeature?.[1]?.trim()) return cleanHotelName(forFeature[1])
  const quick = stripped.match(/quick question about (?:our feature for\s+)?(.+?)(?:'s|’s)?(?:\s+feature)?$/i)
  if (quick?.[1]?.trim() && !/^our feature$/i.test(quick[1])) return cleanHotelName(quick[1])
  const fromHht = stripped.match(/^hotel hot tubs\s*\/\s*(.+)$/i)
  if (fromHht?.[1]?.trim()) return cleanHotelName(fromHht[1])
  const toHht = stripped.match(/^(.+?)\s*\/\s*hotel hot tubs$/i)
  if (toHht?.[1]?.trim()) return cleanHotelName(toHht[1])
  const dash = stripped.match(/^(.+?)\s+[-–—]\s+hotel hot tubs editor/i)
  if (dash?.[1]?.trim()) return cleanHotelName(dash[1])
  return null
}

export function extractHotelFromBody(text: string | null | undefined): string | null {
  if (!text?.trim()) return null
  const decoded = decodeEntities(text)
  const selected = decoded.match(/selected\s+(.+?)\s+for our/i)
  if (selected?.[1]?.trim()) return cleanHotelName(selected[1])
  const update = decoded.match(/update\s+(.+?)(?:'s|’s|'|’)\s+feature/i)
  if (update?.[1]?.trim()) return cleanHotelName(update[1])
  return extractHotelFromSubject(decoded.split('\n')[0] ?? decoded)
}

export function extractHhtListingSlugs(text: string | null | undefined): string[] {
  if (!text) return []
  const out: string[] = []
  const re = /hotelhottubs\.com\/[a-z0-9-]+\/([a-z0-9-]+)/gi
  for (const match of decodedMatches(text, re)) {
    const slug = match[1]?.toLowerCase()
    if (slug && slug !== 'editors-choice') out.push(slug)
  }
  return [...new Set(out)]
}

export function classifyFirstTouch(text: string | null | undefined): FirstTouchKind | null {
  if (!text?.trim()) return null
  const t = decodeEntities(text).toLowerCase()
  const asked =
    /press (or|&|and) awards/.test(t) ||
    /press & awards/.test(t) ||
    /awards page/.test(t) ||
    /including the recognition/.test(t) ||
    (/badge/.test(t) && /logo files|suggested copy/.test(t))
  if (asked) return 'asked_backlink'
  if (/can you help us update/.test(t)) return 'no_backlink'
  if (/we currently (list|tie)|which (current )?(room|accommodation)/.test(t)) return 'no_backlink'
  if (/share some additional photos/.test(t)) return 'no_backlink'
  const firstLine = t.split('\n')[0] ?? t
  if (
    /editor['’]s choice 2026/.test(firstLine) &&
    !/update .+ feature/.test(firstLine) &&
    !/guest post|resource suggestion/.test(firstLine)
  ) {
    return 'asked_backlink'
  }
  if (
    /hotel hot tubs/.test(firstLine) &&
    !/update .+ feature/.test(firstLine) &&
    !/guest post|resource suggestion|unsubscribe/.test(firstLine)
  ) {
    return 'asked_backlink'
  }
  return null
}

export function sequenceFromFirstTouch(kind: FirstTouchKind | null | undefined): AttioSequence | null {
  if (kind === 'asked_backlink') return 'Asked backlink'
  if (kind === 'no_backlink') return 'Fact-check'
  return null
}

export function isAttioSequence(value: unknown): value is AttioSequence {
  return typeof value === 'string' && (ATTIO_SEQUENCES as readonly string[]).includes(value)
}

export function emailLocalPart(email: string | null | undefined): string | null {
  if (!email) return null
  const at = email.trim().toLowerCase().indexOf('@')
  if (at < 1) return null
  return email.trim().toLowerCase().slice(0, at)
}

function listingSlug(lead: OutreachLead): string {
  return lead.sourceKey.replace(/^(editor-choice|backlink|guest-post):/i, '').toLowerCase()
}

function leadNeedles(lead: OutreachLead): string[] {
  const slug = listingSlug(lead)
  const raw = [slug, ...(lead.names ?? [])]
  return [...new Set(raw.map(compactHint).filter((hint) => hint.length >= 5))]
}

function rowHints(row: GmailOutreachRow): string[] {
  const local = emailLocalPart(row.email)?.replace(/(pr|press|media|info|marketing)$/g, '') ?? ''
  const raw = [...(row.hotelHints ?? []), local]
  return [...new Set(raw.map(compactHint).filter((hint) => hint.length >= 5))]
}

function hintTokens(value: string): string[] {
  return nameKey(value)
    .replace(HINT_STOP, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 2)
    .sort()
}

function tokenSetEqual(left: string, right: string): boolean {
  const a = hintTokens(left)
  const b = hintTokens(right)
  if (a.length < 2 || a.length !== b.length) return false
  return a.join('|') === b.join('|')
}

function exactSlugMatch(row: GmailOutreachRow, lead: OutreachLead): boolean {
  const key = listingSlug(lead)
  if (row.hhtSlugs?.some((slug) => slug.toLowerCase() === key)) return true
  const names = [key, ...(lead.names ?? [])]
  if ((row.hotelHints ?? []).some((hint) => names.some((name) => tokenSetEqual(hint, name)))) return true
  const needles = leadNeedles(lead)
  if (!needles.length) return false
  return rowHints(row).some((hint) => needles.includes(hint))
}

function looseSlugMatch(row: GmailOutreachRow, lead: OutreachLead): boolean {
  const needles = leadNeedles(lead)
  if (!needles.length) return false
  return rowHints(row).some((hint) =>
    needles.some((needle) => {
      if (needle.includes(hint) && hint.length >= 6) return true
      if (hint.includes(needle) && needle.length >= 8) return true
      return false
    }),
  )
}

function slugMatches(row: GmailOutreachRow, lead: OutreachLead): boolean {
  return exactSlugMatch(row, lead) || looseSlugMatch(row, lead)
}

/**
 * Gmail-derived status may advance New → Contacted → Replied.
 * It never overwrites Positive / Won / No Response / Rejected.
 */
export function statusFromOutreach(
  current: AttioStatus | null | undefined,
  args: { contacted: boolean; replied: boolean; contactFound?: boolean },
): AttioStatus {
  const status = isAttioStatus(current) ? current : null
  if (args.replied) {
    if (!status || PRE_REPLIED.has(status)) return 'Replied'
    return status
  }
  if (args.contacted) {
    if (!status || PRE_CONTACTED.has(status)) return 'Contacted'
    return status
  }
  if (args.contactFound) {
    if (!status || status === 'New' || status === 'Researching') return 'Contact Found'
    return status
  }
  return status ?? 'New'
}

export function matchGmailToLeads(args: {
  rows: readonly GmailOutreachRow[]
  leads: readonly OutreachLead[]
}): { matches: OutreachMatch[]; unmatched: GmailOutreachRow[] } {
  const rows = mergeInboundByHotelHint(args.rows)
  const matches: OutreachMatch[] = []
  const matchedEntryIds = new Set<string>()
  const claimedEmails = new Set<string>()

  for (const lead of args.leads) {
    const emails = new Set(lead.personEmails.map((e) => e.toLowerCase()))
    const row = rows.find((r) => emails.has(r.email.toLowerCase()))
    if (!row) continue
    matches.push({ lead, row: mergeRows([row]), via: 'email', emails: [row.email.toLowerCase()] })
    matchedEntryIds.add(lead.entryId)
    claimedEmails.add(row.email.toLowerCase())
  }

  const remainingRows = rows.filter((row) => !claimedEmails.has(row.email.toLowerCase()))
  const byDomain = new Map<string, GmailOutreachRow[]>()
  for (const row of remainingRows) {
    const domain = emailDomain(row.email)
    if (!domain || isGenericEmailDomain(domain)) continue
    const list = byDomain.get(domain) ?? []
    list.push(row)
    byDomain.set(domain, list)
  }

  for (const [domain, domainRows] of byDomain) {
    const candidates = args.leads.filter(
      (lead) => !matchedEntryIds.has(lead.entryId) && lead.companyDomains.some((d) => d.toLowerCase() === domain),
    )
    if (candidates.length !== 1) continue
    const lead = candidates[0]!
    const row = mergeRows(domainRows)
    const emails = domainRows.map((used) => used.email.toLowerCase())
    matches.push({ lead, row, via: 'domain', emails })
    matchedEntryIds.add(lead.entryId)
    for (const used of emails) claimedEmails.add(used)
  }

  const leftoverRows = rows.filter((row) => !claimedEmails.has(row.email.toLowerCase()))
  const leftoverByLead = new Map<string, GmailOutreachRow[]>()
  const addLeftover = (lead: OutreachLead, row: GmailOutreachRow) => {
    const list = leftoverByLead.get(lead.entryId) ?? []
    list.push(row)
    leftoverByLead.set(lead.entryId, list)
  }
  for (const row of leftoverRows) {
    const exact = args.leads.filter((lead) => exactSlugMatch(row, lead))
    if (exact.length) {
      for (const lead of exact) addLeftover(lead, row)
      continue
    }
    const loose = args.leads.filter((lead) => looseSlugMatch(row, lead))
    if (loose.length === 1) addLeftover(loose[0]!, row)
  }
  for (const [entryId, grouped] of leftoverByLead) {
    const existing = matches.find((row) => row.lead.entryId === entryId)
    if (existing) {
      existing.row = mergeRows([existing.row, ...grouped])
      existing.emails = [...new Set([...existing.emails, ...grouped.map((used) => used.email.toLowerCase())])]
    } else {
      const lead = args.leads.find((row) => row.entryId === entryId)
      if (!lead) continue
      matches.push({
        lead,
        row: mergeRows(grouped),
        via: 'slug',
        emails: grouped.map((used) => used.email.toLowerCase()),
      })
      matchedEntryIds.add(lead.entryId)
    }
    for (const used of grouped) claimedEmails.add(used.email.toLowerCase())
  }

  for (const row of rows) {
    if (!(row.hotelHints?.length || row.hhtSlugs?.length)) continue
    const extras = args.leads.filter((lead) => !matchedEntryIds.has(lead.entryId) && exactSlugMatch(row, lead))
    for (const lead of extras) {
      matches.push({
        lead,
        row: mergeRows([row]),
        via: 'slug',
        emails: [row.email.toLowerCase()],
      })
      matchedEntryIds.add(lead.entryId)
      claimedEmails.add(row.email.toLowerCase())
    }
  }

  const unmatched = rows.filter((row) => !claimedEmails.has(row.email.toLowerCase()) && row.outbound.length > 0)
  return { matches, unmatched }
}

function mergeRows(rows: readonly GmailOutreachRow[]): GmailOutreachRow {
  const outbound = [...new Set(rows.flatMap((row) => row.outbound.map(normalizeIsoDate).filter((d): d is string => Boolean(d))))].sort()
  const inbounds = rows.map((row) => normalizeIsoDate(row.inbound)).filter((d): d is string => Boolean(d)).sort()
  const hotelHints = [...new Set(rows.flatMap((row) => row.hotelHints ?? []))]
  const hhtSlugs = [...new Set(rows.flatMap((row) => row.hhtSlugs ?? []))]
  const firstTouch = rows.some((row) => row.firstTouch === 'asked_backlink')
    ? 'asked_backlink'
    : rows.find((row) => row.firstTouch === 'no_backlink')?.firstTouch
  return {
    email: rows[0]?.email ?? '',
    outbound,
    inbound: inbounds[0] ?? null,
    hotelHints: hotelHints.length ? hotelHints : undefined,
    hhtSlugs: hhtSlugs.length ? hhtSlugs : undefined,
    firstTouch,
  }
}

export function mergeInboundByHotelHint(rows: readonly GmailOutreachRow[]): GmailOutreachRow[] {
  const inboundByHint = new Map<string, string>()
  for (const row of rows) {
    const inbound = normalizeIsoDate(row.inbound)
    if (!inbound) continue
    for (const hint of (row.hotelHints ?? []).map(compactHint).filter((h) => h.length >= 5)) {
      const current = inboundByHint.get(hint)
      if (!current || inbound < current) inboundByHint.set(hint, inbound)
    }
  }
  return rows.map((row) => {
    if (row.inbound) return { ...row }
    const inbound = (row.hotelHints ?? [])
      .map(compactHint)
      .map((hint) => inboundByHint.get(hint))
      .filter((d): d is string => Boolean(d))
      .sort()[0] ?? null
    return inbound ? { ...row, inbound } : { ...row }
  })
}

export function outreachCrmValues(args: {
  existing: Record<string, unknown>
  row: GmailOutreachRow
  firstFollowupDays: number
}): { values: Record<string, unknown>; updated: string[] } {
  const dates = contactDatesFromOutbound(args.row.outbound)
  const incoming: Record<string, unknown> = {
    ...dates,
    replied_at: args.row.inbound,
    outreach_date: dates.contact_1_date,
  }
  if (!args.row.inbound && dates.contact_1_date) {
    incoming.next_follow_up = addDaysIso(dates.contact_1_date, args.firstFollowupDays)
  }
  const sequence = sequenceFromFirstTouch(args.row.firstTouch)
  if (sequence) incoming.sequence = sequence

  const values: Record<string, unknown> = {}
  const updated: string[] = []
  for (const [key, next] of Object.entries(incoming)) {
    const merged = mergeField({ owner: 'crm', current: args.existing[key], incoming: next })
    if (merged.skipped) continue
    values[key] = merged.value
    updated.push(key)
  }

  const currentStatus = isAttioStatus(args.existing.status) ? args.existing.status : null
  const next = statusFromOutreach(currentStatus, {
    contacted: Boolean(dates.contact_1_date),
    replied: Boolean(args.row.inbound),
  })
  if (next !== currentStatus) {
    values.status = next
    updated.push('status')
  }

  return { values, updated }
}

function addDaysIso(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function decodeEntities(value: string): string {
  return value
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
}

function cleanHotelName(value: string): string {
  return decodeEntities(value)
    .replace(/\s+/g, ' ')
    .replace(/\s+’s feature$/i, '')
    .trim()
}

function* decodedMatches(text: string, re: RegExp): Generator<RegExpExecArray> {
  const decoded = decodeEntities(text)
  let match: RegExpExecArray | null
  while ((match = re.exec(decoded))) yield match
}
