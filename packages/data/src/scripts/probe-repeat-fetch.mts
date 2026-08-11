/** Does this domain answer consistently, or intermittently serve an interstitial? */
const domain = process.argv[2] ?? 'chron.com'
for (let i = 1; i <= 4; i++) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), 12000)
  try {
    const res = await fetch(`https://${domain}/`, { redirect: 'follow', signal: c.signal,
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                 accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'accept-language': 'en-US,en;q=0.9' } })
    const html = await res.text()
    const text = html.replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ')
      .replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim()
    const marks = ['captcha','checking your browser','enable javascript','consent','cookie','access denied','subscribe','cloudflare','are you a human']
      .filter((m) => text.toLowerCase().includes(m) || html.toLowerCase().includes(m))
    console.log(`#${i} http=${res.status} html=${html.length} text=${text.length}  markers=[${marks.join(',')}]`)
    if (text.length < 600) console.log(`    thin text: "${text.slice(0, 140)}"`)
  } catch (e) { console.log(`#${i} FAILED ${(e as Error).message}`) } finally { clearTimeout(t) }
}
