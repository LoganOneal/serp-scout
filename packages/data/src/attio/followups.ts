import {
  ATTIO_LISTS,
  ATTIO_WORKSTREAMS,
  emptyReport,
  followupDueDate,
  followupTaskContent,
  isAttioStatus,
  isDueOnOrBefore,
  nextFollowupNumber,
  parseFollowupCadence,
  parseFollowupMarker,
  parseIsoDate,
  shouldSkipFollowup,
  tally,
  todayUtc,
  type AttioStatus,
  type AttioWorkstream,
  type ReplyDetector,
  type SyncReport,
} from '@rnr/core'
import { AttioClient } from './client.js'
import { entryValuesMap } from './values.js'
import { AttioEmailReplyDetector } from './replies.js'

interface EntryHit {
  id: { entry_id: string; list_id: string }
  parent_record_id: string
  values?: Record<string, unknown>
  entry_values?: Record<string, unknown>
}

interface TaskHit {
  id: { task_id: string }
  content_plaintext?: string
  is_completed?: boolean
  linked_records?: Array<{ target_object?: string; target_record_id?: string }>
}

export async function processFollowups(args: {
  client: AttioClient
  dryRun: boolean
  now?: Date
  detector?: ReplyDetector
  env?: Record<string, string | undefined>
}): Promise<SyncReport> {
  const report = emptyReport(args.dryRun, 'followups')
  const cadence = parseFollowupCadence(args.env ?? process.env)
  const today = todayUtc(args.now)
  const detector = args.detector ?? new AttioEmailReplyDetector(args.client)
  const tasks = await listOpenTasks(args.client)
  const markersByKey = new Map<string, number[]>()
  for (const task of tasks) {
    const marker = parseFollowupMarker(task.content_plaintext)
    if (!marker) continue
    const list = markersByKey.get(marker.sourceKey) ?? []
    list.push(marker.n)
    markersByKey.set(marker.sourceKey, list)
  }

  for (const workstream of ATTIO_WORKSTREAMS) {
    const entries = await listAllEntries(args.client, workstream)
    for (const entry of entries) {
      const values = entryValuesMap(entry)
      const status = isAttioStatus(values.status) ? values.status : null
      const sourceKey = typeof values.source_key === 'string' ? values.source_key : null
      if (!sourceKey || shouldSkipFollowup(status)) continue
      const next = followupDueDate({
        outreachDate: parseIsoDate(values.outreach_date),
        nextFollowup: parseIsoDate(values.next_follow_up),
        existingNumbers: markersByKey.get(sourceKey) ?? [],
        cadence,
      })
      if (!isDueOnOrBefore(next, today)) {
        report.skipped.push({ kind: 'task', action: 'skip', name: sourceKey, reason: next ? 'not_due' : 'missing_next_follow_up' })
        continue
      }

      const outreachDate = parseIsoDate(values.outreach_date)
      const reply = outreachDate
        ? await detector.findInboundReply({
            companyRecordId: entry.parent_record_id,
            personRecordId: typeof values.primary_contact === 'string' ? values.primary_contact : null,
            afterDate: outreachDate,
          })
        : null

      if (reply?.inbound) {
        report.entries.push({
          kind: 'entry',
          action: 'update',
          name: sourceKey,
          reason: 'inbound_reply_detected_should_be_Replied',
        })
        if (!args.dryRun) {
          await args.client.patch(`/lists/${ATTIO_LISTS[workstream].slug}/entries/${entry.id.entry_id}`, {
            data: { entry_values: { status: 'Replied' satisfies AttioStatus } },
          })
        }
        continue
      }

      const n = nextFollowupNumber(markersByKey.get(sourceKey) ?? [])
      if (!n) {
        report.skipped.push({ kind: 'task', action: 'skip', name: sourceKey, reason: 'followups_already_created' })
        continue
      }

      const content = followupTaskContent({
        sourceKey,
        n,
        workstream,
        companyName: sourceKey,
        targetUrl: typeof values.target_article_url === 'string'
          ? values.target_article_url
          : typeof values.guidelines_url === 'string'
            ? values.guidelines_url
            : typeof values.hht_listing_url === 'string'
              ? values.hht_listing_url
              : null,
        outreachDate,
        attioUrl: `https://app.attio.com/list/${ATTIO_LISTS[workstream].slug}`,
      })
      report.tasks.push({ kind: 'task', action: 'create', name: sourceKey, reason: `followup_${n}_cadence_${cadence.firstDays}/${cadence.secondDays}` })
      if (args.dryRun) continue
      await args.client.post('/tasks', {
        data: {
          content,
          format: 'plaintext',
          deadline_at: `${today}T17:00:00.000Z`,
          is_completed: false,
          linked_records: [{ target_object: 'companies', target_record_id: entry.parent_record_id }],
          assignees: [],
        },
      })
    }
  }

  return tally(report)
}

async function listAllEntries(client: AttioClient, workstream: AttioWorkstream): Promise<EntryHit[]> {
  const out: EntryHit[] = []
  let offset = 0
  while (true) {
    const res = await client.post<{ data: EntryHit[] }>(`/lists/${ATTIO_LISTS[workstream].slug}/entries/query`, {
      filter: { status: 'Contacted' },
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

async function listOpenTasks(client: AttioClient): Promise<TaskHit[]> {
  const out: TaskHit[] = []
  let offset = 0
  while (true) {
    const res = await client.get<{ data: TaskHit[] }>('/tasks', { is_completed: false, limit: 200, offset })
    const page = res.data ?? []
    out.push(...page)
    if (page.length < 200) break
    offset += page.length
  }
  return out
}
