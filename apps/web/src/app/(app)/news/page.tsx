import { Newspaper, TrendingUp, TrendingDown, Sparkles } from 'lucide-react'

// Placeholder while the Bloomberg-style card-market news tracker is built.
// The previous RSS-aggregation implementation is preserved in git history.

export const metadata = { title: 'News — Coming Soon' }

const TEASER_ROWS = [
  { tag: 'SET', headline: 'Set rotation & reprint watch', dir: 'down' as const },
  { tag: 'PSA', headline: 'Population report movements', dir: 'up' as const },
  { tag: 'HYPE', headline: 'Influencer & tournament signals', dir: 'up' as const },
  { tag: 'SEALED', headline: 'Sealed product supply alerts', dir: 'down' as const },
]

export default function NewsPage() {
  return (
    <div className="max-w-3xl mx-auto px-4 py-10 space-y-8">
      {/* Hero */}
      <div
        className="relative overflow-hidden rounded-2xl px-6 py-10 text-center"
        style={{
          background: 'linear-gradient(135deg, #0a0f1a 0%, #160d12 55%, #0a0f1a 100%)',
          border: '1px solid rgba(239,68,68,0.18)',
        }}
      >
        <div aria-hidden className="pointer-events-none absolute -top-16 -right-12 h-52 w-52 rounded-full opacity-20 blur-3xl"
          style={{ background: 'radial-gradient(circle, #ef4444 0%, transparent 70%)' }} />

        <div className="relative">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-red-500/30 bg-red-500/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-widest text-red-300">
            <Sparkles className="h-3 w-3" /> Coming soon
          </span>
          <div className="mt-4 flex items-center justify-center gap-2.5">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-red-500/15 border border-red-500/25">
              <Newspaper className="h-5 w-5 text-red-300" />
            </span>
            <h1 className="text-2xl font-bold tracking-tight text-white">Card Market News</h1>
          </div>
          <p className="mx-auto mt-3 max-w-md text-sm text-white/45 leading-relaxed">
            A Bloomberg-style news terminal for the trading-card market — reprints, population
            shifts, hype cycles and sealed-supply signals, tied directly to the cards they move.
          </p>
        </div>
      </div>

      {/* Faux preview rows */}
      <div className="space-y-2">
        <p className="text-[10px] uppercase tracking-widest text-white/30 font-medium px-1">A taste of what&apos;s coming</p>
        {TEASER_ROWS.map((r) => (
          <div
            key={r.tag}
            className="flex items-center gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3 opacity-60"
          >
            <span className="text-[10px] font-bold tracking-wider text-white/40 w-14 shrink-0">{r.tag}</span>
            <span className="flex-1 text-sm text-white/55">{r.headline}</span>
            {r.dir === 'up'
              ? <TrendingUp className="h-4 w-4 text-emerald-400/60 shrink-0" />
              : <TrendingDown className="h-4 w-4 text-red-400/60 shrink-0" />}
          </div>
        ))}
        <p className="text-center text-[11px] text-white/25 pt-2">
          In the works — check back soon.
        </p>
      </div>
    </div>
  )
}
