import { DEFAULT_HHT_OPP_COMPETITORS, DEFAULT_HHT_OPP_SCORE_WEIGHTS } from '@rnr/core'
import { db, getHhtOppCompetitors, getHhtOppScoreWeights, liveCallsEnabled, queryOr } from '@rnr/data'
import { PageHeader } from '@/components/shell/PageHeader'
import Link from 'next/link'
import { saveHhtOppCompetitorsAction, saveHhtOppWeightsAction } from '../hht-opp/actions'

export const dynamic = 'force-dynamic'

export default async function SettingsPage() {
  const live = liveCallsEnabled()
  const weights = await queryOr('hhtOppWeights', () => getHhtOppScoreWeights(db()), DEFAULT_HHT_OPP_SCORE_WEIGHTS)
  const competitors = await queryOr('hhtOppCompetitors', () => getHhtOppCompetitors(db()), [...DEFAULT_HHT_OPP_COMPETITORS])

  return (
    <div>
      <PageHeader
        title="Settings"
        description="Workspace configuration, integrations, and methodology. Multi-tenant team settings ship later."
      />

      <div className="card" id="spend">
        <h3 style={{ marginTop: 0 }}>Spend mode</h3>
        <p className="sub" style={{ marginTop: 0 }}>
          {live ? (
            <>
              <span className="badge stop">Live</span> Provider calls purchase real DataForSEO /
              Google Ads data. Caps apply per run and daily SERP monitor.
            </>
          ) : (
            <>
              <span className="badge warn">Fixtures</span> All provider calls are synthetic ($0). Set{' '}
              <code>LIVE_CALLS_ENABLED=true</code> only when credentials and account health are
              confirmed.
            </>
          )}
        </p>
      </div>

      <div className="card" id="integrations">
        <h3 style={{ marginTop: 0 }}>Integrations</h3>
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: 'var(--text-dim)' }}>
          <li>
            <strong>DataForSEO</strong> — organic + maps SERPs (research &amp; monitoring)
          </li>
          <li>
            <strong>Google Ads</strong> — keyword volume on promote (OAuth + developer token); Opportunity Miner idea expansion
          </li>
          <li>
            <strong>Semrush</strong> — Opportunity Miner keyword/domain/ads evidence via{' '}
            <code>SEMRUSH_API_KEY</code> (same Analytics reports as the Semrush MCP)
          </li>
          <li>
            <strong>Retell / Twilio</strong> — voice agent CRM (
            <Link href="/agent">Voice agent</Link>)
          </li>
        </ul>
        <p className="sub" style={{ marginBottom: 0, marginTop: 12, fontSize: 12.5 }}>
          Credentials are environment variables on the host — see <code>.env.example</code> and{' '}
          <code>docs/vercel-deploy.md</code>.
        </p>
      </div>

      <div className="card" id="methodology">
        <h3 style={{ marginTop: 0 }}>Estimates &amp; methodology</h3>
        <p className="sub" style={{ marginTop: 0 }}>
          This product refuses to dress guesses as measurements. Keep these distinctions when you
          act on a number:
        </p>
        <dl className="kv">
          <dt>Search volume</dt>
          <dd>Catalog volumes come from Google Ads exports / API. Scan demand is population-modelled when not purchased.</dd>
          <dt>SERP difficulty</dt>
          <dd>Measured from live/fixture organic only. Missing components are omitted — never zeroed.</dd>
          <dt>EMD / 30-day verdict</dt>
          <dd>A prior from published research until calibration has outcomes. The only “go buy” signal.</dd>
          <dt>Rent</dt>
          <dd>Modelled, not a quote from a tenant.</dd>
          <dt>Nulls</dt>
          <dd>Render as — . Zero means measured zero.</dd>
          <dt>HHT Opportunity Engine</dt>
          <dd>
            Eligibility, prices, and contacts are extracted from publisher pages with source excerpts.
            Absence of a prohibition is REVIEW, never PASS. Missing prices are labeled
            “Price unknown — contact publisher.” Semrush Authority Score is shown only after
            explicit enrichment of PASS or approved REVIEW domains.
          </dd>
          <dt>Opportunity Miner</dt>
          <dd>
            Volume, CPC, KD, advertisers, and domain_rank traffic are Semrush or Google Ads
            evidence. Prices and lifetime are marked observed vs inferred. Traffic Analytics
            visits are unavailable on the current Semrush MCP plan — we do not invent them.
            Adjusted cluster volume takes the max of semantic near-duplicates, then applies a
            conservative overlap factor.
          </dd>
        </dl>
      </div>

      <div className="card" id="hht-opp-weights">
        <h3 style={{ marginTop: 0 }}>HHT Opportunity Engine score weights</h3>
        <p className="sub" style={{ marginTop: 0 }}>
          Overall score is a weighted blend. Values are normalized to 100%. Cost efficiency is a comparative score, not a precise financial model.
        </p>
        <form action={saveHhtOppWeightsAction} className="hht-opp-weights-form">
          <WeightInput name="seoValue" label="SEO value" value={weights.seoValue} />
          <WeightInput name="feasibility" label="Feasibility" value={weights.feasibility} />
          <WeightInput name="topicalRelevance" label="Topical relevance" value={weights.topicalRelevance} />
          <WeightInput name="editorialQuality" label="Editorial quality" value={weights.editorialQuality} />
          <WeightInput name="costEfficiency" label="Cost efficiency" value={weights.costEfficiency} />
          <WeightInput name="freshness" label="Freshness" value={weights.freshness} />
          <button className="primary" type="submit">
            Save weights
          </button>
        </form>
      </div>

      <div className="card" id="hht-opp-competitors">
        <h3 style={{ marginTop: 0 }}>HHT competitor domains</h3>
        <p className="sub" style={{ marginTop: 0 }}>
          Used for Semrush referring-domain overlap. Prioritize domains that link to two or more of these and not HotelHotTubs.com. OTAs are ignored.
        </p>
        <form action={saveHhtOppCompetitorsAction}>
          <label>
            <span className="sub">One domain per line</span>
            <textarea name="competitors" rows={5} defaultValue={competitors.join('\n')} style={{ width: '100%', font: '12.5px var(--mono)' }} />
          </label>
          <button className="primary" type="submit">
            Save competitors
          </button>
        </form>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Product flow</h3>
        <p className="sub" style={{ marginTop: 0, marginBottom: 0 }}>
          <strong>Research</strong> → <strong>Pipeline</strong> (save) → <strong>Markets</strong>{' '}
          (operate) → <strong>Tracking</strong> (monitor) → deepen research on the market cell.
        </p>
      </div>
    </div>
  )
}

function WeightInput({ name, label, value }: { name: string; label: string; value: number }) {
  return (
    <label>
      <span>{label}</span>
      <input name={name} type="number" step="0.01" min="0" max="1" defaultValue={value} />
    </label>
  )
}
