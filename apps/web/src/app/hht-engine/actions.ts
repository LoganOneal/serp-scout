'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import {
  approveLeadReview,
  queueApprovedOpportunitiesForCrm,
  queueApprovedOpportunityForCrm,
  rejectLeadReview,
  saveLeadReview,
  type SaveLeadReviewInput,
} from '@rnr/data'

function messageUrl(path: string, message: string, tone: 'success' | 'error' = 'success'): string {
  const params = new URLSearchParams({ message, tone })
  return `${path}?${params}`
}

function reviewInput(formData: FormData): SaveLeadReviewInput {
  const opportunityId = Number(formData.get('opportunityId'))
  if (!Number.isInteger(opportunityId) || opportunityId <= 0) throw new Error('Invalid opportunity')
  const sequence = [1, 2].flatMap((position) => {
    const subject = String(formData.get(`followup${position}Subject`) ?? '').trim()
    const body = String(formData.get(`followup${position}Body`) ?? '').trim()
    if (!subject && !body) return []
    const delayDays = Math.max(1, Math.min(90, Number(formData.get(`followup${position}Delay`)) || (position === 1 ? 3 : 7)))
    return [{ position, delayDays, subject, body }]
  })
  return {
    opportunityId,
    subject: String(formData.get('subject') ?? '').trim(),
    body: String(formData.get('body') ?? '').trim(),
    sequence,
    reviewer: String(formData.get('reviewer') ?? '').trim(),
    notes: String(formData.get('notes') ?? '').trim(),
  }
}

async function runReviewAction(
  formData: FormData,
  mutate: (input: SaveLeadReviewInput) => Promise<void>,
  success: string,
): Promise<never> {
  let id = Number(formData.get('opportunityId'))
  try {
    const input = reviewInput(formData)
    id = input.opportunityId
    await mutate(input)
    revalidatePath('/hht-engine')
    revalidatePath(`/hht-engine/${id}`)
    redirect(messageUrl(`/hht-engine/${id}`, success))
  } catch (error) {
    if (isRedirectError(error)) throw error
    redirect(messageUrl(`/hht-engine/${id}`, error instanceof Error ? error.message : 'Review action failed.', 'error'))
  }
}

export async function saveLeadReviewAction(formData: FormData): Promise<never> {
  return runReviewAction(formData, saveLeadReview, 'Changes saved. Approval is required before CRM queueing.')
}

export async function approveLeadReviewAction(formData: FormData): Promise<never> {
  return runReviewAction(formData, approveLeadReview, 'Approved snapshot saved. This lead can now be pushed to the CRM outbox.')
}

export async function rejectLeadReviewAction(formData: FormData): Promise<never> {
  return runReviewAction(formData, rejectLeadReview, 'Lead rejected. Nothing was sent or queued.')
}

export async function pushLeadToCrmAction(formData: FormData): Promise<never> {
  const id = Number(formData.get('opportunityId'))
  try {
    if (!Number.isInteger(id) || id <= 0) throw new Error('Invalid opportunity')
    const result = await queueApprovedOpportunityForCrm(id)
    if (!result.queued) throw new Error(result.reason ?? 'Lead could not be queued')
    revalidatePath('/hht-engine')
    revalidatePath(`/hht-engine/${id}`)
    redirect(messageUrl(`/hht-engine/${id}`, 'Exact approved snapshot queued for CRM sync. No outreach was sent.'))
  } catch (error) {
    if (isRedirectError(error)) throw error
    redirect(messageUrl(`/hht-engine/${id}`, error instanceof Error ? error.message : 'CRM queue failed.', 'error'))
  }
}

export async function bulkPushLeadsToCrmAction(formData: FormData): Promise<never> {
  const ids = formData.getAll('opportunityIds')
    .map(Number)
    .filter((id) => Number.isInteger(id) && id > 0)
  if (ids.length === 0) redirect(messageUrl('/hht-engine', 'Select at least one lead.', 'error'))
  try {
    const results = await queueApprovedOpportunitiesForCrm(ids)
    const queued = results.filter((result) => result.queued).length
    const skipped = results.length - queued
    revalidatePath('/hht-engine')
    redirect(messageUrl(
      '/hht-engine',
      `${queued} approved lead${queued === 1 ? '' : 's'} queued for CRM sync; ${skipped} skipped. No outreach was sent.`,
      queued === 0 ? 'error' : 'success',
    ))
  } catch (error) {
    if (isRedirectError(error)) throw error
    redirect(messageUrl('/hht-engine', error instanceof Error ? error.message : 'Bulk CRM queue failed.', 'error'))
  }
}

function isRedirectError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'digest' in error && String(error.digest).startsWith('NEXT_REDIRECT')
}
