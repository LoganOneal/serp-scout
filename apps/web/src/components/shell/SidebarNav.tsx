'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

/**
 * Two apps, split on the decision boundary.
 *
 * ==================== WHY TWO AND NOT FIVE ====================
 * The nav used to carry Research / Pipeline / Markets / Domains / Tracking as
 * peers. They were not peers. Pipeline rendered a table that Markets already
 * showed, from the same query with the same row actions; Tracking re-ran the
 * markets query with fewer columns and no actions of its own; Domains was a
 * kind of research run wearing a section's clothes.
 *
 * The real boundary is whether you are still deciding:
 *
 *   Scout      -- which markets are worth money, and which are already taken?
 *   Portfolio  -- are the ones I picked doing what I expected?
 *
 * Everything that spends money to learn something lives in Scout. Everything
 * about a market already committed to lives in Portfolio.
 * ==============================================================
 */

type NavItem = { href: string; label: string; exact?: boolean; hint?: string }
type NavGroup = { title: string; items: NavItem[] }

const GROUPS: NavGroup[] = [
  {
    title: 'Scout',
    items: [
      {
        href: '/scout',
        label: 'Research',
        exact: true,
        hint: 'Screen niches × markets, then sweep their SERPs',
      },
      {
        href: '/scout/opportunity-miner',
        label: 'Opportunity Miner',
        hint: 'National search-market anomalies for PLG / SMB businesses',
      },
      {
        href: '/scout/domains',
        label: 'Domains',
        hint: 'Find acquirable domains in a market',
      },
    ],
  },
  {
    title: 'Portfolio',
    items: [
      { href: '/portfolio', label: 'Markets', hint: 'Markets you have committed to' },
    ],
  },
  {
    title: 'Hotel Hot Tubs',
    items: [
      {
        href: '/hht-bl',
        label: 'Backlinks',
        hint: 'Backlink research, opportunities, and acquired links',
      },
      {
        href: '/hht-opp',
        label: 'Opportunity Engine',
        hint: 'Discover and qualify publisher backlink opportunities for HotelHotTubs',
      },
      {
        href: '/hotel-backlink-scout',
        label: 'Hotel Backlink Scout',
        hint: 'Inventory-first hotel and linking-entity opportunities',
      },
      {
        href: '/hht-reddit',
        label: 'Reddit',
        hint: 'City demand and raw keywords for manual Reddit research',
      },
    ],
  },
  {
    title: 'System',
    items: [
      { href: '/settings', label: 'Settings' },
      { href: '/agent', label: 'Voice agent' },
    ],
  },
]

function isActive(pathname: string, item: NavItem): boolean {
  if (item.exact) {
    /**
     * Research is `exact` so it does not stay lit while you are in Domains --
     * but sweep runs and locality scans ARE research, so they light it too.
     */
    return (
      pathname === item.href ||
      pathname.startsWith('/scout/runs') ||
      pathname.startsWith('/scout/scans')
    )
  }
  return pathname === item.href || pathname.startsWith(`${item.href}/`)
}

export function SidebarNav() {
  const pathname = usePathname() ?? '/'

  return (
    <aside className="app-sidebar">
      <div className="app-sidebar-brand">
        <Link href="/scout" className="app-logo">
          SERP Scout
        </Link>
        <div className="app-logo-sub">Local SEO markets</div>
      </div>

      <nav className="app-sidebar-nav" aria-label="Primary">
        {GROUPS.map((group) => (
          <div key={group.title} className="app-nav-group">
            <div className="app-nav-group-title">{group.title}</div>
            <ul>
              {group.items.map((item) => {
                const active = isActive(pathname, item)
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className={active ? 'app-nav-link active' : 'app-nav-link'}
                      aria-current={active ? 'page' : undefined}
                      title={item.hint}
                    >
                      {item.label}
                    </Link>
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
      </nav>

      <div className="app-sidebar-foot">
        <Link href="/settings#methodology" className="app-nav-foot-link">
          Estimates &amp; methodology
        </Link>
      </div>
    </aside>
  )
}
