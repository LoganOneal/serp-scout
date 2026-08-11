import 'dotenv/config'
import { DataForSeoClient, fetchAccountStatus } from '../providers/dataforseo/client.js'
import { AccountIssueError } from '../providers/dataforseo/errors.js'

const login = process.env['DATAFORSEO_LOGIN']?.trim()
const password = process.env['DATAFORSEO_PASSWORD']?.trim()
if (!login || !password) {
  console.error('DATAFORSEO_LOGIN / PASSWORD missing in .env')
  process.exit(1)
}

console.log('login', login)

const client = new DataForSeoClient({
  credentials: { login, password },
  timeoutMs: 30_000,
})

try {
  const status = await fetchAccountStatus(client)
  console.log('account', status)
} catch (e) {
  console.error('account_error', (e as Error).message)
}

try {
  await client.post('/serp/google/organic/live/advanced', [
    {
      keyword: 'pizza',
      location_code: 1026481, // Houston-style city code from our corpus
      language_code: 'en',
      device: 'desktop',
      os: 'windows',
      depth: 10,
    },
  ])
  console.log('serp_probe: OK (live advanced accepted)')
} catch (e) {
  const err = e as Error
  console.error(
    'serp_probe: FAIL',
    err instanceof AccountIssueError ? `AccountIssue ${err.code}` : err.name,
    err.message.slice(0, 400),
  )
}
