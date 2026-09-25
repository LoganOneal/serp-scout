/** Minimal CSV parser. Handles quoted fields and doubled quotes. */
export function parseCsv(text: string): Record<string, string>[] {
  const lines = splitCsvRows(text.replace(/^\uFEFF/, ''))
  if (!lines.length) return []
  const headers = lines[0]!.map((h) => h.trim())
  return lines.slice(1).filter((row) => row.some((cell) => cell.trim())).map((cols) => {
    const out: Record<string, string> = {}
    headers.forEach((header, i) => {
      out[header] = cols[i] ?? ''
    })
    return out
  })
}

function splitCsvRows(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        cur += '"'
        i++
      } else if (ch === '"') {
        inQuotes = false
      } else {
        cur += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      row.push(cur)
      cur = ''
    } else if (ch === '\n') {
      row.push(cur.replace(/\r$/, ''))
      rows.push(row)
      row = []
      cur = ''
    } else {
      cur += ch
    }
  }
  if (cur.length || row.length) {
    row.push(cur.replace(/\r$/, ''))
    rows.push(row)
  }
  return rows.filter((r) => r.length && !(r.length === 1 && r[0] === ''))
}
