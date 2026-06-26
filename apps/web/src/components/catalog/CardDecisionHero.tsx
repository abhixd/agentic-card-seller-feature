'use client'

// CardDecisionHero — the "wow" above-the-fold layout (Option A):
//   [ decision metrics ]   [ enlarged, tilting card image ]   [ trajectory + actions ]
// Everything that matters is visible without scrolling. Modern feel: count-up
// numbers, self-filling bars, a self-drawing trend line, a cursor-tilt image,
// and a staggered entrance. Self-contained: fetches /api/cards/[id]/intelligence.

import { useEffect, useRef, useState } from 'react'
import Image from 'next/image'
import { TrendingUp, ShieldAlert, Sparkles, Info, ChevronDown, ChevronUp } from 'lucide-react'
import { AddToInventoryButton } from '@/components/inventory/AddToInventoryButton'

interface SourceContribution { source: string; price: number; weight: number; n: number }
interface Consensus {
  price: number; range: { low: number; high: number }
  confidence: 'low' | 'medium' | 'high'; sources: SourceContribution[]
  outliers: { price: number }[]; sampleSize: number
}
interface Factor { key: string; label: string; score: number; weight: number; detail: string }
interface ScoreBlock { score: number; label: string; factors: Factor[]; insufficient: boolean }
interface TrendPoint { date: string; price: number }
interface Intelligence {
  consensus: { raw: Consensus }
  scores: { opportunity: ScoreBlock; risk: ScoreBlock; valuation: string; valuationDetail: string; lowData: boolean }
  trend: { points: TrendPoint[]; changePct: number | null }
  gradingUpsidePct: number | null
  liquidityPerMonth: number | null
  dataSources: string[]
}

const fmt = (n: number) => `$${n.toFixed(2)}`

const VALUATION_STYLE: Record<string, string> = {
  Undervalued:    'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  'Fairly Valued':'bg-zinc-500/15 text-zinc-300 border-zinc-500/30',
  Overheated:     'bg-red-500/15 text-red-300 border-red-500/30',
  Unknown:        'bg-zinc-500/10 text-zinc-400 border-zinc-500/25',
}
const SOURCE_LABEL: Record<string, string> = {
  ebay: 'eBay sold', tcgplayer: 'TCGplayer', cardmarket: 'CardMarket', pricecharting: 'PriceCharting', justtcg: 'JustTCG',
}
const FACTOR_INFO: Record<string, string> = {
  momentum: 'Which way the price has been trending. Rising prices score higher.',
  liquidity: 'How many actually sell each month — how easily you could flip it.',
  fairvalue: 'How far the price sits below fair value. Cheaper than fair = more opportunity.',
  grading: 'Estimated extra profit if you grade it vs. selling it raw.',
  volatility: 'How much the price jumps around. Wilder swings = riskier.',
  'thin-volume': 'Too few sales makes it hard to sell quickly without cutting the price.',
  overpay: 'Whether you’d be paying above fair value right now.',
}
const METRIC_INFO = {
  opportunity: 'How attractive this card is to BUY right now (0–100). Higher = more upside.',
  risk: 'How risky buying now is (0–100). Higher = more uncertainty.',
}

function scoreColor(score: number, kind: 'opportunity' | 'risk'): string {
  const good = kind === 'opportunity' ? score >= 60 : score < 40
  const bad = kind === 'opportunity' ? score < 40 : score >= 60
  if (good) return '#34d399'
  if (bad) return '#f87171'
  return '#fbbf24'
}

