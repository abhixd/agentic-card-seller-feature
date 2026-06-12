'use client'

import { useEffect, useState, useRef } from 'react'

// ── Types ─────────────────────────────────────────────────────────────────────

interface InsightMetrics {
  dataPoints:      number
  lowDataWarning:  boolean
  stagnant:        boolean
  currentPrice:    number | null
  change7d:        number | null
  change30d:       number | null
  ath:             number | null
  atl:             number | null
  athDate:         string | null
  atlDate:         string | null
}

interface InsightResponse {
  insight:        string
  metrics:        InsightMetrics
  newsHeadlines:  string[]
  cached:         boolean
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtPrice(n: number | null): string {
  return n != null ? `$${n.toFixed(2)}` : 'N/A'
}

function dataQualityLabel(n: number): { text: string; color: string } {
  if (n >= 30) return { text: 'Strong data',      color: '#34d399' }
  if (n >= 14) return { text: 'Good data',        color: '#60a5fa' }
  if (n >= 3)  return { text: 'Limited data',     color: '#fbbf24' }
  return              { text: 'Very little data', color: '#f87171' }
}

// ── Typewriter hook ───────────────────────────────────────────────────────────

function useTypewriter(text: string, speed = 18) {
  const [displayed, setDisplayed] = useState('')
  const [done, setDone]           = useState(false)
  const indexRef  = useRef(0)
  const timerRef  = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!text) return
    setDisplayed('')
    setDone(false)
    indexRef.current = 0

    const tick = () => {
      indexRef.current += 1
      setDisplayed(text.slice(0, indexRef.current))
      if (indexRef.current >= text.length) {
        setDone(true)
        return
      }
      const ch = text[indexRef.current - 1]
      // Longer pause at sentence ends for natural reading rhythm
      const delay = (ch === '.' || ch === '!' || ch === '?') ? speed * 9 : speed
      timerRef.current = setTimeout(tick, delay)
    }

    timerRef.current = setTimeout(tick, speed)
    return () => { if (timerRef.current) clearTimeout(timerRef.current) }
  }, [text, speed])

  return { displayed, done }
}

// ── Skeleton ──────────────────────────────────────────────────────────────────

function InsightSkeleton() {
  return (
    <div
      className="rounded-xl border border-purple-500/20 p-5"
      style={{
        background: 'linear-gradient(135deg, hsl(var(--card)) 0%, rgba(139,92,246,0.05) 100%)',
        boxShadow:  '0 0 0 1px rgba(139,92,246,0.12), 0 0 20px rgba(139,92,246,0.06)',
      }}
    >
      <div className="flex items-center gap-2 mb-4">
        <span className="w-2.5 h-2.5 rounded-full bg-purple-500/30 animate-pulse" />
        <div className="h-4 w-14 rounded bg-purple-500/20 animate-pulse" />
        <div className="h-4 w-7  rounded bg-purple-500/15 animate-pulse" />
      </div>
      <div className="space-y-2.5">
        {[100, 92, 85, 65].map((w, i) => (
          <div key={i} className="h-3 rounded animate-pulse"
            style={{ width: `${w}%`, background: `rgba(139,92,246,${0.10 - i * 0.02})` }} />
        ))}
      </div>
      <div className="flex gap-2 mt-4">
        {[1, 2].map(i => (
          <div key={i} className="h-[52px] w-24 rounded-lg bg-zinc-800/50 animate-pulse" />
        ))}
      </div>
    </div>
  )
}

// ── Metric chip ───────────────────────────────────────────────────────────────

function Chip({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <div className="flex flex-col items-center justify-center px-3 py-2.5 rounded-lg bg-zinc-900/80 border border-zinc-800 min-w-[80px]">
      <span className="text-[10px] font-medium text-zinc-600 uppercase tracking-widest leading-none mb-1.5">
        {label}
      </span>
      <span className={`text-sm font-semibold tabular-nums leading-none ${valueColor ?? 'text-zinc-200'}`}>
        {value}
      </span>
    </div>
  )
}

// ── Blinking cursor ───────────────────────────────────────────────────────────

