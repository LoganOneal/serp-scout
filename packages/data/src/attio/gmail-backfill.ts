import { readFileSync } from 'node:fs'
import {
  ATTIO_LISTS,
  ATTIO_WORKSTREAMS,
  canonicalCompanyDomain,
  emailDomain,
  emptyReport,
  extractHhtListingSlugs,
  isGenericEmailDomain,
  matchGmailToLeads,
  mergeInboundByHotelHint,
  outreachCrmValues,
  tally,
  type AttioWorkstream,
  type GmailOutreachRow,
  type OutreachLead,
  type SyncReport,
} from '@rnr/core'
import { AttioClient } from './client.js'
import { encodeEntryValues, entryValuesMap, unwrapValue } from './values.js'

interface EntryHit {
  id: { entry_id: string; list_id: string }
  parent_record_id: string
  entry_values?: Record<string, unknown>
  values?: Record<string, unknown>
}

interface RecordHit {
  id: { record_id: string }
  values?: Record<string, unknown>
}

export interface GmailOutreachFile {
  source?: string
  capturedAt?: string
  rows: GmailOutreachRow[]
}

export function loadGmailOutreachFile(path: string): GmailOutreachFile {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as GmailOutreachFile
  if (!Array.isArray(parsed.rows)) throw new Error(`Gmail outreach file ${path} is missing rows[]`)
  const rows = mergeInboundByHotelHint(
    parsed.rows.map((row) => ({
      email: String(row.email ?? '').trim().toLowerCase(),
      outbound: Array.isArray(row.outbound) ? row.outbound : [],
      inbound: row.inbound ? String(row.inbound) : null,
      hotelHints: Array.isArray(row.hotelHints) ? row.hotelHints.map(String) : undefined,
      hhtSlugs: Array.isArray(row.hhtSlugs) ? row.hhtSlugs.map(String) : undefined,
      firstTouch: row.firstTouch === 'asked_backlink' || row.firstTouch === 'no_backlink' ? row.firstTouch : undefined,
    })).filter((row) => row.email.includes('@')),
  ).filter((row) => row.outbound.length > 0)
  return { ...parsed, rows }
}

