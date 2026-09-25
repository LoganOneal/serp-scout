import {
  allListSpecs,
  emptyReport,
  printReport,
  tally,
  type AttioAttributeSpec,
  type AttioListSpec,
  type AttioWorkstream,
  type SyncReport,
} from '@rnr/core'
import { AttioClient, AttioError } from './client.js'

interface AttioList {
  id: { list_id: string }
  api_slug: string
  name: string
  parent_object?: string[]
}

interface AttioAttribute {
  id: { attribute_id: string }
  api_slug: string
  title: string
  type: string
  is_unique?: boolean
}

export async function setupAttioLists(args: {
  client: AttioClient
  dryRun: boolean
  workstreams?: AttioWorkstream[]
}): Promise<SyncReport> {
  const report = emptyReport(args.dryRun)
  const specs = args.workstreams?.length
    ? allListSpecs().filter((spec) => args.workstreams!.includes(spec.workstream))
    : allListSpecs()

  const lists = await listAllLists(args.client)
  for (const spec of specs) {
    const existing = lists.find((row) => row.api_slug === spec.slug)
    if (existing) {
      const parent = existing.parent_object?.[0]
      if (parent && parent !== 'companies' && parent !== spec.parentObject) {
        throw new Error(
          `List ${spec.slug} exists but parent object is ${parent}, expected companies. Refusing to repurpose a People list.`,
        )
      }
      report.lists.push({ kind: 'list', action: 'skip', name: spec.slug, id: existing.id.list_id, reason: 'already_exists' })
      await ensureAttributes(args.client, spec, existing.api_slug, args.dryRun, report)
      continue
    }
    report.lists.push({ kind: 'list', action: 'create', name: spec.slug, reason: spec.name })
    if (args.dryRun) continue
    const created = await args.client.post<{ data: AttioList }>('/lists', {
      data: {
        name: spec.name,
        api_slug: spec.slug,
        parent_object: spec.parentObject,
        workspace_access: 'full-access',
        workspace_member_access: [],
      },
    })
    lists.push(created.data)
    await ensureAttributes(args.client, spec, created.data.api_slug, false, report)
  }
  return tally(report)
}

export function plannedSetupReport(args: {
  dryRun: boolean
  workstreams?: AttioWorkstream[]
}): SyncReport {
  const report = emptyReport(args.dryRun)
  const specs = args.workstreams?.length
    ? allListSpecs().filter((spec) => args.workstreams!.includes(spec.workstream))
    : allListSpecs()
  for (const spec of specs) {
    report.lists.push({ kind: 'list', action: 'create', name: spec.slug, reason: 'offline_plan' })
    for (const attr of spec.attributes) {
      report.attributes.push({ kind: 'attribute', action: 'create', name: `${spec.slug}.${attr.apiSlug}`, reason: 'offline_plan' })
    }
  }
  return tally(report)
}

async function listAllLists(client: AttioClient): Promise<AttioList[]> {
  const res = await client.get<{ data: AttioList[] }>('/lists')
  return res.data ?? []
}

async function ensureAttributes(
  client: AttioClient,
  spec: AttioListSpec,
  listSlug: string,
  dryRun: boolean,
  report: SyncReport,
): Promise<void> {
  const existing = await paginateAttributes(client, listSlug)
  const bySlug = new Map(existing.map((row) => [row.api_slug, row]))
  for (const attr of spec.attributes) {
    const found = bySlug.get(attr.apiSlug)
    if (found) {
      if (found.type !== attr.type) {
        throw new Error(
          `Attribute ${listSlug}.${attr.apiSlug} exists as ${found.type}, expected ${attr.type}. Refusing to coerce.`,
        )
      }
      report.attributes.push({ kind: 'attribute', action: 'skip', name: `${listSlug}.${attr.apiSlug}`, reason: 'already_exists' })
      if (!dryRun) await ensureOptions(client, listSlug, attr, report)
      continue
    }
    report.attributes.push({ kind: 'attribute', action: 'create', name: `${listSlug}.${attr.apiSlug}` })
    if (dryRun) continue
    await client.post(`/lists/${listSlug}/attributes`, { data: attributePayload(attr) })
    await ensureOptions(client, listSlug, attr, report)
  }
}

function attributePayload(attr: AttioAttributeSpec) {
  const config: Record<string, unknown> = {}
  if (attr.type === 'currency') {
    config.currency = { default_currency_code: attr.currencyCode ?? 'USD', display_type: 'symbol' }
  }
  if (attr.type === 'record-reference') {
    config.record_reference = { allowed_objects: attr.allowedObjects ?? ['people'] }
  }
  return {
    title: attr.title,
    description: attr.description,
    api_slug: attr.apiSlug,
    type: attr.type,
    is_required: false,
    is_unique: Boolean(attr.isUnique),
    is_multiselect: Boolean(attr.isMultiselect),
    config,
  }
}

async function ensureOptions(
  client: AttioClient,
  listSlug: string,
  attr: AttioAttributeSpec,
  report: SyncReport,
): Promise<void> {
  if (attr.type === 'status' && attr.statuses) {
    const current = await client.get<{ data: Array<{ title: string }> }>(
      `/lists/${listSlug}/attributes/${attr.apiSlug}/statuses`,
    )
    const have = new Set((current.data ?? []).map((row) => row.title))
    for (const title of attr.statuses) {
      if (have.has(title)) {
        report.attributes.push({ kind: 'status', action: 'skip', name: `${listSlug}.status.${title}` })
        continue
      }
      report.attributes.push({ kind: 'status', action: 'create', name: `${listSlug}.status.${title}` })
      try {
        await client.post(`/lists/${listSlug}/attributes/${attr.apiSlug}/statuses`, {
          data: { title, celebration_enabled: title === 'Won / Published' },
        })
      } catch (err) {
        if (err instanceof AttioError && err.status === 409) continue
        throw err
      }
    }
  }
  if (attr.type === 'select' && attr.options) {
    const current = await client.get<{ data: Array<{ title: string }> }>(
      `/lists/${listSlug}/attributes/${attr.apiSlug}/options`,
    )
    const have = new Set((current.data ?? []).map((row) => row.title))
    for (const title of attr.options) {
      if (have.has(title)) {
        report.attributes.push({ kind: 'select_option', action: 'skip', name: `${listSlug}.${attr.apiSlug}.${title}` })
        continue
      }
      report.attributes.push({ kind: 'select_option', action: 'create', name: `${listSlug}.${attr.apiSlug}.${title}` })
      try {
        await client.post(`/lists/${listSlug}/attributes/${attr.apiSlug}/options`, { data: { title } })
      } catch (err) {
        if (err instanceof AttioError && err.status === 409) continue
        throw err
      }
    }
  }
}

async function paginateAttributes(client: AttioClient, listSlug: string): Promise<AttioAttribute[]> {
  const out: AttioAttribute[] = []
  let offset = 0
  while (true) {
    const res = await client.get<{ data: AttioAttribute[] }>(`/lists/${listSlug}/attributes`, { limit: 200, offset })
    const page = res.data ?? []
    out.push(...page)
    if (page.length < 200) break
    offset += page.length
  }
  return out
}

export { printReport }
