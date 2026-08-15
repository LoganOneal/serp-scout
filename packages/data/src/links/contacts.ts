import 'server-only'
import Anthropic from '@anthropic-ai/sdk'
import { existsSync } from 'node:fs'
import { and, eq } from 'drizzle-orm'
import type { ContactConfidence } from '@rnr/core'
import type { Database } from '../db.js'
import { linkContacts, linkProspects } from '../schema.js'

/**
 * Who at this site handles editorial and partnership requests?
 *
 * ==================== THE AGENT NEVER INVENTS A CONTACT ====================
 * If the page does not say who handles this, the field is null and the prospect
 * is `confidence: 'none'`. It does not become "Hi there", and it does not
 * become a guessed `editor@domain.com` presented as found.
 *
 * The reason is operational, not fastidious: a guessed address BOUNCES, and
 * enough bounces destroy a sending domain — which costs far more than any one
 * placement is worth. A guessed NAME is worse: it lands, it is wrong, and it
 * tells the recipient exactly what this is.
 *
 * Three mechanisms enforce it rather than one comment asking nicely:
 *
 *   1. A strict JSON schema (`output_config.format`) with every field nullable,
 *      so "not found" is representable and the model never has to fill a slot.
 *   2. Every extracted field requires an `evidence` quote lifted VERBATIM from
 *      the page. A field without evidence is discarded on our side.
 *   3. Pattern-guessed addresses are allowed but stored as
 *      `confidence: 'pattern'` and excluded from a first send by default.
 * =========================================================================
 *
 * See docs/plan-link-outreach.md §4.
 */

/** Pages that carry an editorial contact, in the order worth trying. */
export const CONTACT_PATHS = [
  '/write-for-us',
  '/contribute',
  '/guest-post',
  '/guest-posts',
  '/contact',
  '/contact-us',
  '/about',
  '/about-us',
  '/team',
  '/editorial',
  '/advertise',
] as const

/** Bytes of page text handed to the model. Contact details sit near the top. */
const MAX_PAGE_CHARS = 12_000

export interface FetchedPage {
  url: string
  text: string
}

/**
 * Plain HTTP first, because it is free and works for most small sites.
 *
 * `on_page/instant_pages` is NOT used here: it returns no `raw_html` at all —
 * verified in this repo against `example.com` and recorded in
 * `domain-search-backlog.md` §5 — and `store_raw_html: true` does not change
 * it. The paid browser-render fallback is a separate, deliberate escalation.
 */
export async function fetchContactPages(
  domain: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number; maxPages?: number } = {},
): Promise<{ pages: FetchedPage[]; tried: number; blocked: boolean }> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const timeoutMs = opts.timeoutMs ?? 10_000
  const maxPages = opts.maxPages ?? 3
  const pages: FetchedPage[] = []
  let tried = 0
  let blocked = false

  for (const path of CONTACT_PATHS) {
    if (pages.length >= maxPages) break
    const url = `https://${domain}${path}`
    tried += 1
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      const res = await fetchImpl(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: {
          // Identify honestly. A scraper pretending to be Chrome is the kind of
          // thing that gets an IP range blocked for everyone.
          'user-agent': 'Mozilla/5.0 (compatible; rnr-outreach/1.0; +contact-discovery)',
          accept: 'text/html,application/xhtml+xml',
        },
      })
      clearTimeout(timer)

      // 403/429 from Cloudflare and friends. Recorded, not retried.
      if (res.status === 403 || res.status === 429) {
        blocked = true
        continue
      }
      if (!res.ok) continue

      const html = await res.text()
      const text = htmlToText(html)
      if (text.trim().length > 200) pages.push({ url, text: text.slice(0, MAX_PAGE_CHARS) })
    } catch {
      // Timeouts, DNS failures, TLS errors. All the same outcome: no page.
    }
  }

  return { pages, tried, blocked }
}

