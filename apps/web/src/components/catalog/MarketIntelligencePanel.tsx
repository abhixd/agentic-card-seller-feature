'use client'

// Market Consensus Price + Investment Intelligence panel (PRD pillars 1 & 2).
// Self-contained & additive: fetches /api/cards/[catalogId]/intelligence and
// renders it. Remove the single <MarketIntelligencePanel/> usage to roll back.

import { useEffect, useState } from 'react'
import { ChevronDown, ChevronUp, TrendingUp, ShieldAlert, Sparkles, Loader2 } from 'lucide-react'

interface SourceContribution { source: string; price: number; weight: number; n: number }
interface Consensus {
  version: string
  price: number
  range: { low: number; high: number }
  confidence: 'low' | 'medium' | 'high'
  confidenceScore: number
  sources: SourceContribution[]
  outliers: { price: number }[]
  sampleSize: number
}
interface Factor { key: string; label: string; score: number; weight: number; detail: string }
interface ScoreBlock { score: number; label: string; factors: Factor[] }
interface Intelligence {
  card: { card_name: string; set_name: string }
  consensus: { raw: Consensus; graded: Consensus | null }
  scores: {
    opportunity: ScoreBlock
    risk: ScoreBlock
    valuation: string
    valuationDetail: string
    lowData: boolean
  }
  dataSources: string[]
}

const fmt = (n: number) => `$${n.toFixed(2)}`

const CONFIDENCE_STYLE: Record<string, string> = {
  high:   'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  medium: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  low:    'bg-zinc-500/15 text-zinc-400 border-zinc-500/30',
}

const VALUATION_STYLE: Record<string, string> = {
  Undervalued:    'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  'Fairly Valued':'bg-zinc-500/15 text-zinc-300 border-zinc-500/30',
  Overheated:     'bg-red-500/15 text-red-300 border-red-500/30',
}

const SOURCE_LABEL: Record<string, string> = {
  ebay: 'eBay sold', tcgplayer: 'TCGplayer', cardmarket: 'CardMarket', pricecharting: 'PriceCharting', justtcg: 'JustTCG',
}

/** Opportunity: green at high. Risk: red at high. */
function scoreColor(score: number, kind: 'opportunity' | 'risk'): string {
  const good = kind === 'opportunity' ? score >= 60 : score < 40
  const bad = kind === 'opportunity' ? score < 40 : score >= 60
  if (good) return '#34d399'
  if (bad) return '#f87171'
  return '#fbbf24'
}

