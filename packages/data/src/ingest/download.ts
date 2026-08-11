import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import yauzl from 'yauzl'
import { resolveFromRoot } from '../paths.js'

/**
 * Cached downloads of the Census bulk files.
 *
 * They are large, immutable for a given vintage, and re-fetchable -- so they are
 * cached on disk under .cache/ and never re-downloaded on a repeat ingest.
 */

/**
 * Anchored on the workspace root, not cwd.
 *
 * Only ever run from the root today (`pnpm ingest:geo`), so this was latent rather
 * than broken -- but it is the same defect that made call recordings unreadable from
 * the web app, and one helper removes the class.
 */
export const CACHE_DIR = resolveFromRoot(join('.cache', 'census'))

function ensureCacheDir(): void {
  mkdirSync(CACHE_DIR, { recursive: true })
}

/**
 * Assert the body is what we asked for, not an HTML error page.
 *
 * The rule that produced this: api.census.gov returns an 8,529-byte HTML
 * "Missing Key" page under HTTP 200. Status codes are not evidence of content.
 */
function assertNotHtml(path: string, url: string): void {
  const head = readFileSync(path).subarray(0, 200).toString('utf8').trimStart().toLowerCase()
  if (head.startsWith('<!doctype html') || head.startsWith('<html')) {
    throw new Error(
      `${url} returned an HTML page rather than data (first bytes: ${head.slice(0, 80)}). ` +
        'A 200 status does not mean the body is what was requested.',
    )
  }
}

export async function downloadText(url: string, cacheName: string): Promise<string> {
  ensureCacheDir()
  const target = join(CACHE_DIR, cacheName)
  if (existsSync(target) && statSync(target).size > 0) {
    assertNotHtml(target, url)
    return readFileSync(target, 'utf8')
  }

  process.stdout.write(`  downloading ${cacheName} ... `)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`)
  if (!res.body) throw new Error(`${url} returned no body`)
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(target))
  const size = statSync(target).size
  console.log(`${(size / 1_048_576).toFixed(1)} MB`)
  assertNotHtml(target, url)
  // Census gazetteer files are latin1 in places (accented place names).
  return readFileSync(target, 'utf8')
}

/** Download a zip and extract the first entry matching `fileInZip`. */
/**
 * Download a zip and extract the first entry matching `fileInZip`.
 *
 * Decoded as UTF-8, verified against the bytes: "Doña Ana County" is stored as
 * `44 6F C3 B1 61` -- a UTF-8 ñ. Reading these files as Latin-1 (a reasonable
 * guess for Census data, and the original implementation here) silently turns it
 * into "DoÃ±a Ana County", which then fails to resolve and shows up as a missing
 * county rather than as an encoding bug. Every accented place name in the corpus
 * is affected -- Doña Ana, Cañon City, Española, Kaneʻohe.
 */
export async function downloadZipEntry(
  url: string,
  fileInZip: RegExp,
  cacheName: string,
): Promise<string> {
  ensureCacheDir()
  const target = join(CACHE_DIR, cacheName)
  if (existsSync(target) && statSync(target).size > 0) {
    return readFileSync(target, 'utf8')
  }

  process.stdout.write(`  downloading ${cacheName} ... `)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`)
  const zipBytes = Buffer.from(await res.arrayBuffer())
  const zipPath = join(tmpdir(), `rnr-${cacheName}.zip`)
  await pipeline(Readable.from(zipBytes), createWriteStream(zipPath))

  // Kept as a Buffer end-to-end so the bytes are written to the cache verbatim
  // and decoded exactly once, at the end.
  const buffer = await new Promise<Buffer>((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error('zip open failed'))
      let found = false
      zip.on('entry', (entry) => {
        if (!fileInZip.test(entry.fileName)) {
          zip.readEntry()
          return
        }
        found = true
        zip.openReadStream(entry, (streamErr, stream) => {
          if (streamErr || !stream) return reject(streamErr ?? new Error('zip read failed'))
          const chunks: Buffer[] = []
          stream.on('data', (c: Buffer) => chunks.push(c))
          stream.on('end', () => resolve(Buffer.concat(chunks)))
          stream.on('error', reject)
        })
      })
      zip.on('end', () => {
        if (!found) reject(new Error(`No entry matching ${fileInZip} in ${url}`))
      })
      zip.on('error', reject)
      zip.readEntry()
    })
  })

  await pipeline(Readable.from(buffer), createWriteStream(target))
  console.log(`${(buffer.length / 1_048_576).toFixed(1)} MB extracted`)
  return buffer.toString('utf8')
}

/** Split into non-empty lines, tolerating CRLF and a trailing newline. */
export function lines(text: string): string[] {
  return text.split(/\r?\n/).filter((l) => l.trim().length > 0)
}

/** Minimal CSV row splitter that honours double-quoted fields. */
export function splitCsv(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"'
          i++
        } else inQuotes = false
      } else cur += c
    } else if (c === '"') inQuotes = true
    else if (c === ',') {
      out.push(cur)
      cur = ''
    } else cur += c
  }
  out.push(cur)
  return out
}