/**
 * Strip markup without a dependency.
 *
 * `mailto:` hrefs are hoisted into the text before tags are removed, because
 * the address is frequently ONLY in the attribute — a naive tag strip loses
 * exactly the field we came for.
 */
export function htmlToText(html: string): string {
  const mailtos = [...html.matchAll(/href=["']mailto:([^"'?]+)/gi)].map((m) => m[1]).filter(Boolean)
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)))
    .replace(/\s+/g, ' ')
  return mailtos.length > 0 ? `${mailtos.map((m) => `mailto: ${m}`).join('\n')}\n${body}` : body
}

export interface ExtractedContact {
  email: string | null
  name: string | null
  role: string | null
  confidence: ContactConfidence
  evidence: string | null
  sourceUrl: string | null
  guestPostTerms: string | null
  statedPriceUsd: number | null
}

/**
 * Every field nullable, and `evidence` carries the verbatim quote.
 *
 * Nullable everywhere is the point: the model is never forced to produce a
 * value it does not have, which is what makes "found nothing" a first-class
 * answer rather than a failure the model routes around by guessing.
 */
const CONTACT_SCHEMA = {
  type: 'object',
  properties: {
    email: {
      type: ['string', 'null'],
      description:
        'The contact email address, exactly as written on the page, including obfuscated forms ' +
        'de-obfuscated (e.g. "name [at] site.com" becomes "name@site.com"). Null if the page ' +
        'does not publish one.',
    },
    name: {
      type: ['string', 'null'],
      description: 'The person who handles editorial or partnership requests, only if the page names them. Null otherwise.',
    },
    role: {
      type: ['string', 'null'],
      description: 'Their stated job title, only if the page states it. Null otherwise.',
    },
    evidence: {
      type: ['string', 'null'],
      description:
        'A short quote copied VERBATIM from the page that supports the fields above. Do not ' +
        'paraphrase. Null if you found nothing.',
    },
    guest_post_terms: {
      type: ['string', 'null'],
      description: 'What the page says about accepting guest posts or sponsored content, quoted or closely summarised. Null if it says nothing.',
    },
    stated_price_usd: {
      type: ['number', 'null'],
      description: 'A price the page names for a placement, in USD. Null if no price is stated.',
    },
    accepts_contact_form_only: {
      type: 'boolean',
      description: 'True if the page offers only a contact form and publishes no email address.',
    },
  },
  required: [
    'email',
    'name',
    'role',
    'evidence',
    'guest_post_terms',
    'stated_price_usd',
    'accepts_contact_form_only',
  ],
  additionalProperties: false,
} as const

const SYSTEM = `You extract publisher contact details from web pages for editorial outreach.

Report only what the page actually says. Every field is nullable and null is the correct answer whenever the page does not state something — you are never required to fill a field.

Rules:
- Copy the email address exactly as published. De-obfuscate written forms such as "name [at] site dot com" into "name@site.com", but never construct an address from a pattern, a person's name, or the domain.
- Give a name or role only when the page names that person. Do not infer who is likely responsible.
- "evidence" must be a short quote copied verbatim from the page text. If you cannot quote it, the field it supports should be null.
- Prefer an editorial, partnerships, or contributions address over a generic sales or support one.
- If the page only offers a contact form, set accepts_contact_form_only and leave email null.`

export interface ExtractOptions {
  apiKey?: string
  model?: string
  client?: Anthropic
}

/**
 * One model call over the fetched pages.
 *
 * Effort is deliberately low: this is verbatim extraction from short text, not
 * a reasoning task, and the cost is multiplied by every prospect in the run.
 */
