export interface SyncAction {
  kind:
    | 'list'
    | 'attribute'
    | 'status'
    | 'select_option'
    | 'company'
    | 'person'
    | 'entry'
    | 'note'
    | 'task'
  action: 'create' | 'update' | 'skip' | 'stale' | 'error'
  id?: string
  name: string
  reason?: string
}

export interface SyncReport {
  dryRun: boolean
  workstream?: string
  lists: SyncAction[]
  attributes: SyncAction[]
  companies: SyncAction[]
  people: SyncAction[]
  entries: SyncAction[]
  notes: SyncAction[]
  tasks: SyncAction[]
  skipped: SyncAction[]
  stale: SyncAction[]
  errors: SyncAction[]
  counts: {
    source: number
    companiesCreate: number
    companiesUpdate: number
    peopleCreate: number
    peopleUpdate: number
    entriesCreate: number
    entriesUpdate: number
    skipped: number
    stale: number
    errors: number
  }
}

export function emptyReport(dryRun: boolean, workstream?: string): SyncReport {
  return {
    dryRun,
    workstream,
    lists: [],
    attributes: [],
    companies: [],
    people: [],
    entries: [],
    notes: [],
    tasks: [],
    skipped: [],
    stale: [],
    errors: [],
    counts: {
      source: 0,
      companiesCreate: 0,
      companiesUpdate: 0,
      peopleCreate: 0,
      peopleUpdate: 0,
      entriesCreate: 0,
      entriesUpdate: 0,
      skipped: 0,
      stale: 0,
      errors: 0,
    },
  }
}

export function tally(report: SyncReport): SyncReport {
  const count = (rows: SyncAction[], action: SyncAction['action']) => rows.filter((row) => row.action === action).length
  report.counts.companiesCreate = count(report.companies, 'create')
  report.counts.companiesUpdate = count(report.companies, 'update')
  report.counts.peopleCreate = count(report.people, 'create')
  report.counts.peopleUpdate = count(report.people, 'update')
  report.counts.entriesCreate = count(report.entries, 'create')
  report.counts.entriesUpdate = count(report.entries, 'update')
  report.counts.skipped = report.skipped.length
  report.counts.stale = report.stale.length
  report.counts.errors = report.errors.length
  return report
}

export function printReport(report: SyncReport): string {
  const lines = [
    `Attio ${report.dryRun ? 'dry-run' : 'apply'}${report.workstream ? ` · ${report.workstream}` : ''}`,
    `source=${report.counts.source} companies +${report.counts.companiesCreate}/~${report.counts.companiesUpdate} people +${report.counts.peopleCreate}/~${report.counts.peopleUpdate} entries +${report.counts.entriesCreate}/~${report.counts.entriesUpdate}`,
    `skipped=${report.counts.skipped} stale=${report.counts.stale} errors=${report.counts.errors}`,
  ]
  const summarize = (label: string, rows: SyncAction[]) => {
    if (!rows.length) return
    lines.push(`${label}:`)
    for (const row of rows.slice(0, 40)) {
      lines.push(`  ${row.action.padEnd(6)} ${row.name}${row.reason ? ` — ${row.reason}` : ''}`)
    }
    if (rows.length > 40) lines.push(`  … ${rows.length - 40} more`)
  }
  summarize('Lists', report.lists)
  summarize('Attributes', report.attributes)
  summarize('Companies', report.companies)
  summarize('People', report.people)
  summarize('Entries', report.entries)
  summarize('Notes', report.notes)
  summarize('Tasks', report.tasks)
  summarize('Skipped', report.skipped)
  summarize('Stale', report.stale)
  summarize('Errors', report.errors)
  return lines.join('\n')
}
