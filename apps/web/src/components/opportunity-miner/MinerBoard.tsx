'use client'

import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { NULL_DISPLAY, num } from '@/lib/format'

export interface MinerRow {
  slug: string
  name: string
  score: number | null
  volume: number | null
  growth: number | null
  cpc: number | null
  kd: number | null
  price: number | null
  priceObserved: boolean
  advertisers: number
  coverage: number | null
  serpWeakness: number | null
  type: string
  status: string
  buyer: string
  monetization: number | null
}

export function MinerBoard({ rows }: { rows: MinerRow[] }) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()

  function set(key: string, value: string) {
    const next = new URLSearchParams(params.toString())
    if (!value) next.delete(key)
    else next.set(key, value)
    router.push(`${pathname}?${next.toString()}`)
  }

  return (
    <div className="om-board">
      <form className="om-filters" onSubmit={(e) => e.preventDefault()}>
        <select defaultValue={params.get('type') ?? ''} onChange={(e) => set('type', e.target.value)}>
          <option value="">All types</option>
          <option value="B2C">B2C</option>
          <option value="prosumer">Prosumer</option>
          <option value="SMB">SMB</option>
          <option value="vertical_saas">Vertical SaaS</option>
          <option value="utility">Utility</option>
        </select>
        <select defaultValue={params.get('ai') ?? ''} onChange={(e) => set('ai', e.target.value)}>
          <option value="">AI + non-AI</option>
          <option value="1">AI</option>
          <option value="0">Non-AI</option>
        </select>
        <select defaultValue={params.get('status') ?? ''} onChange={(e) => set('status', e.target.value)}>
          <option value="">All statuses</option>
          <option value="new">New</option>
          <option value="interesting">Interesting</option>
          <option value="investigate">Investigate</option>
          <option value="validated">Validated</option>
          <option value="building">Building</option>
          <option value="rejected">Rejected</option>
        </select>
        <select defaultValue={params.get('sort') ?? 'score'} onChange={(e) => set('sort', e.target.value)}>
          <option value="score">Sort: score</option>
          <option value="volume">Sort: volume</option>
          <option value="coverage">Sort: CPC coverage</option>
          <option value="growth">Sort: growth</option>
          <option value="serp">Sort: SERP weakness</option>
          <option value="monetization">Sort: monetization</option>
        </select>
        <label>
          Min volume
          <input
            type="number"
            defaultValue={params.get('minVolume') ?? ''}
            onBlur={(e) => set('minVolume', e.target.value)}
          />
        </label>
        <label>
          Max KD
          <input type="number" defaultValue={params.get('maxKd') ?? ''} onBlur={(e) => set('maxKd', e.target.value)} />
        </label>
        <label>
          Min coverage
          <input
            type="number"
            step="0.1"
            defaultValue={params.get('minCoverage') ?? ''}
            onBlur={(e) => set('minCoverage', e.target.value)}
          />
        </label>
        <label className="om-check">
          <input
            type="checkbox"
            defaultChecked={params.get('ads') === '1'}
            onChange={(e) => set('ads', e.target.checked ? '1' : '')}
          />
          Persistent advertisers
        </label>
        <label className="om-check">
          <input
            type="checkbox"
            defaultChecked={params.get('weakSerp') === '1'}
            onChange={(e) => set('weakSerp', e.target.checked ? '1' : '')}
          />
          Weak SERP
        </label>
      </form>

      {rows.length === 0 ? (
        <div className="empty" style={{ padding: 24 }}>
          No markets yet. Seed and discover from the CLI:
          <pre className="om-cli">python miner.py seed{'\n'}python miner.py discover --country=us --max-depth=3 --live</pre>
        </div>
      ) : (
        <div className="table-scroll sm-table-wrap om-table-wrap">
          <table className="opp-grid-table sm-table">
            <thead>
              <tr>
                <th>Market</th>
                <th className="num">Score</th>
                <th className="num">Volume</th>
                <th className="num">Growth</th>
                <th className="num">CPC</th>
                <th className="num">KD</th>
                <th className="num">Price</th>
                <th className="num">Advertisers</th>
                <th className="num">CPC coverage</th>
                <th className="num">SERP weakness</th>
                <th>Type</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.slug} className="opp-grid-row-link">
                  <td>
                    <Link href={`/scout/opportunity-miner/${r.slug}`}>{r.name}</Link>
                    <div className="om-sub">
                      {r.status}
                      {r.buyer !== 'unknown' ? ` · ${r.buyer}` : ''}
                    </div>
                  </td>
                  <td className="num sm-score">{r.score == null ? NULL_DISPLAY : r.score.toFixed(1)}</td>
                  <td className="num">{num(r.volume)}</td>
                  <td className="num">{r.growth == null ? NULL_DISPLAY : `${Math.round(r.growth * 100)}%`}</td>
                  <td className="num">{r.cpc == null ? NULL_DISPLAY : `$${r.cpc.toFixed(2)}`}</td>
                  <td className="num">{r.kd == null ? NULL_DISPLAY : r.kd.toFixed(0)}</td>
                  <td className="num">
                    {r.price == null ? NULL_DISPLAY : `$${Math.round(r.price)}`}
                    <span className={`om-conf ${r.priceObserved ? 'observed' : 'inferred'}`}>
                      {r.priceObserved ? 'observed' : 'inferred'}
                    </span>
                  </td>
                  <td className="num">{r.advertisers}</td>
                  <td className="num">{r.coverage == null || r.coverage === 0 ? NULL_DISPLAY : `${r.coverage.toFixed(2)}x`}</td>
                  <td className="num">{r.serpWeakness == null ? NULL_DISPLAY : r.serpWeakness.toFixed(1)}</td>
                  <td>{r.type.replace('_', ' ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