export async function extractContact(
  domain: string,
  pages: FetchedPage[],
  opts: ExtractOptions = {},
): Promise<ExtractedContact> {
  if (pages.length === 0) {
    return {
      email: null,
      name: null,
      role: null,
      confidence: 'none',
      evidence: null,
      sourceUrl: null,
      guestPostTerms: null,
      statedPriceUsd: null,
    }
  }

  const client =
    opts.client ??
    new Anthropic(opts.apiKey === undefined ? {} : { apiKey: opts.apiKey })

  const corpus = pages.map((p) => `--- ${p.url} ---\n${p.text}`).join('\n\n')

  const response = await client.messages.create({
    model: opts.model ?? 'claude-opus-5',
    max_tokens: 2_000,
    system: SYSTEM,
    output_config: {
      effort: 'low',
      format: { type: 'json_schema', schema: CONTACT_SCHEMA },
    },
    messages: [
      {
        role: 'user',
        content: `Site: ${domain}\n\nPages:\n\n${corpus}`,
      },
    ],
  })

  /**
   * A refusal is not a "no contact found" — it is the absence of an answer, and
   * folding it into `none` would let a blocked extraction masquerade as a
   * measured negative.
   */
  if (response.stop_reason === 'refusal') {
    throw new Error(`contact extraction refused for ${domain}`)
  }

  const text = response.content.find((b) => b.type === 'text')
  if (!text || text.type !== 'text') throw new Error(`no text block for ${domain}`)

  const parsed = JSON.parse(text.text) as {
    email: string | null
    name: string | null
    role: string | null
    evidence: string | null
    guest_post_terms: string | null
    stated_price_usd: number | null
    accepts_contact_form_only: boolean
  }

  /**
   * Our side of the never-invent rule. The schema lets the model return null;
   * this discards anything it returned WITHOUT the verbatim quote that makes it
   * checkable. A confident-looking extraction with no evidence is exactly the
   * failure mode we are guarding, so it is dropped rather than trusted.
   */
  const hasEvidence = typeof parsed.evidence === 'string' && parsed.evidence.trim().length > 0
  const email = hasEvidence ? cleanEmail(parsed.email) : null

  const confidence: ContactConfidence = email
    ? 'stated'
    : parsed.accepts_contact_form_only
      ? 'form_only'
      : 'none'

  return {
    email,
    name: hasEvidence && email ? (parsed.name?.trim() || null) : null,
    role: hasEvidence && email ? (parsed.role?.trim() || null) : null,
    confidence,
    evidence: hasEvidence ? parsed.evidence!.trim() : null,
    sourceUrl: pages[0]?.url ?? null,
    guestPostTerms: parsed.guest_post_terms?.trim() || null,
    statedPriceUsd:
      typeof parsed.stated_price_usd === 'number' && Number.isFinite(parsed.stated_price_usd)
        ? parsed.stated_price_usd
        : null,
  }
}

/** Reject anything that is not plausibly an address rather than repairing it. */
export function cleanEmail(raw: string | null): string | null {
  if (!raw) return null
  const e = raw
    .trim()
    .toLowerCase()
    .replace(/\s*\[\s*at\s*\]\s*/g, '@')
    .replace(/\s*\(\s*at\s*\)\s*/g, '@')
    .replace(/\s+at\s+/g, '@')
    .replace(/\s*\[\s*dot\s*\]\s*/g, '.')
    .replace(/\s*\(\s*dot\s*\)\s*/g, '.')
    .replace(/\s+dot\s+/g, '.')
    .replace(/\s/g, '')
  return /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(e) ? e : null
}

export interface DiscoverResult {
  attempted: number
  found: number
  formOnly: number
  blocked: number
  none: number
  /** Extractions that threw. UNKNOWN — never counted as "no contact found". */
  failed: number
  costNote: string
}

/**
 * The SDK resolves `ANTHROPIC_API_KEY`, then `ANTHROPIC_AUTH_TOKEN`, then an
 * `ant auth login` profile on disk. Checking only the env var would report "not
 * configured" on a machine that is perfectly well authenticated, so this probes
 * cheaply and lets the SDK's own resolution decide.
 */