/** Count up to a number with an easeOutCubic ramp. */
function useCountUp(target: number | null, duration = 950): number {
  const [val, setVal] = useState(0)
  useEffect(() => {
    if (target == null) { setVal(0); return }
    let raf = 0
    let start = 0
    const tick = (t: number) => {
      if (!start) start = t
      const p = Math.min(1, (t - start) / duration)
      setVal(target * (1 - Math.pow(1 - p, 3)))
      if (p < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [target, duration])
  return val
}

function InfoDot({ text }: { text: string }) {
  return (
    <span title={text} aria-label={text} className="inline-flex cursor-help align-middle text-white/30 hover:text-white/70 transition-colors">
      <Info className="h-3 w-3" />
    </span>
  )
}

function Sparkline({ points, color }: { points: TrendPoint[]; color: string }) {
  if (points.length < 2) {
    return <div className="h-12 flex items-center justify-center text-[10px] text-white/25">No trend data yet</div>
  }
  const ys = points.map((p) => p.price)
  const min = Math.min(...ys), max = Math.max(...ys)
  const span = max - min || 1
  const W = 200, H = 48
  const poly = points.map((p, i) => {
    const x = (i / (points.length - 1)) * W
    const y = H - ((p.price - min) / span) * (H - 8) - 4
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-12" preserveAspectRatio="none" aria-hidden>
      <polyline points={poly} fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="hero-spark" pathLength={1} />
    </svg>
  )
}

function ScoreTile({ kind, block, animate }: { kind: 'opportunity' | 'risk'; block: ScoreBlock; animate: boolean }) {
  const color = block.insufficient ? '#9ca3af' : scoreColor(block.score, kind)
  const Icon = kind === 'opportunity' ? TrendingUp : ShieldAlert
  const shown = useCountUp(animate && !block.insufficient ? block.score : null)
  return (
    <div className="hero-card rounded-xl border px-3.5 py-3 transition-all duration-200 hover:-translate-y-0.5"
      style={{ borderColor: `${color}33`, background: `${color}10` }}>
      <div className="flex items-center gap-1.5">
        <Icon className="h-3.5 w-3.5 shrink-0" style={{ color }} />
        <span className="text-[10px] uppercase tracking-widest text-white/45 font-medium">{kind === 'opportunity' ? 'Opportunity' : 'Risk'}</span>
        <InfoDot text={METRIC_INFO[kind]} />
      </div>
      {block.insufficient ? (
        <>
          <p className="mt-1 text-3xl font-bold leading-none text-white/30">—</p>
          <p className="mt-0.5 text-[11px] text-white/40">Not enough data yet</p>
          <div className="mt-2 h-1 rounded-full bg-white/10" />
        </>
      ) : (
        <>
          <p className="mt-1 text-3xl font-bold leading-none tabular-nums" style={{ color }}>{Math.round(shown)}</p>
          <p className="mt-0.5 text-[11px] font-semibold" style={{ color }}>{block.label}</p>
          <div className="mt-2 h-1 rounded-full bg-white/10 overflow-hidden">
            <div className="h-full rounded-full" style={{ width: `${animate ? block.score : 0}%`, background: color, transition: 'width 1.1s cubic-bezier(.22,1,.36,1)' }} />
          </div>
        </>
      )}
    </div>
  )
}

export function CardDecisionHero({
  catalogId, cardName, setName, year, cardNumber, imageUrl, types,
}: {
  catalogId: string
  cardName: string
  setName: string
  year: number | null
  cardNumber: string | null
  imageUrl: string | null
  types: string[]
}) {
  const [data, setData] = useState<Intelligence | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)        // gates the entrance/count-up
  const [showMath, setShowMath] = useState(false)
  const [tilt, setTilt] = useState({ rx: 0, ry: 0, on: false })
  const [zoomed, setZoomed] = useState(false)
  const tiltRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!zoomed) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setZoomed(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [zoomed])

  useEffect(() => {
    let cancelled = false
    setError(null)
    fetch(`/api/cards/${catalogId}/intelligence`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error ?? 'Failed to load')
        return r.json()
      })
      .then((d) => { if (!cancelled) { setData(d); requestAnimationFrame(() => setReady(true)) } })
      .catch((e) => { if (!cancelled) setError(e.message) })
    return () => { cancelled = true }
  }, [catalogId])

  const raw = data?.consensus.raw
  const price = useCountUp(ready && raw && raw.price > 0 ? raw.price : null)

  function onTiltMove(e: React.MouseEvent) {
    const el = tiltRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const px = (e.clientX - r.left) / r.width
    const py = (e.clientY - r.top) / r.height
    setTilt({ ry: (px - 0.5) * 14, rx: -(py - 0.5) * 14, on: true })
  }

  return (
    <div
      className="relative overflow-hidden rounded-3xl p-5 sm:p-6"
      style={{ background: 'linear-gradient(135deg,#0b1018 0%,#0d1326 55%,#0b1018 100%)', border: '1px solid rgba(99,102,241,0.2)' }}
    >
      <style>{`
        @keyframes heroRise { from { opacity:0; transform: translateY(10px) } to { opacity:1; transform:none } }
        @keyframes heroDraw { to { stroke-dashoffset: 0 } }
        @keyframes heroGlow { 0%,100% { opacity:.18 } 50% { opacity:.34 } }
        .hero-rise { opacity:0; animation: heroRise .55s cubic-bezier(.22,1,.36,1) forwards; }
        .hero-spark { stroke-dasharray: 1; stroke-dashoffset: 1; animation: heroDraw 1.2s ease .15s forwards; }
        .hero-card:hover { box-shadow: 0 8px 30px rgba(0,0,0,.35); }
      `}</style>
      <div aria-hidden className="pointer-events-none absolute -top-24 left-1/2 -translate-x-1/2 h-64 w-[28rem] rounded-full blur-3xl"
        style={{ background: 'radial-gradient(circle,#6366f1 0%,transparent 70%)', animation: 'heroGlow 6s ease-in-out infinite' }} />

      <div className="relative grid grid-cols-1 lg:grid-cols-[1fr_220px_1fr] gap-4 lg:gap-5 items-start">

        {/* ── LEFT: the decision ── */}
        <div className="flex flex-col gap-3 order-2 lg:order-1">
          <div className="hero-rise hero-card rounded-2xl border border-white/[0.08] bg-white/[0.025] p-4" style={{ animationDelay: '60ms' }}>
            <p className="text-[10px] uppercase tracking-widest text-white/40 font-medium flex items-center gap-1">Consensus price</p>
            {error ? (
              <p className="mt-1 text-sm text-red-300/80">{error}</p>
            ) : !raw ? (
              <div className="mt-2 h-8 w-28 rounded-lg bg-white/5 animate-pulse" />
            ) : raw.price > 0 ? (
              <>
                <p className="text-3xl sm:text-4xl font-bold tracking-tight text-white tabular-nums leading-tight">{fmt(price)}</p>
                <p className="text-[11px] text-white/45 tabular-nums">{fmt(raw.range.low)} – {fmt(raw.range.high)} · {raw.confidence} confidence</p>
                {data && (
                  <div className="mt-2.5">
                    <span className={`text-[11px] font-semibold px-2.5 py-1 rounded-md uppercase tracking-wide border ${VALUATION_STYLE[data.scores.valuation] ?? VALUATION_STYLE.Unknown}`}>
                      {data.scores.valuation}
                    </span>
                  </div>
                )}
              </>
            ) : (
              <p className="mt-1 text-xs text-white/45">No price data yet — populates as sources sync.</p>
            )}
          </div>

          {data && (
            <div className="hero-rise grid grid-cols-2 gap-3" style={{ animationDelay: '140ms' }}>
              <ScoreTile kind="opportunity" block={data.scores.opportunity} animate={ready} />
              <ScoreTile kind="risk" block={data.scores.risk} animate={ready} />
            </div>
          )}
        </div>

        {/* ── CENTER: the image, enlarged + cursor-tilt ── */}
        <div className="flex flex-col items-center gap-3 order-1 lg:order-2">
          <div
            ref={tiltRef}
            onMouseMove={onTiltMove}
            onMouseLeave={() => setTilt({ rx: 0, ry: 0, on: false })}
            className="hero-rise relative w-44 sm:w-52"
            style={{ animationDelay: '0ms', perspective: '900px' }}
          >
            <div
              onClick={() => { if (imageUrl) setZoomed(true) }}
              title="Click to enlarge"
              className="relative rounded-2xl overflow-hidden border border-white/10 bg-black/30 cursor-zoom-in"
              style={{
                aspectRatio: '2/3',
                transform: `rotateX(${tilt.rx}deg) rotateY(${tilt.ry}deg) scale(${tilt.on ? 1.03 : 1})`,
                transition: tilt.on ? 'transform .08s linear' : 'transform .4s cubic-bezier(.22,1,.36,1)',
                boxShadow: '0 24px 60px rgba(0,0,0,0.5)',
              }}
            >
              {imageUrl ? (
                <Image src={imageUrl} alt={cardName} fill className="object-contain p-1.5" sizes="220px" unoptimized />
              ) : (
                <div className="absolute inset-0 flex items-center justify-center text-white/25 text-xs">No image</div>
              )}
              <div aria-hidden className="pointer-events-none absolute inset-0"
                style={{ background: tilt.on ? `radial-gradient(420px circle at ${50 + tilt.ry * 3}% ${50 - tilt.rx * 3}%, rgba(255,255,255,0.14), transparent 45%)` : 'none' }} />
            </div>
          </div>
          <div className="text-center hero-rise" style={{ animationDelay: '90ms' }}>
            <h1 className="text-base sm:text-lg font-bold tracking-tight text-white leading-tight">{cardName}</h1>
            <p className="text-[11px] text-white/45">{setName}{year ? ` · ${year}` : ''}{cardNumber ? ` · #${cardNumber}` : ''}</p>
            {types.length > 0 && (
              <div className="mt-1.5 flex items-center justify-center gap-1 flex-wrap">
                {types.map((t) => (
                  <span key={t} className="text-[9px] px-2 py-0.5 rounded-full border border-white/10 text-white/50">{t}</span>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* ── RIGHT: trajectory + actions ── */}
        <div className="flex flex-col gap-3 order-3">
          <div className="hero-rise hero-card rounded-2xl border border-white/[0.08] bg-white/[0.025] p-4" style={{ animationDelay: '200ms' }}>
            <p className="text-[10px] uppercase tracking-widest text-white/40 font-medium">Price trend</p>
            {data ? <Sparkline points={data.trend.points} color="#60a5fa" /> : <div className="h-12" />}
            {data?.trend.changePct != null ? (
              <p className="text-[11px] font-semibold mt-1" style={{ color: data.trend.changePct >= 0 ? '#34d399' : '#f87171' }}>
                {data.trend.changePct >= 0 ? '+' : ''}{data.trend.changePct.toFixed(1)}%
                {data.liquidityPerMonth != null && <span className="text-white/40 font-normal"> · {data.liquidityPerMonth.toFixed(0)} sales / mo</span>}
              </p>
            ) : (
              <p className="text-[11px] text-white/35 mt-1">Connect price history to chart this.</p>
            )}
          </div>

          {data?.gradingUpsidePct != null && (
            <div className="hero-rise hero-card rounded-2xl border border-emerald-500/15 bg-emerald-500/[0.06] p-4" style={{ animationDelay: '260ms' }}>
              <p className="text-[10px] uppercase tracking-widest text-emerald-300/60 font-medium">Grading upside</p>
              <p className="text-lg font-bold text-emerald-300 mt-0.5">
                {data.gradingUpsidePct >= 0 ? '+' : ''}{data.gradingUpsidePct.toFixed(0)}% <span className="text-[11px] font-medium text-emerald-300/60">at best PSA grade</span>
              </p>
            </div>
          )}

          <div className="hero-rise" style={{ animationDelay: '320ms' }}>
            <AddToInventoryButton catalogId={catalogId} tcgPrice={raw && raw.price > 0 ? raw.price : null} />
          </div>
        </div>
      </div>

      {/* ── Show the math ── */}
      {data && raw && raw.price > 0 && (
        <div className="relative mt-4">
          <button onClick={() => setShowMath((v) => !v)}
            className="flex items-center gap-1.5 text-[11px] text-white/45 hover:text-white/80 transition-colors">
            {showMath ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            {showMath ? 'Hide the math' : 'Show the math'}
          </button>
          {showMath && (
            <div className="hero-rise mt-3 grid grid-cols-1 sm:grid-cols-3 gap-5 border-t border-white/[0.08] pt-4">
              <div className="space-y-1.5">
                <p className="text-[10px] uppercase tracking-widest text-white/40 font-medium">Source breakdown</p>
                {raw.sources.map((s) => (
                  <div key={s.source} className="flex items-center gap-2 text-[11px]">
                    <span className="w-20 shrink-0 text-white/45">{SOURCE_LABEL[s.source] ?? s.source}</span>
                    <div className="flex-1 h-1.5 bg-white/10 rounded-full overflow-hidden">
                      <div className="h-full bg-indigo-400/70 rounded-full" style={{ width: `${Math.round(s.weight * 100)}%` }} />
                    </div>
                    <span className="tabular-nums text-white/50 w-10 text-right">{Math.round(s.weight * 100)}%</span>
                  </div>
                ))}
                <p className="text-[10px] text-white/30">{raw.sampleSize} data point{raw.sampleSize === 1 ? '' : 's'}{raw.outliers.length > 0 ? ` · ${raw.outliers.length} outlier${raw.outliers.length === 1 ? '' : 's'} dropped` : ''}</p>
              </div>
              {(['opportunity', 'risk'] as const).map((kind) => {
                const block = data.scores[kind]
                const color = scoreColor(block.score, kind)
                return (
                  <div key={kind} className="space-y-2">
                    <p className="text-[10px] uppercase tracking-widest text-white/40 font-medium">{kind === 'opportunity' ? 'Opportunity' : 'Risk'} factors</p>
                    {block.factors.length === 0 && <p className="text-[11px] text-white/40">Not enough data.</p>}
                    {block.factors.map((f) => (
                      <div key={f.key} className="space-y-1">
                        <div className="flex items-center justify-between gap-2 text-[11px]">
                          <span className="text-white/80 flex items-center gap-1">{f.label} {FACTOR_INFO[f.key] && <InfoDot text={FACTOR_INFO[f.key]} />}</span>
                          <span className="tabular-nums text-white/45">{f.score}</span>
                        </div>
                        <div className="h-1 bg-white/10 rounded-full overflow-hidden">
                          <div className="h-full rounded-full" style={{ width: `${f.score}%`, background: color, opacity: 0.6 }} />
                        </div>
                        <p className="text-[10px] text-white/40 leading-snug">{f.detail}</p>
                      </div>
                    ))}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      <div className="relative mt-3 flex items-center gap-1.5">
        <Sparkles className="h-3 w-3 text-indigo-300/60" />
        <p className="text-[10px] text-white/30">Consensus blends recency, volume &amp; source reliability. Not financial advice.</p>
      </div>

      {/* ── Lightbox: click image to enlarge, click anywhere / Esc to close ── */}
      {zoomed && imageUrl && (
        <div
          onClick={() => setZoomed(false)}
          role="dialog"
          aria-modal="true"
          aria-label={`${cardName} enlarged`}
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/85 backdrop-blur-sm cursor-zoom-out p-6"
          style={{ animation: 'heroRise .18s ease' }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={imageUrl}
            alt={cardName}
            className="max-h-[92vh] max-w-[92vw] object-contain rounded-2xl"
            style={{ boxShadow: '0 30px 90px rgba(0,0,0,0.7)', animation: 'heroRise .28s cubic-bezier(.22,1,.36,1)' }}
          />
          <span className="absolute bottom-5 left-1/2 -translate-x-1/2 text-[11px] text-white/40">
            Click anywhere or press Esc to close
          </span>
        </div>
      )}
    </div>
  )
}
