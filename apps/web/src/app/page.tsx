'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  TrendingUp,
  BarChart2,
  Award,
  Globe,
  ChevronRight,
  Search,
  Zap,
  ShieldCheck,
} from 'lucide-react'

// ── Search hero (client island) ───────────────────────────────────────────────

function HeroSearch() {
  const router = useRouter()
  const [query, setQuery] = useState('')

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const q = query.trim()
    if (q.length < 2) return
    router.push(`/analyze?q=${encodeURIComponent(q)}`)
  }

  return (
    <form onSubmit={handleSubmit} className="w-full max-w-xl mx-auto">
      <div className="relative group">
        <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground/60 group-focus-within:text-primary transition-colors pointer-events-none" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search any card — Charizard, Pikachu 151, Base Set…"
          className="w-full bg-card/80 backdrop-blur border border-border/40 rounded-2xl pl-12 pr-36 py-4 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/15 transition-all shadow-lg shadow-black/20"
        />
        <button
          type="submit"
          disabled={query.trim().length < 2}
          className="absolute right-2 top-1/2 -translate-y-1/2 bg-primary text-primary-foreground text-sm font-semibold px-5 py-2 rounded-xl transition-all hover:bg-primary/90 active:scale-[0.97] disabled:opacity-40 disabled:cursor-not-allowed shadow-sm"
        >
          Analyze →
        </button>
      </div>
      <p className="text-center text-xs text-muted-foreground/50 mt-3">
        No account needed to search · Sign in to save results
      </p>
    </form>
  )
}

// ── Feature data ──────────────────────────────────────────────────────────────

const FEATURES = [
  {
    icon: BarChart2,
    color: 'text-blue-400',
    bg:    'bg-blue-500/10',
    title: '90-Day eBay History',
    body:  'Real sold prices — not listings. See what cards actually cleared, with trend lines and daily volume.',
  },
  {
    icon: TrendingUp,
    color: 'text-emerald-400',
    bg:    'bg-emerald-500/10',
    title: 'TCGPlayer Market Prices',
    body:  'Low/Mid/Market/High per finish and edition. 1st Edition, Unlimited, Reverse Holo — all separated.',
  },
  {
    icon: Award,
    color: 'text-amber-400',
    bg:    'bg-amber-500/10',
    title: 'Graded Card Premiums',
    body:  'PSA, BGS, and CGC slab sales pulled from real eBay data. Know exactly how much grading adds.',
  },
  {
    icon: Globe,
    color: 'text-red-400',
    bg:    'bg-red-500/10',
    title: 'Japanese Market',
    body:  'Japanese card sales tracked separately from English. No more mixing EN and JP prices.',
  },
  {
    icon: ShieldCheck,
    color: 'text-purple-400',
    bg:    'bg-purple-500/10',
    title: 'Condition Estimator',
    body:  'NM baseline with LP/MP/HP/Damaged multipliers based on TCGPlayer tier standards.',
  },
  {
    icon: Zap,
    color: 'text-primary',
    bg:    'bg-primary/10',
    title: 'Instant Intelligence',
    body:  'Search any card, get a full price breakdown in seconds. No spreadsheets, no guesswork.',
  },
]

const STEPS = [
  { n: '01', title: 'Search any card',        body: 'Type a card name. We pull from 5,000+ cards across all sets.' },
  { n: '02', title: 'See the full picture',   body: 'TCGPlayer prices, 90-day eBay history, graded premiums, JP market — all on one screen.' },
  { n: '03', title: 'Price with confidence',  body: 'Know the true market price before you list. Never undersell, never price yourself out.' },
]

