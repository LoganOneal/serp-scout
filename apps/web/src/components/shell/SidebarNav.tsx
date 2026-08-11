'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

type NavItem = { href: string; label: string; exact?: boolean }
type NavGroup = { title: string; items: NavItem[] }

const GROUPS: NavGroup[] = [
  {
    title: 'Work',
    items: [
      { href: '/research', label: 'Research', exact: true },
      { href: '/pipeline', label: 'Pipeline' },
      { href: '/markets', label: 'Markets' },
      { href: '/domains', label: 'Domains' },
      { href: '/tracking', label: 'Tracking' },
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
  if (item.exact) return pathname === item.href
  if (item.href === '/markets') {
    return pathname === '/markets' || pathname.startsWith('/markets/')
  }
  return pathname === item.href || pathname.startsWith(`${item.href}/`)
}

export function SidebarNav() {
  const pathname = usePathname() ?? '/'

  return (
    <aside className="app-sidebar">
      <div className="app-sidebar-brand">
        <Link href="/research" className="app-logo">
          Rank &amp; Rent
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
