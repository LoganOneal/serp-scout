import Link from 'next/link'

export type HhtSectionTabsProps = {
  active: 'backlinks' | 'reddit'
}

const ITEMS: Array<{ id: HhtSectionTabsProps['active']; href: string; label: string }> = [
  { id: 'backlinks', href: '/hht-bl', label: 'Backlinks' },
  { id: 'reddit', href: '/hht-reddit', label: 'Reddit' },
]

/** Top-level navigation inside the Hotel Hot Tubs workspace. */
export function HhtSectionTabs({ active }: HhtSectionTabsProps) {
  return (
    <nav className="hht-section-tabs" aria-label="Hotel Hot Tubs research sections">
      {ITEMS.map((item) => (
        <Link
          key={item.id}
          href={item.href}
          className={`hht-section-tab${active === item.id ? ' active' : ''}`}
          aria-current={active === item.id ? 'page' : undefined}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  )
}
