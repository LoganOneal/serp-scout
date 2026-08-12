import {
  db,
  getOpportunityScreenBoard,
  listActiveNichesForPicker,
  listNicheEconomicsRanked,
  listRecentDeepDiveRuns,
  listScanRuns,
  liveCallsEnabled,
  queryOr,
  researchCatalogEnabled,
} from '@rnr/data'
import { PageHeader } from '@/components/shell/PageHeader'
import { ScanRunList } from '@/components/research/ScanRunList'
import { OpportunityFunnel } from '@/components/research/OpportunityFunnel'
import { searchLocalitiesAction } from '@/app/actions'
import type { PickerOption } from '@/components/LocalityPicker'

export const dynamic = 'force-dynamic'

export default async function ResearchPage() {
  const database = db()
  const catalogOn = researchCatalogEnabled()

  /**
   * Locality scans had no index anywhere in the product, so a scan was lost the
   * moment you navigated away from its result screen. Listing them is the whole
   * fix -- the pages themselves were always fine.
   */
  const scanRuns = await queryOr('listScanRuns', () => listScanRuns(database, 25), [])

  const board = catalogOn
    ? await queryOr('getOpportunityScreenBoard', () => getOpportunityScreenBoard(database), {
        keywords: [],
        geos: [],
        keywordTotal: 0,
        geoPurchasableTotal: 0,
        defaultTopKeywordIds: [],
        defaultTopGeoIds: [],
      })
    : {
        keywords: [],
        geos: [],
        keywordTotal: 0,
        geoPurchasableTotal: 0,
        defaultTopKeywordIds: [],
        defaultTopGeoIds: [],
      }

  const deepDiveRuns = catalogOn
    ? await queryOr('listRecentDeepDiveRuns', () => listRecentDeepDiveRuns(database, 12), [])
    : []

  const nicheEconomics = catalogOn
    ? await queryOr('listNicheEconomicsRanked', () => listNicheEconomicsRanked(database), [])
    : []

  const nicheList = await queryOr(
    'listActiveNichesForPicker',
    () => listActiveNichesForPicker(database),
    [],
  )

  async function searchLocalities(q: string): Promise<PickerOption[]> {
    'use server'
    const rows = await searchLocalitiesAction(q)
    return rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      kind: r.kind,
      name: r.name,
      stateCode: r.stateCode,
      population: r.population,
      scannable: r.providerLocationCode !== null,
      unmatchedReason: r.unmatchedReason,
    }))
  }

  return (
    // Workspace root: fills the viewport so the tables below own the scroll.
    <div className="opp-workspace">
      <div className="run-page-head">
        <PageHeader
          title="Research"
          description="Screen niches × markets (each niche expands to buy-intent keywords), then sweep geo SERPs. Local volume is DataForSEO Keywords Data at the market location_code (not map-pack listings)."
        />

        {!liveCallsEnabled() && (
          <div className="warnbox" style={{ marginBottom: 0 }}>
            <strong>Fixture mode.</strong> Market sweep SERPs are synthetic ($0). Set{' '}
            <code>LIVE_CALLS_ENABLED=true</code> for real DataForSEO.
          </div>
        )}
      </div>

      <ScanRunList
        runs={scanRuns.map((r) => ({
          id: r.id,
          status: r.status,
          locality: `${r.localityName}, ${r.stateCode}`,
          nicheCount: r.nicheCount,
          spendUsd: Number(r.spendMicros) / 1_000_000,
          usedFixtures: r.usedFixtures,
          createdAt: r.createdAt.toISOString(),
        }))}
      />

      {!catalogOn ? (
        <div className="stopbox">Catalog research is disabled (RESEARCH_CATALOG_ENABLED=false).</div>
      ) : (
        <OpportunityFunnel
          geoTotal={board.geoPurchasableTotal}
          geos={board.geos.map((g) => ({
            id: g.id,
            market: g.market,
            stateAbbr: g.stateAbbr,
            selectedRank: g.selectedRank,
            population2025: g.population2025,
            dataforseoLocationCode: g.dataforseoLocationCode,
          }))}
          defaultGeoIds={board.defaultTopGeoIds}
          nicheEconomics={nicheEconomics}
          deepDiveRuns={deepDiveRuns.map((r) => ({
            id: r.id,
            status: r.status,
            jobCount: r.jobCount,
            jobsDone: r.jobsDone,
            jobsFailed: r.jobsFailed,
            jobsSkipped: r.jobsSkipped,
            hitCount: r.hitCount,
            label: r.label,
            error: r.error,
            createdAt: r.createdAt.toISOString(),
            usedFixtures: r.usedFixtures,
            spendMicros: r.spendMicros != null ? String(r.spendMicros) : '0',
            estimatedCostMicros:
              r.estimatedCostMicros != null ? String(r.estimatedCostMicros) : null,
          }))}
          searchLocalities={searchLocalities}
          niches={nicheList}
          live={liveCallsEnabled()}
        />
      )}
    </div>
  )
}
