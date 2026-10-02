export interface DraftVariables {
  publisherName: string
  contactName: string
  articleTitle: string
  articleUrl: string
  rankingKeyword: string
  serpPosition: string
  city: string
  state: string
  targetHhtUrl: string
  secondaryHhtUrl: string
  insertionSuggestion: string
  guestPostRequirements: string
  pitchTopics: string
  fitLine: string
  subjectLine: string
  submissionMethod: string
  submissionUrl: string
  pitchTopicCount: string
  pitchContentStage: string
  requiredSubjectLineFormat: string
  acceptedTopics: string
  excludedTopics: string
  wordCount: string
  linkPolicy: string
  samplesRequired: string
  bioRequired: string
  aiContentPolicy: string
  paidOrSponsored: string
  guidelineEvidence: string
}

export class TemplatePlaceholderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TemplatePlaceholderError'
  }
}

export function renderTemplate(
  template: string,
  variables: DraftVariables,
  options: { requireSubject?: boolean; maxBodyLength?: number } = {},
): { subject: string; body: string } {
  if (/\[\[\s*PLACEHOLDER/i.test(template)) {
    throw new TemplatePlaceholderError('Template still contains placeholder copy markers')
  }
  const content = template
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n')
  const rendered = content.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => {
    const value = (variables as unknown as Record<string, string>)[key]
    return value ?? ''
  })
  const unresolved = rendered.match(/\{\{[^}]+\}\}/)
  if (unresolved) throw new TemplatePlaceholderError(`Template contains unknown variable ${unresolved[0]}`)
  const lines = rendered.split('\n')
  const subjectLine = lines.find((line) => line.toLowerCase().startsWith('subject:'))
  const subject = subjectLine ? subjectLine.slice(subjectLine.indexOf(':') + 1).trim() : ''
  const body = lines.filter((line) => line !== subjectLine).join('\n').trim()
  if (options.requireSubject && !subject) throw new TemplatePlaceholderError('Email template has no subject')
  if (options.maxBodyLength !== undefined && body.length > options.maxBodyLength) {
    throw new TemplatePlaceholderError(`Rendered template exceeds ${options.maxBodyLength} characters`)
  }
  return { subject, body }
}

export function geographicKeywords(city: string, state: string, templates: string[]): string[] {
  return templates.map((template) => template.replaceAll('{city}', city).replaceAll('{state}', state))
}
