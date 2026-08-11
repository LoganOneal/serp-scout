/**
 * DNS + HTTP triage for specific domains, printed raw.
 *
 * The fastest way to argue with a verdict: it shows exactly what stages 3a-3c
 * saw, which is how the kohler.com timeout-as-dead bug was found.
 *
 *   pnpm exec tsx packages/data/src/scripts/probe-http-one.mts <domain...>
 */
import { dnsTriage } from '../domains/dns-triage.js'
import { httpTriage } from '../domains/http-triage.js'
for (const d of process.argv.slice(2)) {
  const dns = await dnsTriage(d)
  const http = await httpTriage(d)
  console.log(d, '\n  dns:', JSON.stringify({a: dns.addresses.length, ns: dns.nameservers.length, errored: dns.errored}),
    '\n  http:', JSON.stringify(http))
}
