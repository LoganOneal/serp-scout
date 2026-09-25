import { readFileSync } from 'node:fs'
import { ATTIO_LISTS, emptyReport, isAttioStatus, statusFromOutreach, tally, type SyncReport } from '@rnr/core'
import { AttioClient, AttioError } from './client.js'
import { encodeEntryValues, entryValuesMap, splitName } from './values.js'

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

export interface ContactPatch {
  source_key: string
  action: string
  contact_name?: string | null
  contact_email?: string | null
  contact_phone?: string | null
  contact_route_url?: string | null
  native_form?: boolean
  notes?: string | null
  existing_person_record_id?: string | null
  replace_primary_contact_record_id?: string | null
  suppress_outreach?: boolean
}

export interface FieldPatch {
  source_key: string
  action: string
  new_press_media_page?: string | null
  new_hotel_website?: string | null
  notes?: string | null
}

export interface EditorsChoicePatchPlan {
  attio_list_slug?: string
  contact_patches?: ContactPatch[]
  press_media_patches?: FieldPatch[]
  hotel_website_patches?: FieldPatch[]
  suppressed_leads?: string[]
}

const SUPPRESS_NOTE = 'Suppressed: excluded from Editor’s Choice outreach.'

export function loadEditorsChoicePatchPlan(path: string): EditorsChoicePatchPlan {
  return JSON.parse(readFileSync(path, 'utf8')) as EditorsChoicePatchPlan
}

export async function applyEditorsChoicePatches(args: {
  client: AttioClient
  plan: EditorsChoicePatchPlan
  dryRun: boolean
}): Promise<SyncReport> {
  const report = emptyReport(args.dryRun, 'editors-choice-patches')
  const listSlug = args.plan.attio_list_slug ?? ATTIO_LISTS['editors-choice'].slug
  const entries = await queryAllEntries(args.client, listSlug)
  const byKey = new Map<string, EntryHit>()
  for (const entry of entries) {
    const key = asText(entryValuesMap(entry).source_key)
    if (key) byKey.set(key, entry)
  }

  const contactPatches = args.plan.contact_patches ?? []
  report.counts.source = contactPatches.length
    + (args.plan.press_media_patches?.length ?? 0)
    + (args.plan.hotel_website_patches?.length ?? 0)

  for (const patch of contactPatches) {
    await applyContactPatch({ client: args.client, listSlug, byKey, patch, dryRun: args.dryRun, report })
  }
  for (const patch of args.plan.press_media_patches ?? []) {
    await patchField({
      client: args.client,
      listSlug,
      byKey,
      sourceKey: patch.source_key,
      field: 'press_media_page',
      value: patch.action === 'set' ? patch.new_press_media_page ?? null : null,
      dryRun: args.dryRun,
      report,
    })
  }
  for (const patch of args.plan.hotel_website_patches ?? []) {
    const clear = patch.action === 'clear' || patch.action === 'clear_or_review'
    await patchField({
      client: args.client,
      listSlug,
      byKey,
      sourceKey: patch.source_key,
      field: 'hotel_website',
      value: clear ? null : patch.new_hotel_website ?? null,
      dryRun: args.dryRun,
      report,
    })
  }

  const refreshed = await queryAllEntries(args.client, listSlug)
  await restoreStatusesFromTouches({ client: args.client, listSlug, entries: refreshed, dryRun: args.dryRun, report })
  return tally(report)
}

export async function restoreEditorsChoiceStatuses(args: {
  client: AttioClient
  dryRun: boolean
}): Promise<SyncReport> {
  const report = emptyReport(args.dryRun, 'editors-choice-status-restore')
  const listSlug = ATTIO_LISTS['editors-choice'].slug
  const entries = await queryAllEntries(args.client, listSlug)
  await restoreStatusesFromTouches({ client: args.client, listSlug, entries, dryRun: args.dryRun, report })
  return tally(report)
}

