import { liveCallsEnabled } from '@rnr/data'
import { PageHeader } from '@/components/shell/PageHeader'
import Link from 'next/link'

export const dynamic = 'force-dynamic'

export default function SettingsPage() {
  const live = liveCallsEnabled()

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
            <strong>Google Ads</strong> — keyword volume on promote (OAuth + developer token)
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
        </dl>
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
