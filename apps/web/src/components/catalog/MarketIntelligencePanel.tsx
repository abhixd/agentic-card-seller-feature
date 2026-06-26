'use client'

// Market Consensus Price + Investment Intelligence panel (PRD pillars 1 & 2).
// Compact, decision-first: the four numbers that matter (price, valuation,
// opportunity, risk) sit above the fold; the supporting math is one tap away.
// Self-contained & additive: remove the single <MarketIntelligencePanel/> usage to roll back.

import { useEffect, useState } from 'react'
import { ChevronDown, ChevronUp, TrendingUp, ShieldAlert, Sparkles, Loader2, Info } from 'lucide-react'

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
interface ScoreBlock { score: number; label: string; factors: Factor[]; insufficient: boolean }
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

const VALUATION_STYLE: Record<string, string> = {
  Undervalued:    'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  'Fairly Valued':'bg-zinc-500/15 text-zinc-300 border-zinc-500/30',
  Overheated:     'bg-red-500/15 text-red-300 border-red-500/30',
  Unknown:        'bg-zinc-500/10 text-zinc-400 border-zinc-500/20',
}

const SOURCE_LABEL: Record<string, string> = {
  ebay: 'eBay sold', tcgplayer: 'TCGplayer', cardmarket: 'CardMarket', pricecharting: 'PriceCharting', justtcg: 'JustTCG',
}

// Plain-English explanations shown behind the small "i" icons.
const METRIC_INFO: Record<string, string> = {
  consensus: 'One trusted price blended from eBay sold listings, TCGplayer and CardMarket — weighted toward recent, real sales, with outliers thrown out.',
  opportunity: 'How attractive this card is to BUY right now (0–100). Higher means more upside — rising price, strong demand, and trading below fair value.',
  risk: 'How risky buying now is (0–100). Higher means more uncertainty — few sales, big price swings, hype spikes, or lots of supply.',
  valuation: 'Whether today’s market price sits below (undervalued), at (fair), or above (overheated) our fair-value estimate.',
}

const FACTOR_INFO: Record<string, string> = {
  momentum: 'Which way the price has been trending. Rising prices score higher.',
  growth: 'How fast the price is climbing, per month.',
  liquidity: 'How many actually sell each month — i.e. how easily you could flip it.',
  fairvalue: 'How far the current price sits below fair value. Cheaper than fair = more opportunity.',
  grading: 'Estimated extra profit if you grade it vs. selling it raw.',
  scarcity: 'How few graded copies exist. Scarcer usually means more upside.',
  volatility: 'How much the price jumps around. Wilder swings = riskier.',
  'thin-volume': 'Too few sales makes it hard to sell quickly without cutting the price.',
  overheating: 'A sudden price spike can be hype that may not last.',
  overpay: 'Whether you’d be paying above fair value right now.',
  population: 'Lots of graded copies already out there can cap the upside.',
  reprint: 'Risk the card gets reprinted, which usually drops its value.',
}

/** Opportunity: green at high. Risk: red at high. */
function scoreColor(score: number, kind: 'opportunity' | 'risk'): string {
  const good = kind === 'opportunity' ? score >= 60 : score < 40
  const bad = kind === 'opportunity' ? score < 40 : score >= 60
  if (good) return '#34d399'
  if (bad) return '#f87171'
  return '#fbbf24'
}

/** A small "i" with a plain-English tooltip (native title — no clipping, works everywhere). */
function InfoDot({ text }: { text: string }) {
  return (
    <span title={text} aria-label={text} className="inline-flex cursor-help align-middle text-muted-foreground/40 hover:text-muted-foreground/80 transition-colors">
      <Info className="h-3 w-3" />
    </span>
  )
}

