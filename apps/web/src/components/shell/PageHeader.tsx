import type { ReactNode } from 'react'

export function PageHeader({
  title,
  description,
  actions,
  breadcrumb,
}: {
  title: string
  description?: string
  actions?: ReactNode
  breadcrumb?: ReactNode
}) {
  return (
    <div className="page-header">
      {breadcrumb && <div className="page-breadcrumb">{breadcrumb}</div>}
      <div className="page-header-row">
        <div>
          <h1 className="page-title">{title}</h1>
          {description && <p className="page-desc">{description}</p>}
        </div>
        {actions && <div className="page-header-actions">{actions}</div>}
      </div>
    </div>
  )
}
