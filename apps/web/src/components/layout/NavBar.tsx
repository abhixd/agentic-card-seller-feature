'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import {
  LayoutDashboard, ScanLine, Archive, LogOut,
  TrendingUp, Settings, Award, Target, Newspaper,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { createClient } from '@/lib/supabase/client'
import { signOut } from '@/lib/auth/authService'
import { Button } from '@/components/ui/button'

// Cleaned to the core decision surfaces only. Secondary tools (trade, wantlist,
// marketplace, community, sets, news, releases, eBay listings, optimize) still
// exist at their routes but are no longer top-level nav clutter.
const navItems = [
  {
    href:  '/dashboard',
    label: 'Dashboard',
    icon:  LayoutDashboard,
    grad:  ['#6366f1', '#4338ca'],   // indigo
    glow:  'rgba(99,102,241,0.7)',
    text:  'text-indigo-300',
  },
  {
    href:  '/analyze',
    label: 'Analyze',
    icon:  ScanLine,
    grad:  ['#8b5cf6', '#6d28d9'],   // violet
    glow:  'rgba(139,92,246,0.7)',
    text:  'text-violet-300',
  },
  {
    href:  '/grade',
    label: 'Grade',
    icon:  Award,
    grad:  ['#f43f5e', '#be123c'],   // rose
    glow:  'rgba(244,63,94,0.7)',
    text:  'text-rose-300',
  },
  {
    href:  '/scout',
    label: 'Scout',
    icon:  Target,
    grad:  ['#06b6d4', '#0e7490'],   // cyan
    glow:  'rgba(6,182,212,0.7)',
    text:  'text-cyan-300',
  },
  {
    href:  '/inventory',
    label: 'Portfolio',
    icon:  Archive,
    grad:  ['#10b981', '#047857'],   // emerald
    glow:  'rgba(16,185,129,0.7)',
    text:  'text-emerald-300',
  },
  {
    href:  '/market',
    label: 'Market',
    icon:  TrendingUp,
    grad:  ['#f59e0b', '#b45309'],   // amber
    glow:  'rgba(245,158,11,0.7)',
    text:  'text-amber-300',
  },
  {
    href:  '/news',
    label: 'News',
    icon:  Newspaper,
    grad:  ['#ef4444', '#b91c1c'],   // red
    glow:  'rgba(239,68,68,0.7)',
    text:  'text-red-300',
  },
  {
    href:  '/settings',
    label: 'Settings',
    icon:  Settings,
    grad:  ['#64748b', '#475569'],   // slate
    glow:  'rgba(100,116,139,0.7)',
    text:  'text-slate-300',
  },
]

