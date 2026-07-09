import { createClient } from '@/lib/supabase/server'
import Link from 'next/link'
import Image from 'next/image'
import {
  TrendingUp, TrendingDown, Minus, BarChart2,
  ArrowUpRight, ArrowDownRight, Clock, Search, Flame,
  Crown, AlertTriangle,
} from 'lucide-react'
import { Sparkline } from '@/components/ui/Sparkline'
import { AnimatedNumber } from '@/components/ui/AnimatedNumber'

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractTcgPrice(meta: any): { market: number; mid: number | null } | null {
  const prices = meta?.tcgplayer?.prices
  if (!prices) return null
  const BANDS = [
    'holofoil', '1stEditionHolofoil', 'reverseHolofoil',
    'normal', 'unlimitedHolofoil', '1stEditionNormal',
  ]
  for (const band of BANDS) {
    const p = prices[band]
    if (p?.market && p.market > 0) return { market: p.market as number, mid: p.mid ?? null }
  }
  for (const b of Object.values(prices) as any[]) {
    if (b?.market && b.market > 0) return { market: b.market, mid: b.mid ?? null }
  }
  return null
}

interface HistoryPoint { date: string; price: number }

function extractHistory(meta: any): HistoryPoint[] {
  const pts: HistoryPoint[] = meta?.tcg_history?.points ?? []
  return pts
    .filter((p: any) => typeof p?.date === 'string' && typeof p?.price === 'number')
    .sort((a: HistoryPoint, b: HistoryPoint) =>
      new Date(a.date).getTime() - new Date(b.date).getTime()
    )
}

function closestPrice(pts: HistoryPoint[], targetMs: number, toleranceDays = 4): number | null {
  if (pts.length === 0) return null
  let best: HistoryPoint | null = null
  let bestDiff = Infinity
  for (const p of pts) {
    const diff = Math.abs(new Date(p.date).getTime() - targetMs)
    if (diff < bestDiff) { bestDiff = diff; best = p }
  }
  return bestDiff <= toleranceDays * 86_400_000 ? (best?.price ?? null) : null
}

function fmtUsd(n: number) {
  return n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : `$${n.toFixed(2)}`
}
function fmtPct(n: number) {
  return `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`
}

// ── Signal badge logic ────────────────────────────────────────────────────────

type Signal = 'rocket' | 'crash' | 'ath' | 'hot' | 'cooling' | null

function computeSignal(chg7d: number | null, chg30d: number | null, market: number, ath: number | null): Signal {
  if (chg7d != null && chg7d >= 20)  return 'rocket'
  if (chg7d != null && chg7d <= -20) return 'crash'
  if (ath != null && market > 0 && market >= ath * 0.97) return 'ath'
  if (chg30d != null && chg30d >= 12) return 'hot'
  if (chg30d != null && chg30d <= -12) return 'cooling'
  return null
}