async function restoreStatusesFromTouches(args: {
  client: AttioClient
  listSlug: string
  entries: EntryHit[]
  dryRun: boolean
  report: SyncReport
}): Promise<void> {
  for (const entry of args.entries) {
    const values = entryValuesMap(entry)
    const sourceKey = asText(values.source_key) ?? entry.id.entry_id
    const current = isAttioStatus(values.status) ? values.status : null
    const next = statusFromOutreach(current, {
      contacted: Boolean(asText(values.contact_1_date) ?? values.contact_1_date),
      replied: Boolean(asText(values.replied_at) ?? values.replied_at),
      contactFound: Boolean(values.primary_contact),
    })
    if (next === current) continue
    await writeEntry({
      client: args.client,
      listSlug: args.listSlug,
      entry,
      payload: { status: next },
      dryRun: args.dryRun,
      report: args.report,
      name: sourceKey,
      reason: `status:${current ?? 'blank'}->${next}`,
    })
  }
}

async function applyContactPatch(args: {
  client: AttioClient
  listSlug: string
  byKey: Map<string, EntryHit>
  patch: ContactPatch
  dryRun: boolean
  report: SyncReport
}): Promise<void> {
  const { patch, byKey, client, listSlug, dryRun, report } = args
  const entry = byKey.get(patch.source_key)
  if (!entry) {
    report.skipped.push({ kind: 'entry', action: 'skip', name: patch.source_key, reason: 'missing_list_entry' })
    return
  }
  const existing = entryValuesMap(entry)
  const payload: Record<string, unknown> = {}

  if (patch.action === 'clear_primary_contact_and_suppress_outreach' || patch.suppress_outreach) {
    payload.primary_contact = null
    payload.suppress_outreach = true
    payload.press_media_page = null
    const notes = asText(existing.outcome_notes)
    if (!notes?.includes('Suppressed')) {
      payload.outcome_notes = notes ? `${notes}\n${SUPPRESS_NOTE}` : SUPPRESS_NOTE
    }
    await writeEntry({ client, listSlug, entry, payload, dryRun, report, name: patch.source_key, reason: 'suppress' })
    return
  }

  let personId: string | null = patch.existing_person_record_id ?? null
  const email = patch.contact_email?.trim().toLowerCase() || null
  if (!personId && email) {
    personId = await upsertPersonByEmail({
      client,
      email,
      name: patch.contact_name,
      phone: patch.contact_phone,
      description: personDescription(patch),
      companyRecordId: entry.parent_record_id,
      dryRun,
      report,
    })
  } else if (!personId && patch.contact_name) {
    personId = await createPersonWithoutEmail({
      client,
      name: patch.contact_name,
      phone: patch.contact_phone,
      description: personDescription(patch),
      companyRecordId: entry.parent_record_id,
      dryRun,
      report,
      sourceKey: patch.source_key,
    })
  } else if (personId && !dryRun) {
    await associateCompany(client, personId, entry.parent_record_id).catch(() => undefined)
  }

  if (personId) payload.primary_contact = personId
  const noteBits = [asText(existing.outcome_notes), patch.notes, routeNote(patch)].filter(Boolean)
  if (noteBits.length && !asText(existing.outcome_notes)) {
    payload.outcome_notes = uniqueNotes(noteBits)
  }

  if (!Object.keys(payload).length) {
    report.skipped.push({ kind: 'entry', action: 'skip', name: patch.source_key, reason: 'nothing_to_patch' })
    return
  }
  await writeEntry({
    client,
    listSlug,
    entry,
    payload,
    dryRun,
    report,
    name: patch.source_key,
    reason: patch.action,
  })
}

async function patchField(args: {
  client: AttioClient
  listSlug: string
  byKey: Map<string, EntryHit>
  sourceKey: string
  field: 'press_media_page' | 'hotel_website'
  value: string | null
  dryRun: boolean
  report: SyncReport
}): Promise<void> {
  const entry = args.byKey.get(args.sourceKey)
  if (!entry) {
    args.report.skipped.push({ kind: 'entry', action: 'skip', name: args.sourceKey, reason: `missing_list_entry:${args.field}` })
    return
  }
  const current = asText(entryValuesMap(entry)[args.field])
  const next = args.value?.trim() || null
  if ((current ?? null) === next) {
    args.report.entries.push({ kind: 'entry', action: 'skip', name: args.sourceKey, reason: `${args.field}:unchanged` })
    return
  }
  await writeEntry({
    client: args.client,
    listSlug: args.listSlug,
    entry,
    payload: { [args.field]: next },
    dryRun: args.dryRun,
    report: args.report,
    name: args.sourceKey,
    reason: `${args.field}:${next ? 'set' : 'clear'}`,
  })
}

