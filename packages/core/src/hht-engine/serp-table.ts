export interface SerpRow {
  position: number
  domain: string
  url: string
}

export function parseOrganicSerp(data: unknown, offset = 0): SerpRow[] {
  if (Array.isArray(data)) {
    return data.flatMap((row, index) => fromRecord(row as Record<string, unknown>, offset + index))
  }
  if (typeof data !== 'string' || !data.trim()) return []
  const lines = data.trim().split(/\r?\n/).filter(Boolean)
  const header = lines[0]?.split(/[;\t,]/).map((cell) => cell.trim().toLowerCase()) ?? []
  const delimiter = lines[0]?.includes(';') ? ';' : lines[0]?.includes('\t') ? '\t' : ','
  const rows: SerpRow[] = []
  for (let i = 1; i < lines.length; i += 1) {
    const cells = lines[i]?.split(delimiter) ?? []
    const record: Record<string, string> = {}
    header.forEach((name, index) => {
      record[name] = cells[index]?.trim() ?? ''
    })
    const url = record['url'] || record['ur'] || ''
    const domain = record['domain'] || record['dn'] || ''
    const position = Number(record['position'] || record['po'] || offset + i)
    if (!url || !domain || !Number.isFinite(position)) continue
    rows.push({ position, domain, url })
  }
  return rows
}

/** Keyword column from a resource_organic export. SERP rows stay in parseOrganicSerp. */
export function parseRankedKeywords(data: unknown): string[] {
  if (Array.isArray(data)) {
    return data.flatMap((row) => {
      const record = row as Record<string, unknown>
      const keyword = String(record['keyword'] ?? record['Keyword'] ?? record['Ph'] ?? '').trim()
      return keyword ? [keyword] : []
    })
  }
  if (typeof data !== 'string' || !data.trim()) return []
  const lines = data.trim().split(/\r?\n/).filter(Boolean)
  const header = lines[0]?.split(/[;\t,]/).map((cell) => cell.trim().toLowerCase()) ?? []
  const delimiter = lines[0]?.includes(';') ? ';' : lines[0]?.includes('\t') ? '\t' : ','
  const index = header.findIndex((name) => name === 'keyword' || name === 'ph')
  if (index < 0) return []
  const keywords: string[] = []
  for (let i = 1; i < lines.length; i += 1) {
    const keyword = lines[i]?.split(delimiter)[index]?.trim() ?? ''
    if (keyword) keywords.push(keyword)
  }
  return keywords
}

function fromRecord(row: Record<string, unknown>, fallbackPosition: number): SerpRow[] {
  const url = String(row['url'] ?? row['Url'] ?? '')
  const domain = String(row['domain'] ?? row['Domain'] ?? '')
  const position = Number(row['position'] ?? fallbackPosition + 1)
  if (!url || !domain) return []
  return [{ position, domain, url }]
}
