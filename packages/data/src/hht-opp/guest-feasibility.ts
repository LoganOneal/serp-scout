import 'server-only'
import {
  guestContactMethod,
  judgePitchPages,
  serpResultKey,
  writeGuestPitch,
  type PitchPage,
} from '@rnr/core'
import { eq } from 'drizzle-orm'
import type { Database } from '../db.js'
import {
  hhtOppContacts,
  hhtOppCrawledPages,
  hhtOppDomains,
  hhtOppGuestEvaluations,
  hhtOppOpportunities,
} from '../schema.js'

const PITCH_PATHS = ['/', '/write-for-us', '/guest-post', '/guest-posts', '/contribute', '/submissions', '/contact']

export interface FeasibilityPage {
  url: string
  text: string
  html?: string | null
  status?: number | null
}

export interface GuestFeasibilityResult {
  verdict: string
  pitchUrl: string
  contact: { method: 'email' | 'form'; value: string; sourceUrl: string } | null
}

/**
 * Judge a domain with the guest-post feasibility check. An email or form is
 * stored only after the verdict is Pursue.
 */
export async function applyGuestFeasibility(
  db: Database,
  rootDomain: string,
  options: { pages?: FeasibilityPage[]; serpUrl?: string } = {},
): Promise<GuestFeasibilityResult> {
  const pages = await pagesForDomain(db, rootDomain, options)
  const judgement = judgePitchPages(rootDomain, pages.map(toPitchPage))
  const pursue = judgement.verdict === 'PURSUE'
  const contact = pursue ? guestContactMethod(pages) : null
  const quote = (judgement.quote || judgement.notes).slice(0, 500)
  const pitch = pursue ? await pitchForPursue(db, rootDomain, judgement.pitchUrl, pages, quote) : null
  await db.insert(hhtOppGuestEvaluations).values({
    rootDomain,
    verdict: judgement.verdict,
    pitchUrl: judgement.pitchUrl,
    quote,
    contactMethod: contact?.method ?? null,
    contactValue: contact?.value ?? null,
    pitchSubject: pitch?.subject ?? null,
    pitchAngle: pitch?.angle ?? null,
    pitchBody: pitch?.body ?? null,
    pitchDraftedAt: pitch ? new Date() : null,
  }).onConflictDoUpdate({
    target: hhtOppGuestEvaluations.rootDomain,
    set: {
      verdict: judgement.verdict,
      pitchUrl: judgement.pitchUrl,
      quote,
      contactMethod: contact?.method ?? null,
      contactValue: contact?.value ?? null,
      pitchSubject: pitch?.subject ?? null,
      pitchAngle: pitch?.angle ?? null,
      pitchBody: pitch?.body ?? null,
      pitchDraftedAt: pitch ? new Date() : null,
      evaluatedAt: new Date(),
    },
  })
  if (pursue && contact) await attachPursueContact(db, rootDomain, contact)
  return { verdict: judgement.verdict, pitchUrl: judgement.pitchUrl, contact }
}

/** Run the feasibility check on every domain that already has an hht-opp lead. */
export async function evaluateHhtOppLeads(
  db: Database,
  options: { concurrency?: number; log?: (message: string) => void } = {},
): Promise<{ domains: number; counts: Record<string, number> }> {
  const log = options.log ?? ((message: string) => console.log(message))
  const rows = await db.select({ rootDomain: hhtOppDomains.rootDomain })
    .from(hhtOppOpportunities)
    .innerJoin(hhtOppDomains, eq(hhtOppDomains.id, hhtOppOpportunities.domainId))
  const domains = [...new Set(rows.map((row) => row.rootDomain))]
  const counts: Record<string, number> = {}
  let cursor = 0
  const concurrency = options.concurrency ?? 2

  async function worker() {
    while (cursor < domains.length) {
      const domain = domains[cursor++]
      const index = cursor
      try {
        const result = await applyGuestFeasibility(db, domain)
        counts[result.verdict] = (counts[result.verdict] ?? 0) + 1
        if (index % 20 === 0 || result.verdict === 'PURSUE') {
          log(`${index} / ${domains.length} ${domain} ${result.verdict}${result.contact ? ` ${result.contact.method}` : ''}`)
        }
      } catch (error) {
        counts['ERROR'] = (counts['ERROR'] ?? 0) + 1
        log(`${index} / ${domains.length} ${domain} ERROR ${error instanceof Error ? error.message : 'failed'}`)
      }
    }
  }

  log(`Evaluating ${domains.length} hht-opp domains.`)
  await Promise.all(Array.from({ length: Math.min(concurrency, domains.length) }, () => worker()))
  return { domains: domains.length, counts }
}

/** Write the skill pitch for every domain already marked Pursue. */
export async function draftPursueGuestPitches(db: Database): Promise<number> {
  const rows = await db.select({
    rootDomain: hhtOppGuestEvaluations.rootDomain,
    pitchUrl: hhtOppGuestEvaluations.pitchUrl,
    quote: hhtOppGuestEvaluations.quote,
  }).from(hhtOppGuestEvaluations).where(eq(hhtOppGuestEvaluations.verdict, 'PURSUE'))
  let drafted = 0
  for (const row of rows) {
    const pages = await storedPages(db, row.rootDomain)
    const pitch = await pitchForPursue(db, row.rootDomain, row.pitchUrl ?? `https://${row.rootDomain}/`, pages, row.quote ?? '')
    await db.update(hhtOppGuestEvaluations).set({
      pitchSubject: pitch.subject,
      pitchAngle: pitch.angle,
      pitchBody: pitch.body,
      pitchDraftedAt: new Date(),
    }).where(eq(hhtOppGuestEvaluations.rootDomain, row.rootDomain))
    drafted += 1
  }
  return drafted
}

