/**
 * Diagnostic for P3: which CDX query shapes actually return snapshots?
 *
 * The first pass of probe-wayback-directory returned zero for all three
 * directories, which is either a genuine coverage gap or a bad query. Those are
 * very different answers, so they get separated before anything is concluded.
 */

const CDX = 'http://web.archive.org/cdx/search/cdx'

const QUERIES: Array<[string, string]> = [
  ['sanity: example.com', `${CDX}?url=example.com&output=json&limit=3`],
  ['bbb plain', `${CDX}?url=bbb.org/us/wi/kenosha/category/plumber&output=json&limit=5`],
  ['bbb prefix *', `${CDX}?url=bbb.org/us/wi/kenosha*&output=json&limit=8`],
  ['bbb chicago *', `${CDX}?url=bbb.org/us/il/chicago/category/plumber*&output=json&limit=8`],
  ['yp kenosha', `${CDX}?url=yellowpages.com/kenosha-wi/plumbers&output=json&limit=5`],
  ['yp chicago', `${CDX}?url=yellowpages.com/chicago-il/plumbers&output=json&limit=5`],
  ['yp prefix *', `${CDX}?url=yellowpages.com/kenosha-wi*&output=json&limit=8`],
  ['yelp biz search', `${CDX}?url=yelp.com/search*Kenosha*&output=json&limit=5`],
  ['manta kenosha', `${CDX}?url=manta.com/mb_*kenosha*&output=json&limit=5`],
]

for (const [label, q] of QUERIES) {
  try {
    const res = await fetch(q, { signal: AbortSignal.timeout(45_000) })
    const txt = await res.text()
    const rows = txt.trim() ? (JSON.parse(txt) as string[][]) : []
    const n = Math.max(0, rows.length - 1)
    console.log(`${label.padEnd(22)} HTTP ${res.status}  rows ${String(n).padStart(4)}`)
    for (const r of rows.slice(1, 4)) {
      console.log(`      ${r[1]}  ${r[4]}  ${String(r[2]).slice(0, 88)}`)
    }
  } catch (e) {
    console.log(`${label.padEnd(22)} ERR ${(e as Error).message}`)
  }
}