async function writeEntry(args: {
  client: AttioClient
  listSlug: string
  entry: EntryHit
  payload: Record<string, unknown>
  dryRun: boolean
  report: SyncReport
  name: string
  reason: string
}): Promise<void> {
  args.report.entries.push({ kind: 'entry', action: 'update', name: args.name, reason: args.reason })
  if (args.dryRun) return
  try {
    await args.client.patch(`/lists/${args.listSlug}/entries/${args.entry.id.entry_id}`, {
      data: { entry_values: encodeEntryValues(args.payload) },
    })
  } catch (err) {
    args.report.errors.push({
      kind: 'entry',
      action: 'error',
      name: args.name,
      reason: err instanceof Error ? err.message : String(err),
    })
  }
}

async function upsertPersonByEmail(args: {
  client: AttioClient
  email: string
  name?: string | null
  phone?: string | null
  description: string
  companyRecordId: string
  dryRun: boolean
  report: SyncReport
}): Promise<string | null> {
  const values: Record<string, unknown> = {
    email_addresses: [args.email],
  }
  if (args.name?.trim()) values.name = splitName(args.name)
  const phone = e164Phone(args.phone)
  if (phone) values.phone_numbers = [phone]
  if (args.description) values.description = args.description
  values.company = [{ target_object: 'companies', target_record_id: args.companyRecordId }]

  if (args.dryRun) {
    args.report.people.push({ kind: 'person', action: 'update', name: args.email })
    return `dry-run:${args.email}`
  }
  try {
    const res = await args.client.put<{ data: RecordHit }>('/objects/people/records', {
      data: { values },
    }, { matching_attribute: 'email_addresses' })
    const id = res.data.id.record_id
    args.report.people.push({ kind: 'person', action: 'update', name: args.email, id })
    return id
  } catch (err) {
    args.report.errors.push({
      kind: 'person',
      action: 'error',
      name: args.email,
      reason: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

async function createPersonWithoutEmail(args: {
  client: AttioClient
  name: string
  phone?: string | null
  description: string
  companyRecordId: string
  dryRun: boolean
  report: SyncReport
  sourceKey: string
}): Promise<string | null> {
  if (args.dryRun) {
    args.report.people.push({ kind: 'person', action: 'create', name: args.name })
    return `dry-run:${args.sourceKey}`
  }
  const values: Record<string, unknown> = {
    name: splitName(args.name),
    company: [{ target_object: 'companies', target_record_id: args.companyRecordId }],
  }
  const phone = e164Phone(args.phone)
  if (phone) values.phone_numbers = [phone]
  if (args.description) values.description = args.description
  try {
    const res = await args.client.post<{ data: RecordHit }>('/objects/people/records', { data: { values } })
    const id = res.data.id.record_id
    args.report.people.push({ kind: 'person', action: 'create', name: args.name, id })
    return id
  } catch (err) {
    args.report.skipped.push({
      kind: 'person',
      action: 'skip',
      name: args.sourceKey,
      reason: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

async function associateCompany(client: AttioClient, personId: string, companyRecordId: string): Promise<void> {
  await client.patch(`/objects/people/records/${personId}`, {
    data: { values: { company: [{ target_object: 'companies', target_record_id: companyRecordId }] } },
  })
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

function personDescription(patch: ContactPatch): string {
  return uniqueNotes([
    patch.notes,
    patch.contact_route_url ? `Contact route: ${patch.contact_route_url}` : null,
    patch.native_form ? 'Native first-party inquiry form.' : null,
    patch.contact_phone && !e164Phone(patch.contact_phone) ? `Phone: ${patch.contact_phone}` : null,
  ])
}

function routeNote(patch: ContactPatch): string | null {
  if (patch.contact_email) return null
  if (patch.contact_route_url) return `Best contact route (no public email): ${patch.contact_route_url}`
  return null
}

function uniqueNotes(parts: Array<string | null | undefined>): string {
  return [...new Set(parts.map((part) => part?.trim()).filter((part): part is string => Boolean(part)))].join('\n')
}

function e164Phone(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null
  const digits = raw.replace(/\D/g, '')
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  return null
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export { AttioError }
