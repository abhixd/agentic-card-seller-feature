'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  LayoutDashboard, ScanLine, Archive, BookOpen,
  Newspaper, Users, ArrowLeftRight, TrendingUp, Heart, ShoppingBag, CalendarDays,
  ShoppingCart, Settings,
} from 'lucide-react'
import { cn } from '@/lib/utils'

const navItems = [
  { href: '/dashboard', label: 'Home',    icon: LayoutDashboard, grad: ['#6366f1','#4338ca'], glow: 'rgba(99,102,241,0.75)',  text: 'text-indigo-300' },
  { href: '/analyze',   label: 'Analyze', icon: ScanLine,        grad: ['#8b5cf6','#6d28d9'], glow: 'rgba(139,92,246,0.75)', text: 'text-violet-300' },
  { href: '/inventory', label: 'Cards',   icon: Archive,         grad: ['#10b981','#047857'], glow: 'rgba(16,185,129,0.75)', text: 'text-emerald-300' },
  { href: '/market',    label: 'Market',  icon: TrendingUp,      grad: ['#f59e0b','#b45309'], glow: 'rgba(245,158,11,0.75)', text: 'text-amber-300' },
  { href: '/trade',       label: 'Trade',   icon: ArrowLeftRight, grad: ['#f97316','#c2410c'], glow: 'rgba(249,115,22,0.75)', text: 'text-orange-300' },
  { href: '/wantlist',    label: 'Wants',   icon: Heart,          grad: ['#ec4899','#be185d'], glow: 'rgba(236,72,153,0.75)', text: 'text-pink-300' },
  { href: '/marketplace', label: 'P2P',     icon: ShoppingBag,    grad: ['#6366f1','#4338ca'], glow: 'rgba(99,102,241,0.75)', text: 'text-indigo-300' },
  { href: '/community',   label: 'Social',  icon: Users,           grad: ['#a855f7','#7e22ce'], glow: 'rgba(168,85,247,0.75)', text: 'text-purple-300' },
  { href: '/sets',      label: 'Sets',    icon: BookOpen,        grad: ['#eab308','#a16207'], glow: 'rgba(234,179,8,0.75)',  text: 'text-yellow-300' },
  { href: '/news',      label: 'News',     icon: Newspaper,    grad: ['#ef4444','#b91c1c'], glow: 'rgba(239,68,68,0.75)',  text: 'text-red-300'  },
  { href: '/releases',  label: 'Releases', icon: CalendarDays, grad: ['#06b6d4','#0891b2'], glow: 'rgba(6,182,212,0.75)', text: 'text-cyan-300' },
  { href: '/listings',  label: 'eBay',     icon: ShoppingCart, grad: ['#10b981','#047857'], glow: 'rgba(16,185,129,0.75)', text: 'text-emerald-300' },
  { href: '/settings',  label: 'Settings', icon: Settings,     grad: ['#64748b','#475569'], glow: 'rgba(100,116,139,0.75)', text: 'text-slate-300' },
]

export function MobileNav() {
  const pathname = usePathname()

  const prevPath   = useRef(pathname)
  const [justActive, setJustActive] = useState('')

  useEffect(() => {
    if (prevPath.current !== pathname) {
      prevPath.current = pathname
      const match = navItems.find(n => pathname.startsWith(n.href))
      if (match) {
        setJustActive(match.href)
        const t = setTimeout(() => setJustActive(''), 450)
        return () => clearTimeout(t)
      }
    }
  }, [pathname])

  return (
    <nav className="md:hidden fixed bottom-0 left-0 right-0 z-50">
      {/* Glassmorphism background */}
      <div
        className="absolute inset-0 border-t border-white/[0.07]"
        style={{
          background:           'rgba(11, 14, 22, 0.85)',
          backdropFilter:       'blur(20px) saturate(1.5)',
          WebkitBackdropFilter: 'blur(20px) saturate(1.5)',
        }}
      />

      <div className="relative flex items-stretch">
        {navItems.map(({ href, label, icon: Icon, grad, glow, text }) => {
          const isActive   = pathname.startsWith(href)
          const isBouncing = justActive === href

          return (
            <Link
              key={href}
              href={href}
              className={cn(
                'press-effect flex-1 flex flex-col items-center justify-center gap-0.5 py-2 relative select-none',
                'transition-opacity duration-150',
                !isActive && 'opacity-55 hover:opacity-80',
              )}
            >
              {/* Top pill indicator */}
              {isActive && (
                <span
                  className="mobile-pill-in absolute top-0 left-1/2 -translate-x-1/2 h-[2px] w-6 rounded-full"
                  style={{
                    background: `linear-gradient(90deg, ${grad[0]}, ${grad[1]})`,
                    boxShadow:  `0 0 8px 2px ${glow}`,
                  }}
                />
              )}

              {/* Colorful icon container */}
              <div
                className={cn(
                  'relative flex items-center justify-center w-8 h-8 rounded-xl',
                  'transition-transform duration-200',
                  isActive && !isBouncing ? 'scale-110' : 'scale-100',
                  isBouncing && 'mobile-icon-pop',
                )}
                style={
                  isActive
                    ? {
                        background: `linear-gradient(135deg, ${grad[0]}, ${grad[1]})`,
                        boxShadow:  `0 2px 12px 0 ${glow}, 0 0 0 1px ${grad[0]}50`,
                      }
                    : {
                        background: `linear-gradient(135deg, ${grad[0]}20, ${grad[1]}18)`,
                        border:     `1px solid ${grad[0]}28`,
                      }
                }
              >
                <Icon
                  className={cn(
                    'h-4 w-4 transition-colors duration-200',
                    isActive ? 'text-white' : text,
                  )}
                  style={isActive ? { filter: 'drop-shadow(0 1px 3px rgba(0,0,0,0.4))' } : undefined}
                />
              </div>

              <span
                className={cn(
                  'text-[9px] font-medium tracking-wide transition-colors duration-200',
                  isActive ? 'text-white/80' : 'text-white/30',
                )}
              >
                {label}
              </span>
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
