import 'server-only'
import Anthropic from '@anthropic-ai/sdk'
import {
  buildDraftPrompt,
  defaultPitchAngle,
  fallbackDraft,
  formatPrice,
  HHT_OPP_TYPE_LABELS,
  type HhtOppType,
} from '@rnr/core'
import { eq } from 'drizzle-orm'
import { anthropicConfigured } from '../links/contacts.js'
import type { Database } from '../db.js'
import { hhtOppDrafts, hhtOppOpportunities } from '../schema.js'
import { suggestHhtAssets } from './assets.js'
import { getHhtOppDetail } from './queries.js'

export type DraftTone = 'default' | 'shorter' | 'more_editorial' | 'more_casual' | 'more_data' | 'new_angle'

export async function generateHhtOppDraft(
  db: Database,
  opportunityId: number,
  tone: DraftTone = 'default',
): Promise<{ id: number; subject: string; body: string }> {
  const detail = await getHhtOppDetail(db, opportunityId)
  if (!detail) throw new Error(`Opportunity ${opportunityId} not found`)

  const { opportunity, domain, requirements, contacts, sources } = detail
  const contact =
    contacts.find((row) => row.status === 'VERIFIED_PUBLIC' && row.email)?.email ??
    contacts.find((row) => row.formUrl)?.formUrl ??
    null
  const articles = sources
    .filter((row) => row.role !== 'opportunity_page' && row.title)
    .map((row) => `${row.title} — ${row.url}`)
    .slice(0, 6)
  const assets = await suggestHhtAssets(db, {
    text: `${opportunity.whyItMatters ?? ''} ${requirements.map((row) => row.requirementText).join(' ')}`,
    opportunityUrl: opportunity.opportunityUrl,
  })

  const ctx = {
    publicationName: domain.displayName ?? domain.rootDomain,
    domain: domain.rootDomain,
    opportunityType: opportunity.opportunityType as HhtOppType,
    inventedTypeName: opportunity.inventedType && typeof opportunity.inventedType['name'] === 'string'
      ? opportunity.inventedType['name']
      : null,
    requirementsSummary: opportunity.requirementsSummary,
    eligibility: opportunity.eligibility,
    eligibilityReason: opportunity.eligibilityReason,
    recentArticles: articles,
    submissionMethod: contact?.includes('@') ? `email ${contact}` : contact,
    linkType: opportunity.linkType,
    priceLabel: formatPrice({
      amount: opportunity.priceAmount,
      currency: opportunity.priceCurrency,
      status: opportunity.priceStatus,
      pricingModel: opportunity.pricingModel,
      included: null,
      evidence: null,
    }),
    contact,
    opportunityUrl: opportunity.opportunityUrl,
    relevantArticleUrl: opportunity.relevantArticleUrl,
    brokenUrl: opportunity.brokenUrl,
    hhtAssets: assets.map((row) =>
      row.imageRights === 'UNKNOWN' ? `${row.label} — ${row.url} (image rights require review)` : `${row.label} — ${row.url}`,
    ),
    pitchAngle: opportunity.pitchAngle ?? defaultPitchAngle(opportunity.opportunityType as HhtOppType),
  }

  let subject: string
  let body: string
  let pitchAngle = ctx.pitchAngle
  let articleIdeas: string[] = []

  if (anthropicConfigured()) {
    const client = new Anthropic()
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1_400,
      messages: [{ role: 'user', content: buildDraftPrompt(ctx, { tone }) }],
    })
    const text = response.content[0] && response.content[0].type === 'text' ? response.content[0].text : ''
    const parsed = parseDraftJson(text)
    if (parsed) {
      subject = parsed.subject
      body = parsed.body
      pitchAngle = parsed.pitch_angle || pitchAngle
      articleIdeas = parsed.article_ideas ?? []
    } else {
      const fallback = fallbackDraft(ctx)
      subject = fallback.subject
      body = fallback.body
      articleIdeas = fallback.articleIdeas
    }
  } else {
    const fallback = fallbackDraft(ctx)
    subject = fallback.subject
    body = fallback.body
    articleIdeas = fallback.articleIdeas
  }

  assertDraftHonesty(body, ctx.priceLabel)

  const inserted = await db
    .insert(hhtOppDrafts)
    .values({
      opportunityId,
      subject,
      body,
      pitchAngle,
      articleIdeas,
      tone,
      status: 'draft',
    })
    .returning({ id: hhtOppDrafts.id })

  await db
    .update(hhtOppOpportunities)
    .set({
      status: opportunity.status === 'NEW' || opportunity.status === 'REVIEW' || opportunity.status === 'PASS'
        ? 'DRAFT_READY'
        : opportunity.status,
      pitchAngle,
      updatedAt: new Date(),
    })
    .where(eq(hhtOppOpportunities.id, opportunityId))

  return { id: inserted[0]!.id, subject, body }
}

function parseDraftJson(text: string): {
  subject: string
  body: string
  pitch_angle?: string
  article_ideas?: string[]
} | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end < 0) return null
  try {
    const raw = JSON.parse(text.slice(start, end + 1)) as {
      subject?: string
      body?: string
      pitch_angle?: string
      article_ideas?: string[]
    }
    if (!raw.subject || !raw.body) return null
    return {
      subject: String(raw.subject),
      body: String(raw.body),
      pitch_angle: raw.pitch_angle ? String(raw.pitch_angle) : undefined,
      article_ideas: Array.isArray(raw.article_ideas) ? raw.article_ideas.map(String) : [],
    }
  } catch {
    return null
  }
}

function assertDraftHonesty(body: string, priceLabel: string): void {
  if (/i (?:stayed|visited|slept) at/i.test(body)) {
    throw new Error('Draft claimed firsthand hotel experience. Refusing to store it.')
  }
  if (priceLabel === 'Price unknown — contact publisher' && /\$\d{2,}/.test(body) && !/if you publish paid/i.test(body)) {
    throw new Error('Draft invented a price. Refusing to store it.')
  }
  void HHT_OPP_TYPE_LABELS
}
