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
        {/* Dot grid overlay */}
        <div className="ambient-dot-grid" />
      </div>

      <NavBar />
      <main className="relative z-10 flex-1 overflow-y-auto pb-16 md:pb-0">
        <div className="max-w-4xl mx-auto px-4 py-6 page-enter">{children}</div>
      </main>
      <MobileNav />
      <Toaster richColors />
    </div>
  )
}
