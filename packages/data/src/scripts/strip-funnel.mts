import { readFileSync, writeFileSync } from 'node:fs'

const p = 'apps/web/src/components/research/OpportunityFunnel.tsx'
let s = readFileSync(p, 'utf8')
const start = s.indexOf('          {/* REMOVED_OLD_KEYWORD_PANEL')
const end = s.indexOf('          {/* Run deep dive */}')
console.log({ start, end })
if (start < 0 || end < 0) process.exit(1)
s = s.slice(0, start) + s.slice(end)
// fix run summary
s = s.replace(
  /Deep dive · \{kwIds\.size\} × \{geoIds\.size\} × \{deviceN\} =\{\s*' '\s*\}\s*\{localEst\.jobs\.toLocaleString\(\)\} SERPs/,
  `Deep dive · {nicheIds.size} niches × ~${8} kw × {geoIds.size} markets × {deviceN} ={' '}
                {localEst.jobs.toLocaleString()} SERPs`,
)
s = s.replace(
  'Select at least one keyword and one market to run.',
  'Select at least one niche and one market to run.',
)
writeFileSync(p, s)
console.log('stripped ok, len', s.length)
