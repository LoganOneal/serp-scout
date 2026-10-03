export type SemrushCallClass = 'ok' | 'auth' | 'exhausted' | 'rate_limit' | 'empty' | 'invalid' | 'retry'

/**
 * Semrush errors carry a random hex trace_id. Matching digits or words against
 * the raw text let a trace id containing "401" pause the account, so the id is
 * removed and only whole words and Semrush ERROR codes count.
 */
export function classifySemrushFailure(message: string): SemrushCallClass {
  const text = message
    .replace(/"trace_id"\s*:\s*"[^"]*"/gi, '')
    .replace(/\b[0-9a-f]{16,}\b/gi, '')
    .toLowerCase()
  const code = /\berror\s+(\d+)\s*::/.exec(text)?.[1]
  if (
    code === '132' ||
    text.includes('not enough api units') ||
    text.includes('enough api units') ||
    text.includes('no_api_units') ||
    text.includes('zero balance')
  ) {
    return 'exhausted'
  }
  if (code === '50' || text.includes('nothing found')) return 'empty'
  if (
    /\bhttp (401|403)\b/.test(text) ||
    /\b(unauthori[sz]ed|invalid_grant|invalid_token|forbidden|no_subscription)\b/.test(text)
  ) {
    return 'auth'
  }
  if (/\bhttp 429\b/.test(text) || text.includes('rate limit') || text.includes('too many requests')) return 'rate_limit'
  if (code) return 'invalid'
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
    'The run is paused until Semrush is working again. Queued Semrush jobs stay in place.',
  ].join(' ')
}
