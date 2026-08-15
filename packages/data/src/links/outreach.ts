import 'server-only'
import Anthropic from '@anthropic-ai/sdk'
import { and, eq, isNotNull, or, sql } from 'drizzle-orm'
import type { Database } from '../db.js'
import {
  linkContacts,
  linkProspects,
  outreachCampaigns,
  outreachMessages,
  outreachSuppressions,
  sites,
} from '../schema.js'
import { siteSupplyFact, supplyFactFor } from '../supply/query.js'

/**
 * Drafting outreach, and the checks that run before anything can be sent.
 *
 * ==================== SUPPRESSION IS BUILT BEFORE DRAFTING ================
 * Retrofitting a do-not-contact check is how a "please stop" gets emailed a
 * second time. CAN-SPAM requires honouring an opt-out within 10 business days,
 * which assumes the list exists and is consulted — so it is the first thing
 * here, and every draft passes through it.
 *
 * ==================== AND NOTHING SENDS FROM THIS FILE ====================
 * `draftCampaign` produces `status: 'draft'` rows. There is no send function.
 * Deliverability — warmup, sending-domain separation, throttling, bounce and
 * reply handling — is a specialist problem that lemlist (already connected)
 * solves, and writing an email sender here would mean owning all of it badly.
 * =========================================================================
 *
 * See docs/plan-link-outreach.md §5.
 */

// --- Suppression -------------------------------------------------------------

export async function suppress(
  db: Database,
  args: { email?: string; domain?: string; reason: string },
): Promise<void> {
  const email = args.email?.trim().toLowerCase() || null
  const domain = args.domain?.trim().toLowerCase().replace(/^www\./, '') || null
  if (!email && !domain) throw new Error('suppress needs an email or a domain')

  await db
    .insert(outreachSuppressions)
    .values({ email, domain, reason: args.reason })
    .onConflictDoNothing()
}

export interface SuppressionCheck {
  suppressed: boolean
  reason: string | null
}

/**
 * Checked on BOTH the address and its domain.
 *
 * Domain-level matters more than it looks: someone who asks to be left alone
 * usually speaks for the site, not just for the inbox the mail happened to
 * reach. Suppressing only the exact address means the next contact discovered
 * at that domain is fair game, which is precisely what they asked us not to do.
 */
export async function checkSuppression(
  db: Database,
  args: { email: string | null; domain: string },
): Promise<SuppressionCheck> {
  const email = args.email?.trim().toLowerCase() ?? null
  const domain = args.domain.trim().toLowerCase().replace(/^www\./, '')

  const rows = await db
    .select()
    .from(outreachSuppressions)
    .where(
      or(
        email ? eq(outreachSuppressions.email, email) : sql`false`,
        eq(outreachSuppressions.domain, domain),
      ),
    )
    .limit(1)

  const hit = rows[0]
  return hit ? { suppressed: true, reason: hit.reason } : { suppressed: false, reason: null }
}

// --- Drafting ----------------------------------------------------------------

const DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    subject: { type: 'string', description: 'A plain, specific subject line. No "Re:", no fake thread.' },
    body: {
      type: 'string',
      description:
        'The email body. Plain text. Include the unsubscribe line and postal address exactly as given.',
    },
    facts_used: {
      type: 'array',
      description: 'Every specific claim made about the recipient site, and where it came from.',
      items: {
        type: 'object',
        properties: {
          claim: { type: 'string' },
          source: { type: 'string', description: 'Which supplied field this came from.' },
        },
        required: ['claim', 'source'],
        additionalProperties: false,
      },
    },
  },
  required: ['subject', 'body', 'facts_used'],
  additionalProperties: false,
} as const

const DRAFT_SYSTEM = `You write short, honest outreach emails proposing a guest post.

You may only state facts that appear in the data you are given. Every specific claim about the recipient's site must be listed in facts_used with the field it came from. If you have no specific fact about them, write a shorter email rather than inventing a detail — a generic email is recoverable, a wrong one is not.

Rules:
- Never fabricate having read a specific article, met the person, or corresponded before.
- Never use a "Re:" subject or otherwise imply an existing thread.
- Address the person by name only if a name is supplied. Otherwise open without a name — do not write "Hi there" filler or guess a role.
- Say plainly who you are and what you want in the first two sentences.
- Include the supplied unsubscribe line and postal address verbatim at the end.
- Keep it under 150 words before the footer.`

export interface DraftResult {
  campaignId: number
  drafted: number
  blocked: number
  skippedPattern: number
  notes: string[]
}

