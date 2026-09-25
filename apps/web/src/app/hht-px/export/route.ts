import { NextResponse } from 'next/server'
import { db, exportHhtPxCsv, type HhtPxExportKind } from '@rnr/data'

export const dynamic = 'force-dynamic'

const KINDS = new Set<HhtPxExportKind>(['keywords', 'pages', 'domains', 'outreach'])

export async function GET(request: Request) {
  const kind = new URL(request.url).searchParams.get('kind') as HhtPxExportKind | null
  if (!kind || !KINDS.has(kind)) {
    return NextResponse.json({ error: 'kind must be keywords, pages, domains, or outreach' }, { status: 400 })
  }
  const { filename, csv } = await exportHhtPxCsv(db(), kind)
  return new NextResponse(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
    },
  })
}
