import { createClient } from '@/lib/supabase/server'
import { ScanLine, Archive, MessageSquare, Lock, Sparkles, TrendingUp, BarChart2, Clock, ArrowRight } from 'lucide-react'
import Link from 'next/link'

// ── Ticker data ──────────────────────────────────────────────────────────────

const tickerItems = [
  { name: 'Charizard ex',        price: '$145.00', dir: 'up',   change: '+12.5%' },
  { name: 'Pikachu VMAX',        price:  '$89.00', dir: 'flat', change:  '+0.3%' },
  { name: 'Mewtwo V-UNION',      price:  '$62.50', dir: 'up',   change:  '+8.1%' },
  { name: 'Rayquaza VMAX',       price: '$110.00', dir: 'up',   change: '+15.2%' },
  { name: 'Umbreon VMAX Alt',    price: '$225.00', dir: 'down', change:  '-4.7%' },
  { name: 'Lugia VStar',         price:  '$74.00', dir: 'flat', change:  '-0.8%' },
  { name: 'Giratina VStar',      price:  '$58.00', dir: 'up',   change:  '+6.3%' },
  { name: 'Mew VMAX Alt',        price: '$195.00', dir: 'down', change:  '-7.1%' },
]

// ── Quick actions ─────────────────────────────────────────────────────────────

const quickActions = [
  {
    href: '/analyze',
    icon: ScanLine,
    title: 'Analyze a Card',
    description: 'Pull comps and get a sell / grade / hold recommendation.',
    gradient: 'linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%)',
    glow: 'rgba(99,102,241,0.35)',
  },
  {
    href: '/inventory',
    icon: Archive,
    title: 'View Inventory',
    description: 'Browse saved cards and manage their status.',
    gradient: 'linear-gradient(135deg, #10b981 0%, #3b82f6 100%)',
    glow: 'rgba(16,185,129,0.30)',
  },
  {
    href: '/chat',
    icon: MessageSquare,
    title: 'Chat Copilot',
    description: 'Ask the AI to rank opportunities or explain any call.',
    gradient: 'linear-gradient(135deg, #f59e0b 0%, #ef4444 100%)',
    glow: 'rgba(245,158,11,0.30)',
  },
]

// ── Market spotlight sets ─────────────────────────────────────────────────────

const spotlightSets = [
  { name: 'Scarlet & Violet',      abbr: 'SV',  activity: 92, color: '#f43f5e' },
  { name: 'Prismatic Evolutions',  abbr: 'PE',  activity: 78, color: '#a855f7' },
  { name: 'Paldea Evolved',        abbr: 'PAL', activity: 61, color: '#3b82f6' },
]

// ── Locked portfolio features ─────────────────────────────────────────────────

const lockedFeatures = [
  'Portfolio value',
  'Profit / loss tracking',
  'ROI by set',
  'Best time to sell',
]

// ── Helpers ───────────────────────────────────────────────────────────────────

function getGreeting(hour: number): string {
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}

