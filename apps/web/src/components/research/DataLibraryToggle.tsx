'use client'

import { useState, type ReactNode } from 'react'

/** Collapsed “Data library” for catalog CSV import — not a top-level nav item. */
export function DataLibraryToggle({
  children,
  defaultOpen = false,
}: {
  children: ReactNode
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <div className="card" style={{ marginTop: 8 }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          background: 'none',
          border: 'none',
          padding: 0,
          fontWeight: 650,
          fontSize: 13,
          cursor: 'pointer',
          color: 'var(--text)',
        }}
      >
        {open ? '▾' : '▸'} Data library (import keywords &amp; geos)
      </button>
      {open && <div style={{ marginTop: 14 }}>{children}</div>}
    </div>
  )
}
