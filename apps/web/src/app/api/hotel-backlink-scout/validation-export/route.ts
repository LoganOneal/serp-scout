import { db, listHotelBlUrlValidations } from '@rnr/data'

export const dynamic = 'force-dynamic'

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  const text = value instanceof Date ? value.toISOString() : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

export async function GET(): Promise<Response> {
  const database = db()
  const rows = await listHotelBlUrlValidations(database)
  const headers = [
    'Hotel', 'City', 'State', 'Country', 'HotelHotTubs listing', 'Current listing page',
    'Listing matched', 'Listing address', 'Imported candidate URL', 'Resolved candidate URL',
    'Entity scope', 'Entity type', 'Validation status', 'Validation confidence',
    'Validation reason', 'Canonical hotel domain', 'Needs review', 'Validated at',
  ]
  const body = [headers, ...rows.map((row) => Object.values(row))]
    .map((row) => row.map(csvCell).join(','))
    .join('\r\n')
  return new Response(`\uFEFF${body}`, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="hotel-url-validation-${new Date().toISOString().slice(0, 10)}.csv"`,
      'cache-control': 'no-store',
    },
  })
}
