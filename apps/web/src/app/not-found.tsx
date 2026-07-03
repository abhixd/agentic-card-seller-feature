import Link from 'next/link'
import { Search, LayoutDashboard } from 'lucide-react'

// Themed 404 — replaces Next's unstyled default.

export default function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="text-center space-y-5">
        <p className="stat-num text-gradient text-7xl font-extrabold tracking-tight">404</p>
        <div>
          <h1 className="text-lg font-bold tracking-tight">This page doesn&apos;t exist</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            The card you&apos;re hunting might, though.
          </p>
        </div>
        <div className="flex items-center justify-center gap-2">
          <Link
            href="/dashboard"
            className="inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-semibold text-white transition-all hover:brightness-110"
            style={{ background: 'linear-gradient(135deg, #4f46e5, #7c3aed)' }}
          >
            <LayoutDashboard className="h-3.5 w-3.5" /> Dashboard
          </Link>
          <Link
            href="/analyze"
            className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-4 py-2 text-sm font-medium text-foreground/80 hover:bg-white/[0.08] transition-colors"
          >
            <Search className="h-3.5 w-3.5" /> Search cards
          </Link>
        </div>
      </div>
    </div>
  )
}
