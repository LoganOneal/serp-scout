import Link from 'next/link'

export function QuickActionCard({
  title,
  description,
  href,
  cta,
}: {
  title: string
  description: string
  href: string
  cta: string
}) {
  return (
    <Link href={href} className="quick-card">
      <div className="quick-card-title">{title}</div>
      <p className="quick-card-desc">{description}</p>
      <span className="quick-card-cta">{cta} →</span>
    </Link>
  )
}
