import 'server-only'
import { writeFile } from 'node:fs/promises'
import type { HhtBlMechanism } from '@rnr/core'

export interface HhtBlAnalysisQueueItem {
  backlinkId: number
  sourceDomain: string
  sourcePageTitle: string | null
  sourceSection: string | null
  anchor: string | null
  competitorDomain: string
  competitorTargetUrl: string
  competitorTargetSummary: string | null
  analogousSitesLinked: number
  authorityScore: number | null
  allowedMechanisms: HhtBlMechanism[]
}

export async function writeHhtBlAnalysisQueue(
  path: string,
  rows: HhtBlAnalysisQueueItem[],
): Promise<void> {
  const body = rows.map((row) => JSON.stringify(row)).join('\n')
  await writeFile(path, body ? `${body}\n` : '', 'utf8')
}

