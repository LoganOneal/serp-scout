import Link from 'next/link'

export interface FunnelStat {
  label: string
  value: string | number
  href?: string
  tone?: 'default' | 'warn' | 'danger' | 'ok'
}

export function FunnelStrip({ stats }: { stats: FunnelStat[] }) {
  return (
    <div className="funnel-strip">
      {stats.map((s) => {
        const inner = (
          <>
            <div className="funnel-value">{s.value}</div>
            <div className="funnel-label">{s.label}</div>
          </>
        )
        const cls = `funnel-tile${s.tone && s.tone !== 'default' ? ` tone-${s.tone}` : ''}`
        if (s.href) {
          return (
            <Link key={s.label} href={s.href} className={cls}>
              {inner}
            </Link>
          )
        }
        return (
          <div key={s.label} className={cls}>
            {inner}
          </div>
        )
      })}
    </div>
  )
}