export async function backfillOutreachFromGmail(args: {
  client: AttioClient
  dryRun: boolean
  rows: readonly GmailOutreachRow[]
  workstreams?: AttioWorkstream[]
  env?: Record<string, string | undefined>
}): Promise<SyncReport> {
  const report = emptyReport(args.dryRun, 'gmail-outreach')
  report.counts.source = args.rows.length
  const firstFollowupDays = 2
  const sources = args.workstreams?.length ? args.workstreams : [...ATTIO_WORKSTREAMS]

  const peopleById = await peopleByGmailEmails(args.client, args.rows)
  const companiesById = await companiesByGmailDomains(args.client, args.rows)

  const claimedEmails = new Set<string>()
  for (const workstream of sources) {
    const listSlug = ATTIO_LISTS[workstream].slug
    const entries = await queryAllEntries(args.client, listSlug)
    const leads: OutreachLead[] = entries.map((entry) => {
      const values = entryValuesMap(entry)
      const personId = typeof values.primary_contact === 'string' ? values.primary_contact : null
      const person = personId ? peopleById.get(personId) : undefined
      const company = companiesById.get(entry.parent_record_id)
      const sourceKey = asText(values.source_key) ?? entry.id.entry_id
      return {
        entryId: entry.id.entry_id,
        sourceKey,
        workstream,
        personEmails: person?.emails ?? [],
        companyDomains: [
          ...new Set([
            ...(company?.domains ?? []),
            ...domainsFromEntry(values),
          ]),
        ],
        names: namesFromEntry(sourceKey, values),
      }
    })

    const { matches } = matchGmailToLeads({ rows: args.rows, leads })

    for (const match of matches) {
      for (const email of match.emails) claimedEmails.add(email)
      const entry = entries.find((row) => row.id.entry_id === match.lead.entryId)
      if (!entry) continue
      const existing = entryValuesMap(entry)
      const patch = outreachCrmValues({ existing, row: match.row, firstFollowupDays })
      if (!patch.updated.length) {
        report.entries.push({
          kind: 'entry',
          action: 'skip',
          name: match.lead.sourceKey,
          reason: `${match.via}:unchanged`,
        })
        continue
      }
      report.entries.push({
        kind: 'entry',
        action: 'update',
        name: match.lead.sourceKey,
        reason: `${match.via}:${patch.updated.join(',')}`,
      })
      if (args.dryRun) continue
      try {
        await args.client.patch(`/lists/${listSlug}/entries/${entry.id.entry_id}`, {
          data: { entry_values: encodeEntryValues(patch.values) },
        })
      } catch (err) {
        report.errors.push({
          kind: 'entry',
          action: 'error',
          name: match.lead.sourceKey,
          reason: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  for (const row of args.rows) {
    if (claimedEmails.has(row.email.toLowerCase())) continue
    report.skipped.push({
      kind: 'entry',
      action: 'skip',
      name: row.email,
      reason: 'no_matching_lead',
    })
  }

  return tally(report)
}

async function peopleByGmailEmails(
  client: AttioClient,
  rows: readonly GmailOutreachRow[],
): Promise<Map<string, { emails: string[] }>> {
  const byId = new Map<string, { emails: string[] }>()
  for (const row of rows) {
    const records = await queryRecords(client, 'people', {
      email_addresses: { email_address: { $eq: row.email } },
    })
    for (const record of records) {
      const emails = collectKeyed(record.values?.email_addresses, 'email_address')
      const current = byId.get(record.id.record_id) ?? { emails: [] }
      byId.set(record.id.record_id, { emails: [...new Set([...current.emails, ...emails, row.email])] })
    }
  }
  return byId
}

async function companiesByGmailDomains(
  client: AttioClient,
  rows: readonly GmailOutreachRow[],
): Promise<Map<string, { domains: string[] }>> {
  const domains = [...new Set(rows.map((row) => emailDomain(row.email)).filter((d): d is string => Boolean(d) && !isGenericEmailDomain(d)))]
  const byId = new Map<string, { domains: string[] }>()
  for (const domain of domains) {
    const records = await queryRecords(client, 'companies', {
      domains: { domain: { $eq: domain } },
    })
    for (const record of records) {
      const found = collectKeyed(record.values?.domains, 'domain')
      const current = byId.get(record.id.record_id) ?? { domains: [] }
      byId.set(record.id.record_id, { domains: [...new Set([...current.domains, ...found, domain])] })
    }
  }
  return byId
}

async function queryRecords(
  client: AttioClient,
  object: 'people' | 'companies',
  filter: Record<string, unknown>,
): Promise<RecordHit[]> {
  try {
    const res = await client.post<{ data: RecordHit[] }>(`/objects/${object}/records/query`, {
      filter,
      limit: 50,
    })
    return res.data ?? []
  } catch {
    return []
  }
}

async function queryAllEntries(client: AttioClient, listSlug: string): Promise<EntryHit[]> {
  const out: EntryHit[] = []
  let offset = 0
  while (true) {
    const res = await client.post<{ data: EntryHit[] }>(`/lists/${listSlug}/entries/query`, {
      limit: 500,
      offset,
    })
    const page = res.data ?? []
    out.push(...page)
    if (page.length < 500) break
    offset += page.length
  }
  return out
}

function collectKeyed(raw: unknown, key: 'email_address' | 'domain'): string[] {
  if (raw == null) return []
  const items = Array.isArray(raw) ? raw : [raw]
  const out: string[] = []
  for (const item of items) {
    const value = unwrapValue(item)
    if (typeof value === 'string' && value.trim()) out.push(value.trim().toLowerCase())
    else if (item && typeof item === 'object' && typeof (item as Record<string, unknown>)[key] === 'string') {
      out.push(String((item as Record<string, unknown>)[key]).trim().toLowerCase())
    }
  }
  return [...new Set(out)]
}

function asText(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim()
  return null
}

const ENTRY_URL_FIELDS = [
  'hotel_website',
  'hht_listing_url',
  'press_media_page',
  'target_article_url',
  'guidelines_url',
  'target_page_url',
] as const

function domainsFromEntry(values: Record<string, unknown>): string[] {
  const out: string[] = []
  for (const field of ENTRY_URL_FIELDS) {
    const domain = canonicalCompanyDomain(asText(values[field]))?.domain
    if (domain) out.push(domain)
  }
  return out
}

function namesFromEntry(sourceKey: string, values: Record<string, unknown>): string[] {
  const slug = sourceKey.replace(/^(editor-choice|backlink|guest-post):/i, '')
  return [
    slug,
    ...extractHhtListingSlugs(asText(values.hht_listing_url) ?? ''),
    asText(values.article_title),
    asText(values.hotel_website),
  ].filter((name): name is string => Boolean(name))
}