export function NavBar() {
  const pathname = usePathname()
  const router   = useRouter()

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
          top: 0; right: 0;
          width: 1px; height: 100%;
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
        style={{ background: 'linear-gradient(180deg, #0d1117 0%, #0f1623 40%, #0d1117 100%)' }}
      >
        {/* Ambient corner glows */}
        <div className="absolute top-0 left-0 w-48 h-48 rounded-full pointer-events-none"
          style={{ background: 'radial-gradient(circle, rgba(99,102,241,0.09) 0%, transparent 70%)' }} />
        <div className="absolute bottom-0 right-0 w-32 h-32 rounded-full pointer-events-none"
          style={{ background: 'radial-gradient(circle, rgba(139,92,246,0.07) 0%, transparent 70%)' }} />

        {/* ── ScanDex wordmark: the logo scans itself ── */}
        <style>{`
          @keyframes sdxBeam {
            0%       { left: -18%; opacity: 0; }
            6%       { opacity: 1; }
            42%      { left: 104%; opacity: 1; }
            48%,100% { left: 104%; opacity: 0; }
          }
          @keyframes sdxTileScan {
            0%, 100% { top: 12%; opacity: .0; }
            15%      { opacity: .95; }
            50%      { top: 82%; opacity: .95; }
            85%      { opacity: 0; }
          }
        `}</style>
        <div className="flex items-center gap-3 mb-7 px-2 pt-1 select-none">
          {/* Icon tile — a card being scanned */}
          <div
            className="logo-glow relative flex items-center justify-center w-8 h-8 rounded-lg flex-shrink-0 overflow-hidden transition-transform duration-300 hover:scale-110"
            style={{ background: 'linear-gradient(135deg, #4f46e5, #7c3aed)' }}
          >
            <ScanLine className="h-4 w-4 text-white" />
            <span aria-hidden className="absolute left-1 right-1 h-[1.5px] rounded-full"
              style={{ background: 'rgba(255,255,255,0.9)', boxShadow: '0 0 6px 1px rgba(255,255,255,0.8)', animation: 'sdxTileScan 3.2s ease-in-out infinite' }} />
          </div>
          {/* Wordmark — Scan (white) + Dex (gradient) with a sweeping scanner beam */}
          <div className="flex items-center gap-2 min-w-0">
            <span className="relative inline-block overflow-hidden font-extrabold text-[17px] tracking-tight leading-none">
              <span className="text-white">Scan</span>
              <span
                style={{
                  background: 'linear-gradient(90deg, #818cf8, #a78bfa, #c084fc)',
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                  backgroundClip: 'text',
                }}
              >
                Dex
              </span>
              <span aria-hidden className="pointer-events-none absolute top-[-15%] bottom-[-15%] w-[14px]"
                style={{
                  background: 'linear-gradient(90deg, transparent, rgba(196,181,253,0.85), transparent)',
                  filter: 'blur(0.5px)',
                  animation: 'sdxBeam 4.6s ease-in-out infinite',
                }} />
            </span>
            <span className="beta-badge flex-shrink-0 text-[9px] font-semibold tracking-widest uppercase px-1.5 py-0.5 rounded-full border border-white/10 text-white/30 bg-white/5">
              BETA
            </span>
          </div>
        </div>

        {/* Nav items */}
        <nav className="flex flex-col gap-0.5">
          {navItems.map(({ href, label, icon: Icon, grad, glow, text }, index) => {
            const isActive = pathname.startsWith(href)

            return (
              <Link
                key={href}
                href={href}
                className={cn(
                  'nav-item-anim shimmer-on-hover group relative flex items-center gap-3 px-2.5 py-1.5 rounded-xl overflow-hidden',
                  'transition-all duration-200',
                  isActive
                    ? 'text-white'
                    : 'text-white/50 hover:text-white/85 hover:bg-white/[0.04]',
                )}
                style={{
                  animationDelay: `${index * 28}ms`,
                  ...(isActive
                    ? {
                        background: `linear-gradient(90deg,
                          ${grad[0]}18 0%,
                          ${grad[1]}08 100%)`,
                      }
                    : {}),
                }}
              >
                {/* Active left accent bar */}
                {isActive && (
                  <span
                    className="nav-active-bar absolute left-0 top-1/2 w-[3px] h-6 rounded-r-full"
                    style={{
                      background: `linear-gradient(180deg, ${grad[0]}, ${grad[1]})`,
                      boxShadow:  `0 0 10px 2px ${glow}`,
                    }}
                  />
                )}

                {/* ── Colorful icon container ── */}
                <div
                  className={cn(
                    'relative flex items-center justify-center w-7 h-7 rounded-lg flex-shrink-0',
                    'transition-all duration-200',
                    isActive
                      ? 'scale-100'
                      : 'group-hover:scale-110 group-hover:-rotate-6',
                  )}
                  style={
                    isActive
                      ? {
                          background: `linear-gradient(135deg, ${grad[0]}, ${grad[1]})`,
                          boxShadow:  `0 2px 10px 0 ${glow}, 0 0 0 1px ${grad[0]}40`,
                        }
                      : {
                          background: `linear-gradient(135deg, ${grad[0]}22, ${grad[1]}18)`,
                          border:     `1px solid ${grad[0]}30`,
                        }
                  }
                >
                  <Icon
                    className={cn(
                      'h-3.5 w-3.5 transition-all duration-200',
                      isActive ? 'text-white' : text,
                    )}
                    style={isActive ? { filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.4))' } : undefined}
                  />
                </div>

                {/* Label */}
                <span className="truncate text-sm font-medium transition-all duration-200 group-hover:translate-x-0.5">
                  {label}
                </span>

                {/* Active trailing dot */}
                {isActive && (
                  <span
                    className="ml-auto w-1.5 h-1.5 rounded-full flex-shrink-0"
                    style={{
                      background: grad[0],
                      boxShadow:  `0 0 6px 2px ${glow}`,
                    }}
                  />
                )}
              </Link>
            )
          })}
        </nav>

        {/* Sign out */}
        <div className="mt-auto pt-3 border-t border-white/5">
          <Button
            variant="ghost"
            size="sm"
            className="group w-full justify-start gap-3 text-white/30 hover:text-red-400 hover:bg-red-500/8 transition-all duration-200 rounded-xl text-sm font-medium px-2.5"
            onClick={handleSignOut}
          >
            <div className="flex items-center justify-center w-7 h-7 rounded-lg flex-shrink-0 transition-all duration-200 bg-white/[0.04] border border-white/8 group-hover:bg-red-500/20 group-hover:border-red-500/30 group-hover:scale-110 group-hover:-rotate-6">
              <LogOut className="h-3.5 w-3.5 transition-colors duration-200 group-hover:text-red-400" />
            </div>
            Sign out
          </Button>
        </div>
      </aside>
    </>
  )
}
