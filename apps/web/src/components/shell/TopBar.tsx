import Link from 'next/link'

export function TopBar({ live }: { live: boolean }) {
  return (
    <header className="app-topbar">
      <div className="app-topbar-left">
        <span className="app-topbar-workspace">Workspace</span>
        <span className="app-topbar-sep">/</span>
        <span className="app-topbar-product">SERP Scout</span>
      </div>
      <div className="app-topbar-right">
        {live ? (
          <span className="pill pill-live" title="LIVE_CALLS_ENABLED=true — purchases spend money">
            Live spend
          </span>
        ) : (
          <span className="pill pill-fixture" title="Fixture mode — $0 synthetic providers">
            Fixtures · $0
          </span>
        )}
        <Link href="/settings" className="app-topbar-link">
          Settings
        </Link>
      </div>
    </header>
  )
}