function dirMeta(dir: string) {
  if (dir === 'up')   return { symbol: '↑', color: '#22c55e' }
  if (dir === 'down') return { symbol: '↓', color: '#ef4444' }
  return              { symbol: '→', color: '#94a3b8' }
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default async function DashboardPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const username = user?.email?.split('@')[0] ?? 'trader'

  // Server-side time for greeting
  const hour = new Date().getHours()
  const greeting = getGreeting(hour)

  // Duplicate ticker items so the marquee loops seamlessly
  const tickerLoop = [...tickerItems, ...tickerItems]

  return (
    <div className="space-y-8 pb-12">

      {/* ── Hero ── */}
      <section
        className="relative overflow-hidden rounded-2xl px-8 py-10"
        style={{
          background: 'linear-gradient(135deg, #0d1117 0%, #0f172a 50%, #0d1117 100%)',
          border: '1px solid rgba(255,255,255,0.06)',
        }}
      >
        {/* Grid overlay */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.04]"
          style={{
            backgroundImage:
              'linear-gradient(rgba(255,255,255,1) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,1) 1px, transparent 1px)',
            backgroundSize: '40px 40px',
          }}
        />
        {/* Glow orb */}
        <div
          aria-hidden
          className="pointer-events-none absolute -top-20 -right-20 h-64 w-64 rounded-full opacity-20 blur-3xl"
          style={{ background: 'radial-gradient(circle, #6366f1 0%, transparent 70%)' }}
        />

        <div className="relative animate-fade-in">
          <p className="mb-1 text-xs font-semibold uppercase tracking-widest text-white/40">
            Card Seller OS
          </p>
          <h1
            className="text-4xl font-black tracking-tight sm:text-5xl"
            style={{
              background: 'linear-gradient(90deg, #e2e8f0 0%, #94a3b8 60%, #6366f1 100%)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              backgroundClip: 'text',
            }}
          >
            {greeting}, {username}.
          </h1>
          <p className="mt-3 text-sm text-white/45 sm:text-base">
            Your cards are working while you sleep.
          </p>
        </div>
      </section>

      {/* ── Live Market Ticker ── */}
      <section className="overflow-hidden rounded-xl" style={{ background: '#080c10', border: '1px solid rgba(255,255,255,0.06)' }}>
        <div className="flex items-center gap-3 border-b border-white/[0.06] px-4 py-2">
          <span className="flex h-1.5 w-1.5 rounded-full bg-green-400 shadow-[0_0_6px_#4ade80]" />
          <span className="text-[10px] font-bold uppercase tracking-widest text-white/30">Live · 24h Market</span>
        </div>
        {/* Marquee track */}
        <div className="relative flex overflow-hidden py-3" aria-label="Market ticker">
          <div
            className="flex shrink-0 items-center gap-8 whitespace-nowrap"
            style={{ animation: 'ticker 28s linear infinite' }}
          >
            {tickerLoop.map((item, i) => {
              const { symbol, color } = dirMeta(item.dir)
              const changeBg =
                item.dir === 'up'   ? 'rgba(34,197,94,0.15)'  :
                item.dir === 'down' ? 'rgba(239,68,68,0.15)'  :
                                     'rgba(148,163,184,0.12)'
              const changeColor =
                item.dir === 'up'   ? '#4ade80' :
                item.dir === 'down' ? '#f87171' :
                                     '#94a3b8'
              const changeBorder =
                item.dir === 'up'   ? 'rgba(74,222,128,0.25)'  :
                item.dir === 'down' ? 'rgba(248,113,113,0.25)' :
                                     'rgba(148,163,184,0.2)'
              return (
                <span key={i} className="flex items-center gap-1.5 text-sm">
                  <span className="font-semibold text-white/80">{item.name}</span>
                  <span className="font-mono font-bold text-white">{item.price}</span>
                  <span className="font-bold" style={{ color }}>{symbol}</span>
                  <span
                    className="rounded-full px-1.5 py-0.5 text-[10px] font-bold tabular-nums"
                    style={{ background: changeBg, color: changeColor, border: `1px solid ${changeBorder}` }}
                  >
                    {item.change}
                  </span>
                  <span className="text-[9px] text-white/20">24h</span>
                  <span className="mx-2 text-white/10">|</span>
                </span>
              )
            })}
          </div>
        </div>
      </section>

      {/* ── Quick Actions ── */}
      <section>
        <h2 className="mb-4 text-xs font-bold uppercase tracking-widest text-white/30">
          Quick Actions
        </h2>
        <div className="grid gap-4 sm:grid-cols-3">
          {quickActions.map(({ href, icon: Icon, title, description, gradient, glow }) => (
            <Link
              key={href}
              href={href}
              className="group relative flex flex-col gap-4 overflow-hidden rounded-xl p-5 transition-all duration-200 hover:-translate-y-0.5"
              style={{
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid rgba(255,255,255,0.08)',
              }}
            >
              {/* Hover glow */}
              <div
                className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
                style={{ background: `radial-gradient(ellipse at top left, ${glow} 0%, transparent 65%)` }}
              />

              {/* Icon tile */}
              <div
                className="flex h-10 w-10 items-center justify-center rounded-lg shadow-lg"
                style={{ background: gradient }}
              >
                <Icon className="h-5 w-5 text-white" />
              </div>

              <div className="flex-1">
                <p className="mb-1 text-sm font-semibold text-white/90">{title}</p>
                <p className="text-xs leading-relaxed text-white/40">{description}</p>
              </div>

              {/* Arrow */}
              <div className="flex items-center gap-1 text-xs font-semibold text-white/30 transition-all duration-200 group-hover:gap-2 group-hover:text-white/60">
                Open
                <ArrowRight className="h-3 w-3 transition-transform duration-200 group-hover:translate-x-0.5" />
              </div>
            </Link>
          ))}
        </div>
      </section>

      {/* ── Bottom row: Portfolio + Market Spotlight ── */}
      <div className="grid gap-4 lg:grid-cols-2">

        {/* Portfolio Summary */}
        <section
          className="relative overflow-hidden rounded-xl p-6"
          style={{
            background: 'rgba(255,255,255,0.02)',
            border: '1px solid rgba(255,255,255,0.07)',
          }}
        >
          <div
            aria-hidden
            className="pointer-events-none absolute -bottom-12 -right-12 h-40 w-40 rounded-full opacity-10 blur-2xl"
            style={{ background: 'radial-gradient(circle, #6366f1 0%, transparent 70%)' }}
          />
          <div className="relative">
            <div className="mb-1 flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-indigo-400" />
              <span className="text-xs font-bold uppercase tracking-widest text-white/30">Portfolio</span>
            </div>
            <p className="mt-3 text-sm font-semibold text-white/60">
              Connect your inventory to unlock:
            </p>
            <ul className="mt-4 space-y-2.5">
              {lockedFeatures.map((feat) => (
                <li key={feat} className="flex items-center gap-2.5 text-sm text-white/35">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md" style={{ background: 'rgba(99,102,241,0.12)', border: '1px solid rgba(99,102,241,0.2)' }}>
                    <Lock className="h-3 w-3 text-indigo-400" />
                  </span>
                  {feat}
                </li>
              ))}
            </ul>
            <div className="mt-5">
              <Link
                href="/inventory"
                className="inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-xs font-semibold text-white transition-opacity hover:opacity-80"
                style={{ background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)' }}
              >
                <Sparkles className="h-3.5 w-3.5" />
                Add your first card
              </Link>
            </div>
          </div>
        </section>

        {/* Market Spotlight */}
        <section
          className="relative overflow-hidden rounded-xl p-6"
          style={{
            background: 'rgba(255,255,255,0.02)',
            border: '1px solid rgba(255,255,255,0.07)',
          }}
        >
          <div className="mb-5 flex items-center gap-2">
            <BarChart2 className="h-4 w-4 text-fuchsia-400" />
            <span className="text-xs font-bold uppercase tracking-widest text-white/30">Market Spotlight</span>
          </div>
          <p className="mb-4 text-[11px] font-semibold uppercase tracking-widest text-white/20">
            Most Active Sets This Week
          </p>
          <div className="space-y-4">
            {spotlightSets.map(({ name, abbr, activity, color }) => (
              <div key={abbr}>
                <div className="mb-1.5 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span
                      className="flex h-6 w-9 items-center justify-center rounded text-[10px] font-black"
                      style={{ background: `${color}22`, color, border: `1px solid ${color}44` }}
                    >
                      {abbr}
                    </span>
                    <span className="text-sm font-medium text-white/70">{name}</span>
                  </div>
                  <span className="font-mono text-xs text-white/30">{activity}%</span>
                </div>
                {/* Activity bar */}
                <div className="h-1.5 w-full overflow-hidden rounded-full" style={{ background: 'rgba(255,255,255,0.05)' }}>
                  <div
                    className="h-full rounded-full transition-all duration-700"
                    style={{ width: `${activity}%`, background: `linear-gradient(90deg, ${color} 0%, ${color}88 100%)` }}
                  />
                </div>
              </div>
            ))}
          </div>
          <div className="mt-5 flex items-center gap-1.5 text-[11px] text-white/20">
            <Clock className="h-3 w-3" />
            Updated hourly · Powered by market comps
          </div>
        </section>

      </div>

      {/* Ticker keyframe — injected into the page via a style tag */}
      <style>{`
        @keyframes ticker {
          0%   { transform: translateX(0); }
          100% { transform: translateX(-50%); }
        }
      `}</style>
    </div>
  )
}