function Cursor() {
  return (
    <span
      className="inline-block w-[2px] h-3.5 bg-purple-400/80 ml-0.5 align-middle rounded-sm"
      style={{ animation: 'nexus-cursor 0.85s step-end infinite' }}
    />
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

interface Props {
  catalogId: string
}

export function NEXUSCardInsight({ catalogId }: Props) {
  const [data,    setData]    = useState<InsightResponse | null>(null)
  const [error,   setError]   = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const revealTimer = setTimeout(() => setVisible(true), 200)

    fetch(`/api/cards/${catalogId}/insight`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json() as Promise<InsightResponse>
      })
      .then((json) => { setData(json); setLoading(false) })
      .catch((err) => {
        console.error('[NEXUSCardInsight]', err)
        setError('NEXUS unavailable right now')
        setLoading(false)
      })

    return () => clearTimeout(revealTimer)
  }, [catalogId])

  const { displayed, done } = useTypewriter(data?.insight ?? '', 16)

  if (!visible) return null
  if (loading)  return <InsightSkeleton />

  if (error) {
    return (
      <div className="rounded-xl border border-zinc-800 p-4" style={{ background: 'hsl(var(--card))' }}>
        <div className="flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-zinc-700" />
          <span className="text-zinc-500 font-bold text-xs tracking-widest uppercase">NEXUS</span>
          <span className="text-zinc-700">·</span>
          <span className="text-xs text-zinc-600">{error}</span>
        </div>
      </div>
    )
  }

  if (!data) return null

  const { metrics, newsHeadlines } = data
  const dq = dataQualityLabel(metrics.dataPoints)

  // Only show stagnant warning when price is barely moving AND not fluctuating wildly
  // (rapid daily changes = active market, not stagnant regardless of 30d net change)
  const showStagnant = metrics.stagnant

  return (
    <>
      <style>{`
        @keyframes nexus-cursor {
          0%, 100% { opacity: 1; }
          50%       { opacity: 0; }
        }
        @keyframes nexus-scan {
          0%   { transform: translateY(-100%); opacity: 0.5; }
          100% { transform: translateY(500%);  opacity: 0;   }
        }
        @keyframes nexus-glow {
          0%, 100% { box-shadow: 0 0 0 1px rgba(139,92,246,0.12), 0 0 18px rgba(139,92,246,0.07); }
          50%       { box-shadow: 0 0 0 1px rgba(139,92,246,0.20), 0 0 30px rgba(139,92,246,0.12); }
        }
        @keyframes nexus-fade-in {
          from { opacity: 0; transform: translateY(6px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>

      <div
        className="rounded-xl border border-purple-500/20 p-5 space-y-4 relative overflow-hidden"
        style={{
          background: 'linear-gradient(135deg, hsl(var(--card)) 0%, rgba(139,92,246,0.06) 100%)',
          animation:  'nexus-glow 4s ease-in-out infinite, nexus-fade-in 0.4s ease-out both',
        }}
      >
        {/* Moving scan line — subtle depth effect */}
        <div
          className="absolute inset-x-0 h-20 pointer-events-none"
          style={{
            background: 'linear-gradient(to bottom, transparent, rgba(139,92,246,0.035), transparent)',
            animation:  'nexus-scan 7s linear infinite',
            top: 0,
          }}
        />

        {/* ── Header ── */}
        <div className="flex items-center gap-2 relative">
          <span className="relative flex h-2.5 w-2.5 shrink-0">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-purple-400 opacity-55" />
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-purple-500" />
          </span>

          <span
            className="font-black text-sm tracking-[0.2em] uppercase"
            style={{
              background: 'linear-gradient(90deg, #a78bfa 0%, #c084fc 60%, #a78bfa 100%)',
              backgroundSize: '200% 100%',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              backgroundClip: 'text',
            }}
          >
            NEXUS
          </span>

          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-400 border border-purple-500/30 uppercase tracking-widest">
            AI
          </span>

          <div className="ml-auto flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500/80"
              style={{ animation: 'nexus-cursor 2s ease-in-out infinite' }} />
            <span className="text-[10px] text-zinc-600 font-medium uppercase tracking-widest">
              {done ? 'Ready' : 'Generating'}
            </span>
          </div>
        </div>

        {/* ── Warnings (only if genuinely needed) ── */}
        {metrics.lowDataWarning && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 flex gap-2 items-start">
            <span className="text-amber-400 shrink-0 text-xs mt-0.5">⚠</span>
            <div>
              <p className="text-xs font-semibold text-amber-300">Not enough sales tracked yet</p>
              <p className="text-[11px] text-amber-400/60 mt-0.5 leading-snug">
                Very few price data points found — numbers may not reflect the true market.
              </p>
            </div>
          </div>
        )}

        {showStagnant && (
          <div className="rounded-lg border border-yellow-500/20 bg-yellow-500/6 px-3 py-2.5 flex gap-2 items-start">
            <span className="text-yellow-500/70 shrink-0 text-xs mt-0.5">◈</span>
            <div>
              <p className="text-xs font-semibold text-yellow-300/80">Price barely moves on this card</p>
              <p className="text-[11px] text-yellow-400/50 mt-0.5 leading-snug">
                Less than 1% change over 30 days — very few active buyers and sellers right now.
              </p>
            </div>
          </div>
        )}

        {/* ── Typewriter insight text ── */}
        <div className="relative">
          <div
            className="absolute left-0 top-1 bottom-1 w-[2px] rounded-full opacity-60"
            style={{ background: 'linear-gradient(to bottom, #7c3aed, rgba(124,58,237,0))' }}
          />
          <p className="text-sm leading-relaxed text-white/85 pl-4 min-h-[1.5rem]">
            {displayed || <span className="text-zinc-700 italic text-xs">Thinking…</span>}
            {!done && displayed && <Cursor />}
          </p>
        </div>

        {/* ── Metric chips — only what matters ── */}
        <div className="flex flex-wrap gap-2">
          {metrics.ath != null && (
            <Chip label="All-time high" value={fmtPrice(metrics.ath)} valueColor="text-zinc-200" />
          )}
          <Chip label="Data quality" value={dq.text} valueColor={dq.color} />
        </div>

        {/* ── News ── */}
        {newsHeadlines.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-[10px] uppercase tracking-widest text-zinc-700 font-medium">In the news</p>
            <div className="flex flex-wrap gap-1.5">
              {newsHeadlines.map((headline, i) => (
                <span
                  key={i}
                  className="inline-block text-[11px] px-2.5 py-1 rounded-full bg-blue-950/40 border border-blue-800/25 text-blue-400/70 leading-tight"
                  title={headline}
                >
                  {headline.length > 60 ? `${headline.slice(0, 57)}…` : headline}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </>
  )
}