function MetricCard({ kind, block }: { kind: 'opportunity' | 'risk'; block: ScoreBlock }) {
  const color = scoreColor(block.score, kind)
  const Icon = kind === 'opportunity' ? TrendingUp : ShieldAlert
  return (
    <div className="rounded-xl border border-border/25 bg-card/60 px-3.5 py-3">
      <div className="flex items-center gap-1.5">
        <Icon className="h-3.5 w-3.5 shrink-0" style={{ color: block.insufficient ? undefined : color }} />
        <span className="text-[10px] uppercase tracking-widest text-muted-foreground font-medium">
          {kind === 'opportunity' ? 'Opportunity' : 'Risk'}
        </span>
        <InfoDot text={METRIC_INFO[kind]} />
      </div>
      {block.insufficient ? (
        <>
          <div className="mt-1 flex items-baseline gap-1">
            <span className="text-3xl font-bold tabular-nums leading-none text-muted-foreground/40">—</span>
          </div>
          <p className="mt-0.5 text-[11px] text-muted-foreground/60">Not enough data yet</p>
          <div className="mt-2 h-1 bg-muted/30 rounded-full" />
        </>
      ) : (
        <>
          <div className="mt-1 flex items-baseline gap-1">
            <span className="text-3xl font-bold tabular-nums leading-none" style={{ color }}>{block.score}</span>
            <span className="text-[10px] text-muted-foreground/60">/100</span>
          </div>
          <p className="mt-0.5 text-[11px] font-semibold" style={{ color }}>{block.label}</p>
          <div className="mt-2 h-1 bg-muted/40 rounded-full overflow-hidden">
            <div className="h-full rounded-full transition-all" style={{ width: `${block.score}%`, background: color }} />
          </div>
        </>
      )}
    </div>
  )
}

function FactorList({ block, kind }: { block: ScoreBlock; kind: 'opportunity' | 'risk' }) {
  const color = scoreColor(block.score, kind)
  return (
    <div className="space-y-2">
      <p className="text-[10px] uppercase tracking-widest text-muted-foreground/70 font-medium">
        {kind === 'opportunity' ? 'Opportunity' : 'Risk'} factors
      </p>
      {block.factors.length === 0 && <p className="text-xs text-muted-foreground">Not enough data for a breakdown.</p>}
      {block.factors.map((f) => (
        <div key={f.key} className="space-y-1">
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="text-foreground/90 flex items-center gap-1">
              {f.label} {FACTOR_INFO[f.key] && <InfoDot text={FACTOR_INFO[f.key]} />}
            </span>
            <span className="tabular-nums text-muted-foreground">{f.score}/100</span>
          </div>
          <div className="h-1 bg-muted/40 rounded-full overflow-hidden">
            <div className="h-full rounded-full" style={{ width: `${f.score}%`, background: color, opacity: 0.55 + f.weight }} />
          </div>
          <p className="text-[10px] text-muted-foreground/70 leading-snug">{f.detail}</p>
        </div>
      ))}
    </div>
  )
}

export function MarketIntelligencePanel({ catalogId }: { catalogId: string }) {
  const [data, setData] = useState<Intelligence | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showDetails, setShowDetails] = useState(false)

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
    <div className="rounded-2xl border p-5 space-y-3.5"
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

      {hasPrice ? (
        <>
          {/* ── Consensus price + valuation (above the fold) ── */}
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-medium flex items-center gap-1">
                Consensus price <InfoDot text={METRIC_INFO.consensus} />
              </p>
              <p className="text-3xl font-bold tracking-tight text-white tabular-nums leading-tight">{fmt(raw.price)}</p>
              <p className="text-[11px] text-muted-foreground tabular-nums">
                {fmt(raw.range.low)} – {fmt(raw.range.high)} · {raw.confidence} confidence
              </p>
            </div>
            <span className="shrink-0 flex items-center gap-1">
              <span className={`text-[11px] font-semibold px-2.5 py-1 rounded-md uppercase tracking-wide border ${VALUATION_STYLE[valuation] ?? VALUATION_STYLE['Fairly Valued']}`}>
                {valuation}
              </span>
              <InfoDot text={METRIC_INFO.valuation} />
            </span>
          </div>

          {/* ── Opportunity + Risk (above the fold) ── */}
          <div className="grid grid-cols-2 gap-2.5">
            <MetricCard kind="opportunity" block={opportunity} />
            <MetricCard kind="risk" block={risk} />
          </div>

          {valuationDetail && (
            <p className="text-[11px] text-muted-foreground/70 leading-snug">{valuationDetail}</p>
          )}

          {/* ── The math, one tap away ── */}
          <button
            onClick={() => setShowDetails((v) => !v)}
            className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
          >
            {showDetails ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            {showDetails ? 'Hide the math' : 'Show the math'}
          </button>

          {showDetails && (
            <div className="space-y-4 pt-2 border-t border-border/15">
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
              <FactorList block={opportunity} kind="opportunity" />
              <FactorList block={risk} kind="risk" />
            </div>
          )}
        </>
      ) : (
        <p className="text-xs text-muted-foreground">No price data for this card yet — it populates as eBay and price sources sync.</p>
      )}

      {lowData && hasPrice && (
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
