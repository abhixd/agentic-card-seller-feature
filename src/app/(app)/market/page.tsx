import { createClient } from '@/lib/supabase/server'
import Link from 'next/link'
import Image from 'next/image'
import {
  TrendingUp, TrendingDown, Minus, BarChart2, Activity,
  Zap, ArrowUpRight, ArrowDownRight, Clock, Search,
} from 'lucide-react'
import { Sparkline } from '@/components/ui/Sparkline'

// ── Shared helpers ────────────────────────────────────────────────────────────

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

function extractSparkPoints(meta: any): number[] {
  const pts: { date: string; price: number }[] = meta?.tcg_history?.points ?? []
  return pts.slice(-30).map((p: any) => p.price)
}

function fmtUsd(n: number) {
  return n >= 1000 ? `$${(n / 1000).toFixed(2)}k` : `$${n.toFixed(2)}`
}
function fmtPct(n: number) {
  return `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default async function MarketPage() {
  const supabase = await createClient()

  // Fetch a large batch of catalog cards — order by created_at (no updated_at column exists)
  // We fetch a large set so the JS-side price filter has enough priced cards to build top-100
  const { data: rawCards } = await supabase
    .from('card_catalog_items')
    .select('catalog_id, card_name, set_name, card_number, canonical_image_url, metadata_json, franchise_or_brand, year')
    .order('created_at', { ascending: false })
    .limit(2000)

  // ── Process: extract price, compute change proxy ──────────────────────────
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
    chgPct:      number    // market vs mid — proxy for recent direction
    updated_at:  string
    sparkPoints: number[]
  }

  const processed: CardRow[] = (rawCards ?? [])
    .map((c: any) => {
      const p = extractTcgPrice(c.metadata_json)
      if (!p) return null
      const chgPct = p.mid && p.mid > 0 ? ((p.market - p.mid) / p.mid) * 100 : 0
      return {
        catalog_id:  c.catalog_id  as string,
        card_name:   c.card_name   as string,
        set_name:    c.set_name    as string,
        card_number: c.card_number as string | null,
        image_url:   c.canonical_image_url as string | null,
        franchise:   (c.franchise_or_brand ?? 'Pokémon') as string,
        year:        c.year as number | null,
        market:      p.market,
        mid:         p.mid,
        chgPct,
        updated_at:  (c.metadata_json?.tcgplayer?.updatedAt ?? '') as string,
        sparkPoints: extractSparkPoints(c.metadata_json),
      } as CardRow
    })
    .filter(Boolean) as CardRow[]

  // Deduplicate: keep only the highest-priced version per unique card name
  // This prevents one Pokémon (e.g. Charizard) from occupying 20+ slots via set variants
  const seenNames = new Map<string, CardRow>()
  for (const card of processed) {
    const key = card.card_name.toLowerCase().trim()
    const existing = seenNames.get(key)
    if (!existing || card.market > existing.market) {
      seenNames.set(key, card)
    }
  }
  const deduplicated = Array.from(seenNames.values())

  // Top 100 by market price across deduplicated unique card names
  const top100 = [...deduplicated]
    .sort((a, b) => b.market - a.market)
    .slice(0, 100)

  // ── Index stats ───────────────────────────────────────────────────────────
  const indexValue      = top100.reduce((s, c) => s + c.market, 0)
  const avgPrice        = indexValue / (top100.length || 1)
  const gainers         = top100.filter(c => c.chgPct > 1)
  const losers          = top100.filter(c => c.chgPct < -1)
  const flat            = top100.filter(c => Math.abs(c.chgPct) <= 1)
  const indexChg        = top100.length > 0
    ? top100.reduce((s, c) => s + c.chgPct, 0) / top100.length : 0

  // Top movers
  const topGainers = [...gainers].sort((a, b) => b.chgPct - a.chgPct).slice(0, 5)
  const topLosers  = [...losers].sort((a, b) => a.chgPct - b.chgPct).slice(0, 5)

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
                CSOI 100 · Card Seller OS Index · Top 100 by TCGPlayer Market
              </span>
            </div>

            <div className="flex items-end gap-4">
              <div>
                <p className="text-4xl font-black tabular-nums tracking-tight"
                  style={{
                    background: 'linear-gradient(90deg, #e2e8f0 0%, #94a3b8 60%, #f59e0b 100%)',
                    WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text',
                  }}>
                  {fmtUsd(indexValue)}
                </p>
                <p className="text-[10px] text-white/25 mt-1">Composite market value of top 100 cards</p>
              </div>
              <div className={`flex flex-col items-end pb-1 ${isUp ? 'text-emerald-400' : 'text-red-400'}`}>
                <div className="flex items-center gap-1 text-lg font-bold">
                  {isUp ? <ArrowUpRight className="h-5 w-5" /> : <ArrowDownRight className="h-5 w-5" />}
                  {fmtPct(indexChg)}
                </div>
                <span className="text-[10px] opacity-50">market vs mid avg</span>
              </div>
            </div>
          </div>

          {/* Breadth tiles */}
          <div className="flex flex-wrap gap-3">
            {[
              { label: 'Cards tracked', value: top100.length.toString(), sub: `of ${processed.length} priced`, color: 'text-white/70' },
              { label: 'Avg price',     value: fmtUsd(avgPrice),         sub: 'top 100 median',               color: 'text-amber-300' },
              { label: 'Advancing',     value: gainers.length.toString(), sub: 'mkt > mid',                  color: 'text-emerald-300' },
              { label: 'Declining',     value: losers.length.toString(),  sub: 'mkt < mid',                  color: 'text-red-400'    },
              { label: 'Unchanged',     value: flat.length.toString(),    sub: '±1%',                        color: 'text-white/30'   },
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

      {/* ══ Movers row ═══════════════════════════════════════════════════════ */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Top gainers */}
        <div className="rounded-xl border border-emerald-400/12 overflow-hidden" style={{ background: '#080c10' }}>
          <div className="flex items-center gap-2 px-4 py-2.5 border-b border-emerald-400/10">
            <TrendingUp className="h-3.5 w-3.5 text-emerald-400/60" />
            <span className="text-[10px] font-bold uppercase tracking-widest text-emerald-400/40">Top Movers · Up</span>
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
                <p className="text-[10px] font-semibold text-emerald-400 tabular-nums">{fmtPct(c.chgPct)}</p>
              </div>
            </Link>
          )) : (
            <p className="px-4 py-4 text-xs text-white/20 text-center">No movers detected</p>
          )}
        </div>

        {/* Top losers */}
        <div className="rounded-xl border border-red-400/10 overflow-hidden" style={{ background: '#080c10' }}>
          <div className="flex items-center gap-2 px-4 py-2.5 border-b border-red-400/8">
            <TrendingDown className="h-3.5 w-3.5 text-red-400/60" />
            <span className="text-[10px] font-bold uppercase tracking-widest text-red-400/40">Top Movers · Down</span>
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
                <p className="text-[10px] font-semibold text-red-400 tabular-nums">{fmtPct(c.chgPct)}</p>
              </div>
            </Link>
          )) : (
            <p className="px-4 py-4 text-xs text-white/20 text-center">No movers detected</p>
          )}
        </div>
      </div>

      {/* ══ CSOI 100 Full Table ═══════════════════════════════════════════════ */}
      <div className="rounded-xl border border-white/8 overflow-hidden" style={{ background: '#080c10' }}>
        {/* Table header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/[0.06]">
          <div className="flex items-center gap-2">
            <BarChart2 className="h-3.5 w-3.5 text-amber-400/60" />
            <span className="text-[10px] font-bold uppercase tracking-widest text-white/30">CSOI 100 · Full Index</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-white/15 flex items-center gap-1">
              <Clock className="h-3 w-3" /> Sorted by TCGPlayer market price
            </span>
          </div>
        </div>

        {/* Column headers */}
        <div
          className="grid px-4 py-2 border-b border-white/[0.04] text-[9px] uppercase tracking-widest text-white/20 font-semibold"
          style={{ gridTemplateColumns: '32px 1fr 70px 100px 100px 80px 70px' }}
        >
          <span>#</span>
          <span>Card</span>
          <span>Trend</span>
          <span className="text-right">Market</span>
          <span className="text-right">Mid</span>
          <span className="text-right">vs Mid</span>
          <span className="text-right">Set Year</span>
        </div>

        {top100.map((c, idx) => {
          const isUp   = c.chgPct > 1
          const isDown = c.chgPct < -1
          return (
            <Link
              key={c.catalog_id}
              href={`/analyze/${c.catalog_id}`}
              className="grid px-4 py-2.5 border-b border-white/[0.03] last:border-0 hover:bg-white/[0.025] transition-colors items-center group"
              style={{ gridTemplateColumns: '32px 1fr 70px 100px 100px 80px 70px' }}
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

              {/* Trend sparkline */}
              <div className="flex items-center">
                {c.sparkPoints.length >= 2
                  ? <Sparkline points={c.sparkPoints} width={56} height={22} />
                  : <span className="text-[10px] text-white/10">—</span>
                }
              </div>

              {/* Market price */}
              <p className="text-sm font-bold tabular-nums text-right text-white/90">{fmtUsd(c.market)}</p>

              {/* Mid price */}
              <p className="text-xs tabular-nums text-right text-white/35">
                {c.mid != null ? fmtUsd(c.mid) : '—'}
              </p>

              {/* vs Mid */}
              <div className="flex items-center justify-end gap-0.5">
                {isUp
                  ? <ArrowUpRight className="h-3 w-3 text-emerald-400 shrink-0" />
                  : isDown
                  ? <ArrowDownRight className="h-3 w-3 text-red-400 shrink-0" />
                  : <Minus className="h-3 w-3 text-white/15 shrink-0" />}
                <span className={`text-[11px] font-medium tabular-nums ${isUp ? 'text-emerald-400' : isDown ? 'text-red-400' : 'text-white/20'}`}>
                  {isUp || isDown ? fmtPct(c.chgPct) : '—'}
                </span>
              </div>

              {/* Year */}
              <p className="text-[10px] tabular-nums text-right text-white/20">{c.year ?? '—'}</p>
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
        CSOI 100 — top 100 unique cards by TCGPlayer market price · one entry per card name (highest-priced variant shown) ·
        &quot;vs Mid&quot; compares market vs TCGPlayer mid price as a momentum proxy ·
        prices update as cards are analyzed · to track true popularity, integrate TCGPlayer Partner API
      </p>
    </div>
  )
}
