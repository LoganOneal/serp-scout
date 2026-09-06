export interface ExtractedAuthor {
  name: string
  excerpt: string
}

export function cleanAuthorName(raw: string | null | undefined): string | null {
  if (!raw) return null
  const name = raw
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^by\s+/i, '')
  if (name.length < 4 || name.length > 60) return null
  if (!/^[A-Za-z][A-Za-z .'-]+$/.test(name)) return null
  const parts = name.split(/\s+/).filter(Boolean)
  if (parts.length < 2 || parts.length > 3) return null
  if (/admin|editor|staff|team|author|writer|guest|hotel hot|semrush/i.test(name)) return null
  return parts.map((part) => part[0]!.toUpperCase() + part.slice(1).toLowerCase()).join(' ')
}

export function extractAuthors(html: string | null | undefined, text: string | null | undefined): ExtractedAuthor[] {
  const found = new Map<string, ExtractedAuthor>()
  const add = (raw: string | null | undefined, excerpt: string) => {
    const name = cleanAuthorName(raw)
    if (!name) return
    const key = name.toLowerCase()
    if (found.has(key)) return
    found.set(key, { name, excerpt: excerpt.replace(/\s+/g, ' ').trim().slice(0, 180) })
  }

  if (html) {
    add(html.match(/<meta[^>]+name=["']author["'][^>]+content=["']([^"']+)/i)?.[1], 'meta name=author')
    add(html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']author["']/i)?.[1], 'meta name=author')
    for (const match of html.matchAll(/rel=["']author["'][^>]*>([^<]{3,80})/gi)) {
      add(match[1], match[0].replace(/<[^>]+>/g, ' '))
    }
    for (const match of html.matchAll(/class=["'][^"']*(?:author-name|byline)[^"']*["'][^>]*>([^<]{3,80})/gi)) {
      add(match[1], match[0].replace(/<[^>]+>/g, ' '))
    }
  }

  for (const match of (text ?? '').matchAll(/\b(?:by|written by)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})/g)) {
    add(match[1], match[0])
  }

  return [...found.values()]
}

export function authorSearchQueries(name: string): string[] {
  return [`"${name}" travel writer`, `"${name}" "romantic hotels"`, `"${name}" "write for us"`]
}
