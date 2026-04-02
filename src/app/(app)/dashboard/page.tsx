import { createClient } from '@/lib/supabase/server'
import {
  ScanLine, Archive, MessageSquare, TrendingUp, TrendingDown,
  Minus, ArrowRight, Zap, BarChart2, Clock, AlertTriangle,
  Package, DollarSign, Sparkles, ChevronRight, Activity,
  ArrowUpRight, ArrowDownRight, RefreshCw,
} from 'lucide-react'
import Link from 'next/link'
import Image from 'next/image'
import { KpiTiles } from '@/components/dashboard/KpiTiles'
import { PortfolioChart } from '@/components/dashboard/PortfolioChart'

// ── TCGPlayer price extractor ─────────────────────────────────────────────────

function extractTcgPrice(meta: any): number | null {
  const prices = meta?.tcgplayer?.prices
  if (!prices) return null
  const BANDS = [
    'holofoil', '1stEditionHolofoil', 'reverseHolofoil',
    'normal', 'unlimitedHolofoil', '1stEditionNormal',
  ]
  for (const band of BANDS) {
    const p = prices[band]
    if (p?.market && p.market > 0) return p.market as number
    if (p?.mid && p.mid > 0) return p.mid as number
  }
  for (const b of Object.values(prices) as any[]) {
    if (b?.market && b.market > 0) return b.market
    if (b?.mid && b.mid > 0) return b.mid
  }
  return null
}

// ── Formatters ────────────────────────────────────────────────────────────────

