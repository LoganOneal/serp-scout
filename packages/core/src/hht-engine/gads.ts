export function classifyGadsFailure(message: string): 'auth' | 'rate_limit' | 'retry' {
  const text = message.toLowerCase()
  if (text.includes('invalid_grant') || text.includes('unauthorized') || text.includes('401') || text.includes('403') || text.includes('developer token')) {
    return 'auth'
  }
  if (text.includes('429') || text.includes('resource_exhausted') || text.includes('rate')) return 'rate_limit'
  return 'retry'
}
