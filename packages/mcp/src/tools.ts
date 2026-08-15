import {
  db,
  findSiteByDomain,
  listIngestRuns,
  listKeywordBoard,
  listProspects,
  listSupplySources,
  listUnresolvedSuppliers,
  loadEconomicsCatalog,
  resolveKeywordEconomics,
  searchSupplyItems,
  summariseCoverage,
  supplyOpportunityReport,
} from '@rnr/data'
import { sites } from '@rnr/data/schema'
import { formatMicrosUsd, type KeywordVerdict, type ProspectVerdict } from '@rnr/core'
import type { ToolDefinition } from './rpc.js'

/**
 * The read-only tool surface.
 *
 * ==================== READ-ONLY IS THE DESIGN, NOT A v1 LIMITATION ==========
 * There is no tool here that spends money, sends email, or writes a row.
 *
 * The ads launcher deliberately needs FOUR independent conditions before it can
 * spend, and the outreach path deliberately has no send command at all. Those
 * gates exist so that no single surface can authorise money on its own — and a
 * conversational surface is the one where "yes, go ahead" is cheapest to say and
 * hardest to audit afterwards. A `launch_campaign` tool would route around every
 * one of them through the least deliberate interface in the system.
 *
 * So this answers questions. The commands that act stay in the CLI, where they
 * are typed on purpose.
 * ===========================================================================
 */

const str = (v: unknown): string | undefined => {
  const s = typeof v === 'string' ? v.trim() : ''
  return s.length > 0 ? s : undefined
}
const num = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : undefined
}

/**
 * Every tool takes a site DOMAIN, never an id.
 *
 * An agent that has to guess a primary key will guess one, and `siteId: 3` is a
 * plausible-looking argument that silently answers about the wrong property.
 * A domain is the thing the operator actually says out loud.
 */
async function siteIdFor(domain: string | undefined): Promise<{ id: number; domain: string }> {
  const d = str(domain)
  if (!d) throw new Error('`site` is required — pass the domain, e.g. "hotelhottubs.com".')
  const site = await findSiteByDomain(db(), d)
  if (!site) {
    const all = await db().select({ domain: sites.domain }).from(sites).limit(25)
    throw new Error(
      `No site "${d}". Known: ${all.map((s) => s.domain).join(', ') || '(none)'}`,
    )
  }
  // `sites.domain` is nullable in the schema (a local cell can exist before a
  // domain is bought). Falling back to what was asked for keeps the echo honest.
  return { id: site.id, domain: site.domain ?? d }
}

const SITE_PROP = {
  site: { type: 'string', description: 'Site domain, e.g. "hotelhottubs.com".' },
} as const

const usd = (m: bigint | null): string | null => (m === null ? null : formatMicrosUsd(m, { precision: 2 }))