export interface DraftArgs {
  siteId: number
  runId: number
  name: string
  fromName: string
  fromEmail: string
  /** CAN-SPAM requires a valid physical postal address in commercial email. */
  postalAddress: string
  unsubscribeLine: string
  /** Topic we are proposing to write for them. */
  proposedTopic: string
  /**
   * Scope the supply fact to one entity, e.g. `aspen-co`.
   *
   * Omitted, the pitch carries the site-wide figure instead. Both are sourced to
   * a coverage row; neither is generated when there is no coverage at all.
   */
  supplyEntity?: string | null
  limit?: number
  /** Include `confidence: 'pattern'` addresses. Off by default — bounces. */
  includePatternAddresses?: boolean
  live?: boolean
  model?: string
}

export async function draftCampaign(db: Database, args: DraftArgs): Promise<DraftResult> {
  const notes: string[] = []

  if (!args.postalAddress.trim() || !args.unsubscribeLine.trim()) {
    /**
     * Refused, not defaulted. A physical address and a working opt-out are
     * CAN-SPAM requirements on commercial email; generating drafts without them
     * would produce a campaign that cannot legally be sent, and the gap would
     * only surface at the point somebody pressed send.
     */
    throw new Error(
      'postalAddress and unsubscribeLine are required: CAN-SPAM requires a valid physical ' +
        'address and a working opt-out in commercial email.',
    )
  }

  const [site] = await db
    .select({ domain: sites.domain })
    .from(sites)
    .where(eq(sites.id, args.siteId))
    .limit(1)
  if (!site?.domain) throw new Error(`site ${args.siteId} has no domain`)

  /**
   * Resolved ONCE, before the loop. It is a fact about us, not about the
   * recipient, so re-querying it per contact would be the same answer at 25x
   * the cost.
   */
  const ourSupply = args.supplyEntity
    ? await supplyFactFor(db, args.siteId, args.supplyEntity)
    : await siteSupplyFact(db, args.siteId)

  if (!ourSupply) {
    notes.push(
      'No supply coverage, so drafts carry no claim about our own inventory. The prompt is told ' +
        'not to characterise it rather than to guess — a generic email is recoverable, a wrong ' +
        'one is not.',
    )
  }

  const [campaign] = await db
    .insert(outreachCampaigns)
    .values({
      siteId: args.siteId,
      runId: args.runId,
      name: args.name,
      status: 'draft',
      fromName: args.fromName,
      fromEmail: args.fromEmail,
      postalAddress: args.postalAddress,
    })
    .returning({ id: outreachCampaigns.id })
  if (!campaign) throw new Error('failed to create campaign')

  const confidences = args.includePatternAddresses ? ['stated', 'pattern'] : ['stated']
  const rows = await db
    .select({
      contactId: linkContacts.id,
      email: linkContacts.email,
      name: linkContacts.name,
      role: linkContacts.role,
      confidence: linkContacts.confidence,
      evidence: linkContacts.evidence,
      guestPostTerms: linkContacts.guestPostTerms,
      domain: linkProspects.domain,
      rankedKeywords: linkProspects.rankedKeywords,
      competitorLinkCount: linkProspects.competitorLinkCount,
    })
    .from(linkContacts)
    .innerJoin(linkProspects, eq(linkProspects.id, linkContacts.prospectId))
    .where(
      and(
        eq(linkProspects.runId, args.runId),
        isNotNull(linkContacts.email),
        sql`${linkContacts.confidence} in ${confidences}`,
      ),
    )
    .limit(args.limit ?? 25)

  if (!args.includePatternAddresses) {
    notes.push(
      'Pattern-guessed addresses excluded. They bounce, and bounces damage the sending domain ' +
        'more than any single placement is worth. Pass includePatternAddresses to override.',
    )
  }

  let drafted = 0
  let blocked = 0

  if (args.live === false) {
    notes.push(`${rows.length} contact(s) ready to draft. Pass --live to generate.`)
    return { campaignId: campaign.id, drafted: 0, blocked: 0, skippedPattern: 0, notes }
  }

  const client = new Anthropic()

  for (const row of rows) {
    // THE CHECK. Before drafting, not before sending — a suppressed contact
    // should not have a draft sitting in the table waiting to be approved.
    const suppression = await checkSuppression(db, { email: row.email, domain: row.domain })
    if (suppression.suppressed) {
      blocked += 1
      await db.insert(outreachMessages).values({
        campaignId: campaign.id,
        contactId: row.contactId,
        subject: '(blocked)',
        body: '(blocked)',
        status: 'blocked',
        blockedReason: `suppressed: ${suppression.reason}`,
      })
      continue
    }

    const facts = {
      recipient_site: row.domain,
      recipient_name: row.name ?? '(not published — do not guess)',
      recipient_role: row.role ?? '(not published — do not guess)',
      their_stated_guest_post_terms: row.guestPostTerms ?? '(none published)',
      our_site: site.domain,
      proposed_topic: args.proposedTopic,
      /**
       * ==================== A CHECKABLE FACT ABOUT US ====================
       * Every other field here describes THEM, and the system prompt tells the
       * model to write a shorter email rather than invent one. That is the right
       * default and it produces a thin pitch: we ask for a link and offer
       * nothing specific in return.
       *
       * Supply fixes that with a number rather than an adjective. "We list 38
       * hot tub suites across 12 Aspen properties" is checkable, sourced to a
       * coverage row with a timestamp, and is the kind of specific that
       * distinguishes a pitch from a template.
       *
       * Null when there is no coverage, never a vague stand-in — "a great
       * selection" is exactly the unsourced filler the facts_used gate exists to
       * reject.
       * ===================================================================
       */
      our_supply: ourSupply?.claim ?? '(no supply data — do not characterise our inventory)',
      our_supply_source: ourSupply?.source ?? null,
      from_name: args.fromName,
      postal_address: args.postalAddress,
      unsubscribe_line: args.unsubscribeLine,
    }

    const response = await client.messages.create({
      model: args.model ?? 'claude-opus-5',
      max_tokens: 2_000,
      system: DRAFT_SYSTEM,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: DRAFT_SCHEMA } },
      messages: [{ role: 'user', content: JSON.stringify(facts, null, 2) }],
    })

    if (response.stop_reason === 'refusal') {
      blocked += 1
      continue
    }
    const textBlock = response.content.find((b) => b.type === 'text')
    if (!textBlock || textBlock.type !== 'text') continue

    const draft = JSON.parse(textBlock.text) as {
      subject: string
      body: string
      facts_used: Array<{ claim: string; source: string }>
    }

    /**
     * Merge-field and footer verification, on our side.
     *
     * A body containing an unresolved placeholder, or missing the unsubscribe
     * line, is BLOCKED rather than sent — those are the two failures that are
     * both certain to be noticed by the recipient and certain to be noticed too
     * late.
     */
    const problems: string[] = []
    if (/\{\{|\}\}|\[insert|\[name\]|XXX/i.test(draft.body)) {
      problems.push('unresolved merge field in body')
    }
    if (!draft.body.includes(args.unsubscribeLine.trim())) problems.push('missing unsubscribe line')
    if (!draft.body.includes(args.postalAddress.trim())) problems.push('missing postal address')
    if (/^re:/i.test(draft.subject)) problems.push('subject implies an existing thread')

    await db.insert(outreachMessages).values({
      campaignId: campaign.id,
      contactId: row.contactId,
      subject: draft.subject,
      body: draft.body,
      status: problems.length > 0 ? 'blocked' : 'draft',
      blockedReason: problems.length > 0 ? problems.join('; ') : null,
      personalisation: Object.fromEntries(draft.facts_used.map((f) => [f.claim, f.source])),
    })

    if (problems.length > 0) blocked += 1
    else drafted += 1
  }

  notes.push(
    'Drafts only. Nothing here sends — deliverability (warmup, sending domain, throttling, ' +
      'bounce and reply handling) belongs in lemlist, which is already connected.',
  )

  return { campaignId: campaign.id, drafted, blocked, skippedPattern: 0, notes }
}

export interface MessageRow {
  id: number
  subject: string
  status: string
  blockedReason: string | null
  email: string | null
  domain: string
}

export async function listMessages(
  db: Database,
  campaignId: number,
  limit = 50,
): Promise<MessageRow[]> {
  return db
    .select({
      id: outreachMessages.id,
      subject: outreachMessages.subject,
      status: outreachMessages.status,
      blockedReason: outreachMessages.blockedReason,
      email: linkContacts.email,
      domain: linkProspects.domain,
    })
    .from(outreachMessages)
    .innerJoin(linkContacts, eq(linkContacts.id, outreachMessages.contactId))
    .innerJoin(linkProspects, eq(linkProspects.id, linkContacts.prospectId))
    .where(eq(outreachMessages.campaignId, campaignId))
    .limit(limit)
}
