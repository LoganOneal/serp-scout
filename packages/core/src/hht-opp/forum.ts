/**
 * Forum / UGC detection and outbound-link policy.
 *
 * Dofollow is measured from HTML `rel` attributes, never inferred from
 * “comments welcome” copy. `rel=ugc`, `rel=nofollow`, and `rel=sponsored`
 * are not dofollow.
 */

import { excerptAround, firstMatch, makeEvidence } from './evidence.js'
import type { HhtOppConfidence, HhtOppEvidence, HhtOppInventedType, HhtOppLinkType } from './types.js'
import type { EligibilityResult } from './eligibility.js'

export interface ForumPageInput {
  url: string
  title: string | null
  text: string
  html?: string | null
}

export interface ForumSignals {
  isForum: boolean
  allowsUgc: boolean
  software: string | null
  evidence: string | null
}

export interface UgcLinkSample {
  url: string
  rel: string
  dofollow: boolean
}

export interface UgcLinkPolicy {
  linkType: HhtOppLinkType
  confidence: HhtOppConfidence
  evidence: string | null
  dofollowCount: number
  nofollowCount: number
  sampleSize: number
}

const FORUM_PATH =
  /(?:\/(?:forums?|community|discussions?|threads?|topics?|showthread|viewtopic|viewforum|boards?|talk|chatter|xf|t\/[a-z0-9-]+)|[-_](?:forums?|boards?)|message[-_]?boards?)\b/i

const COMMUNITY_HOST = /(?:^|\.)(?:community|boards|forum)\./i