export const TOOLS: ToolDefinition[] = [
  {
    name: 'list_sites',
    description:
      'List every site in the portfolio with its kind and status. Call this first when you do ' +
      'not know the exact domain — every other tool takes one.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async handler() {
      return db()
        .select({
          domain: sites.domain,
          kind: sites.kind,
          status: sites.status,
          displayName: sites.displayName,
        })
        .from(sites)
        .limit(200)
    },
  },

  {
    name: 'supply_search',
    description:
      'Search the supply read model — what this site actually has to sell. Filter by entity ' +
      '(e.g. locality "aspen-co"), free text, price ceiling, or attributes such as ' +
      '{"in_room_hot_tub": true}. Answers "what do we list in Aspen under $400?". Prices are ' +
      'as last pulled from the site, not live availability.',
    inputSchema: {
      type: 'object',
      properties: {
        ...SITE_PROP,
        entity_slug: { type: 'string', description: 'Resolved entity slug, e.g. "aspen-co".' },
        q: { type: 'string', description: 'Substring over item title and supplier name.' },
        attributes: {
          type: 'object',
          description: 'Exact-match attribute filter, e.g. {"in_room_hot_tub": true}.',
        },
        max_price_usd: { type: 'number' },
        min_price_usd: { type: 'number' },
        include_unavailable: {
          type: 'boolean',
          description: 'Default false. Items whose availability is unstated are excluded by default.',
        },
        limit: { type: 'number', description: 'Default 25, max 200.' },
      },
      required: ['site'],
      additionalProperties: false,
    },
    async handler(a) {
      const site = await siteIdFor(str(a['site']))
      const maxUsd = num(a['max_price_usd'])
      const minUsd = num(a['min_price_usd'])
      const rows = await searchSupplyItems(db(), {
        siteId: site.id,
        entitySlug: str(a['entity_slug']) ?? null,
        q: str(a['q']) ?? null,
        attributes: (a['attributes'] as Record<string, string | number | boolean>) ?? null,
        maxPriceMicros: maxUsd === undefined ? null : BigInt(Math.round(maxUsd * 1_000_000)),
        minPriceMicros: minUsd === undefined ? null : BigInt(Math.round(minUsd * 1_000_000)),
        availableOnly: a['include_unavailable'] !== true,
        limit: num(a['limit']) ?? 25,
      })
      return {
        site: site.domain,
        count: rows.length,
        items: rows.map((r) => ({
          title: r.title,
          supplier: r.supplierName,
          entity: r.entitySlug,
          price: usd(r.priceMicros),
          currency: r.currency,
          available: r.available,
          url: r.affiliateUrl ?? r.url,
          attributes: r.attributes,
          lastConfirmed: r.lastSeenAt,
        })),
        caveat:
          'Snapshot from the last supply pull, not a live availability check. `lastConfirmed` ' +
          'says how old each row is.',
      }
    },
  },

  {
    name: 'supply_coverage',
    description:
      'Cross supply against keyword demand and return the 2x2. SUPPLY_GAP = real demand we ' +
      'cannot fulfil (do not build, do not bid). KEYWORD_GAP = inventory with no keyword row — ' +
      'the cheapest pages to write, because the supply risk is already gone. UNKNOWN means a ' +
      'signal was never measured and is NOT a zero.',
    inputSchema: {
      type: 'object',
      properties: {
        ...SITE_PROP,
        cell: {
          type: 'string',
          enum: ['BUILD_FIRST', 'KEYWORD_GAP', 'SUPPLY_GAP', 'IGNORE', 'UNKNOWN'],
        },
        limit: { type: 'number', description: 'Default 40.' },
      },
      required: ['site'],
      additionalProperties: false,
    },
    async handler(a) {
      const site = await siteIdFor(str(a['site']))
      const report = await supplyOpportunityReport(db(), site.id)
      const cell = str(a['cell'])
      const rows = (cell ? report.rows.filter((r) => r.cell === cell) : report.rows).slice(
        0,
        num(a['limit']) ?? 40,
      )
      return {
        site: site.domain,
        byCell: report.byCell,
        notes: report.notes,
        rows: rows.map((r) => ({
          entity: r.entitySlug,
          cell: r.cell,
          action: r.action,
          supply: r.supplyStatus,
          demand: r.demandStatus,
          suppliers: r.supplierCount,
          availableItems: r.availableItemCount,
          medianPrice: usd(r.medianPriceMicros),
          keywords: r.keywordCount,
          bestVolume: r.bestVolume,
        })),
      }
    },
  },

  {
    name: 'supply_status',
    description:
      'Connected supply feeds, the last pull for each, and every supplier whose location could ' +
      'not be resolved to an entity slug. Unresolved suppliers are UNKNOWN coverage, never zero ' +
      '— they are an importer problem, not a reason to stop building pages.',
    inputSchema: {
      type: 'object',
      properties: SITE_PROP,
      required: ['site'],
      additionalProperties: false,
    },
    async handler(a) {
      const site = await siteIdFor(str(a['site']))
      const sources = await listSupplySources(db(), site.id)
      const summary = await summariseCoverage(db(), site.id)
      const detail = []
      for (const s of sources) {
        detail.push({
          id: s.id,
          baseUrl: s.baseUrl,
          entityKind: s.entityKind,
          lastPulledAt: s.lastPulledAt,
          manifest: s.lastManifest,
          runs: (await listIngestRuns(db(), s.id, 3)).map((r) => ({
            status: r.status,
            mode: r.mode,
            itemsPulled: r.itemsPulled,
            itemsMarkedGone: r.itemsMarkedGone,
            unresolvedSuppliers: r.unresolvedSuppliers,
            manifestTotalItems: r.manifestTotalItems,
            startedAt: r.startedAt,
            notes: r.notes,
            error: r.error,
          })),
          unresolved: await listUnresolvedSuppliers(db(), s.id, 10),
        })
      }
      return { site: site.domain, coverage: { ...summary, topEntities: summary.topEntities.map((e) => ({ ...e, medianPrice: usd(e.medianPriceMicros) })) }, sources: detail }
    },
  },

  {
    name: 'keyword_board',
    description:
      'What to do about each keyword this site targets. DEFEND (top-3, protect it), IMPROVE ' +
      '(page 1-2, on-page work), BUILD (nothing ranks and the SERP is enterable), IGNORE ' +
      '(measured and not worth it), UNKNOWN (a needed signal was never measured — NOT the same ' +
      'as IGNORE). Verdicts already have the supply gate applied.',
    inputSchema: {
      type: 'object',
      properties: {
        ...SITE_PROP,
        verdict: { type: 'string', enum: ['DEFEND', 'IMPROVE', 'BUILD', 'IGNORE', 'UNKNOWN'] },
        limit: { type: 'number', description: 'Default 40.' },
      },
      required: ['site'],
      additionalProperties: false,
    },
    async handler(a) {
      const site = await siteIdFor(str(a['site']))
      const verdict = str(a['verdict']) as KeywordVerdict | undefined
      const rows = await listKeywordBoard(db(), site.id, {
        ...(verdict ? { verdicts: [verdict] } : {}),
        limit: num(a['limit']) ?? 40,
      })
      return {
        site: site.domain,
        count: rows.length,
        keywords: rows.map((r) => ({
          keyword: r.keyword,
          verdict: r.verdict,
          why: r.verdictReason,
          volume: r.volume,
          volumeScope: r.volumeScope,
          position: r.position,
          difficulty: r.difficulty,
          monthlyValue: usd(r.monthlyValueMicros),
          sources: r.sources,
        })),
      }
    },
  },

  {
    name: 'keyword_economics',
    description:
      'Explain the money behind one keyword: order value, commission rate, measured conversion, ' +
      'and where each number came from. Answers "why does this keyword need a 12% conversion ' +
      'rate to break even?". Every figure carries its provenance — an inherited site average ' +
      'and a per-vendor rate are not the same claim.',
    inputSchema: {
      type: 'object',
      properties: {
        ...SITE_PROP,
        keyword: { type: 'string', description: 'The keyword, matched case-insensitively.' },
      },
      required: ['site', 'keyword'],
      additionalProperties: false,
    },
    async handler(a) {
      const site = await siteIdFor(str(a['site']))
      const keyword = str(a['keyword'])
      if (!keyword) throw new Error('`keyword` is required.')

      const rows = await listKeywordBoard(db(), site.id, { limit: 5000 })
      const match = rows.find((r) => r.keyword.toLowerCase() === keyword.toLowerCase())
      if (!match) throw new Error(`"${keyword}" is not a target keyword for ${site.domain}.`)

      const catalog = await loadEconomicsCatalog(db(), site.id)
      const resolved = resolveKeywordEconomics(catalog, {
        keywordNorm: match.keyword.toLowerCase(),
        patternLabel: null,
        entities: null,
      })

      return {
        site: site.domain,
        keyword: match.keyword,
        verdict: match.verdict,
        volume: match.volume,
        orderValue: {
          value: usd(resolved.orderValueMicros.value),
          inherited: resolved.orderValueMicros.inherited,
          from: resolved.orderValueMicros.resolvedFrom,
        },
        commission: {
          bps: resolved.commissionRateBps.value,
          from: resolved.commissionRateBps.resolvedFrom,
        },
        conversion: resolved.conversion
          ? {
              meanBps: resolved.conversion.meanBps,
              lowerBps: resolved.conversion.lowerBps,
              chain: resolved.conversion.chain,
            }
          : null,
        note:
          resolved.conversion === null
            ? 'No conversion has been observed. The break-even model compares the REQUIRED rate ' +
              'against one you actually achieve, so nothing here is decidable until it is recorded.'
            : 'Verdicts use the posterior LOWER bound, not the mean — a rate measured on 40 ' +
              'clicks must clear break-even by far more than one measured on 40,000.',
      }
    },
  },

  {
    name: 'prospect_board',
    description:
      'Link prospects from a mining run, with the max bid each is worth. PURSUE is worth ' +
      'approaching; REJECT usually failed the traffic gate, which comes first because authority ' +
      'metrics are manufacturable and ranking for real queries is not. "competitorLinks" of 4+ ' +
      'means a link marketplace: the easiest sale and the worst footprint.',
    inputSchema: {
      type: 'object',
      properties: {
        run_id: { type: 'number', description: 'The mining run id.' },
        verdict: { type: 'string', enum: ['PURSUE', 'MARGINAL', 'REJECT', 'UNKNOWN'] },
        limit: { type: 'number', description: 'Default 30.' },
      },
      required: ['run_id'],
      additionalProperties: false,
    },
    async handler(a) {
      const runId = num(a['run_id'])
      if (runId === undefined) throw new Error('`run_id` is required.')
      const verdict = str(a['verdict']) as ProspectVerdict | undefined
      const rows = await listProspects(db(), runId, {
        ...(verdict ? { verdicts: [verdict] } : {}),
        limit: num(a['limit']) ?? 30,
      })
      return {
        runId,
        count: rows.length,
        prospects: rows.map((r) => ({
          domain: r.domain,
          verdict: r.verdict,
          why: r.verdictReason,
          rankedKeywords: r.rankedKeywords,
          organicEtv: r.organicEtv,
          dfsRank: r.dfsRank,
          spamScore: r.spamScore,
          competitorLinks: r.competitorLinkCount,
          maxBid: usd(r.maxBidMicros),
          warnings: r.warnings,
        })),
      }
    },
  },
]
