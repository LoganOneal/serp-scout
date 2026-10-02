export type SemrushCallClass = 'ok' | 'auth' | 'exhausted' | 'rate_limit' | 'retry'

export function classifySemrushFailure(message: string): SemrushCallClass {
  const text = message.toLowerCase()
  if (text.includes('error 132') || text.includes('not enough api units') || text.includes('zero balance')) {
    return 'exhausted'
  }
  if (text.includes('401') || text.includes('unauthorized') || text.includes('invalid_grant') || text.includes('auth')) {
    return 'auth'
  }
  if (text.includes('429') || text.includes('rate limit') || text.includes('too many requests')) return 'rate_limit'
  return 'retry'
}

export function semrushReplacementNotice(input: {
  reason: 'credits exhausted' | 'authorization failed'
  pausedAt: string
  unitsUsed: number
  queuedJobs: number
}): string {
  return [
    'Replace the Semrush account in the Cursor MCP connector.',
    'Leave this Mac logged in and unlocked so the new login can be copied to Supabase Vault.',
    `Reason: ${input.reason}.`,
    `Paused at: ${input.pausedAt}.`,
    `Credits used by this account: ${input.unitsUsed}.`,
    `Queued Semrush jobs waiting: ${input.queuedJobs}.`,
    'Scraping, drafting, and Supabase outbox stages are still running.',
  ].join(' ')
}
