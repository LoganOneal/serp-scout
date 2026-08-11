import 'dotenv/config'
import { PARKING_PHRASES_FOR_AUDIT } from '../domains/http-triage.js'
const targets = ['constellationhome.com', 'greaterhoustonhvac.com', 'astoriaplumbers.nyc']
for (const d of targets) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), 12000)
  try {
    const res = await fetch(`https://${d}/`, { redirect: 'follow', signal: c.signal,
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0 Safari/537.36' } })
    const html = await res.text()
    const text = html.replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ')
      .replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().toLowerCase()
    const hits = PARKING_PHRASES_FOR_AUDIT.filter((p) => text.includes(p))
    console.log(`${d}\n   text=${text.length}ch  matched: ${hits.length ? hits.map((h)=>`"${h}"`).join(', ') : '(none)'}`)
  } catch (e) { console.log(`${d}  failed: ${(e as Error).message}`) } finally { clearTimeout(t) }
}
