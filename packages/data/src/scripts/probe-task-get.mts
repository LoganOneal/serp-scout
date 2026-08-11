import 'dotenv/config'
const auth = 'Basic ' + Buffer.from(`${process.env['DATAFORSEO_LOGIN']}:${process.env['DATAFORSEO_PASSWORD']}`).toString('base64')
const call = async (p: string) => (await fetch('https://api.dataforseo.com/v3' + p, { headers: { Authorization: auth } })).json()
const bal = async () => (await call('/appendix/user_data')).tasks?.[0]?.result?.[0]?.money?.balance ?? 0

const id = process.argv[2]!
const b0 = await bal()
const got = await call(`/serp/google/organic/task_get/advanced/${id}`)
const t = got.tasks?.[0]
const b1 = await bal()
const items = t?.result?.[0]?.items
console.log(`status ${t?.status_code} "${t?.status_message}"`)
console.log(`items: ${Array.isArray(items) ? items.length : 'none'}`)
console.log(`task_get cost: $${(b0 - b1).toFixed(5)}`)
if (Array.isArray(items)) {
  const organic = items.filter((i: any) => i.type === 'organic')
  console.log(`organic results: ${organic.length}`)
  console.log(`first: ${organic[0]?.domain} (rank_absolute ${organic[0]?.rank_absolute})`)
}
