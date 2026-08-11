import 'dotenv/config'
import { classifyDomain } from '@rnr/core'
import { dnsTriage } from '../domains/dns-triage.js'
import { httpTriage } from '../domains/http-triage.js'
import { fetchRdapRecord } from '../domains/rdap-record.js'
for (const d of process.argv.slice(2)) {
  const dns = await dnsTriage(d)
  const http = await httpTriage(d)
  const rdap = await fetchRdapRecord(d)
  const c = classifyDomain({ dns, http, rdap })
  console.log(
    `${d.padEnd(30)} ${c.status.padEnd(14)} http=${http.outcome}/${http.httpStatus ?? '—'}` +
      ` text=${http.visibleTextChars}ch phrase=${http.matchedPhrase ?? '—'}\n   ${c.reason}`,
  )
}