function SignalBadge({ signal }: { signal: Signal }) {
  if (!signal) return null
  const map: Record<Exclude<Signal, null>, { icon: string; label: string; cls: string }> = {
    rocket:  { icon: '🚀', label: '+7d surge',   cls: 'bg-emerald-500/20 border-emerald-500/40 text-emerald-300' },
    crash:   { icon: '📉', label: '-7d drop',    cls: 'bg-red-500/20    border-red-500/40    text-red-300'     },
    ath:     { icon: '👑', label: 'Near ATH',    cls: 'bg-amber-500/20  border-amber-500/40  text-amber-300'   },
    hot:     { icon: '🔥', label: '+30d hot',    cls: 'bg-orange-500/20 border-orange-500/40 text-orange-300'  },
    cooling: { icon: '❄️', label: '-30d cool',   cls: 'bg-blue-500/20   border-blue-500/40   text-blue-300'    },
  }
  const { icon, label, cls } = map[signal]
  return (
    <span className={`inline-flex items-center gap-0.5 text-[9px] font-bold px-1.5 py-0.5 rounded-full border ${cls} whitespace-nowrap`}>
      {icon} {label}
    </span>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default async function MarketPage() {
  const supabase = await createClient()

  // Fetch the full catalog (no created_at bias — all cards, large limit)
  // Order by catalog_id to get a stable, unbiased full-catalog sample
  const { data: rawCards } = await supabase
    .from('card_catalog_items')
    .select('catalog_id, card_name, set_name, card_number, canonical_image_url, metadata_json, franchise_or_brand, year')
    .limit(10000)

  // ── Process ───────────────────────────────────────────────────────────────
  const now = Date.now()
  const ms7d  = now - 7  * 86_400_000
  const ms30d = now - 30 * 86_400_000

  type CardRow = {
    catalog_id:  string
    card_name:   string
    set_name:    string
    card_number: string | null
    image_url:   string | null
    franchise:   string
    year:        number | null
    market:      number
    mid:         number | null
    chg7d:       number | null   // real 7-day % change from history
    chg30d:      number | null   // real 30-day % change from history
    ath:         number | null
    signal:      Signal
    sparkPoints: number[]
  }

  const processed: CardRow[] = (rawCards ?? [])
    .map((c: any) => {
      const p = extractTcgPrice(c.metadata_json)
      if (!p) return null

      const history = extractHistory(c.metadata_json)
      const price7d  = closestPrice(history, ms7d,  3)
      const price30d = closestPrice(history, ms30d, 5)

      const chg7d  = price7d  != null && price7d  > 0 ? ((p.market - price7d)  / price7d  * 100) : null
      const chg30d = price30d != null && price30d > 0 ? ((p.market - price30d) / price30d * 100) : null

      let ath: number | null = null
      for (const pt of history) {
        if (ath === null || pt.price > ath) ath = pt.price
      }

      const signal = computeSignal(chg7d, chg30d, p.market, ath)

      return {
        catalog_id:  c.catalog_id  as string,
        card_name:   String(c.card_name ?? '') as string,
        set_name:    c.set_name    as string,
        card_number: c.card_number as string | null,
        image_url:   c.canonical_image_url as string | null,
        franchise:   (c.franchise_or_brand ?? 'Pokémon') as string,
        year:        c.year as number | null,
        market:      p.market,
        mid:         p.mid,
        chg7d,
        chg30d,
        ath,
        signal,
        sparkPoints: history.slice(-30).map(h => h.price),
      } as CardRow
    })
    .filter(Boolean) as CardRow[]

  // Deduplicate: keep highest-priced version per unique card name
  const seenNames = new Map<string, CardRow>()
  for (const card of processed) {
    const key = card.card_name.toLowerCase().trim()
    if (!key) continue // skip rows with no name rather than crashing/grouping them
    const existing = seenNames.get(key)
    if (!existing || card.market > existing.market) {
      seenNames.set(key, card)
    }
  }
  const deduplicated = Array.from(seenNames.values())

  // Top 100 by market price
  const top100 = [...deduplicated]
    .sort((a, b) => b.market - a.market)
    .slice(0, 100)

  // ── Index stats ───────────────────────────────────────────────────────────
  const indexValue = top100.reduce((s, c) => s + c.market, 0)
  const avgPrice   = indexValue / (top100.length || 1)

  // Use real 30d changes for the index direction (fall back to 7d if needed)
  const cardsWithChg30d  = top100.filter(c => c.chg30d != null)
  const cardsWithChg7d   = top100.filter(c => c.chg7d  != null)
  const indexChg30d      = cardsWithChg30d.length > 0
    ? cardsWithChg30d.reduce((s, c) => s + (c.chg30d ?? 0), 0) / cardsWithChg30d.length
    : null
  const indexChg7d       = cardsWithChg7d.length > 0
    ? cardsWithChg7d.reduce((s, c) => s + (c.chg7d ?? 0), 0) / cardsWithChg7d.length
    : null
  const indexChg = indexChg30d ?? indexChg7d ?? 0

  const gainers30d = top100.filter(c => (c.chg30d ?? 0) > 2)
  const losers30d  = top100.filter(c => (c.chg30d ?? 0) < -2)

  // Notable movers — cards with real historical change data
  const notable = top100.filter(c => c.signal !== null)
  const topGainers = [...deduplicated]
    .filter(c => c.chg30d != null)
    .sort((a, b) => (b.chg30d ?? 0) - (a.chg30d ?? 0))
    .slice(0, 5)
  const topLosers = [...deduplicated]
    .filter(c => c.chg30d != null)
    .sort((a, b) => (a.chg30d ?? 0) - (b.chg30d ?? 0))
    .slice(0, 5)

  const isUp = indexChg >= 0

  return (
    <div className="space-y-5 pb-12 max-w-[1400px]">

      {/* ══ Index header ═════════════════════════════════════════════════════ */}
      <div
        className="relative overflow-hidden rounded-2xl px-6 py-5"
        style={{
          background: 'linear-gradient(135deg, #080c10 0%, #0c1220 50%, #080c10 100%)',
          border: '1px solid rgba(255,255,255,0.06)',
        }}
      >
        <div
          aria-hidden className="pointer-events-none absolute inset-0 opacity-[0.025]"
          style={{
            backgroundImage: 'linear-gradient(rgba(255,255,255,1) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,1) 1px, transparent 1px)',
            backgroundSize: '32px 32px',
          }}
        />
        <div aria-hidden className="pointer-events-none absolute -top-12 -right-12 h-48 w-48 rounded-full opacity-15 blur-3xl"
          style={{ background: 'radial-gradient(circle, #f59e0b 0%, transparent 70%)' }} />

        <div className="relative flex flex-wrap items-start justify-between gap-6">
          {/* Index value */}
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className={`flex h-1.5 w-1.5 rounded-full shrink-0 ${isUp ? 'bg-emerald-400 shadow-[0_0_6px_#4ade80]' : 'bg-red-400 shadow-[0_0_6px_#f87171]'}`} />
              <span className="text-[10px] font-bold uppercase tracking-widest text-white/30">
                SDX 100 · The ScanDex Index · Top 100 by TCGPlayer Market
              </span>
            </div>

            <div className="flex items-end gap-4">
              <div>
                <p className="text-4xl font-black tabular-nums tracking-tight"
                  style={{
                    background: 'linear-gradient(90deg, #e2e8f0 0%, #94a3b8 60%, #f59e0b 100%)',
                    WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text',
                  }}>
                  <AnimatedNumber value={indexValue} format="usdCompact" duration={1100} />
                </p>
                <p className="text-[10px] text-white/25 mt-1">Composite market value of top 100 cards</p>
              </div>
              {indexChg30d != null || indexChg7d != null ? (
                <div className={`flex flex-col items-end pb-1 ${isUp ? 'text-emerald-400' : 'text-red-400'}`}>
                  <div className="flex items-center gap-1 text-lg font-bold">
                    {isUp ? <ArrowUpRight className="h-5 w-5" /> : <ArrowDownRight className="h-5 w-5" />}
                    {fmtPct(indexChg)}
                  </div>
                  <span className="text-[10px] opacity-50">{indexChg30d != null ? '30d avg' : '7d avg'}</span>
                </div>
              ) : null}
            </div>
          </div>

          {/* Breadth tiles */}
          <div className="flex flex-wrap gap-3">
            {[
              { label: 'Total in catalog',  value: processed.length.toLocaleString(),   sub: 'priced cards',    color: 'text-white/70'   },
              { label: 'In top 100',        value: top100.length.toString(),             sub: 'unique by name',  color: 'text-amber-300'  },
              { label: 'Avg price',         value: fmtUsd(avgPrice),                    sub: 'top 100',         color: 'text-amber-300'  },
              { label: 'Up 30d',            value: gainers30d.length.toString(),         sub: 'in top 100',      color: 'text-emerald-300'},
              { label: 'Down 30d',          value: losers30d.length.toString(),          sub: 'in top 100',      color: 'text-red-400'    },
              { label: 'Signals',           value: notable.length.toString(),            sub: 'notable moves',   color: 'text-orange-300' },
            ].map(({ label, value, sub, color }) => (
              <div key={label} className="min-w-[100px] rounded-xl border border-white/8 bg-white/[0.04] px-3 py-2.5">
                <p className="text-[9px] uppercase tracking-widest text-white/20 font-semibold mb-1">{label}</p>
                <p className={`text-lg font-black tabular-nums ${color}`}>{value}</p>
                <p className="text-[9px] text-white/20 mt-0.5">{sub}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ══ Notable signals strip (if any) ════════════════════════════════════ */}
      {notable.length > 0 && (
        <div className="rounded-xl border border-orange-500/20 overflow-hidden" style={{ background: 'rgba(20,10,5,0.9)' }}>
          <div className="flex items-center gap-2 px-4 py-2 border-b border-orange-500/10">
            <Flame className="h-3.5 w-3.5 text-orange-400/60" />
            <span className="text-[10px] font-bold uppercase tracking-widest text-orange-400/40">
              Notable Moves · Cards with significant price signals
            </span>
          </div>
          <div className="flex flex-wrap gap-2 p-3">
            {notable.slice(0, 12).map(c => (
              <Link
                key={c.catalog_id}
                href={`/analyze/${c.catalog_id}`}
                className="flex items-center gap-2 px-3 py-2 rounded-lg border border-white/[0.06] bg-white/[0.03] hover:bg-white/[0.06] transition-colors min-w-0"
              >
                {c.image_url
                  ? <Image src={c.image_url} alt={c.card_name} width={18} height={25}
                      className="rounded object-cover shrink-0 opacity-70" unoptimized />
                  : <div className="w-[18px] h-[25px] rounded bg-white/5 shrink-0" />}
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-white/80 truncate max-w-[120px]">{c.card_name}</p>
                  <div className="flex items-center gap-1 mt-0.5">
                    <SignalBadge signal={c.signal} />
                    {c.chg30d != null && (
                      <span className={`text-[9px] font-bold tabular-nums ${c.chg30d >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {fmtPct(c.chg30d)}
                      </span>
                    )}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* ══ Movers row ═══════════════════════════════════════════════════════ */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Top gainers */}
        <div className="rounded-xl border border-emerald-400/12 overflow-hidden" style={{ background: '#080c10' }}>
          <div className="flex items-center gap-2 px-4 py-2.5 border-b border-emerald-400/10">
            <TrendingUp className="h-3.5 w-3.5 text-emerald-400/60" />
            <span className="text-[10px] font-bold uppercase tracking-widest text-emerald-400/40">
              Top Gainers · 30-Day
            </span>
          </div>
          {topGainers.length > 0 ? topGainers.map((c, i) => (
            <Link key={c.catalog_id} href={`/analyze/${c.catalog_id}`}
              className="flex items-center gap-3 px-4 py-2.5 border-b border-white/[0.04] last:border-0 hover:bg-white/[0.025] transition-colors">
              <span className="text-[10px] font-mono text-white/20 w-4">{i + 1}</span>
              {c.image_url
                ? <Image src={c.image_url} alt={c.card_name} width={20} height={28} className="rounded shrink-0 opacity-75" unoptimized />
                : <div className="w-5 h-7 rounded bg-white/5 shrink-0" />}
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-white/80 truncate">{c.card_name}</p>
                <p className="text-[10px] text-white/25 truncate">{c.set_name}</p>
              </div>
              <div className="text-right shrink-0">
                <p className="text-sm font-bold tabular-nums text-white/80">{fmtUsd(c.market)}</p>
                <p className="text-[10px] font-semibold text-emerald-400 tabular-nums">{fmtPct(c.chg30d ?? 0)}</p>
              </div>
            </Link>
          )) : (
            <p className="px-4 py-4 text-xs text-white/20 text-center">Not enough history data yet</p>
          )}
        </div>

        {/* Top losers */}
        <div className="rounded-xl border border-red-400/10 overflow-hidden" style={{ background: '#080c10' }}>
          <div className="flex items-center gap-2 px-4 py-2.5 border-b border-red-400/8">
            <TrendingDown className="h-3.5 w-3.5 text-red-400/60" />
            <span className="text-[10px] font-bold uppercase tracking-widest text-red-400/40">
              Top Decliners · 30-Day
            </span>
          </div>
          {topLosers.length > 0 ? topLosers.map((c, i) => (
            <Link key={c.catalog_id} href={`/analyze/${c.catalog_id}`}
              className="flex items-center gap-3 px-4 py-2.5 border-b border-white/[0.04] last:border-0 hover:bg-white/[0.025] transition-colors">
              <span className="text-[10px] font-mono text-white/20 w-4">{i + 1}</span>
              {c.image_url
                ? <Image src={c.image_url} alt={c.card_name} width={20} height={28} className="rounded shrink-0 opacity-75" unoptimized />
                : <div className="w-5 h-7 rounded bg-white/5 shrink-0" />}
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-white/80 truncate">{c.card_name}</p>
                <p className="text-[10px] text-white/25 truncate">{c.set_name}</p>
              </div>
              <div className="text-right shrink-0">
                <p className="text-sm font-bold tabular-nums text-white/80">{fmtUsd(c.market)}</p>
                <p className="text-[10px] font-semibold text-red-400 tabular-nums">{fmtPct(c.chg30d ?? 0)}</p>
              </div>
            </Link>
          )) : (
            <p className="px-4 py-4 text-xs text-white/20 text-center">Not enough history data yet</p>
          )}
        </div>
      </div>

      {/* ══ SDX 100 Full Table ═══════════════════════════════════════════════ */}
      <div className="rounded-xl border border-white/8 overflow-hidden" style={{ background: '#080c10' }}>
        {/* Table header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/[0.06]">
          <div className="flex items-center gap-2">
            <BarChart2 className="h-3.5 w-3.5 text-amber-400/60" />
            <span className="text-[10px] font-bold uppercase tracking-widest text-white/30">SDX 100 · Full Index</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-white/15 flex items-center gap-1">
              <Clock className="h-3 w-3" /> Sorted by TCGPlayer market price · entire catalog
            </span>
          </div>
        </div>

        {/* Column headers */}
        <div
          className="grid px-4 py-2 border-b border-white/[0.04] text-[9px] uppercase tracking-widest text-white/20 font-semibold"
          style={{ gridTemplateColumns: '32px 1fr 70px 90px 80px 80px 90px' }}
        >
          <span>#</span>
          <span>Card</span>
          <span>Trend</span>
          <span className="text-right">Market</span>
          <span className="text-right">7d</span>
          <span className="text-right">30d</span>
          <span>Signal</span>
        </div>

        {top100.map((c, idx) => {
          const up7   = (c.chg7d  ?? 0) > 1
          const down7 = (c.chg7d  ?? 0) < -1
          const up30  = (c.chg30d ?? 0) > 1
          const down30 = (c.chg30d ?? 0) < -1
          return (
            <Link
              key={c.catalog_id}
              href={`/analyze/${c.catalog_id}`}
              className="grid px-4 py-2.5 border-b border-white/[0.03] last:border-0 hover:bg-white/[0.025] transition-colors items-center group"
              style={{ gridTemplateColumns: '32px 1fr 70px 90px 80px 80px 90px' }}
            >
              {/* Rank */}
              <span className="text-[11px] font-mono text-white/20">{idx + 1}</span>

              {/* Card identity */}
              <div className="flex items-center gap-2.5 min-w-0">
                {c.image_url ? (
                  <Image src={c.image_url} alt={c.card_name} width={18} height={25}
                    className="rounded object-cover shrink-0 opacity-70 group-hover:opacity-90 transition-opacity" unoptimized />
                ) : (
                  <div className="w-[18px] h-[25px] rounded bg-white/5 shrink-0" />
                )}
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-white/80 truncate leading-tight">{c.card_name}</p>
                  <p className="text-[10px] text-white/25 truncate leading-tight">
                    {c.set_name}{c.card_number ? ` · #${c.card_number}` : ''}
                  </p>
                </div>
              </div>

              {/* Sparkline */}
              <div className="flex items-center">
                {c.sparkPoints.length >= 2
                  ? <Sparkline points={c.sparkPoints} width={56} height={22} />
                  : <span className="text-[10px] text-white/10">—</span>
                }
              </div>

              {/* Market price */}
              <p className="text-sm font-bold tabular-nums text-right text-white/90">{fmtUsd(c.market)}</p>

              {/* 7d change */}
              <div className="flex items-center justify-end gap-0.5">
                {c.chg7d != null ? (
                  <>
                    {up7   ? <ArrowUpRight   className="h-3 w-3 text-emerald-400 shrink-0" />
                    : down7 ? <ArrowDownRight className="h-3 w-3 text-red-400    shrink-0" />
                    : <Minus className="h-3 w-3 text-white/15 shrink-0" />}
                    <span className={`text-[11px] font-medium tabular-nums ${up7 ? 'text-emerald-400' : down7 ? 'text-red-400' : 'text-white/20'}`}>
                      {fmtPct(c.chg7d)}
                    </span>
                  </>
                ) : <span className="text-[10px] text-white/10">—</span>}
              </div>

              {/* 30d change */}
              <div className="flex items-center justify-end gap-0.5">
                {c.chg30d != null ? (
                  <>
                    {up30   ? <ArrowUpRight   className="h-3 w-3 text-emerald-400 shrink-0" />
                    : down30 ? <ArrowDownRight className="h-3 w-3 text-red-400    shrink-0" />
                    : <Minus className="h-3 w-3 text-white/15 shrink-0" />}
                    <span className={`text-[11px] font-medium tabular-nums ${up30 ? 'text-emerald-400' : down30 ? 'text-red-400' : 'text-white/20'}`}>
                      {fmtPct(c.chg30d)}
                    </span>
                  </>
                ) : <span className="text-[10px] text-white/10">—</span>}
              </div>

              {/* Signal badge */}
              <div>
                <SignalBadge signal={c.signal} />
              </div>
            </Link>
          )
        })}

        {top100.length === 0 && (
          <div className="px-4 py-12 text-center">
            <BarChart2 className="h-8 w-8 text-white/10 mx-auto mb-3" />
            <p className="text-sm text-white/30">No priced cards in the catalog yet</p>
            <p className="text-xs text-white/15 mt-1">Search and analyze cards to populate the index</p>
            <Link href="/analyze" className="inline-flex items-center gap-1.5 mt-4 text-xs text-indigo-400 hover:text-indigo-300 transition-colors">
              <Search className="h-3.5 w-3.5" /> Analyze your first card
            </Link>
          </div>
        )}
      </div>

      {/* ── Footer note ─────────────────────────────────────────────────────── */}
      <p className="text-[10px] text-white/15 text-center">
        SDX 100 — top 100 unique cards by TCGPlayer market price · drawn from the entire catalog ({processed.length.toLocaleString()} priced cards) ·
        one entry per card name (highest-priced variant shown) ·
        7d / 30d changes use real price history from tcg_history ·
        signals: 🚀 +20% in 7d · 📉 −20% in 7d · 👑 near ATH · 🔥 +12% in 30d · ❄️ −12% in 30d
      </p>
    </div>
  )
}