async function pitchForPursue(
  db: Database,
  rootDomain: string,
  pitchUrl: string,
  pages: FeasibilityPage[],
  quote: string,
) {
  const [domain] = await db.select({ displayName: hhtOppDomains.displayName })
    .from(hhtOppDomains)
    .where(eq(hhtOppDomains.rootDomain, rootDomain))
    .limit(1)
  const matched = pages.find((page) => serpResultKey(page.url) === serpResultKey(pitchUrl))
  const guidelineText = matched?.text
    ?? [...pages].sort((a, b) => b.text.length - a.text.length)[0]?.text
    ?? quote
  return writeGuestPitch({
    domain: rootDomain,
    publicationName: domain?.displayName,
    pitchUrl,
    guidelineText,
  })
}

async function pagesForDomain(
  db: Database,
  rootDomain: string,
  options: { pages?: FeasibilityPage[]; serpUrl?: string },
): Promise<FeasibilityPage[]> {
  const seeded = (options.pages ?? []).filter((page) => page.text.trim().length >= 40)
  const stored = seeded.length > 0 ? [] : await storedPages(db, rootDomain)
  const have = dedupePages([...seeded, ...stored])
  const missing = pitchUrls(rootDomain, options.serpUrl).filter((url) => !covers(have, url))
  const fetched = (await Promise.all(missing.map((url) => fetchPitchPage(url)))).filter((page): page is FeasibilityPage => page !== null)
  return dedupePages([...have, ...fetched])
}

async function storedPages(db: Database, rootDomain: string): Promise<FeasibilityPage[]> {
  const [domain] = await db.select({ id: hhtOppDomains.id }).from(hhtOppDomains).where(eq(hhtOppDomains.rootDomain, rootDomain)).limit(1)
  if (!domain) return []
  const rows = await db.select().from(hhtOppCrawledPages).where(eq(hhtOppCrawledPages.domainId, domain.id))
  return rows.flatMap((row) => {
    const text = row.pageText?.trim() ?? ''
    if (text.length < 40) return []
    return [{ url: row.url, text, html: row.rawHtml, status: row.httpStatus }]
  })
}

async function attachPursueContact(
  db: Database,
  rootDomain: string,
  contact: { method: 'email' | 'form'; value: string; sourceUrl: string },
): Promise<void> {
  const opportunities = await db.select({ id: hhtOppOpportunities.id })
    .from(hhtOppOpportunities)
    .innerJoin(hhtOppDomains, eq(hhtOppDomains.id, hhtOppOpportunities.domainId))
    .where(eq(hhtOppDomains.rootDomain, rootDomain))
  for (const opportunity of opportunities) {
    const [existing] = await db.select({
      id: hhtOppContacts.id,
      email: hhtOppContacts.email,
      formUrl: hhtOppContacts.formUrl,
    }).from(hhtOppContacts).where(eq(hhtOppContacts.opportunityId, opportunity.id)).limit(1)
    if (existing?.email || existing?.formUrl) continue
    await db.insert(hhtOppContacts).values({
      opportunityId: opportunity.id,
      email: contact.method === 'email' ? contact.value : null,
      formUrl: contact.method === 'form' ? contact.value : null,
      role: contact.method === 'email' ? 'editorial' : 'submission_form',
      status: 'VERIFIED_PUBLIC',
      sourceUrl: contact.sourceUrl,
      sourceExcerpt: contact.value,
    })
  }
}

function pitchUrls(domain: string, serpUrl?: string): string[] {
  return [...new Set([...(serpUrl ? [serpUrl] : []), ...PITCH_PATHS.map((path) => `https://${domain}${path}`)])]
}

function covers(pages: FeasibilityPage[], url: string): boolean {
  const key = serpResultKey(url)
  return pages.some((page) => serpResultKey(page.url) === key)
}

function dedupePages(pages: FeasibilityPage[]): FeasibilityPage[] {
  const seen = new Set<string>()
  const out: FeasibilityPage[] = []
  for (const page of pages) {
    const key = serpResultKey(page.url)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(page)
  }
  return out
}

function toPitchPage(page: FeasibilityPage): PitchPage {
  return {
    url: page.url,
    status: page.status ?? null,
    text: page.text,
    hasContact: /mailto:|\/contact(?:-us)?\/?|@[a-z0-9.-]+\.[a-z]{2,}/i.test(`${page.html ?? ''} ${page.text}`),
  }
}

async function fetchPitchPage(url: string): Promise<FeasibilityPage | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; HotelHotTubsFeasibility/1.0)' },
    })
    const html = (await response.text()).slice(0, 400_000)
    const finalUrl = response.url || url
    if (/wp-json|oembed|\/feed\/?$/i.test(finalUrl)) return null
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (text.length < 40 && response.status >= 400) return { url: finalUrl, text, html, status: response.status }
    return { url: finalUrl, text, html, status: response.status }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
