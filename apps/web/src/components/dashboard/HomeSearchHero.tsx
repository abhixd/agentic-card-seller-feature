'use client'

// Search-first home hero (PRD: the home screen is built around a large search bar).
// The front door to the whole app — type a card, or jump to analyze / grade / scout.
// Self-contained & additive: drop <HomeSearchHero/> at the top of the home page.

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Search, ScanLine, Award, Target, ArrowRight } from 'lucide-react'

const QUICK_ACTIONS = [
  { href: '/analyze', label: 'Analyze a card', icon: ScanLine, hint: 'price + buy/sell/hold' },
  { href: '/grade', label: 'Grade a card', icon: Award, hint: 'photo → PSA estimate' },
  { href: '/scout', label: 'Scout a deal', icon: Target, hint: 'is it underpriced?' },
] as const

export function HomeSearchHero() {
  const router = useRouter()
  const [q, setQ] = useState('')

  function submit(e: React.FormEvent) {
    e.preventDefault()
    const term = q.trim()
    router.push(term ? `/analyze?q=${encodeURIComponent(term)}` : '/analyze')
  }

  return (
    <div
      className="relative overflow-hidden rounded-2xl px-6 py-7 sm:py-9"
      style={{
        background: 'linear-gradient(135deg, #0a0f1a 0%, #0e1426 55%, #0a0f1a 100%)',
        border: '1px solid rgba(99,102,241,0.18)',
      }}
    >
      <div aria-hidden className="pointer-events-none absolute -top-20 -right-12 h-56 w-56 rounded-full opacity-20 blur-3xl"
        style={{ background: 'radial-gradient(circle, #6366f1 0%, transparent 70%)' }} />

      <div className="relative mx-auto max-w-2xl">
        <p className="text-center text-[11px] font-semibold uppercase tracking-widest text-white/35">
          Should you buy it?
        </p>
        <h2 className="mt-1 text-center text-xl sm:text-2xl font-bold tracking-tight text-white">
          Search any card to see what it&apos;s worth.
        </h2>

        {/* Search bar */}
        <form onSubmit={submit} className="mt-5">
          <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-black/30 px-3 focus-within:border-indigo-500/50 transition-colors">
            <Search className="h-5 w-5 text-white/35 shrink-0" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="e.g. Charizard ex 151, or a sealed booster box…"
              aria-label="Search cards"
              className="flex-1 bg-transparent py-3.5 text-sm text-white placeholder:text-white/30 focus:outline-none"
            />
            <button
              type="submit"
              className="shrink-0 inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-semibold text-white transition-all hover:brightness-110"
              style={{ background: 'linear-gradient(135deg, #4f46e5, #7c3aed)' }}
            >
              Search <ArrowRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </form>

        {/* Quick actions */}
        <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-2">
          {QUICK_ACTIONS.map(({ href, label, icon: Icon, hint }) => (
            <Link
              key={href}
              href={href}
              className="group flex items-center gap-2.5 rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2.5 transition-all hover:border-white/15 hover:bg-white/[0.04]"
            >
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-500/15 border border-indigo-500/20 shrink-0">
                <Icon className="h-4 w-4 text-indigo-300" />
              </span>
              <span className="min-w-0">
                <span className="block text-xs font-semibold text-white/85 truncate">{label}</span>
                <span className="block text-[10px] text-white/35 truncate">{hint}</span>
              </span>
            </Link>
          ))}
        </div>
      </div>
    </div>
  )
}
