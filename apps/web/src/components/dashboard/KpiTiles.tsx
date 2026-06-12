'use client'

import { AnimatedNumber } from '@/components/ui/AnimatedNumber'
import { TrendingUp, TrendingDown, DollarSign, Package, Zap } from 'lucide-react'

interface KpiTilesProps {
  totalValue:  number
  totalGain:   number
  gainPct:     number
  activeCount: number
  signalCount: number
  sellCount:   number
  gradeCount:  number
  pricedCount: number
  unpricedCount: number
}

function fmtUsd(n: number) {
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`
  return `$${n.toFixed(2)}`
}

export function KpiTiles({
  totalValue, totalGain, gainPct, activeCount,
  signalCount, sellCount, gradeCount, pricedCount, unpricedCount,
}: KpiTilesProps) {
  const gainPositive = totalGain >= 0

  return (
    <div className="flex flex-wrap gap-3">
      {/* Portfolio Value */}
      <div className="min-w-[130px] rounded-xl border border-white/8 bg-white/[0.04] px-3.5 py-2.5">
        <p className="text-[9px] uppercase tracking-widest text-white/25 font-semibold mb-1 flex items-center gap-1">
          <DollarSign className="h-2.5 w-2.5" /> Portfolio Value
        </p>
        <p className="font-black tabular-nums leading-none text-blue-300 text-xl">
          <AnimatedNumber
            value={totalValue}
            formatter={fmtUsd}
            duration={1200}
          />
        </p>
        <p className="text-[10px] text-white/25 mt-0.5 tabular-nums">
          {unpricedCount > 0 ? `+${unpricedCount} unpriced` : `${pricedCount} priced`}
        </p>
      </div>

      {/* Unrealised P&L */}
      <div className="min-w-[130px] rounded-xl border border-white/8 bg-white/[0.04] px-3.5 py-2.5">
        <p className="text-[9px] uppercase tracking-widest text-white/25 font-semibold mb-1 flex items-center gap-1">
          {gainPositive
            ? <TrendingUp className="h-2.5 w-2.5" />
            : <TrendingDown className="h-2.5 w-2.5" />}
          Unrealised P&L
        </p>
        <p className={`font-black tabular-nums leading-none text-xl ${gainPositive ? 'text-emerald-300' : 'text-red-400'}`}>
          {gainPositive ? '+' : '-'}
          <AnimatedNumber
            value={Math.abs(totalGain)}
            formatter={fmtUsd}
            duration={1200}
          />
        </p>
        <p className="text-[10px] text-white/25 mt-0.5 tabular-nums">
          {gainPositive ? '+' : ''}{gainPct.toFixed(1)}%
        </p>
      </div>

      {/* Cards Active */}
      <div className="min-w-[130px] rounded-xl border border-white/8 bg-white/[0.04] px-3.5 py-2.5">
        <p className="text-[9px] uppercase tracking-widest text-white/25 font-semibold mb-1 flex items-center gap-1">
          <Package className="h-2.5 w-2.5" /> Cards Active
        </p>
        <p className="font-black tabular-nums leading-none text-indigo-300 text-xl">
          <AnimatedNumber value={activeCount} duration={800} />
        </p>
        <p className="text-[10px] text-white/25 mt-0.5 tabular-nums">
          cards tracked
        </p>
      </div>

      {/* Action Signals — only show if any */}
      {signalCount > 0 && (
        <div className="min-w-[130px] rounded-xl border border-amber-400/20 bg-amber-400/[0.04] px-3.5 py-2.5">
          <p className="text-[9px] uppercase tracking-widest text-amber-400/50 font-semibold mb-1 flex items-center gap-1">
            <Zap className="h-2.5 w-2.5" /> Action Signals
          </p>
          <p className="font-black tabular-nums leading-none text-amber-300 text-xl">
            <AnimatedNumber value={signalCount} duration={600} />
          </p>
          <p className="text-[10px] text-amber-400/40 mt-0.5 tabular-nums">
            {sellCount} sell · {gradeCount} grade
          </p>
        </div>
      )}
    </div>
  )
}