export function anthropicConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env['ANTHROPIC_API_KEY']?.trim() || env['ANTHROPIC_AUTH_TOKEN']?.trim()) return true

  /**
   * `new Anthropic()` does NOT throw when nothing resolves — it constructs fine
   * and fails at request time. The first version of this check relied on that
   * throw, passed, and let 25 extractions fail one by one with the cause buried
   * in a per-row catch. So the profile is checked on disk instead.
   */
  const dir =
    env['ANTHROPIC_CONFIG_DIR']?.trim() ||
    (env['APPDATA'] ? `${env['APPDATA']}/Anthropic` : null) ||
    (env['HOME'] ? `${env['HOME']}/.config/anthropic` : null)
  if (!dir) return false
  try {
    return existsSync(`${dir}/credentials`)
  } catch {
    return false
  }
}

/**
 * Run discovery across a run's qualified prospects.
 *
 * Only `PURSUE` rows by default — contact discovery is the second paid stage
 * and running it on rejected prospects spends model tokens to email sites we
 * already decided against.
 */
export async function discoverContacts(
  db: Database,
  runId: number,
  opts: { limit?: number; live?: boolean; model?: string } = {},
): Promise<DiscoverResult> {
  const rows = await db
    .select({ id: linkProspects.id, domain: linkProspects.domain })
    .from(linkProspects)
    .where(and(eq(linkProspects.runId, runId), eq(linkProspects.verdict, 'PURSUE')))
    .limit(opts.limit ?? 25)

  let found = 0
  let formOnly = 0
  let blocked = 0
  let none = 0
  let failed = 0

  if (opts.live === false) {
    return {
      attempted: 0,
      found: 0,
      formOnly: 0,
      blocked: 0,
      none: 0,
      failed: 0,
      costNote: `${rows.length} prospect(s) ready. Pass --live to fetch pages and extract.`,
    }
  }

  /**
   * Checked ONCE, up front, and reported as a blocker rather than discovered
   * per-row inside the catch below. Without this the run reports "0 found" with
   * no cause — which reads as "these sites publish no contacts" when the truth
   * is that nothing was ever asked.
   */
  if (!anthropicConfigured()) {
    return {
      attempted: 0,
      found: 0,
      formOnly: 0,
      blocked: 0,
      none: 0,
      failed: 0,
      costNote:
        `No Anthropic credentials. ${rows.length} prospect(s) are waiting and NOTHING was ` +
        `attempted — this is not "no contacts found". Set ANTHROPIC_API_KEY or run \`ant auth login\`.`,
    }
  }

  for (const row of rows) {
    const fetched = await fetchContactPages(row.domain)
    if (fetched.blocked && fetched.pages.length === 0) blocked += 1

    let contact: ExtractedContact
    try {
      contact = await extractContact(row.domain, fetched.pages, {
        ...(opts.model === undefined ? {} : { model: opts.model }),
      })
    } catch {
      // A failed extraction is UNKNOWN, not "no contact". Counted separately and
      // never stored, so it cannot later be read as a measured negative.
      failed += 1
      continue
    }

    if (contact.confidence === 'stated') found += 1
    else if (contact.confidence === 'form_only') formOnly += 1
    else none += 1

    await db.insert(linkContacts).values({
      prospectId: row.id,
      email: contact.email,
      name: contact.name,
      role: contact.role,
      confidence: contact.confidence,
      evidence: contact.evidence,
      sourceUrl: contact.sourceUrl,
      guestPostTerms: contact.guestPostTerms,
      statedPriceMicros:
        contact.statedPriceUsd === null
          ? null
          : BigInt(Math.round(contact.statedPriceUsd * 1_000_000)),
    })
  }

  return {
    attempted: rows.length,
    found,
    formOnly,
    blocked,
    none,
    failed,
    costNote:
      `Page fetches are free. ${rows.length - failed} extraction call(s) on the configured model. ` +
      `${blocked} site(s) blocked the fetch and ${failed} extraction(s) threw — both are UNKNOWN, ` +
      `not "no contact published".`,
  }
}
