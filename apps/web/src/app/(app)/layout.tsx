import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { NavBar } from '@/components/layout/NavBar'
import { MobileNav } from '@/components/layout/MobileNav'
import { Toaster } from '@/components/ui/sonner'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) redirect('/login')

  return (
    <div className="flex h-screen overflow-hidden relative">
      {/* Ambient background — fixed depth layer */}
      <div aria-hidden className="ambient-bg">
        {/* Primary indigo glow — top-right */}
        <div
          className="ambient-blob"
          style={{
            width: 700,
            height: 700,
            background: 'oklch(0.62 0.2 250 / 0.07)',
            top: '-15%',
            right: '-8%',
            '--float-duration': '16s',
            '--float-delay': '0s',
          } as React.CSSProperties}
        />
        {/* Secondary violet glow — bottom-left */}
        <div
          className="ambient-blob"
          style={{
            width: 500,
            height: 500,
            background: 'oklch(0.65 0.18 280 / 0.05)',
            bottom: '5%',
            left: '-5%',
            '--float-duration': '20s',
            '--float-delay': '-8s',
          } as React.CSSProperties}
        />
        {/* Tertiary cyan glow — center-bottom, adds depth */}
        <div
          className="ambient-blob"
          style={{
            width: 420,
            height: 420,
            background: 'oklch(0.7 0.12 210 / 0.04)',
            bottom: '-12%',
            left: '45%',
            '--float-duration': '24s',
            '--float-delay': '-4s',
          } as React.CSSProperties}
        />
        {/* Dot grid overlay */}
        <div className="ambient-dot-grid" />
      </div>

      {/* Top hairline — light source above the UI */}
      <div aria-hidden className="app-hairline" />

      <NavBar />
      <main className="relative z-10 flex-1 overflow-y-auto pb-16 md:pb-0">
        {/* max-w-7xl: pages are designed for wide terminal layouts — the old
            max-w-4xl crushed the dashboard/market/card hero into a column */}
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 page-enter">{children}</div>
      </main>
      <MobileNav />
      <Toaster richColors />
    </div>
  )
}
