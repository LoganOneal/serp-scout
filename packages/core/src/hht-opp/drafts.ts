import { HHT_SITE_NAME, HHT_SITE_URL, type HhtOppType } from './types.js'

export interface DraftContext {
  publicationName: string
  domain: string
  opportunityType: HhtOppType
  inventedTypeName?: string | null
  requirementsSummary: string[]
  eligibility: string
  eligibilityReason: string
  recentArticles: string[]
  submissionMethod: string | null
  linkType: string
  priceLabel: string
  contact: string | null
  opportunityUrl: string
  relevantArticleUrl?: string | null
  brokenUrl?: string | null
  hhtAssets: string[]
  pitchAngle: string
}

export interface DraftVariant {
  tone: 'default' | 'shorter' | 'more_editorial' | 'more_casual' | 'more_data' | 'new_angle'
}

export function defaultPitchAngle(type: HhtOppType): string {
  switch (type) {
    case 'editorial_guest':
      return 'Room-level hotel amenity verification — private hot tubs, Jacuzzi suites, and romantic stays — using a dataset of 6,000+ U.S. hotels.'
    case 'paid_guest_post':
      return 'Placement inquiry for a travel-amenity article, clarifying link attributes and permanence before any payment.'
    case 'paid_link_insertion':
      return 'A specific existing article where HotelHotTubs is a natural supporting resource.'
    case 'sponsored_content':
      return 'Sponsored travel package inquiry with disclosure and link-attribute questions.'
    case 'directory_listing':
      return 'Add HotelHotTubs.com as a verified hotel-amenity research tool.'
    case 'resource_page':
      return 'HotelHotTubs as a useful planning resource for travelers looking for in-room hot tubs.'
    case 'existing_article':
      return 'Cite HotelHotTubs as supporting data or an additional recommendation.'
    case 'broken_link':
      return 'Replace a dead hotel-resource link with a live, relevant HotelHotTubs page.'
    case 'unlinked_mention':
      return 'Thank the publisher for the mention and ask for a citation link.'
    case 'data_pr':
      return 'Original analysis of 6,000+ U.S. hotels with room-level amenity verification.'
    case 'expert_source':
      return 'HotelHotTubs as a specialist source on in-room hotel amenities.'
    case 'hotel_tourism_partnership':
      return 'Editor’s Choice recognition, destination data, or a hotel profile partnership.'
    case 'other':
      return 'A relevant, evidence-backed way HotelHotTubs can help their readers.'
  }
}

export function buildDraftPrompt(ctx: DraftContext, variant: DraftVariant = { tone: 'default' }): string {
  const toneRule =
    variant.tone === 'shorter'
      ? 'Keep the entire email under 90 words.'
      : variant.tone === 'more_editorial'
        ? 'Write in a more editorial, editor-to-editor voice. Fewer sales words.'
        : variant.tone === 'more_casual'
          ? 'Write more casually, still professional. No slang about “synergy” or “value-add”.'
          : variant.tone === 'more_data'
            ? 'Lead with the strongest HotelHotTubs data point. Stay numerical and sourced.'
            : variant.tone === 'new_angle'
              ? 'Use a different angle than the default pitch. Do not repeat the first-sentence structure of a typical guest-post pitch.'
              : 'Write a concise, specific inquiry.'

  return `You are drafting outreach for ${HHT_SITE_NAME} (${HHT_SITE_URL}).
HotelHotTubs.com is a commercial website that verifies room-level hotel amenities (private hot tubs, Jacuzzi suites, romantic stays). Claire is not an independent personal travel blogger.

Rules:
- Use only the facts below. If a fact is missing, omit it or say it is unknown.
- Never invent a price, email, firsthand stay, or image-rights clearance.
- Never conceal that HotelHotTubs.com is a commercial website.
- Never claim firsthand hotel visits unless listed in HHT assets as verified.
- Never promise imagery. If images are discussed, say image rights require review.
- No outreach is sent automatically. This is a draft for human approval.
- ${toneRule}

Publication: ${ctx.publicationName} (${ctx.domain})
Opportunity type: ${ctx.inventedTypeName ?? ctx.opportunityType}
Opportunity URL: ${ctx.opportunityUrl}
Corporate eligibility: ${ctx.eligibility} — ${ctx.eligibilityReason}
Link type: ${ctx.linkType}
Price: ${ctx.priceLabel}
Submission method: ${ctx.submissionMethod ?? 'unknown'}
Contact: ${ctx.contact ?? 'unknown — do not invent an address'}
Pitch angle: ${ctx.pitchAngle}
Requirements:
${ctx.requirementsSummary.map((line) => `- ${line}`).join('\n') || '- none extracted'}
Relevant articles on their site:
${ctx.recentArticles.map((line) => `- ${line}`).join('\n') || '- none extracted'}
${ctx.relevantArticleUrl ? `Existing article for insertion: ${ctx.relevantArticleUrl}` : ''}
${ctx.brokenUrl ? `Broken URL to replace: ${ctx.brokenUrl}` : ''}
HHT assets that may be offered (do not overclaim):
${ctx.hhtAssets.map((line) => `- ${line}`).join('\n') || '- none selected'}

Return JSON only:
{
  "subject": "...",
  "body": "plain text email",
  "pitch_angle": "one sentence",
  "article_ideas": ["...", "..."] 
}
article_ideas may be empty unless the opportunity is an editorial or paid guest contribution.`
}

