'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { LayoutDashboard, ScanLine, Archive, MessageSquare, LogOut, Layers, BookOpen, Newspaper, Users, ArrowLeftRight, TrendingUp, MapPin, Heart } from 'lucide-react'
import { cn } from '@/lib/utils'
import { createClient } from '@/lib/supabase/client'
import { signOut } from '@/lib/auth/authService'
import { Button } from '@/components/ui/button'

const navItems = [
  {
    href: '/dashboard',
    label: 'Dashboard',
    icon: LayoutDashboard,
    activeColor: 'text-indigo-400',
    activeGlow: 'shadow-indigo-500/20',
  },
  {
    href: '/analyze',
    label: 'Analyze Card',
    icon: ScanLine,
    activeColor: 'text-violet-400',
    activeGlow: 'shadow-violet-500/20',
  },
  {
    href: '/inventory',
    label: 'Inventory',
    icon: Archive,
    activeColor: 'text-emerald-400',
    activeGlow: 'shadow-emerald-500/20',
  },
  {
    href: '/market',
    label: 'Market Index',
    icon: TrendingUp,
    activeColor: 'text-amber-400',
    activeGlow: 'shadow-amber-500/20',
  },
  {
    href: '/trade',
    label: 'Trade Analyzer',
    icon: ArrowLeftRight,
    activeColor: 'text-orange-400',
    activeGlow: 'shadow-orange-500/20',
  },
  {
    href: '/shows',
    label: 'Card Shows',
    icon: MapPin,
    activeColor: 'text-rose-400',
    activeGlow: 'shadow-rose-500/20',
  },
  {
    href: '/wantlist',
    label: 'Wantlist',
    icon: Heart,
    activeColor: 'text-rose-400',
    activeGlow: 'shadow-rose-500/20',
  },
  {
    href: '/chat',
    label: 'Chat',
    icon: MessageSquare,
    activeColor: 'text-sky-400',
    activeGlow: 'shadow-sky-500/20',
  },
  {
    href: '/community',
    label: 'Community',
    icon: Users,
    activeColor: 'text-violet-400',
    activeGlow: 'shadow-violet-500/20',
  },
  {
    href: '/sets',
    label: 'Browse Sets',
    icon: BookOpen,
    activeColor: 'text-amber-400',
    activeGlow: 'shadow-amber-500/20',
  },
  {
    href: '/news',
    label: 'News',
    icon: Newspaper,
    activeColor: 'text-rose-400',
    activeGlow: 'shadow-rose-500/20',
  },
]

export function NavBar() {
  const pathname = usePathname()
  const router = useRouter()

  async function handleSignOut() {
    const supabase = createClient()
    await signOut(supabase)
    router.push('/login')
  }

  return (
    <>
      <style>{`
        @keyframes borderGlow {
          0%   { background-position: 0% 0%; }
          50%  { background-position: 0% 100%; }
          100% { background-position: 0% 0%; }
        }
        .nav-border-glow::after {
          content: '';
          position: absolute;
          top: 0;
          right: 0;
          width: 1px;
          height: 100%;
          background: linear-gradient(
            to bottom,
            transparent 0%,
            #6366f1 25%,
            #8b5cf6 50%,
            #6366f1 75%,
            transparent 100%
          );
          background-size: 100% 200%;
          animation: borderGlow 4s ease-in-out infinite;
        }
      `}</style>

      <aside
        className="nav-border-glow hidden md:flex flex-col w-60 h-screen sticky top-0 p-4 gap-1 relative overflow-hidden"
        style={{
          background: 'linear-gradient(180deg, #0d1117 0%, #0f1623 40%, #0d1117 100%)',
        }}
      >
        {/* Subtle ambient glow in top corner */}
        <div
          className="absolute top-0 left-0 w-40 h-40 rounded-full pointer-events-none"
          style={{
            background: 'radial-gradient(circle, rgba(99,102,241,0.08) 0%, transparent 70%)',
          }}
        />

        {/* Logo / App name */}
        <div className="flex items-center gap-3 mb-7 px-2 pt-1">
          <div
            className="relative flex items-center justify-center w-8 h-8 rounded-lg flex-shrink-0"
            style={{
              background: 'linear-gradient(135deg, #4f46e5, #7c3aed)',
              boxShadow: '0 0 14px 3px rgba(99,102,241,0.45), 0 0 4px 1px rgba(139,92,246,0.3)',
            }}
          >
            <Layers className="h-4 w-4 text-white" />
          </div>
          <div className="flex items-center gap-2 min-w-0">
            <span
              className="font-bold text-sm tracking-tight"
              style={{
                background: 'linear-gradient(90deg, #818cf8, #a78bfa)',
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
                backgroundClip: 'text',
              }}
            >
              Card Seller OS
            </span>
            <span className="flex-shrink-0 text-[9px] font-semibold tracking-widest uppercase px-1.5 py-0.5 rounded-full border border-white/10 text-white/30 bg-white/5">
              BETA
            </span>
          </div>
        </div>

        {/* Nav items */}
        <nav className="flex flex-col gap-0.5">
          {navItems.map(({ href, label, icon: Icon, activeColor, activeGlow }) => {
            const isActive = pathname.startsWith(href)
            return (
              <Link
                key={href}
                href={href}
                className={cn(
                  'group relative flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-all duration-200 overflow-hidden',
                  isActive
                    ? 'text-white'
                    : 'text-white/40 hover:text-white/75 hover:bg-white/5'
                )}
                style={
                  isActive
                    ? {
                        background:
                          'linear-gradient(90deg, rgba(99,102,241,0.15) 0%, rgba(139,92,246,0.08) 100%)',
                      }
                    : undefined
                }
              >
                {/* Left accent bar for active item */}
                {isActive && (
                  <span
                    className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 rounded-full"
                    style={{
                      background: 'linear-gradient(180deg, #6366f1, #8b5cf6)',
                      boxShadow: '0 0 8px 1px rgba(99,102,241,0.6)',
                    }}
                  />
                )}

                <Icon
                  className={cn(
                    'h-4 w-4 flex-shrink-0 transition-colors duration-200',
                    isActive ? activeColor : 'group-hover:text-white/60'
                  )}
                  style={
                    isActive
                      ? { filter: 'drop-shadow(0 0 4px currentColor)' }
                      : undefined
                  }
                />
                <span className="truncate">{label}</span>
              </Link>
            )
          })}
        </nav>

        {/* Sign out */}
        <div className="mt-auto pt-3 border-t border-white/5">
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start gap-3 text-white/30 hover:text-red-400 hover:bg-red-500/10 transition-all duration-200 rounded-lg text-sm font-medium"
            onClick={handleSignOut}
          >
            <LogOut className="h-4 w-4 flex-shrink-0" />
            Sign out
          </Button>
        </div>
      </aside>
    </>
  )
}
