import {
  ATTIO_LISTS,
  emptyReport,
  mergeEntryValues,
  tally,
  type AttioSourceTarget,
  type AttioWorkstream,
  type SyncReport,
} from '@rnr/core'
import { AttioClient, AttioError } from './client.js'
import { encodeEntryValues, entryValuesMap, splitName } from './values.js'

interface RecordHit {
  id: { record_id: string }
  values?: Record<string, unknown>
}

interface EntryHit {
  id: { entry_id: string; list_id: string }
  parent_record_id: string
  entry_values?: Record<string, unknown>
  values?: Record<string, unknown>
}

export async function syncTargets(args: {
  client: AttioClient
  workstream: AttioWorkstream
  targets: AttioSourceTarget[]
  dryRun: boolean
  staleKeys?: string[]
}): Promise<SyncReport> {
  const report = emptyReport(args.dryRun, args.workstream)
  report.counts.source = args.targets.length
  const listSlug = ATTIO_LISTS[args.workstream].slug

  let i = 0
  for (const target of args.targets) {
    i += 1
    if (!args.dryRun && (i === 1 || i === args.targets.length || i % 25 === 0)) {
      console.error(`attio sync ${args.workstream} ${i}/${args.targets.length} ${target.sourceKey}`)
    }
    try {
      await syncOne({ client: args.client, listSlug, target, dryRun: args.dryRun, report })
    } catch (err) {
      report.errors.push({
        kind: 'entry',
        action: 'error',
        name: target.sourceKey,
        reason: err instanceof Error ? err.message : String(err),
      })
    }
  }

  for (const key of args.staleKeys ?? []) {
    report.stale.push({ kind: 'entry', action: 'stale', name: key, reason: 'missing_from_source' })
  }
  return tally(report)
}

async function syncOne(args: {
  client: AttioClient
  listSlug: string
  target: AttioSourceTarget
  dryRun: boolean
  report: SyncReport
}): Promise<void> {
  const { client, listSlug, target, dryRun, report } = args
  const company = await upsertCompany(client, target, dryRun, report)
  let personId: string | null = null
  if (target.contact?.email) {
    personId = await upsertPerson(client, target, company.recordId, dryRun, report)
  } else {
    report.skipped.push({ kind: 'person', action: 'skip', name: target.sourceKey, reason: 'no_contact_in_source' })
  }

  const existing = dryRun && !company.recordId ? null : await findEntry(client, listSlug, target.sourceKey)
  const merged = mergeEntryValues({
    existing: existing ? entryValuesMap(existing) : null,
    sourceOwned: target.sourceOwned,
    crmOwned: personId ? { primary_contact: personId } : undefined,
    isCreate: !existing,
  })

  if (!existing) {
    report.entries.push({ kind: 'entry', action: 'create', name: target.sourceKey, reason: target.companyName })
    if (!dryRun && company.recordId) {
      await client.post(`/lists/${listSlug}/entries`, {
        data: {
          parent_record_id: company.recordId,
          parent_object: 'companies',
          entry_values: encodeEntryValues(merged.values),
        },
      })
    }
  } else {
    const changed = merged.updated.filter((key) => key !== 'status')
    report.entries.push({
      kind: 'entry',
      action: changed.length ? 'update' : 'skip',
      name: target.sourceKey,
      reason: changed.length ? changed.join(',') : 'unchanged',
    })
    if (!dryRun && changed.length) {
      const payload: Record<string, unknown> = {}
      for (const key of changed) payload[key] = merged.values[key]
      await client.patch(`/lists/${listSlug}/entries/${existing.id.entry_id}`, {
        data: { entry_values: encodeEntryValues(payload) },
      })
    }
  }

  if (target.noteTitle && target.noteBody && company.recordId) {
    await maybeNote(client, company.recordId, target.noteTitle, target.noteBody, dryRun, report)
  }
}