function ScoreGauge({ kind, block }: { kind: 'opportunity' | 'risk'; block: ScoreBlock }) {
  const [open, setOpen] = useState(false)
  const color = scoreColor(block.score, kind)
  const Icon = kind === 'opportunity' ? TrendingUp : ShieldAlert
  return (
    <div className="rounded-xl border border-border/25 bg-card/60 overflow-hidden">
      <button onClick={() => setOpen(v => !v)} className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-muted/15 transition-colors">
        <Icon className="h-4 w-4 shrink-0" style={{ color }} />
        <div className="flex-1 min-w-0">
          <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-medium">
            {kind === 'opportunity' ? 'Opportunity Score' : 'Risk Score'}
          </p>
          <p className="text-sm font-semibold" style={{ color }}>{block.label}</p>
        </div>
        <span className="tabular-nums text-2xl font-bold shrink-0" style={{ color }}>{block.score}</span>
        {open ? <ChevronUp className="h-4 w-4 text-muted-foreground shrink-0" /> : <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />}
      </button>
      {/* progress bar */}
      <div className="h-1 bg-muted/40">
        <div className="h-full transition-all" style={{ width: `${block.score}%`, background: color }} />
      </div>
      {open && (
        <div className="px-4 py-3 space-y-2 border-t border-border/15">
          {block.factors.length === 0 && <p className="text-xs text-muted-foreground">Not enough data for a breakdown.</p>}
          {block.factors.map((f) => (
            <div key={f.key} className="space-y-1">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="text-foreground/90">{f.label}</span>
                <span className="tabular-nums text-muted-foreground">{f.score}/100</span>
              </div>
              <div className="h-1 bg-muted/40 rounded-full overflow-hidden">
                <div className="h-full rounded-full" style={{ width: `${f.score}%`, background: color, opacity: 0.5 + f.weight }} />
              </div>
              <p className="text-[10px] text-muted-foreground/70 leading-snug">{f.detail}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function MarketIntelligencePanel({ catalogId }: { catalogId: string }) {
  const [data, setData] = useState<Intelligence | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true); setError(null)
    fetch(`/api/cards/${catalogId}/intelligence`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error ?? 'Failed to load intelligence')
        return r.json()
      })
      .then((d) => { if (!cancelled) { setData(d); setLoading(false) } })
      .catch((e) => { if (!cancelled) { setError(e.message); setLoading(false) } })
    return () => { cancelled = true }
  }, [catalogId])

  const wrap = (children: React.ReactNode) => (
    <div className="rounded-2xl border p-5 space-y-4"
      style={{
        background: 'linear-gradient(135deg, rgba(99,102,241,0.08) 0%, rgba(139,92,246,0.05) 100%)',
        borderColor: 'rgba(99,102,241,0.25)',
        boxShadow: '0 0 0 1px rgba(99,102,241,0.10), 0 4px 24px rgba(99,102,241,0.06)',
      }}>
      {children}
    </div>
  )

  const header = (
    <div className="flex items-center gap-2">
      <Sparkles className="h-4 w-4 text-indigo-300" />
      <h3 className="font-bold text-sm text-white tracking-tight">Market Intelligence</h3>
    </div>
  )

  if (loading) return wrap(<>{header}<div className="flex items-center gap-2 text-xs text-muted-foreground py-6 justify-center"><Loader2 className="h-4 w-4 animate-spin" /> Fusing price sources…</div></>)
  if (error) return wrap(<>{header}<p className="text-xs text-red-300/80">{error}</p></>)
  if (!data) return null

  const { raw } = data.consensus
  const { opportunity, risk, valuation, valuationDetail, lowData } = data.scores
  const hasPrice = raw.price > 0

  return wrap(
    <>
      {header}

      {/* ── Consensus price ── */}
      {hasPrice ? (
        <div className="space-y-3">
          <div className="flex items-end justify-between gap-3">
            <div>
              <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-medium">Market Consensus Price</p>
              <p className="text-3xl font-bold tracking-tight text-white tabular-nums">{fmt(raw.price)}</p>
              <p className="text-xs text-muted-foreground tabular-nums">Range {fmt(raw.range.low)} – {fmt(raw.range.high)}</p>
            </div>
            <span className={`shrink-0 text-[10px] font-semibold px-2 py-1 rounded-md uppercase tracking-widest border ${CONFIDENCE_STYLE[raw.confidence]}`}>
              {raw.confidence} confidence
            </span>
          </div>

          {/* source breakdown */}
          {raw.sources.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[10px] uppercase tracking-widest text-muted-foreground/70 font-medium">Source breakdown</p>
              {raw.sources.map((s) => (
                <div key={s.source} className="flex items-center gap-2 text-xs">
                  <span className="w-24 shrink-0 text-muted-foreground">{SOURCE_LABEL[s.source] ?? s.source}</span>
                  <div className="flex-1 h-1.5 bg-muted/40 rounded-full overflow-hidden">
                    <div className="h-full bg-indigo-400/70 rounded-full" style={{ width: `${Math.round(s.weight * 100)}%` }} />
                  </div>
                  <span className="tabular-nums text-muted-foreground/80 w-16 text-right">{fmt(s.price)}</span>
                  <span className="tabular-nums text-muted-foreground/50 w-9 text-right">{Math.round(s.weight * 100)}%</span>
                </div>
              ))}
              <p className="text-[10px] text-muted-foreground/40">
                {raw.sampleSize} data point{raw.sampleSize === 1 ? '' : 's'}
                {raw.outliers.length > 0 ? ` · ${raw.outliers.length} outlier${raw.outliers.length === 1 ? '' : 's'} rejected` : ''}
                {data.dataSources.length > 0 ? ` · ${data.dataSources.length} source${data.dataSources.length === 1 ? '' : 's'}` : ''}
              </p>
            </div>
          )}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">No price data available for this card yet.</p>
      )}

      {/* ── Valuation + scores ── */}
      <div className="space-y-2.5 pt-1">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-medium">Valuation</p>
          <span className={`text-[10px] font-semibold px-2 py-1 rounded-md uppercase tracking-widest border ${VALUATION_STYLE[valuation] ?? VALUATION_STYLE['Fairly Valued']}`}>
            {valuation}
          </span>
        </div>
        <p className="text-[11px] text-muted-foreground/70 leading-snug -mt-1">{valuationDetail}</p>

        <ScoreGauge kind="opportunity" block={opportunity} />
        <ScoreGauge kind="risk" block={risk} />
      </div>

      {lowData && (
        <p className="text-[10px] text-amber-400/70 leading-snug">
          ⚠ Limited data — scores are directional. They sharpen as more eBay sold comps and price history accrue.
        </p>
      )}
      <p className="text-[10px] text-muted-foreground/40 leading-relaxed">
        Consensus blends recency, sales volume &amp; source reliability. Not financial advice.
      </p>
    </>,
  )
}
