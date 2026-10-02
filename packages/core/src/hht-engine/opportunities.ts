import { hash } from 'fast-sha256'
import type { GuestPostStatus, LeadStatus, OpportunityType } from './types.js'

export function publisherExternalId(rootDomain: string): string {
  return sha256(rootDomain.toLowerCase())
}

export function opportunityExternalId(canonicalKey: string): string {
  return sha256(canonicalKey)
}

function sha256(value: string): string {
  return Array.from(hash(new TextEncoder().encode(value)), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function guestPostKey(rootDomain: string): string {
  return `${rootDomain.toLowerCase()}+guest_post`
}

export function insertionKey(rootDomain: string, canonicalUrl: string): string {
  return `${rootDomain.toLowerCase()}+${canonicalUrl}+link_insertion`
}

export function guestPostIsPrimary(status: GuestPostStatus | null): boolean {
  return status === 'ACCEPTS' || status === 'LIKELY_ACCEPTS'
}

export function insertionLeadStatus(guestPost: GuestPostStatus | null): LeadStatus {
  return guestPostIsPrimary(guestPost) ? 'HELD' : 'QUALIFIED'
}

export function releaseHeldInsertions(guestPostOutcome: LeadStatus): boolean {
  return guestPostOutcome === 'REJECTED' || guestPostOutcome === 'NO_RESPONSE' || guestPostOutcome === 'DECLINED_BY_HHT'
}

export interface InsertionPage {
  canonicalUrl: string
  bestPosition: number
}

export function bundleInsertionPages(pages: InsertionPage[]): InsertionPage[] {
  return [...pages].sort((a, b) => a.bestPosition - b.bestPosition)
}

export function opportunityTypeLabel(type: OpportunityType): string {
  return type
}
