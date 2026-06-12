'use client'

interface SparklineProps {
  /** Raw price points in chronological order */
  points:       number[]
  width?:       number
  height?:      number
  /** Override auto color */
  color?:       string
  strokeWidth?: number
  fillOpacity?: number
  className?:   string
}

/**
 * Minimal SVG sparkline — no dependencies.
 * Auto-colors green (up) or red (down) based on first vs last point.
 * Returns null when fewer than 2 points (caller should guard accordingly).
 */
export function Sparkline({
  points,
  width       = 72,
  height      = 28,
  color,
  strokeWidth = 1.5,
  fillOpacity = 0.12,
  className,
}: SparklineProps) {
  if (points.length < 2) return null

  const min   = Math.min(...points)
  const max   = Math.max(...points)
  const range = max - min || 1
  const pad   = 2   // vertical padding so line doesn't touch SVG edge

  const xs = points.map((_, i) => (i / (points.length - 1)) * width)
  const ys = points.map(p => height - pad - ((p - min) / range) * (height - pad * 2))

  const linePath = xs.map((x, i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${ys[i].toFixed(1)}`).join(' ')
  const fillPath = `${linePath} L${xs[xs.length - 1].toFixed(1)},${height} L${xs[0].toFixed(1)},${height} Z`

  const isUp    = points[points.length - 1] >= points[0]
  const stroke  = color ?? (isUp ? '#4ade80' : '#f87171')

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      style={{ overflow: 'visible', display: 'block' }}
    >
      <path d={fillPath} fill={stroke} fillOpacity={fillOpacity} />
      <path
        d={linePath}
        fill="none"
        stroke={stroke}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