export function fallbackDraft(ctx: DraftContext): { subject: string; body: string; pitchAngle: string; articleIdeas: string[] } {
  const who = `I'm writing from ${HHT_SITE_NAME}, a commercial hotel-amenity research site (${HHT_SITE_URL}). We verify room-level details such as private hot tubs and Jacuzzi suites across 6,000+ U.S. hotels.`
  const contact = ctx.contact ? `I'm using the public contact published at ${ctx.opportunityUrl}.` : `I could not find a public editorial email, so this draft still needs a verified contact.`
  const price =
    ctx.priceLabel === 'Price unknown — contact publisher'
      ? 'If you publish paid placements, could you share current pricing, link attributes, and whether the placement is permanent?'
      : ctx.priceLabel !== '—' && ctx.priceLabel !== 'Free'
        ? `I saw a public price of ${ctx.priceLabel}. Please confirm that is current, along with link attributes.`
        : ''

  let ask = `Would HotelHotTubs be eligible to participate?`
  const ideas: string[] = []
  switch (ctx.opportunityType) {
    case 'editorial_guest':
      ask = `If businesses or industry researchers may contribute, I would like to pitch a reported piece rather than a promotional write-up.`
      ideas.push(
        'How U.S. hotels actually advertise “hot tub in room” vs what guests find at check-in',
        'A state-by-state look at private-tub hotel inventory for romantic weekend planning',
        'What “Jacuzzi suite” listings get wrong — and how travelers can verify amenities',
      )
      break
    case 'paid_guest_post':
    case 'sponsored_content':
      ask = `Before we consider a paid placement, I need to confirm link attributes, disclosure, permanence, and whether HotelHotTubs writes the article or you do.`
      break
    case 'paid_link_insertion':
      ask = ctx.relevantArticleUrl
        ? `Your article ${ctx.relevantArticleUrl} is a natural place to mention a verified hotel-amenity index. May we propose a short, factual sentence and a destination URL?`
        : `If you offer insertions into existing travel articles, I can propose a specific URL and sentence.`
      break
    case 'directory_listing':
      ask = `I would like to submit ${HHT_SITE_NAME} as a hotel-amenity research / planning resource. I can provide the listing copy you require.`
      break
    case 'resource_page':
      ask = `HotelHotTubs would be a relevant addition to this resource list: travelers can search verified in-room hot tubs by destination.`
      break
    case 'broken_link':
      ask = ctx.brokenUrl
        ? `A resource on your page (${ctx.brokenUrl}) appears to be dead. We have a live, relevant replacement on HotelHotTubs if you want a substitute.`
        : `If a hotel-resource link on the page is dead, we can offer a relevant live replacement.`
      break
    case 'unlinked_mention':
      ask = `Thank you for mentioning HotelHotTubs. If you are able to add a citation to ${HHT_SITE_URL}, readers can get to the source.`
      break
    case 'data_pr':
      ask = `We can share methodology and destination-level findings from our hotel-amenity dataset if useful for a data story.`
      break
    case 'expert_source':
      ask = `If you need a sourced comment on in-room amenities, hotel listing accuracy, or romantic-stay inventory, I can provide one.`
      break
    case 'hotel_tourism_partnership':
      ask = `We maintain Editor’s Choice and destination pages that may be useful for a partnership, badge, or data mention.`
      break
    default:
      break
  }

  const requirements = ctx.requirementsSummary.length
    ? `\n\nFrom your public guidelines:\n${ctx.requirementsSummary.map((line) => `• ${line}`).join('\n')}`
    : ''
  const assets = ctx.hhtAssets.length
    ? `\n\nRelevant HotelHotTubs pages we can point to:\n${ctx.hhtAssets.map((line) => `• ${line}`).join('\n')}`
    : ''

  const body = [
    `Hello,`,
    '',
    who,
    '',
    `I am looking at ${ctx.opportunityUrl}.`,
    ask,
    price,
    contact,
    requirements.trim(),
    assets.trim(),
    '',
    `HotelHotTubs.com is a commercial website. I will not claim firsthand stays or supply images unless rights are cleared.`,
    '',
    `Thank you for considering it.`,
    `Claire`,
    HHT_SITE_NAME,
  ]
    .filter((line) => line !== '')
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')

  return {
    subject: subjectFor(ctx),
    body,
    pitchAngle: ctx.pitchAngle,
    articleIdeas: ideas,
  }
}

function subjectFor(ctx: DraftContext): string {
  switch (ctx.opportunityType) {
    case 'unlinked_mention':
      return `Citation request: HotelHotTubs mention on ${ctx.domain}`
    case 'broken_link':
      return `Broken resource link on ${ctx.domain}`
    case 'directory_listing':
      return `Listing request: ${HHT_SITE_NAME}`
    case 'paid_guest_post':
    case 'sponsored_content':
      return `Placement inquiry from ${HHT_SITE_NAME}`
    case 'paid_link_insertion':
      return `Link insertion inquiry: ${ctx.publicationName}`
    case 'data_pr':
      return `Hotel amenity data for ${ctx.publicationName}`
    default:
      return `Contribution inquiry from ${HHT_SITE_NAME}`
  }
}
