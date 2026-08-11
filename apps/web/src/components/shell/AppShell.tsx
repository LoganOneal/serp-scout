import { liveCallsEnabled } from '@rnr/data'
import { SidebarNav } from './SidebarNav'
import { TopBar } from './TopBar'

/**
 * Production SaaS chrome: left rail + top bar + main.
 * Light enterprise shell (SEMrush-class density), not marketing layout.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const live = liveCallsEnabled()

  return (
    <div className="app-shell">
      <SidebarNav />
      <div className="app-main-col">
        <TopBar live={live} />
        <main className="app-content">{children}</main>
      </div>
    </div>
  )
}
