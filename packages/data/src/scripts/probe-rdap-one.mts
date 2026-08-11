import 'dotenv/config'
import { fetchRdapRecord } from '../domains/rdap-record.js'
for (const d of process.argv.slice(2)) {
  const r = await fetchRdapRecord(d)
  console.log(`${d}: registered=${r.registered} created=${r.createdAt?.toISOString() ?? '—'} expires=${r.expiresAt?.toISOString() ?? '—'} registrar=${r.registrar} statuses=[${r.statuses.join(', ')}]`)
}
