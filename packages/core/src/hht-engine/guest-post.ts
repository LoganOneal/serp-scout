import type { GuestPostStatus } from './types.js'

export const GUEST_POST_PATHS = [
  '/write-for-us',
  '/contribute',
  '/contributors',
  '/guest-post',
  '/submissions',
  '/submit',
  '/editorial-guidelines',
  '/pitch',
] as const

const ACCEPT_TEXT = [/write for us/i, /guest post/i, /submit a story/i, /contributor guidelines/i, /we accept/i]
const REJECT_TEXT = [/we do not accept guest/i, /no guest posts/i, /not accepting submissions/i]
const PRICE_TEXT = [/\$\s?\d+/, /sponsored post/i, /buy a link/i, /link insertion.{0,40}\$/i]

export interface GuestPostSignals {
  status: GuestPostStatus
  evidenceUrl: string | null
  requirements: string | null
  sellsPlacements: boolean
  inconclusive: boolean
}

export type GuestPostSubmissionMethod = 'email' | 'form' | 'google_form' | 'other'
export type GuestPostPitchStage = 'outline' | 'draft' | 'either'

export interface StructuredGuestPostGuidelines {
  submissionMethod: GuestPostSubmissionMethod | null
  submissionUrl: string | null
  pitchTopicCount: number | null
  pitchContentStage: GuestPostPitchStage | null
  requiredSubjectLineFormat: string | null
  acceptedTopics: string[]
  excludedTopics: string[]
  wordCount: string | null
  linkPolicy: string | null
  samplesRequired: boolean
  bioRequired: boolean
  aiContentPolicy: string | null
  aiContentProhibited: boolean
  paidOrSponsored: boolean
  evidence: Record<string, string>
}

export function structuredGuidelinesFromAnswer(answer: Record<string, unknown>): StructuredGuestPostGuidelines {
  return {
    submissionMethod: enumValue(answer['submission_method'], ['email', 'form', 'google_form', 'other']),
    submissionUrl: nullableString(answer['submission_url']),
    pitchTopicCount: nullablePositiveInteger(answer['pitch_topic_count']),
    pitchContentStage: enumValue(answer['pitch_content_stage'], ['outline', 'draft', 'either']),
    requiredSubjectLineFormat: nullableString(answer['required_subject_line_format']),
    acceptedTopics: stringArray(answer['accepted_topics']),
    excludedTopics: stringArray(answer['excluded_topics']),
    wordCount: nullableString(answer['word_count']),
    linkPolicy: nullableString(answer['link_policy']),
    samplesRequired: answer['samples_required'] === true,
    bioRequired: answer['bio_required'] === true,
    aiContentPolicy: nullableString(answer['ai_content_policy']),
    aiContentProhibited: answer['ai_content_prohibited'] === true,
    paidOrSponsored: answer['paid_or_sponsored'] === true,
    evidence: evidenceMap(answer['evidence']),
  }
}

export function guestPostGuidelineReviewReasons(
  guidelines: StructuredGuestPostGuidelines,
): string[] {
  const reasons: string[] = []
  if (guidelines.paidOrSponsored) reasons.push('guest_post_paid_or_sponsored')
  if (guidelines.samplesRequired) reasons.push('guest_post_samples_required')
  if (guidelines.aiContentProhibited) reasons.push('guest_post_ai_content_prohibited')
  return reasons
}

export function groundStructuredGuestPostGuidelines(
  guidelines: StructuredGuestPostGuidelines,
  allowedEvidenceUrls: string[],
): StructuredGuestPostGuidelines {
  const allowed = new Set(allowedEvidenceUrls)
  const evidence = Object.fromEntries(
    Object.entries(guidelines.evidence).filter(([, url]) => allowed.has(url)),
  )
  const has = (field: string) => Boolean(evidence[field])
  return {
    submissionMethod: has('submission_method') ? guidelines.submissionMethod : null,
    submissionUrl: has('submission_method') ? guidelines.submissionUrl : null,
    pitchTopicCount: has('pitch_format') ? guidelines.pitchTopicCount : null,
    pitchContentStage: has('pitch_format') ? guidelines.pitchContentStage : null,
    requiredSubjectLineFormat: has('pitch_format') ? guidelines.requiredSubjectLineFormat : null,
    acceptedTopics: has('accepted_topics') ? guidelines.acceptedTopics : [],
    excludedTopics: has('excluded_topics') ? guidelines.excludedTopics : [],
    wordCount: has('word_count') ? guidelines.wordCount : null,
    linkPolicy: has('link_policy') ? guidelines.linkPolicy : null,
    samplesRequired: has('samples_required') && guidelines.samplesRequired,
    bioRequired: has('bio_required') && guidelines.bioRequired,
    aiContentPolicy: has('ai_content_policy') ? guidelines.aiContentPolicy : null,
    aiContentProhibited: has('ai_content_policy') && guidelines.aiContentProhibited,
    paidOrSponsored: has('paid_or_sponsored') && guidelines.paidOrSponsored,
    evidence,
  }
}

export function judgeGuestPostPages(pages: Array<{ url: string; text: string; ok: boolean }>): GuestPostSignals {
  const live = pages.filter((page) => page.ok && page.text.trim())
  const priced = live.find((page) => PRICE_TEXT.some((pattern) => pattern.test(page.text)))
  const accepted = live.find((page) => ACCEPT_TEXT.some((pattern) => pattern.test(page.text)))
  const rejected = live.find((page) => REJECT_TEXT.some((pattern) => pattern.test(page.text)))
  if (accepted) {
    return {
      status: 'ACCEPTS',
      evidenceUrl: accepted.url,
      requirements: excerpt(accepted.text),
      sellsPlacements: Boolean(priced),
      inconclusive: false,
    }
  }
  if (rejected) {
    return {
      status: 'DOES_NOT_ACCEPT',
      evidenceUrl: rejected.url,
      requirements: null,
      sellsPlacements: Boolean(priced),
      inconclusive: false,
    }
  }
  return {
    status: 'UNKNOWN',
    evidenceUrl: priced?.url ?? null,
    requirements: priced ? excerpt(priced.text) : null,
    sellsPlacements: Boolean(priced),
    inconclusive: true,
  }
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function nullablePositiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim())
    : []
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === 'string' && allowed.includes(value as T) ? value as T : null
}

function evidenceMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => (
      typeof entry[1] === 'string' && entry[1].startsWith('http')
    )),
  )
}

function excerpt(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 500)
}

export function extractEmails(text: string): string[] {
  const found = text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) ?? []
  return [...new Set(found.map((email) => email.toLowerCase()))]
}

export function extractContactForms(html: string, baseUrl: string): string[] {
  const urls: string[] = []
  for (const match of html.matchAll(/<form[^>]+action=["']([^"']+)["']/gi)) {
    const action = match[1]
    if (!action) continue
    try {
      urls.push(new URL(action, baseUrl).toString())
    } catch {
      // Ignore malformed form actions.
    }
  }
  return [...new Set(urls)]
}
