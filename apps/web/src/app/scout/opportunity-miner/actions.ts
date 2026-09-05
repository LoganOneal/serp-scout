'use server'

import { revalidatePath } from 'next/cache'
import { db, updateMarketReview } from '@rnr/data'

export async function updateMinerReview(formData: FormData): Promise<{ ok: boolean; error?: string }> {
  const slug = String(formData.get('slug') ?? '')
  if (!slug) return { ok: false, error: 'Missing market' }
  const overrideRaw = String(formData.get('scoreOverride') ?? '').trim()
  const tags = String(formData.get('tags') ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
  try {
    await updateMarketReview(db(), slug, {
      status: String(formData.get('status') ?? 'new'),
      notes: String(formData.get('notes') ?? ''),
      scoreOverride: overrideRaw === '' ? null : Number(overrideRaw),
      tags,
    })
    revalidatePath('/scout/opportunity-miner')
    revalidatePath(`/scout/opportunity-miner/${slug}`)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Save failed' }
  }
}
