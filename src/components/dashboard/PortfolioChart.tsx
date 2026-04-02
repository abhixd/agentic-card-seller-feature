'use client'

import { useEffect, useState } from 'react'
import {
  AreaChart, Area, XAxis, YAxis, Tooltip,
  ResponsiveContainer, CartesianGrid,
} from 'recharts'
import { TrendingUp, Clock } from 'lucide-react'

interface Snapshot {
  snapshot_date: string
  total_value:   number
  card_count:    number
}

interface PortfolioChartProps {
  currentValue: number
  cardCount:    number
}

function fmtUsd(n: number) {
  if (n >= 1000) return `$${(n / 1000).toFixed(2)}k`
  return `$${n.toFixed(2)}`
}

function fmtDate(d: string) {
  const dt = new Date(d + 'T00:00:00')
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export function PortfolioChart({ currentValue, cardCount }: PortfolioChartProps) {
  const [snapshots, setSnapshots] = useState<Snapshot[]>([])
  const [loading,   setLoading]   = useState(true)

  useEffect(() => {
    // Record today's snapshot then fetch history
    fetch('/api/portfolio/snapshot', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ totalValue: currentValue, cardCount }),
    })
      .then(() => fetch('/api/portfolio/snapshot'))
      .then(r => r.json())
      .then(d => {
        setSnapshots(d.snapshots ?? [])
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [currentValue, cardCount])

  const data = snapshots.map(s => ({
    date:  fmtDate(s.snapshot_date),
    value: Number(s.total_value),
  }))

  const hasHistory = data.length >= 2

  const minVal = hasHistory ? Math.min(...data.map(d => d.value)) : 0
  const maxVal = hasHistory ? Math.max(...data.map(d => d.value)) : currentValue * 1.1
  const isUp   = hasHistory
    ? data[data.length - 1].value >= data[0].value
    : true

  const strokeColor = isUp ? '#6366f1' : '#f87171'

  return (
    <div className="rounded-xl border border-white/8 overflow-hidden" style={{ background: '#080c10' }}>
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/[0.06]">
        <div className="flex items-center gap-2">
          <TrendingUp className="h-3.5 w-3.5 text-indigo-400/60" />
          <span className="text-[10px] font-bold uppercase tracking-widest text-white/35">
            Portfolio Value · History
          </span>
        </div>
        {hasHistory && (
          <div className="flex items-center gap-1 text-[10px] text-white/20">
            <Clock className="h-3 w-3" />
            {data.length} day{data.length !== 1 ? 's' : ''} tracked
          </div>
        )}
      </div>

      {loading ? (
        <div className="h-[120px] flex items-center justify-center">
          <div className="h-1 w-24 rounded-full bg-white/5 animate-pulse" />
        </div>
      ) : !hasHistory ? (
        <div className="h-[100px] flex flex-col items-center justify-center gap-1.5 px-4">
          <p className="text-xs text-white/30">Building history…</p>
          <p className="text-[10px] text-white/15 text-center">
            This chart fills in daily. Check back tomorrow to see your portfolio trajectory.
          </p>
        </div>
      ) : (
        <div className="px-2 py-3">
          <ResponsiveContainer width="100%" height={120}>
            <AreaChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="portfolioGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%"   stopColor={strokeColor} stopOpacity={0.25} />
                  <stop offset="100%" stopColor={strokeColor} stopOpacity={0}    />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" vertical={false} />
              <XAxis
                dataKey="date"
                tick={{ fill: 'rgba(255,255,255,0.2)', fontSize: 9 }}
                axisLine={false}
                tickLine={false}
                interval="preserveStartEnd"
              />
              <YAxis
                domain={[minVal * 0.97, maxVal * 1.03]}
                tickFormatter={fmtUsd}
                tick={{ fill: 'rgba(255,255,255,0.2)', fontSize: 9 }}
                axisLine={false}
                tickLine={false}
                width={52}
              />
              <Tooltip
                contentStyle={{
                  background: '#0d1117',
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: 8,
                  fontSize: 11,
                  color: '#fff',
                }}
                formatter={(v) => [fmtUsd(Number(v ?? 0)), 'Portfolio']}
                labelStyle={{ color: 'rgba(255,255,255,0.4)' }}
              />
              <Area
                type="monotone"
                dataKey="value"
                stroke={strokeColor}
                strokeWidth={2}
                fill="url(#portfolioGradient)"
                dot={false}
                activeDot={{ r: 4, fill: strokeColor, stroke: 'none' }}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  )
}