const FORUM_SOFTWARE: Array<{ name: string; pattern: RegExp }> = [
  { name: 'discourse', pattern: /discourse|data-theme-name|\/t\/[a-z0-9-]+\/\d+/i },
  { name: 'phpbb', pattern: /phpbb|viewtopic\.php|viewforum\.php/i },
  { name: 'vbulletin', pattern: /vbulletin|showthread\.php|forumdisplay\.php/i },
  { name: 'xenforo', pattern: /xenforo|xf-body|\.bbwrapper/i },
  { name: 'invision', pattern: /invision|ipb-?forum|ips\.forums/i },
  { name: 'flarum', pattern: /flarum/i },
  { name: 'nodebb', pattern: /nodebb/i },
  { name: 'vanilla', pattern: /vanilla.?forums?|vanillaforums/i },
  { name: 'telligent', pattern: /telligent|communityserver|reportpost\.aspx|post quoted reply/i },
  { name: 'ubb', pattern: /ubbthreads\.php|\bubb\b/i },
  { name: 'disqus', pattern: /disqus\.com|id=["']disqus_thread/i },
  { name: 'wordpress-comments', pattern: /wp-comments|comment-form|id=["']respond/i },
]

const FORUM_COPY = [
  /message board/i,
  /discussion forum/i,
  /community forum/i,
  /\bforums?\b/i,
  /bulletin board/i,
]

const UGC_OPEN = [
  /post a reply/i,
  /leave a comment/i,
  /add a comment/i,
  /post a comment/i,
  /write a comment/i,
  /start (?:a )?new (?:thread|topic|discussion)/i,
  /register to (?:post|comment|reply)/i,
  /sign up to (?:post|comment|reply)/i,
  /reply to this (?:thread|topic)/i,
  /join the (?:discussion|conversation)/i,
  /post quoted reply/i,
  /login \/ register/i,
  /comments? are (?:open|welcome)/i,
]

const NOFOLLOW_RELS = new Set(['nofollow', 'ugc', 'sponsored'])

export function looksLikeForumPath(href: string): boolean {
  return FORUM_PATH.test(href)
}

export function isDofollowRel(rel: string | null | undefined): boolean {
  const tokens = (rel ?? '')
    .toLowerCase()
    .split(/[\s,]+/)
    .filter(Boolean)
  return tokens.every((token) => !NOFOLLOW_RELS.has(token))
}

function communityHost(url: string): boolean {
  try {
    return COMMUNITY_HOST.test(new URL(url).hostname)
  } catch {
    return false
  }
}

export function detectForumSignals(page: ForumPageInput): ForumSignals {
  const blob = `${page.title ?? ''}\n${page.text}\n${page.html ?? ''}\n${page.url}`
  const software = FORUM_SOFTWARE.find((row) => row.pattern.test(blob))?.name ?? null
  const pathHit = looksLikeForumPath(page.url)
  const hostHit = communityHost(page.url)
  const copy = firstMatch(`${page.title ?? ''}\n${page.text}`, FORUM_COPY)
  const isForum = Boolean(software || pathHit || hostHit || copy)
  const ugc = firstMatch(`${page.title ?? ''}\n${page.text}`, UGC_OPEN)
  const allowsUgc = Boolean(ugc || software || pathHit || hostHit)
  const evidence = software ?? copy?.[0] ?? (hostHit || pathHit ? page.url : ugc?.[0] ?? null)
  return { isForum, allowsUgc, software, evidence }
}

export function summarizeUgcLinkPolicy(links: readonly UgcLinkSample[]): UgcLinkPolicy {
  const sampleSize = links.length
  const dofollowCount = links.filter((link) => link.dofollow).length
  const nofollowCount = sampleSize - dofollowCount

  if (sampleSize === 0) {
    return {
      linkType: 'unknown',
      confidence: 'LOW',
      evidence: null,
      dofollowCount: 0,
      nofollowCount: 0,
      sampleSize: 0,
    }
  }

  if (dofollowCount === 0) {
    const sample = links[0]
    return {
      linkType: 'ugc_nofollow',
      confidence: sampleSize >= 3 ? 'HIGH' : 'MEDIUM',
      evidence: sample ? `rel="${sample.rel || ''}" ${sample.url}` : null,
      dofollowCount,
      nofollowCount,
      sampleSize,
    }
  }

  const sample = links.find((link) => link.dofollow)
  return {
    linkType: 'ugc_dofollow',
    confidence: sampleSize >= 3 && dofollowCount >= 2 ? 'HIGH' : 'MEDIUM',
    evidence: sample ? `${sample.url} (no nofollow/ugc/sponsored rel)` : null,
    dofollowCount,
    nofollowCount,
    sampleSize,
  }
}

export function classifyForumUgcEligibility(
  url: string,
  text: string,
  checkedAt = new Date(),
): EligibilityResult {
  const ugc = firstMatch(text, UGC_OPEN)
  return {
    eligibility: 'REVIEW',
    reason:
      'Comments or replies appear open. Commercial-post rules are not a disqualifier. Dofollow is measured from HTML rel attributes, not from site policy copy.',
    evidence: ugc?.[0] ? makeEvidence(url, text, ugc[0], 'MEDIUM', checkedAt) : null,
    confidence: ugc?.[0] ? 'MEDIUM' : 'LOW',
  }
}

export function forumInventedType(signals: ForumSignals): HhtOppInventedType {
  const commentOnly = !signals.isForum && Boolean(signals.allowsUgc)
  return {
    name: signals.software ? `Forum (${signals.software})` : commentOnly ? 'Comments' : 'Forum',
    definition: 'User-generated discussion board or comment thread.',
    whyBacklink: 'Travelers ask destination and lodging questions; outbound links in posts or comments can be dofollow.',
    discoveryMethod: 'forum_ugc',
    outreachMethod: 'Leave a relevant comment or reply if the form is open. Never send automatically.',
  }
}

export function forumOpportunityWhy(signals: ForumSignals, policy: UgcLinkPolicy | null): string {
  const software = signals.software ? ` Detected ${signals.software}.` : ''
  if (policy?.linkType === 'ugc_dofollow') {
    return `Forum or comment thread allows user posts, and ${policy.dofollowCount} sampled UGC outbound link${policy.dofollowCount === 1 ? '' : 's'} are dofollow.${software}`
  }
  if (policy?.linkType === 'ugc_nofollow') {
    return `Forum or comment thread allows user posts, but sampled UGC outbound links use nofollow/ugc/sponsored.${software}`
  }
  return `Forum or comment thread with open UGC. Outbound link attributes were not measurable on the crawled pages.${software}`
}

export function forumEvidence(
  url: string,
  text: string,
  signals: ForumSignals,
  checkedAt = new Date(),
): HhtOppEvidence {
  return makeEvidence(url, `${text}\n${url}`, signals.evidence ?? url, signals.software ? 'HIGH' : 'MEDIUM', checkedAt)
}

export function forumHasSubmissionRoute(text: string): boolean {
  return UGC_OPEN.some((pattern) => pattern.test(text))
}

export function excerptForumMatch(text: string, match: string): string {
  return excerptAround(text, match)
}
