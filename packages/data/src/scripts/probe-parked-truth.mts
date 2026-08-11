/**
 * Why did each PARKED_DEAD domain get that label -- a matched parking phrase,
 * or merely thin visible text?
 *
 * The text floor assumes a page's content is in its HTML. A JavaScript-rendered
 * site serves an empty shell and fills it client-side, and our probe does not
 * run JavaScript.
 */
import 'dotenv/config'
import postgres from 'postgres'

const sql = postgres(process.env['DIRECT_DATABASE_URL']?.trim() || process.env['DATABASE_URL']!, { max: 1, prepare: false })
const rows = await sql<Array<{ domain: string }>>`
  SELECT DISTINCT domain FROM domain_candidates
   WHERE status = 'PARKED_DEAD' AND reason = 'Parking or for-sale page served'
   ORDER BY domain LIMIT 14`
await sql.end()

const APP_SHELL = /<div[^>]+id=["'](root|__next|app|__nuxt)["']|window\.__NUXT__|__NEXT_DATA__|data-reactroot|ng-version|<script[^>]+src=[^>]*\/(_next|static|assets|bundle)/i

console.log('domain                              raw    text  scripts  appShell  what it really is')
console.log('-'.repeat(100))
for (const { domain } of rows) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 12_000)
  try {
    const res = await fetch(`https://${domain}/`, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0 Safari/537.36' },
    })
    const html = await res.text()
    const text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    const scripts = (html.match(/<script/gi) ?? []).length
    const shell = APP_SHELL.test(html)
    const verdict = shell || scripts >= 8 || html.length > 60_000
      ? 'JS-RENDERED SITE — misread'
      : text.length < 600 && html.length < 15_000
        ? 'genuinely thin/parked'
        : 'unclear'
    console.log(
      `${domain.slice(0, 34).padEnd(35)} ${String(html.length).padStart(6)} ${String(text.length).padStart(6)} ${String(scripts).padStart(7)} ${String(shell).padStart(9)}  ${verdict}`,
    )
  } catch (e) {
    console.log(`${domain.slice(0, 34).padEnd(35)} ${'—'.padStart(6)} ${'—'.padStart(6)} ${'—'.padStart(7)} ${'—'.padStart(9)}  fetch failed: ${(e as Error).message.slice(0, 30)}`)
  } finally { clearTimeout(timer) }
}
