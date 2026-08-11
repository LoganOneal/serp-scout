import type { Metadata } from 'next'
import './globals.css'
import { AppShell } from '@/components/shell/AppShell'

export const metadata: Metadata = {
  title: 'Rank & Rent',
  description: 'Research local niches, save markets, monitor SERPs, and operate rank-and-rent sites.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  )
}