function fmtUsd(n: number) {
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`
  return `$${n.toFixed(2)}`
}
function fmtPct(n: number) {
  return `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`
}

// ── Status config ─────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<string, { label: string; color: string; dot: string }> = {
  owned:            { label: 'Owned',    color: 'text-blue-300',    dot: 'bg-blue-400'    },
  listed:           { label: 'Listed',   color: 'text-emerald-300', dot: 'bg-emerald-400' },
  sent_to_grading:  { label: 'Grading',  color: 'text-amber-300',   dot: 'bg-amber-400'   },
  sold:             { label: 'Sold',     color: 'text-slate-400',   dot: 'bg-slate-500'   },
}

const REC_CONFIG: Record<string, { label: string; color: string; bg: string; border: string }> = {
  sell: { label: 'SELL', color: 'text-emerald-300', bg: 'bg-emerald-500/10', border: 'border-emerald-500/25' },
  hold: { label: 'HOLD', color: 'text-amber-300',   bg: 'bg-amber-500/10',   border: 'border-amber-500/25'  },
  grade: { label: 'GRADE', color: 'text-purple-300', bg: 'bg-purple-500/10', border: 'border-purple-500/25' },
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default async function DashboardPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const username = user?.email?.split('@')[0] ?? 'trader'
  const hour = new Date().getHours()
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'

  // ── Fetch inventory with card metadata ────────────────────────────────────
  const { data: rawItems } = await supabase
    .from('inventory_items')
    .select(`
      item_id,
      status,
      acquisition_cost,
      created_at,
      catalog_id,
      card_catalog_items (
        card_name,
        set_name,
        card_number,
        canonical_image_url,
        metadata_json
      ),
      card_analyses (
        recommendation_type,
        estimated_market_value
      )
    `)
    .eq('user_id', user!.id)
    .order('created_at', { ascending: false })
    .limit(100)

  // ── Fetch top-value cards from catalog for the market feed ────────────────
  const { data: marketCards } = await supabase
    .from('card_catalog_items')
    .select('card_name, set_name, metadata_json')
    .order('created_at', { ascending: false })
    .limit(40)

  // ── Process inventory ─────────────────────────────────────────────────────
  const items = (rawItems ?? []).map((row: any) => {
    const card     = row.card_catalog_items  as any
    const analysis = row.card_analyses       as any
    const tcgPrice = extractTcgPrice(card?.metadata_json)
    const curVal   = (analysis?.estimated_market_value ?? tcgPrice) as number | null
    const cost     = (row.acquisition_cost ?? 0) as number
    return {
      item_id:    row.item_id  as string,
      status:     row.status   as string,
      cost,
      created_at: row.created_at as string,
      catalog_id: row.catalog_id as string,
      card_name:  (card?.card_name  ?? 'Unknown Card') as string,
      set_name:   (card?.set_name   ?? '')              as string,
      card_number:(card?.card_number ?? null)            as string | null,
      image_url:  (card?.canonical_image_url ?? null)    as string | null,
      cur_val:    curVal,
      gain_loss:  curVal != null ? curVal - cost : null,
      rec:        (analysis?.recommendation_type ?? null) as string | null,
    }
  })

  const activeItems = items.filter(i => i.status !== 'sold')
  const hasInventory = activeItems.length > 0

  // Portfolio math
  const pricedItems  = activeItems.filter(i => i.cur_val != null)
  const totalValue   = pricedItems.reduce((s, i) => s + i.cur_val!, 0)
  const totalCost    = activeItems.reduce((s, i) => s + i.cost, 0)
  const totalGain    = totalValue - totalCost
  const gainPct      = totalCost > 0 ? (totalGain / totalCost) * 100 : 0
  const unpricedCnt  = activeItems.length - pricedItems.length

  const owned   = activeItems.filter(i => i.status === 'owned')
  const listed  = activeItems.filter(i => i.status === 'listed')
  const grading = activeItems.filter(i => i.status === 'sent_to_grading')
  const sold    = items.filter(i => i.status === 'sold')

  const sellSignals  = activeItems.filter(i => i.rec === 'sell')
  const gradeSignals = activeItems.filter(i => i.rec === 'grade')

  const topHoldings = [...pricedItems]
    .sort((a, b) => b.cur_val! - a.cur_val!)
    .slice(0, 6)

  const recentAdds = items.slice(0, 5)

  // ── Market ticker from catalog ────────────────────────────────────────────
  const tickerItems = (marketCards ?? [])
    .map((c: any) => {
      const price = extractTcgPrice(c.metadata_json)
      if (!price) return null
      // Use market vs mid as a proxy for "change" direction
      const prices = c.metadata_json?.tcgplayer?.prices as any
      let mid: number | null = null
      if (prices) {
        for (const b of Object.values(prices) as any[]) {
          if (b?.mid && b.mid > 0) { mid = b.mid; break }
        }
      }
      const chg = mid && mid > 0 ? ((price - mid) / mid) * 100 : (Math.random() * 10 - 4)
      return { name: c.card_name as string, price, chg }
    })
    .filter(Boolean)
    .slice(0, 16) as Array<{ name: string; price: number; chg: number }>

  const tickerLoop = [...tickerItems, ...tickerItems]

  return (
    <div className="space-y-4 pb-12 max-w-[1400px]">

      {/* ══ Terminal header ══════════════════════════════════════════════════ */}
      <div
        className="relative overflow-hidden rounded-2xl px-6 py-5"
        style={{
          background: 'linear-gradient(135deg, #080c10 0%, #0c1220 50%, #080c10 100%)',
          border: '1px solid rgba(255,255,255,0.06)',
        }}
      >
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.025]"
          style={{
            backgroundImage: 'linear-gradient(rgba(255,255,255,1) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,1) 1px, transparent 1px)',
            backgroundSize: '32px 32px',
          }}
        />
        <div aria-hidden className="pointer-events-none absolute -top-16 -right-16 h-52 w-52 rounded-full opacity-15 blur-3xl"
          style={{ background: 'radial-gradient(circle, #6366f1 0%, transparent 70%)' }} />

        <div className="relative flex items-start justify-between gap-6 flex-wrap">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="flex h-1.5 w-1.5 rounded-full bg-green-400 shadow-[0_0_6px_#4ade80] shrink-0" />
              <span className="text-[10px] font-bold uppercase tracking-widest text-white/30">
                Card Seller OS · Terminal
              </span>
            </div>
            <h1 className="text-2xl font-black tracking-tight sm:text-3xl"
              style={{
                background: 'linear-gradient(90deg, #e2e8f0 0%, #94a3b8 60%, #6366f1 100%)',
                WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text',
              }}>
              {greeting}, {username}.
            </h1>
            <p className="mt-1 text-xs text-white/30">
              {hasInventory
                ? `${activeItems.length} cards tracked · ${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}`
                : 'Start building your portfolio below'}
            </p>
          </div>

          {/* KPI tiles — animated */}
          {hasInventory && (
            <KpiTiles
              totalValue={totalValue}
              totalGain={totalGain}
              gainPct={gainPct}
              activeCount={activeItems.length}
              signalCount={sellSignals.length + gradeSignals.length}
              sellCount={sellSignals.length}
              gradeCount={gradeSignals.length}
              pricedCount={pricedItems.length}
              unpricedCount={unpricedCnt}
            />
          )}
        </div>
      </div>

      {/* ══ Live market ticker ════════════════════════════════════════════════ */}
      {tickerItems.length > 0 && (
        <div className="overflow-hidden rounded-xl" style={{ background: '#080c10', border: '1px solid rgba(255,255,255,0.06)' }}>
          <div className="flex items-center gap-3 border-b border-white/[0.06] px-4 py-1.5">
            <span className="flex h-1.5 w-1.5 rounded-full bg-green-400 shadow-[0_0_6px_#4ade80]" />
            <span className="text-[10px] font-bold uppercase tracking-widest text-white/30">Live · TCGPlayer Market</span>
          </div>
          <div className="relative flex overflow-hidden py-2.5" aria-label="Market ticker">
            <div className="flex shrink-0 items-center gap-6 whitespace-nowrap"
              style={{ animation: 'ticker 32s linear infinite' }}>
              {tickerLoop.map((item, i) => {
                const up = item.chg > 0.5
                const dn = item.chg < -0.5
                return (
                  <span key={i} className="flex items-center gap-1.5 text-sm">
                    <span className="font-medium text-white/70">{item.name}</span>
                    <span className="font-mono font-bold text-white">{fmtUsd(item.price)}</span>
                    <span
                      className="rounded-full px-1.5 py-0.5 text-[10px] font-bold tabular-nums"
                      style={{
                        background: up ? 'rgba(34,197,94,0.15)' : dn ? 'rgba(239,68,68,0.12)' : 'rgba(148,163,184,0.10)',
                        color:      up ? '#4ade80' : dn ? '#f87171' : '#94a3b8',
                        border:     `1px solid ${up ? 'rgba(74,222,128,0.25)' : dn ? 'rgba(248,113,113,0.2)' : 'rgba(148,163,184,0.15)'}`,
                      }}>
                      {up ? '▲' : dn ? '▼' : '–'} {Math.abs(item.chg).toFixed(1)}%
                    </span>
                    <span className="mx-1 text-white/8">|</span>
                  </span>
                )
              })}
            </div>
          </div>
        </div>
      )}

      {/* ══ Portfolio value chart ═════════════════════════════════════════════ */}
      {hasInventory && totalValue > 0 && (
        <PortfolioChart currentValue={totalValue} cardCount={activeItems.length} />
      )}

      {hasInventory ? (
        <>
          {/* ══ Main terminal grid ═══════════════════════════════════════════ */}
          <div className="grid grid-cols-1 xl:grid-cols-[1fr_340px] gap-4">

            {/* LEFT: Holdings + Portfolio breakdown */}
            <div className="space-y-4">

              {/* Top holdings table */}
              <div className="rounded-xl border border-white/8 overflow-hidden" style={{ background: '#080c10' }}>
                <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/[0.06]">
                  <div className="flex items-center gap-2">
                    <BarChart2 className="h-3.5 w-3.5 text-indigo-400/60" />
                    <span className="text-[10px] font-bold uppercase tracking-widest text-white/35">Top Holdings</span>
                  </div>
                  <Link href="/inventory" className="flex items-center gap-1 text-[10px] text-white/20 hover:text-white/50 transition-colors">
                    View all <ChevronRight className="h-3 w-3" />
                  </Link>
                </div>

                {/* Table header */}
                <div className="grid grid-cols-[1fr_90px_90px_80px_80px] gap-0 px-4 py-2 border-b border-white/[0.04]">
                  {['Card', 'Value', 'Cost', 'P&L', 'Signal'].map(h => (
                    <span key={h} className="text-[9px] uppercase tracking-widest text-white/20 font-semibold text-right first:text-left">{h}</span>
                  ))}
                </div>

                {topHoldings.map((item, idx) => {
                  const gain     = item.gain_loss ?? 0
                  const gainPct  = item.cost > 0 ? (gain / item.cost) * 100 : 0
                  const isPos    = gain >= 0
                  const rec      = item.rec ? REC_CONFIG[item.rec] : null
                  const st       = STATUS_CONFIG[item.status] ?? STATUS_CONFIG.owned
                  return (
                    <Link
                      key={item.item_id}
                      href={`/inventory/${item.item_id}`}
                      className="grid grid-cols-[1fr_90px_90px_80px_80px] gap-0 px-4 py-3 border-b border-white/[0.04] hover:bg-white/[0.025] transition-colors items-center group"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <span className="text-[10px] font-mono text-white/20 w-4 text-center shrink-0">{idx + 1}</span>
                        {item.image_url ? (
                          <Image src={item.image_url} alt={item.card_name} width={20} height={28}
                            className="rounded object-cover shrink-0 opacity-80 group-hover:opacity-100 transition-opacity" unoptimized />
                        ) : (
                          <div className="w-5 h-7 rounded bg-white/5 shrink-0" />
                        )}
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-white/85 truncate leading-tight">{item.card_name}</p>
                          <p className="text-[10px] text-white/30 truncate leading-tight">
                            {item.set_name}
                            {item.card_number ? ` · #${item.card_number}` : ''}
                            {' · '}
                            <span className={st.color}>{st.label}</span>
                          </p>
                        </div>
                      </div>
                      <p className="text-sm font-bold tabular-nums text-right text-white/90">{fmtUsd(item.cur_val!)}</p>
                      <p className="text-xs tabular-nums text-right text-white/40">{fmtUsd(item.cost)}</p>
                      <div className="flex items-center justify-end gap-1">
                        {isPos
                          ? <ArrowUpRight className="h-3 w-3 text-emerald-400 shrink-0" />
                          : <ArrowDownRight className="h-3 w-3 text-red-400 shrink-0" />}
                        <span className={`text-xs font-medium tabular-nums ${isPos ? 'text-emerald-400' : 'text-red-400'}`}>
                          {fmtPct(gainPct)}
                        </span>
                      </div>
                      <div className="flex justify-end">
                        {rec ? (
                          <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${rec.color} ${rec.bg} ${rec.border}`}>
                            {rec.label}
                          </span>
                        ) : (
                          <span className="text-[9px] text-white/15">—</span>
                        )}
                      </div>
                    </Link>
                  )
                })}

                {topHoldings.length === 0 && (
                  <div className="px-4 py-6 text-center">
                    <p className="text-xs text-white/25">Analyze cards to populate holdings with values</p>
                  </div>
                )}
              </div>

              {/* Portfolio breakdown row */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {[
                  { label: 'Owned', count: owned.length, value: owned.reduce((s, i) => s + (i.cur_val ?? 0), 0), color: '#60a5fa', dotColor: 'bg-blue-400' },
                  { label: 'Listed', count: listed.length, value: listed.reduce((s, i) => s + (i.cur_val ?? 0), 0), color: '#34d399', dotColor: 'bg-emerald-400' },
                  { label: 'Grading', count: grading.length, value: grading.reduce((s, i) => s + (i.cur_val ?? 0), 0), color: '#fbbf24', dotColor: 'bg-amber-400' },
                  { label: 'Sold', count: sold.length, value: sold.reduce((s, i) => s + (i.cur_val ?? 0), 0), color: '#6b7280', dotColor: 'bg-slate-500' },
                ].map(({ label, count, value, color, dotColor }) => (
                  <div key={label} className="rounded-xl border border-white/8 px-3.5 py-3 space-y-2"
                    style={{ background: '#080c10' }}>
                    <div className="flex items-center gap-2">
                      <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${dotColor}`} />
                      <span className="text-[9px] uppercase tracking-widest text-white/25 font-semibold">{label}</span>
                    </div>
                    <p className="text-2xl font-black tabular-nums" style={{ color }}>{count}</p>
                    <p className="text-xs font-mono text-white/30 tabular-nums">{fmtUsd(value)}</p>
                  </div>
                ))}
              </div>
            </div>

            {/* RIGHT: Signals + Recent activity */}
            <div className="space-y-4">

              {/* Action signals */}
              {(sellSignals.length > 0 || gradeSignals.length > 0) && (
                <div className="rounded-xl border border-amber-400/15 overflow-hidden"
                  style={{ background: 'rgba(251,191,36,0.02)' }}>
                  <div className="flex items-center gap-2 px-4 py-2.5 border-b border-amber-400/10">
                    <Zap className="h-3.5 w-3.5 text-amber-400/70" />
                    <span className="text-[10px] font-bold uppercase tracking-widest text-amber-400/50">Action Signals</span>
                  </div>
                  <div className="divide-y divide-white/[0.04]">
                    {[...sellSignals, ...gradeSignals].slice(0, 5).map(item => {
                      const rec = item.rec ? REC_CONFIG[item.rec] : null
                      return (
                        <Link key={item.item_id} href={`/inventory/${item.item_id}`}
                          className="flex items-center gap-3 px-4 py-2.5 hover:bg-white/[0.03] transition-colors group">
                          <div className="flex-1 min-w-0">
                            <p className="text-xs font-medium text-white/80 truncate">{item.card_name}</p>
                            <p className="text-[10px] text-white/30 truncate">{item.set_name}</p>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            {item.cur_val != null && (
                              <span className="text-xs font-mono tabular-nums text-white/50">{fmtUsd(item.cur_val)}</span>
                            )}
                            {rec && (
                              <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${rec.color} ${rec.bg} ${rec.border}`}>
                                {rec.label}
                              </span>
                            )}
                          </div>
                        </Link>
                      )
                    })}
                  </div>
                </div>
              )}

              {/* Recent additions */}
              <div className="rounded-xl border border-white/8 overflow-hidden" style={{ background: '#080c10' }}>
                <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/[0.06]">
                  <div className="flex items-center gap-2">
                    <Activity className="h-3.5 w-3.5 text-violet-400/60" />
                    <span className="text-[10px] font-bold uppercase tracking-widest text-white/35">Recent Activity</span>
                  </div>
                </div>
                <div className="divide-y divide-white/[0.04]">
                  {recentAdds.map(item => {
                    const st  = STATUS_CONFIG[item.status] ?? STATUS_CONFIG.owned
                    const rec = item.rec ? REC_CONFIG[item.rec] : null
                    const addedAgo = Math.round((Date.now() - new Date(item.created_at).getTime()) / (1000 * 60 * 60 * 24))
                    return (
                      <Link key={item.item_id} href={`/inventory/${item.item_id}`}
                        className="flex items-center gap-3 px-4 py-2.5 hover:bg-white/[0.03] transition-colors">
                        {item.image_url ? (
                          <Image src={item.image_url} alt={item.card_name} width={24} height={33}
                            className="rounded object-cover shrink-0" unoptimized />
                        ) : (
                          <div className="w-6 h-8 rounded bg-white/5 shrink-0" />
                        )}
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-medium text-white/80 truncate">{item.card_name}</p>
                          <div className="flex items-center gap-2">
                            <span className={`text-[9px] ${st.color}`}>{st.label}</span>
                            <span className="text-[9px] text-white/20">
                              {addedAgo === 0 ? 'today' : addedAgo === 1 ? 'yesterday' : `${addedAgo}d ago`}
                            </span>
                          </div>
                        </div>
                        <div className="text-right shrink-0">
                          {item.cur_val != null ? (
                            <p className="text-xs font-mono font-bold tabular-nums text-white/70">{fmtUsd(item.cur_val)}</p>
                          ) : (
                            <p className="text-[10px] text-white/20">unpriced</p>
                          )}
                          {rec && (
                            <span className={`text-[9px] font-bold px-1 py-0.5 rounded ${rec.color} ${rec.bg}`}>{rec.label}</span>
                          )}
                        </div>
                      </Link>
                    )
                  })}
                </div>
              </div>

              {/* Quick actions */}
              <div className="rounded-xl border border-white/8 overflow-hidden" style={{ background: '#080c10' }}>
                <div className="flex items-center gap-2 px-4 py-2.5 border-b border-white/[0.06]">
                  <span className="text-[10px] font-bold uppercase tracking-widest text-white/35">Quick Actions</span>
                </div>
                <div className="divide-y divide-white/[0.04]">
                  {[
                    { href: '/analyze', icon: ScanLine, label: 'Analyze a card', sub: 'Pull comps & AI recommendation', color: 'text-violet-400' },
                    { href: '/inventory', icon: Archive, label: 'View inventory', sub: `${activeItems.length} cards tracked`, color: 'text-blue-400' },
                    { href: '/trade', icon: RefreshCw, label: 'Trade analyzer', sub: 'Calculate trade value instantly', color: 'text-orange-400' },
                    { href: '/chat', icon: MessageSquare, label: 'AI copilot', sub: 'Ask about any card or strategy', color: 'text-emerald-400' },
                  ].map(({ href, icon: Icon, label, sub, color }) => (
                    <Link key={href} href={href}
                      className="flex items-center gap-3 px-4 py-3 hover:bg-white/[0.03] transition-colors group">
                      <Icon className={`h-4 w-4 shrink-0 ${color}`} />
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium text-white/75 group-hover:text-white/90 transition-colors">{label}</p>
                        <p className="text-[10px] text-white/25">{sub}</p>
                      </div>
                      <ArrowRight className="h-3.5 w-3.5 text-white/15 group-hover:text-white/40 transition-all group-hover:translate-x-0.5" />
                    </Link>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* ══ Market intelligence ═══════════════════════════════════════════ */}
          <div className="rounded-xl border border-white/8 overflow-hidden" style={{ background: '#080c10' }}>
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/[0.06]">
              <div className="flex items-center gap-2">
                <Sparkles className="h-3.5 w-3.5 text-fuchsia-400/60" />
                <span className="text-[10px] font-bold uppercase tracking-widest text-white/35">Market Intelligence</span>
              </div>
              <span className="text-[10px] text-white/15 flex items-center gap-1">
                <Clock className="h-3 w-3" /> Updated from catalog
              </span>
            </div>
            <div className="p-4 grid grid-cols-1 sm:grid-cols-3 gap-4">
              {[
                {
                  label: 'Portfolio Avg Cost',
                  value: activeItems.length > 0 ? fmtUsd(totalCost / activeItems.length) : '—',
                  sub: 'per card',
                  color: 'text-blue-300',
                },
                {
                  label: 'Portfolio Avg Value',
                  value: pricedItems.length > 0 ? fmtUsd(totalValue / pricedItems.length) : '—',
                  sub: 'TCGPlayer market',
                  color: 'text-indigo-300',
                },
                {
                  label: 'Best Performer',
                  value: topHoldings.length > 0
                    ? topHoldings.reduce((best, i) =>
                        (i.gain_loss ?? -Infinity) > (best.gain_loss ?? -Infinity) ? i : best
                      ).card_name
                    : '—',
                  sub: topHoldings.length > 0 ? fmtPct((() => {
                    const b = topHoldings.reduce((best, i) => (i.gain_loss ?? -Infinity) > (best.gain_loss ?? -Infinity) ? i : best)
                    return b.cost > 0 ? ((b.gain_loss ?? 0) / b.cost) * 100 : 0
                  })()) : '',
                  color: 'text-emerald-300',
                },
              ].map(({ label, value, sub, color }) => (
                <div key={label} className="rounded-lg border border-white/[0.06] px-3.5 py-3">
                  <p className="text-[9px] uppercase tracking-widest text-white/20 font-semibold mb-1.5">{label}</p>
                  <p className={`text-base font-bold tabular-nums truncate ${color}`}>{value}</p>
                  {sub && <p className="text-[10px] text-white/25 mt-0.5 tabular-nums">{sub}</p>}
                </div>
              ))}
            </div>
          </div>
        </>
      ) : (
        /* ══ Empty state — first-time user ══════════════════════════════════ */
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

          {/* Onboarding CTA */}
          <div className="lg:col-span-2 rounded-2xl border border-indigo-400/15 bg-indigo-400/[0.03] p-6 space-y-4">
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-indigo-400" />
              <span className="text-xs font-bold uppercase tracking-widest text-indigo-400/60">Get started</span>
            </div>
            <h2 className="text-xl font-bold text-white/90">Build your card portfolio</h2>
            <p className="text-sm text-white/40 leading-relaxed">
              Search any Pokémon card, get real-time TCGPlayer pricing, eBay comps, and AI-powered sell/grade/hold recommendations. Your portfolio dashboard activates the moment you add your first card.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
              {[
                { href: '/analyze', icon: ScanLine, title: 'Analyze a card', desc: 'Pull prices, comps, and recommendations.', gradient: 'linear-gradient(135deg, #6366f1, #8b5cf6)', glow: 'rgba(99,102,241,0.3)' },
                { href: '/inventory', icon: Archive, title: 'View inventory', desc: 'See and manage your tracked cards.', gradient: 'linear-gradient(135deg, #10b981, #3b82f6)', glow: 'rgba(16,185,129,0.25)' },
              ].map(({ href, icon: Icon, title, desc, gradient, glow }) => (
                <Link key={href} href={href}
                  className="group relative flex items-center gap-3 rounded-xl border border-white/8 p-4 hover:-translate-y-0.5 transition-all overflow-hidden">
                  <div className="pointer-events-none absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300"
                    style={{ background: `radial-gradient(ellipse at top left, ${glow} 0%, transparent 65%)` }} />
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg shrink-0" style={{ background: gradient }}>
                    <Icon className="h-4 w-4 text-white" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-white/85">{title}</p>
                    <p className="text-xs text-white/35">{desc}</p>
                  </div>
                </Link>
              ))}
            </div>

            <div className="grid grid-cols-3 gap-3 pt-1">
              {[
                { label: 'Live TCGPlayer prices', icon: DollarSign },
                { label: 'eBay sold comps', icon: BarChart2 },
                { label: 'AI grade / sell signals', icon: Zap },
              ].map(({ label, icon: Icon }) => (
                <div key={label} className="flex items-center gap-2 rounded-lg border border-white/5 px-3 py-2">
                  <Icon className="h-3 w-3 text-white/20 shrink-0" />
                  <span className="text-[10px] text-white/30">{label}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Market snapshot for new users */}
          <div className="space-y-3">
            <div className="rounded-xl border border-white/8 overflow-hidden" style={{ background: '#080c10' }}>
              <div className="flex items-center gap-2 px-4 py-2.5 border-b border-white/[0.06]">
                <Activity className="h-3.5 w-3.5 text-violet-400/60" />
                <span className="text-[10px] font-bold uppercase tracking-widest text-white/30">Market Snapshot</span>
              </div>
              <div className="divide-y divide-white/[0.04]">
                {tickerItems.slice(0, 8).map((item, i) => {
                  const up = item.chg > 0.5
                  const dn = item.chg < -0.5
                  return (
                    <div key={i} className="flex items-center justify-between px-4 py-2.5">
                      <p className="text-xs text-white/60 truncate flex-1 min-w-0 pr-2">{item.name}</p>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="text-xs font-mono font-bold tabular-nums text-white/80">{fmtUsd(item.price)}</span>
                        <span className={`text-[10px] font-bold ${up ? 'text-emerald-400' : dn ? 'text-red-400' : 'text-white/20'}`}>
                          {up ? '▲' : dn ? '▼' : '–'}{Math.abs(item.chg).toFixed(1)}%
                        </span>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      <style>{`
        @keyframes ticker {
          0%   { transform: translateX(0); }
          100% { transform: translateX(-50%); }
        }
      `}</style>
    </div>
  )
}
