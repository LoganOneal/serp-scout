/**
 * Does Reddit's public JSON answer a datacenter IP?
 *
 * old.reddit.com HTML returns 403 to DataForSEO's crawlers, which is why the
 * commentability check has NULL on all 293 hits. The .json endpoint is a
 * different surface and may behave differently. If it answers, archived/locked
 * status and comment scores are free.
 */
import 'dotenv/config'
import postgres from 'postgres'

const sql = postgres(process.env['DIRECT_DATABASE_URL']?.trim() || process.env['DATABASE_URL']!, { max: 1, prepare: false })
const posts = await sql<Array<any>>`
  SELECT DISTINCT reddit_post_id, subreddit, title, reddit_url
    FROM discovery_hits WHERE reddit_post_id IS NOT NULL LIMIT 4`
await sql.end()

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

for (const p of posts) {
  const url = `https://www.reddit.com/comments/${p.reddit_post_id}.json?limit=5&sort=top`
  const c = new AbortController()
  const t = setTimeout(() => c.abort(), 15000)
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: c.signal })
    console.log(`\n${p.reddit_post_id} r/${p.subreddit} -> HTTP ${res.status}`)
    if (!res.ok) { console.log(`   ${(await res.text()).slice(0, 90)}`); continue }
    const j: any = await res.json()
    const post = j?.[0]?.data?.children?.[0]?.data
    const comments = (j?.[1]?.data?.children ?? []).filter((x: any) => x.kind === 't1').map((x: any) => x.data)
    console.log(`   archived=${post?.archived}  locked=${post?.locked}  score=${post?.score}  comments=${post?.num_comments}  age=${post?.created_utc ? Math.round((Date.now()/1000 - post.created_utc)/86400) : '?'}d`)
    console.log(`   top comment score: ${comments[0]?.score ?? '—'}  ("${String(comments[0]?.body ?? '').slice(0, 50).replace(/\n/g,' ')}")`)
  } catch (e) {
    console.log(`\n${p.reddit_post_id} FAILED: ${(e as Error).message}`)
  } finally { clearTimeout(t) }
}