async function upsertCompany(
  client: AttioClient,
  target: AttioSourceTarget,
  dryRun: boolean,
  report: SyncReport,
): Promise<{ recordId: string | null; created: boolean }> {
  if (target.domain) {
    const found = await queryRecords(client, 'companies', { domains: target.domain })
    if (found[0]) {
      report.companies.push({ kind: 'company', action: 'skip', name: target.domain, id: found[0].id.record_id, reason: 'matched_domain' })
      if (!dryRun) {
        await client.patch(`/objects/companies/records/${found[0].id.record_id}`, {
          data: { values: { name: target.companyName } },
        })
      }
      return { recordId: found[0].id.record_id, created: false }
    }
    report.companies.push({ kind: 'company', action: 'create', name: target.domain, reason: target.companyName })
    if (dryRun) return { recordId: null, created: true }
    const created = await client.put<{ data: RecordHit }>('/objects/companies/records', {
      data: { values: { domains: [target.domain], name: target.companyName } },
    }, { matching_attribute: 'domains' })
    return { recordId: created.data.id.record_id, created: true }
  }

  const found = await queryRecords(client, 'companies', { name: target.companyName })
  if (found[0]) {
    report.companies.push({ kind: 'company', action: 'skip', name: target.companyName, id: found[0].id.record_id, reason: 'matched_name_no_domain' })
    return { recordId: found[0].id.record_id, created: false }
  }
  report.companies.push({ kind: 'company', action: 'create', name: target.companyName, reason: 'no_domain' })
  if (dryRun) return { recordId: null, created: true }
  const created = await client.post<{ data: RecordHit }>('/objects/companies/records', {
    data: { values: { name: target.companyName } },
  })
  return { recordId: created.data.id.record_id, created: true }
}

async function upsertPerson(
  client: AttioClient,
  target: AttioSourceTarget,
  companyRecordId: string | null,
  dryRun: boolean,
  report: SyncReport,
): Promise<string | null> {
  const email = target.contact!.email
  try {
    const found = await queryRecords(client, 'people', { email_addresses: email })
    const values: Record<string, unknown> = {
      email_addresses: [email],
    }
    if (target.contact?.name) values.name = splitName(target.contact.name)
    if (target.contact?.jobTitle) values.job_title = target.contact.jobTitle
    if (companyRecordId) values.company = [{ target_object: 'companies', target_record_id: companyRecordId }]

    if (found[0]) {
      report.people.push({ kind: 'person', action: 'update', name: email, id: found[0].id.record_id })
      if (!dryRun) {
        await client.patch(`/objects/people/records/${found[0].id.record_id}`, { data: { values } })
      }
      return found[0].id.record_id
    }
    report.people.push({ kind: 'person', action: 'create', name: email })
    if (dryRun) return null
    const created = await client.put<{ data: RecordHit }>('/objects/people/records', {
      data: { values },
    }, { matching_attribute: 'email_addresses' })
    return created.data.id.record_id
  } catch (err) {
    if (err instanceof AttioError && (err.status === 400 || /email_addresses/i.test(err.message))) {
      report.skipped.push({
        kind: 'person',
        action: 'skip',
        name: target.sourceKey,
        reason: 'invalid_email',
      })
      return null
    }
    throw err
  }
}

async function findEntry(client: AttioClient, listSlug: string, sourceKey: string): Promise<EntryHit | null> {
  const res = await client.post<{ data: EntryHit[] }>(`/lists/${listSlug}/entries/query`, {
    filter: { source_key: sourceKey },
    limit: 5,
  })
  return res.data?.[0] ?? null
}

async function queryRecords(
  client: AttioClient,
  object: 'companies' | 'people',
  filter: Record<string, unknown>,
): Promise<RecordHit[]> {
  const res = await client.post<{ data: RecordHit[] }>(`/objects/${object}/records/query`, {
    filter,
    limit: 5,
  })
  return res.data ?? []
}

async function maybeNote(
  client: AttioClient,
  companyRecordId: string,
  title: string,
  content: string,
  dryRun: boolean,
  report: SyncReport,
): Promise<void> {
  const existing = await client.get<{ data: Array<{ title?: string }> }>('/notes', {
    parent_object: 'companies',
    parent_record_id: companyRecordId,
    limit: 50,
  }).catch((err: unknown) => {
    if (err instanceof AttioError && err.status === 400) return { data: [] }
    throw err
  })
  if ((existing.data ?? []).some((note) => note.title === title)) {
    report.notes.push({ kind: 'note', action: 'skip', name: title, reason: 'already_exists' })
    return
  }
  report.notes.push({ kind: 'note', action: 'create', name: title })
  if (dryRun) return
  await client.post('/notes', {
    data: {
      parent_object: 'companies',
      parent_record_id: companyRecordId,
      title,
      content,
      format: 'plaintext',
    },
  })
}

export async function listSourceKeys(client: AttioClient, workstream: AttioWorkstream): Promise<string[]> {
  const listSlug = ATTIO_LISTS[workstream].slug
  const keys: string[] = []
  let offset = 0
  while (true) {
    const res = await client.post<{ data: EntryHit[] }>(`/lists/${listSlug}/entries/query`, {
      limit: 500,
      offset,
    })
    const page = res.data ?? []
    for (const entry of page) {
      const values = entryValuesMap(entry)
      if (typeof values.source_key === 'string') keys.push(values.source_key)
    }
    if (page.length < 500) break
    offset += page.length
  }
  return keys
}
