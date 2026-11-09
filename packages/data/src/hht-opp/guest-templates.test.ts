import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readTrackerYields } from './guest-templates.js'

describe('tracker yields for template priors', () => {
  it('reads pitchable counts per keyword and leaves unattributed rows unknown', () => {
    const dir = mkdtempSync(join(tmpdir(), 'guest-yields-'))
    const file = join(dir, 'keyword-yields-test.csv')
    writeFileSync(file, [
      'keyword_id,keyword,pitchable_opportunities,evaluation_coverage',
      '505,things to do in seattle,4,Final tracker evaluations recorded; first-source attribution only',
      '17,packing list for chile,0,"No organic results; no candidates to evaluate"',
      '99,weekend in boise,0,No keyword-attributed final evaluations; yield unknown beyond recorded zero',
      'x,bad row,1,Final',
    ].join('\n'))
    const yields = readTrackerYields(file)
    expect([...yields.entries()]).toEqual([[505, 4], [17, 0], [99, null]])
  })
})