// ── Page ──────────────────────────────────────────────────────────────────────

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-background text-foreground overflow-x-hidden">

      {/* ── Nav ── */}
      <nav className="fixed top-0 left-0 right-0 z-50 flex items-center justify-between px-6 py-4 border-b border-border/20 bg-background/80 backdrop-blur-md">
        <span className="font-bold text-sm tracking-tight">
          <span className="text-white">Scan</span><span className="text-primary">Dex</span>
        </span>
        <div className="flex items-center gap-3">
          <Link href="/analyze"
            className="text-sm text-muted-foreground hover:text-foreground transition-colors">
            Analyze
          </Link>
          <Link href="/login"
            className="text-sm bg-primary/10 text-primary border border-primary/30 px-4 py-1.5 rounded-xl font-medium hover:bg-primary/20 transition-all">
            Sign in
          </Link>
        </div>
      </nav>

      {/* ── Hero ── */}
      <section className="relative pt-32 pb-24 px-6 flex flex-col items-center text-center overflow-hidden">
        {/* Background glow */}
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-[600px] h-[400px] rounded-full bg-primary/6 blur-[120px]" />
          <div className="absolute top-1/3 left-1/3 w-[300px] h-[200px] rounded-full bg-blue-500/5 blur-[80px]" />
        </div>

        {/* Badge */}
        <div className="inline-flex items-center gap-2 bg-primary/10 border border-primary/25 rounded-full px-4 py-1.5 text-xs text-primary font-medium mb-8">
          <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
          Real-time market intelligence for card sellers
        </div>

        {/* Headline */}
        <h1 className="text-5xl sm:text-6xl lg:text-7xl font-bold tracking-tight leading-[1.05] max-w-4xl mb-6">
          Know exactly what<br />
          <span className="text-primary">your cards are worth.</span>
        </h1>

        {/* Sub */}
        <p className="text-lg text-muted-foreground max-w-xl mb-12 leading-relaxed">
          Real eBay sold data, TCGPlayer market prices, graded card premiums, and Japanese market tracking — all in one place. The information edge every serious seller needs.
        </p>

        {/* Search */}
        <HeroSearch />

        {/* Social proof */}
        <div className="mt-16 flex items-center gap-8 text-xs text-muted-foreground/50 flex-wrap justify-center">
          <span>✓ Live eBay comps</span>
          <span className="text-border/60">·</span>
          <span>✓ TCGPlayer market prices</span>
          <span className="text-border/60">·</span>
          <span>✓ PSA / BGS graded data</span>
          <span className="text-border/60">·</span>
          <span>✓ Japanese card tracking</span>
        </div>
      </section>

      {/* ── Features grid ── */}
      <section className="px-6 py-20 max-w-6xl mx-auto">
        <div className="text-center mb-14">
          <p className="text-[10px] uppercase tracking-widest text-muted-foreground/60 font-medium mb-3">
            What you get
          </p>
          <h2 className="text-3xl font-bold tracking-tight">
            Every data point that matters
          </h2>
          <p className="text-muted-foreground mt-3 max-w-lg mx-auto text-sm">
            We built the tool we wished existed. No filler — just the signals serious sellers actually use.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {FEATURES.map(({ icon: Icon, color, bg, title, body }) => (
            <div key={title}
              className="group relative rounded-2xl border border-border/25 bg-card p-6 hover:border-border/50 hover:-translate-y-0.5 transition-all duration-200 shadow-sm">
              <div className={`inline-flex items-center justify-center w-10 h-10 rounded-xl ${bg} mb-4`}>
                <Icon className={`h-5 w-5 ${color}`} />
              </div>
              <h3 className="font-semibold text-sm mb-2">{title}</h3>
              <p className="text-xs text-muted-foreground leading-relaxed">{body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── How it works ── */}
      <section className="px-6 py-20 border-t border-border/20">
        <div className="max-w-4xl mx-auto">
          <div className="text-center mb-14">
            <p className="text-[10px] uppercase tracking-widest text-muted-foreground/60 font-medium mb-3">
              How it works
            </p>
            <h2 className="text-3xl font-bold tracking-tight">
              From search to sell in seconds
            </h2>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-8 relative">
            {/* Connector line (desktop) */}
            <div className="hidden md:block absolute top-8 left-[calc(16.6%)] right-[calc(16.6%)] h-px bg-gradient-to-r from-transparent via-border/40 to-transparent" />

            {STEPS.map(({ n, title, body }) => (
              <div key={n} className="text-center relative">
                <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-card border border-border/30 text-xl font-bold text-primary/60 mb-5 shadow-sm">
                  {n}
                </div>
                <h3 className="font-semibold text-sm mb-2">{title}</h3>
                <p className="text-xs text-muted-foreground leading-relaxed">{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Supply/demand note ── */}
      <section className="px-6 py-12 max-w-4xl mx-auto">
        <div className="rounded-2xl border border-border/30 bg-card/50 p-8 flex flex-col md:flex-row items-start md:items-center gap-6">
          <div className="flex-shrink-0 w-12 h-12 rounded-xl bg-emerald-500/10 flex items-center justify-center">
            <TrendingUp className="h-6 w-6 text-emerald-400" />
          </div>
          <div>
            <h3 className="font-semibold text-sm mb-1.5">Market signals on every card</h3>
            <p className="text-xs text-muted-foreground leading-relaxed max-w-lg">
              Sales velocity (per week), price momentum (recent vs prior period), and 30/60/90-day trend lines — all derived from real eBay sold data. We never fabricate signals or invent scarcity scores.
            </p>
          </div>
        </div>
      </section>

      {/* ── CTA ── */}
      <section className="px-6 py-24 text-center relative overflow-hidden">
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-[500px] h-[300px] rounded-full bg-primary/5 blur-[100px]" />
        </div>
        <h2 className="text-4xl font-bold tracking-tight mb-4">
          Start analyzing for free
        </h2>
        <p className="text-muted-foreground text-sm mb-10 max-w-md mx-auto">
          No signup required to search. Create an account to save analyses and track your inventory.
        </p>
        <div className="flex items-center justify-center gap-4 flex-wrap">
          <Link href="/analyze"
            className="inline-flex items-center gap-2 bg-primary text-primary-foreground font-semibold px-8 py-3.5 rounded-2xl hover:bg-primary/90 active:scale-[0.97] transition-all shadow-lg shadow-primary/25">
            Search cards now
            <ChevronRight className="h-4 w-4" />
          </Link>
          <Link href="/login"
            className="inline-flex items-center gap-2 bg-card border border-border/40 text-foreground font-medium px-8 py-3.5 rounded-2xl hover:border-border/70 transition-all">
            Create account
          </Link>
        </div>
      </section>

      {/* ── Footer ── */}
      <footer className="border-t border-border/20 px-6 py-8 text-center text-xs text-muted-foreground/40">
        ScanDex · Price data sourced from eBay completed listings and TCGPlayer market prices.
        Not affiliated with eBay, TCGPlayer, Pokémon, or any card manufacturer.
      </footer>
    </div>
  )
}
