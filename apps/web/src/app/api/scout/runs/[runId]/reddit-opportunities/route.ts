import {
  db,
  getDeepDiveRun,
  listRedditOpportunityExportRows,
  redditOpportunityRowsToCsv,
} from '@rnr/data'

export const dynamic = 'force-dynamic'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ runId: string }> },
): Promise<Response> {
  const { runId: raw } = await params
  const runId = Number(raw)
  if (!Number.isInteger(runId) || runId <= 0) {
    return new Response('Invalid run id.', { status: 400 })
  }

  const database = db()
  const run = await getDeepDiveRun(database, runId)
  if (!run) return new Response('Run not found.', { status: 404 })

  const rows = await listRedditOpportunityExportRows(database, { runId })
  const csv = redditOpportunityRowsToCsv(rows)

  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="reddit-opportunities-run-${runId}.csv"`,
      'Cache-Control': 'private, no-store',
    },
  })
}
