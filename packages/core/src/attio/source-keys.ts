import { canonicalPageUrl } from './domains.js'
import type { AttioWorkstream } from './types.js'

export function editorChoiceSourceKey(hotelIdOrSlug: string): string {
  const id = hotelIdOrSlug.trim().toLowerCase()
  if (!id) throw new Error('Editor Choice source key requires a hotel id or slug')
  return `editor-choice:${id}`
}

export function backlinkSourceKey(canonicalTargetArticleUrl: string): string {
  const url = canonicalPageUrl(canonicalTargetArticleUrl)
  if (!url) throw new Error('Backlink source key requires a canonical article URL')
  return `backlink:${url}`
}

export function guestPostSourceKey(sourceIdOrDomainAndOpportunity: string): string {
  const id = sourceIdOrDomainAndOpportunity.trim().toLowerCase()
  if (!id) throw new Error('Guest post source key requires a source id')
  return `guest-post:${id}`
}

export function sourceKeyFor(workstream: AttioWorkstream, identity: string): string {
  switch (workstream) {
    case 'editors-choice':
      return editorChoiceSourceKey(identity)
    case 'backlinks':
      return backlinkSourceKey(identity)
    case 'guest-posts':
      return guestPostSourceKey(identity)
  }
}

export function sourceRef(repo: 'hotel-hot-tubs' | 'serp-scout', location: string): string {
  let cleaned = location.replace(/\\/g, '/')
  cleaned = cleaned.replace(/^[A-Za-z]:/, '')
  cleaned = cleaned.replace(/^\/Users\/[^/]+\//, '')
  cleaned = cleaned.replace(/^\/home\/[^/]+\//, '')
  for (const marker of ['serp-scout/', 'hottub-hotels/', 'hotel-hot-tubs/']) {
    const idx = cleaned.indexOf(marker)
    if (idx >= 0) {
      cleaned = cleaned.slice(idx + marker.length)
      break
    }
  }
  return `${repo}:${cleaned.replace(/^\/+/, '')}`
}

export const FOLLOWUP_MARKER = /\[hht-followup:(.+):(\d+)\]/g

export function followupMarker(sourceKey: string, n: number): string {
  return `[hht-followup:${sourceKey}:${n}]`
}

export function parseFollowupMarker(text: string | null | undefined): { sourceKey: string; n: number } | null {
  if (!text) return null
  const match = /\[hht-followup:(.+):(\d+)\]/.exec(text)
  if (!match) return null
  return { sourceKey: match[1]!, n: Number(match[2]) }
}

export function sourceNoteTitle(sourceKey: string): string {
  return `[hht-source:${sourceKey}]`
}
